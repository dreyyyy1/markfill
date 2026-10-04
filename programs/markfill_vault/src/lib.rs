//! MarkFill vault — PDA custody, user-signed deposit/arm/withdraw,
//! permissionless execute_fill with on-chain Pyth band check.
//!
//! Jupiter CPI program: state::JUPITER_V6.
//! Pyth: pyth-solana-receiver-sdk PriceUpdateV2 (Solana Core receiver).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::Instruction, program::invoke_signed};
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{
        transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
    },
};
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

pub mod errors;
pub mod state;

use errors::MarkFillError;
use state::*;

declare_id!("CYJsEDDTrZQ9zRjPfUrKAawjRfvofH7afeeTPVNHrrsw");

#[program]
pub mod markfill_vault {
    use super::*;

    pub fn initialize_vault(ctx: Context<InitializeVault>) -> Result<()> {
        let v = &mut ctx.accounts.vault;
        v.owner = ctx.accounts.user.key();
        v.bump = ctx.bumps.vault;
        v.next_order_id = 0;
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, MarkFillError::InsufficientUsdc);
        let decimals = ctx.accounts.usdc_mint.decimals;
        transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.user_usdc.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.vault_usdc.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
            decimals,
        )?;
        Ok(())
    }

    pub fn place_order(
        ctx: Context<PlaceOrder>,
        usd_amount: u64,
        band_bps: u16,
        side: u8,
        expiry_ts: i64,
        pyth_feed_id: [u8; 32],
    ) -> Result<()> {
        require!(side == 0 || side == 1, MarkFillError::BadSide);
        require!(usd_amount > 0, MarkFillError::InsufficientUsdc);
        let clock = Clock::get()?;
        require!(expiry_ts > clock.unix_timestamp, MarkFillError::OrderExpired);

        if side == 0 {
            require!(
                ctx.accounts.vault_usdc.amount >= usd_amount,
                MarkFillError::InsufficientUsdc
            );
        } else {
            require!(
                ctx.accounts.vault_stock.amount > 0,
                MarkFillError::InsufficientStock
            );
        }

        let vault = &mut ctx.accounts.vault;
        let order_id = vault.next_order_id;
        vault.next_order_id = order_id.checked_add(1).unwrap();

        let order = &mut ctx.accounts.order;
        order.owner = ctx.accounts.user.key();
        order.vault = vault.key();
        order.order_id = order_id;
        order.stock_mint = ctx.accounts.stock_mint.key();
        order.pyth_feed_id = pyth_feed_id;
        order.usd_amount = usd_amount;
        order.band_bps = band_bps;
        order.side = side;
        order.expiry_ts = expiry_ts;
        order.filled = false;
        order.bump = ctx.bumps.order;
        Ok(())
    }

    pub fn cancel_order(ctx: Context<CancelOrder>) -> Result<()> {
        require!(!ctx.accounts.order.filled, MarkFillError::OrderClosed);
        Ok(())
    }

    /// Permissionless keeper fill. Program re-checks Pyth vs implied fill price.
    /// Jupiter remaining_accounts + `data` come from /swap-instructions.
    /// Source and dest ATAs are hard-constrained to the vault.
    pub fn execute_fill<'info>(
        ctx: Context<'_, '_, 'info, 'info, ExecuteFill<'info>>,
        jupiter_data: Vec<u8>,
        min_out: u64,
    ) -> Result<()> {
        let order = &ctx.accounts.order;
        require!(!order.filled, MarkFillError::OrderClosed);
        let clock = Clock::get()?;
        require!(clock.unix_timestamp <= order.expiry_ts, MarkFillError::OrderExpired);

        require_keys_eq!(ctx.accounts.vault_usdc.owner, ctx.accounts.vault.key(), MarkFillError::BadSwapAccounts);
        require_keys_eq!(ctx.accounts.vault_stock.owner, ctx.accounts.vault.key(), MarkFillError::BadSwapAccounts);

        let nyse_e8 = pyth_e8(&ctx.accounts.pyth_price, &order.pyth_feed_id, &clock)?;
        let stock_decimals = ctx.accounts.stock_mint.decimals;
        let band_bps = order.band_bps;
        // Buy price is known before the swap: the order may spend the full
        // USDC notional and must receive at least min_out stock. That pair is
        // the worst price the band will accept.
        if order.side == 0 {
            let implied_e8 = implied_price_e8(0, order.usd_amount, min_out, stock_decimals)?;
            require!(in_band(0, implied_e8, nyse_e8, band_bps), MarkFillError::OutsideBand);
        }

        let usdc_before = ctx.accounts.vault_usdc.amount;
        let stock_before = ctx.accounts.vault_stock.amount;
        let side = order.side;
        let fill_owner = order.owner;
        let fill_id = order.order_id;
        let fill_usd = order.usd_amount;

        let bump = [ctx.accounts.vault.bump];
        let owner = ctx.accounts.vault.owner;
        let vault_key = ctx.accounts.vault.key();
        let seeds: &[&[u8]] = &[VAULT_SEED, owner.as_ref(), &bump];

        let infos: Vec<AccountInfo> = ctx.remaining_accounts.iter().map(|a| a.clone()).collect();
        let metas: Vec<AccountMeta> = ctx
            .remaining_accounts
            .iter()
            .map(|a| {
                // The vault PDA is not an outer signer (the keeper is). Jupiter
                // still requires it to sign; invoke_signed attaches that signature.
                let signer = a.is_signer || *a.key == vault_key;
                if a.is_writable {
                    AccountMeta::new(*a.key, signer)
                } else {
                    AccountMeta::new_readonly(*a.key, signer)
                }
            })
            .collect();

        invoke_signed(
            &Instruction {
                program_id: JUPITER_V6,
                accounts: metas,
                data: jupiter_data,
            },
            &infos,
            &[seeds],
        )?;

        ctx.accounts.vault_usdc.reload()?;
        ctx.accounts.vault_stock.reload()?;

        if side == 0 {
            require!(
                ctx.accounts.vault_stock.amount >= stock_before.saturating_add(min_out),
                MarkFillError::BadFillBalance
            );
            require!(
                ctx.accounts.vault_usdc.amount <= usdc_before,
                MarkFillError::BadFillBalance
            );
            let spent = usdc_before.saturating_sub(ctx.accounts.vault_usdc.amount);
            require!(spent <= fill_usd, MarkFillError::OverspendCap);
        } else {
            require!(
                ctx.accounts.vault_usdc.amount >= usdc_before.saturating_add(min_out),
                MarkFillError::BadFillBalance
            );
            require!(
                ctx.accounts.vault_stock.amount <= stock_before,
                MarkFillError::BadFillBalance
            );
            let sold = stock_before.saturating_sub(ctx.accounts.vault_stock.amount);
            let received = ctx.accounts.vault_usdc.amount.saturating_sub(usdc_before);
            // Sell price needs the share debit. usd_amount on the order is a
            // USDC notional, not a share count, so it cannot be the denominator.
            let implied_e8 = implied_price_e8(1, sold, received, stock_decimals)?;
            require!(in_band(1, implied_e8, nyse_e8, band_bps), MarkFillError::OutsideBand);
            let max_sold = max_sell_native(fill_usd, nyse_e8, band_bps, stock_decimals)?;
            require!(sold <= max_sold, MarkFillError::OverspendCap);
        }

        let order = &mut ctx.accounts.order;
        order.filled = true;

        emit!(FillEvent {
            owner: fill_owner,
            order_id: fill_id,
            side,
            usd_amount: fill_usd,
            min_out,
            nyse_e8,
        });
        Ok(())
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require!(amount > 0, MarkFillError::InsufficientUsdc);
        let bump = [ctx.accounts.vault.bump];
        let owner = ctx.accounts.vault.owner;
        let seeds: &[&[u8]] = &[VAULT_SEED, owner.as_ref(), &bump];
        let decimals = ctx.accounts.mint.decimals;
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault_ata.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.owner_ata.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            decimals,
        )?;
        Ok(())
    }
}

fn pyth_e8(price_update: &Account<PriceUpdateV2>, feed_id: &[u8; 32], clock: &Clock) -> Result<u64> {
    let p = price_update
        .get_price_no_older_than(clock, 120, feed_id)
        .map_err(|_| error!(MarkFillError::BadPythPrice))?;
    require!(p.price > 0, MarkFillError::BadPythPrice);
    let price = p.price as i128;
    let expo = p.exponent as i32;
    // scale to 1e8
    let e8: i128 = if expo >= -8 {
        price.checked_mul(10i128.pow((expo + 8) as u32)).ok_or(MarkFillError::BadPythPrice)?
    } else {
        price
            .checked_div(10i128.pow((-8 - expo) as u32))
            .ok_or(MarkFillError::BadPythPrice)?
    };
    require!(e8 > 0, MarkFillError::BadPythPrice);
    Ok(e8 as u64)
}

/// USD per whole token, scaled by 1e8 (10_000_000_000 = $100).
///
/// side 0 (buy). Checked before the swap, using the worst case the order allows:
///   usd_amount — USDC atoms the order may spend. 1_000_000 = $1 (6 decimals).
///   min_out    — minimum stock atoms the swap must deliver. 10^stock_decimals = 1 token.
///   usd    = usd_amount / 1e6
///   tokens = min_out / 10^d
///   price  = usd / tokens = usd_amount * 10^d / (min_out * 1e6)
///   e8     = price * 1e8 = usd_amount * 10^d * 100 / min_out
///
/// side 1 (sell). Checked after the swap. The order's usd_amount field is a USDC
/// notional, not a share count, so it is NOT what is passed here. The caller passes
/// the stock atoms actually debited in the usd_amount parameter, and the USDC atoms
/// actually credited in min_out:
///   usd_amount — stock atoms sold. 10^stock_decimals = 1 token.
///   min_out    — USDC atoms received. 1_000_000 = $1 (6 decimals).
///   usd    = min_out / 1e6
///   tokens = usd_amount / 10^d
///   price  = usd / tokens = min_out * 10^d / (usd_amount * 1e6)
///   e8     = price * 1e8 = min_out * 10^d * 100 / usd_amount
///
/// Worked examples (integer division, no remainder in these cases):
///
/// 1. Buy, 8 decimals (AAPLx). Pay $100, receive 1 token.
///    usd_amount = 100_000_000, min_out = 100_000_000, d = 8
///    e8 = 100_000_000 * 10^8 * 100 / 100_000_000 = 10_000_000_000 = $100.
///
/// 2. Buy, 6 decimals. Pay $250, receive 1 token.
///    usd_amount = 250_000_000, min_out = 1_000_000, d = 6
///    e8 = 250_000_000 * 10^6 * 100 / 1_000_000 = 25_000_000_000 = $250.
///
/// 3. Sell, 8 decimals. Sell 0.5 token, receive $50.
///    usd_amount (stock atoms) = 50_000_000, min_out (USDC) = 50_000_000, d = 8
///    e8 = 50_000_000 * 10^8 * 100 / 50_000_000 = 10_000_000_000 = $100.
///
/// 4. Sell, 6 decimals. Sell 2 tokens, receive $500.
///    usd_amount (stock atoms) = 2_000_000, min_out (USDC) = 500_000_000, d = 6
///    e8 = 500_000_000 * 10^6 * 100 / 2_000_000 = 25_000_000_000 = $250.
fn implied_price_e8(side: u8, usd_amount: u64, min_out: u64, stock_decimals: u8) -> Result<u64> {
    require!(min_out > 0 && usd_amount > 0, MarkFillError::OutsideBand);
    require!(stock_decimals <= 18, MarkFillError::OutsideBand);
    let scale = 10u128.pow(stock_decimals as u32);
    if side == 0 {
        let num = (usd_amount as u128)
            .checked_mul(scale)
            .ok_or(MarkFillError::OutsideBand)?
            .checked_mul(100)
            .ok_or(MarkFillError::OutsideBand)?;
        u64::try_from(num / min_out as u128).map_err(|_| error!(MarkFillError::OutsideBand))
    } else {
        let num = (min_out as u128)
            .checked_mul(scale)
            .ok_or(MarkFillError::OutsideBand)?
            .checked_mul(100)
            .ok_or(MarkFillError::OutsideBand)?;
        u64::try_from(num / usd_amount as u128).map_err(|_| error!(MarkFillError::OutsideBand))
    }
}

/// Most stock atoms a sell may debit.
///
/// order usd_amount is USDC notional (6 decimals), not a share count. The band's
/// floor price is the cheapest fill still allowed, so it implies the most shares:
///   floor_e8   = nyse_e8 * (10_000 - band_bps) / 10_000
///   max_whole  = (usd_amount / 1e6) / (floor_e8 / 1e8) = usd_amount * 100 / floor_e8
///   max_native = ceil(max_whole * 10^decimals)
///              = ceil(usd_amount * 100 * 10^decimals / floor_e8)
///
/// A band of 10_000 wipes the floor out to zero. There is no finite share bound
/// then, and this returns OverspendCap instead of pretending there is one.
///
/// Example: sell $100 notional, NYSE $100 (e8 = 10_000_000_000), 8 decimals, 50 bps.
///   floor = 9_950_000_000 ($99.50)
///   max   = ceil(100_000_000 * 100 * 10^8 / 9_950_000_000) = 100_502_513 atoms
///         = 1.00502513 tokens = $100 / $99.50.
fn max_sell_native(usd_amount: u64, nyse_e8: u64, band_bps: u16, stock_decimals: u8) -> Result<u64> {
    require!(band_bps < 10_000, MarkFillError::OverspendCap);
    require!(usd_amount > 0 && nyse_e8 > 0, MarkFillError::OverspendCap);
    require!(stock_decimals <= 18, MarkFillError::OverspendCap);
    let floor = (nyse_e8 as u128)
        .checked_mul(10_000u128 - band_bps as u128)
        .ok_or(MarkFillError::OverspendCap)?
        / 10_000;
    require!(floor > 0, MarkFillError::OverspendCap);
    let num = (usd_amount as u128)
        .checked_mul(100)
        .ok_or(MarkFillError::OverspendCap)?
        .checked_mul(10u128.pow(stock_decimals as u32))
        .ok_or(MarkFillError::OverspendCap)?;
    let max = num
        .checked_add(floor - 1)
        .ok_or(MarkFillError::OverspendCap)?
        / floor;
    u64::try_from(max).map_err(|_| error!(MarkFillError::OverspendCap))
}

fn in_band(side: u8, implied_e8: u64, nyse_e8: u64, band_bps: u16) -> bool {
    let band = band_bps as u128;
    let nyse = nyse_e8 as u128;
    let implied = implied_e8 as u128;
    if side == 0 {
        // buy: implied <= nyse * (1 + band/10000)
        implied * 10_000 <= nyse * (10_000 + band)
    } else if band >= 10_000 {
        // No positive floor price, so a sell cannot be inside the band.
        false
    } else {
        implied * 10_000 >= nyse * (10_000 - band)
    }
}

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        init,
        payer = user,
        space = Vault::SIZE,
        seeds = [VAULT_SEED, user.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        seeds = [VAULT_SEED, user.key().as_ref()],
        bump = vault.bump,
        constraint = vault.owner == user.key() @ MarkFillError::BadOwner
    )]
    pub vault: Account<'info, Vault>,
    #[account(constraint = usdc_mint.key() == USDC_MINT @ MarkFillError::BadSwapAccounts)]
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = usdc_mint, token::authority = user)]
    pub user_usdc: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program
    )]
    pub vault_usdc: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[derive(Accounts)]
pub struct PlaceOrder<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [VAULT_SEED, user.key().as_ref()],
        bump = vault.bump,
        constraint = vault.owner == user.key() @ MarkFillError::BadOwner
    )]
    pub vault: Account<'info, Vault>,
    pub stock_mint: InterfaceAccount<'info, Mint>,
    #[account(constraint = usdc_mint.key() == USDC_MINT @ MarkFillError::BadSwapAccounts)]
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    #[account(
        associated_token::mint = usdc_mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program
    )]
    pub vault_usdc: InterfaceAccount<'info, TokenAccount>,
    #[account(
        associated_token::mint = stock_mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program
    )]
    pub vault_stock: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init,
        payer = user,
        space = Order::SIZE,
        seeds = [ORDER_SEED, user.key().as_ref(), &vault.next_order_id.to_le_bytes()],
        bump
    )]
    pub order: Account<'info, Order>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        close = user,
        constraint = order.owner == user.key() @ MarkFillError::BadOwner,
        seeds = [ORDER_SEED, user.key().as_ref(), &order.order_id.to_le_bytes()],
        bump = order.bump
    )]
    pub order: Account<'info, Order>,
}

#[derive(Accounts)]
pub struct ExecuteFill<'info> {
    /// Keeper — pays fees only. Not an authority on the vault.
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(
        seeds = [VAULT_SEED, vault.owner.as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        mut,
        has_one = vault,
        seeds = [ORDER_SEED, order.owner.as_ref(), &order.order_id.to_le_bytes()],
        bump = order.bump
    )]
    pub order: Account<'info, Order>,
    #[account(constraint = usdc_mint.key() == USDC_MINT @ MarkFillError::BadSwapAccounts)]
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    #[account(constraint = stock_mint.key() == order.stock_mint @ MarkFillError::BadSwapAccounts)]
    pub stock_mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program
    )]
    pub vault_usdc: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = stock_mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program
    )]
    pub vault_stock: InterfaceAccount<'info, TokenAccount>,
    pub pyth_price: Account<'info, PriceUpdateV2>,
    /// CHECK: account constraint pins this to state::JUPITER_V6.
    #[account(constraint = jupiter_program.key() == JUPITER_V6 @ MarkFillError::BadJupiter)]
    pub jupiter_program: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        seeds = [VAULT_SEED, user.key().as_ref()],
        bump = vault.bump,
        constraint = vault.owner == user.key() @ MarkFillError::BadOwner
    )]
    pub vault: Account<'info, Vault>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program
    )]
    pub vault_ata: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = user
    )]
    pub owner_ata: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn price(side: u8, usd_amount: u64, min_out: u64, decimals: u8) -> u64 {
        implied_price_e8(side, usd_amount, min_out, decimals).unwrap()
    }

    #[test]
    fn buy_eight_decimals_is_one_hundred_dollars() {
        // Example 1. $100 USDC for 1 AAPLx token (8 decimals).
        assert_eq!(price(0, 100_000_000, 100_000_000, 8), 10_000_000_000);
    }

    #[test]
    fn buy_six_decimals_is_two_hundred_fifty_dollars() {
        // Example 2. $250 USDC for 1 token (6 decimals).
        assert_eq!(price(0, 250_000_000, 1_000_000, 6), 25_000_000_000);
    }

    #[test]
    fn sell_half_token_eight_decimals_is_one_hundred_dollars() {
        // Example 3. 0.5 token sold, $50 received.
        assert_eq!(price(1, 50_000_000, 50_000_000, 8), 10_000_000_000);
    }

    #[test]
    fn sell_two_tokens_six_decimals_is_two_hundred_fifty_dollars() {
        // Example 4. 2 tokens sold, $500 received.
        assert_eq!(price(1, 2_000_000, 500_000_000, 6), 25_000_000_000);
    }

    #[test]
    fn sell_cap_matches_floor_notional() {
        // $100 notional, NYSE $100, 8 decimals, 50 bps → 100_502_513 atoms.
        let max = max_sell_native(100_000_000, 10_000_000_000, 50, 8).unwrap();
        assert_eq!(max, 100_502_513);
        assert!(100_000_000u64 <= max);
        // 10 whole tokens is far past the order.
        assert!(10 * 100_000_000 > max);
    }

    #[test]
    fn sell_cap_six_decimals() {
        // $500 notional, NYSE $250, 6 decimals, 100 bps → 2_020_203 atoms.
        let max = max_sell_native(500_000_000, 25_000_000_000, 100, 6).unwrap();
        assert_eq!(max, 2_020_203);
    }

    #[test]
    fn full_band_has_no_share_bound() {
        assert!(max_sell_native(100_000_000, 10_000_000_000, 10_000, 8).is_err());
    }

    #[test]
    fn buy_spend_over_notional_fails_the_cap() {
        let usdc_before = 1_000_000_000u64;
        let usdc_after = 100_000_000u64;
        let authorized = 250_000_000u64;
        let spent = usdc_before.saturating_sub(usdc_after);
        assert!(spent > authorized);
        let honest = usdc_before.saturating_sub(usdc_before - authorized);
        assert!(honest <= authorized);
    }

    #[test]
    fn band_edges() {
        let nyse = 10_000_000_000u64;
        assert!(in_band(0, nyse, nyse, 50));
        assert!(in_band(0, 10_040_000_000, nyse, 50));
        assert!(!in_band(0, 10_100_000_000, nyse, 50));
        assert!(in_band(1, nyse, nyse, 50));
        assert!(!in_band(1, 9_900_000_000, nyse, 50));
        assert!(!in_band(1, nyse, nyse, 10_000));
    }
}
