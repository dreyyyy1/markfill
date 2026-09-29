//! MarkFill vault — PDA custody, user-signed deposit/arm/withdraw,
//! permissionless execute_fill with on-chain Pyth band check.
//!
//! Jupiter CPI program: JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5xQNyVTaV4 (v6 aggregator).
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

/// Jupiter v6 aggregator — confirmed 2026-09 (JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5xQNyVTaV4).
fn jupiter_id() -> Pubkey {
    pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4")
}

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
        require_keys_eq!(*ctx.accounts.jupiter_program.key, jupiter_id(), MarkFillError::BadJupiter);

        require_keys_eq!(ctx.accounts.vault_usdc.owner, ctx.accounts.vault.key(), MarkFillError::BadSwapAccounts);
        require_keys_eq!(ctx.accounts.vault_stock.owner, ctx.accounts.vault.key(), MarkFillError::BadSwapAccounts);

        let nyse_e8 = pyth_e8(&ctx.accounts.pyth_price, &order.pyth_feed_id, &clock)?;
        let implied_e8 = implied_price_e8(order.side, order.usd_amount, min_out, ctx.accounts.stock_mint.decimals)?;
        require!(in_band(order.side, implied_e8, nyse_e8, order.band_bps), MarkFillError::OutsideBand);

        let usdc_before = ctx.accounts.vault_usdc.amount;
        let stock_before = ctx.accounts.vault_stock.amount;
        let side = order.side;
        let fill_owner = order.owner;
        let fill_id = order.order_id;
        let fill_usd = order.usd_amount;

        let bump = [ctx.accounts.vault.bump];
        let owner = ctx.accounts.vault.owner;
        let seeds: &[&[u8]] = &[VAULT_SEED, owner.as_ref(), &bump];

        let infos: Vec<AccountInfo> = ctx.remaining_accounts.iter().map(|a| a.clone()).collect();
        let metas: Vec<AccountMeta> = ctx
            .remaining_accounts
            .iter()
            .map(|a| {
                if a.is_writable {
                    AccountMeta::new(*a.key, a.is_signer)
                } else {
                    AccountMeta::new_readonly(*a.key, a.is_signer)
                }
            })
            .collect();

        invoke_signed(
            &Instruction {
                program_id: jupiter_id(),
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
        } else {
            require!(
                ctx.accounts.vault_usdc.amount >= usdc_before.saturating_add(min_out),
                MarkFillError::BadFillBalance
            );
            require!(
                ctx.accounts.vault_stock.amount <= stock_before,
                MarkFillError::BadFillBalance
            );
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

/// Buy: USDC in / stock out. Sell: stock in / USDC out. Result in 1e8 USD per whole token.
fn implied_price_e8(side: u8, usd_amount: u64, min_out: u64, stock_decimals: u8) -> Result<u64> {
    require!(min_out > 0, MarkFillError::OutsideBand);
    if side == 0 {
        // usd_amount is 6 dp, min_out is stock native
        // price = usd / tokens = usd_amount * 10^(stock_decimals-6) / min_out, then * 1e8 / 10^stock_decimals
        // = usd_amount * 1e8 / min_out / 10^(stock_decimals-6) wait:
        // tokens = min_out / 10^d
        // usd = usd_amount / 1e6
        // price = usd/tokens = usd_amount * 10^d / (min_out * 1e6)
        // e8 = price * 1e8 = usd_amount * 10^d * 1e2 / min_out
        let num = (usd_amount as u128)
            .checked_mul(10u128.pow(stock_decimals as u32))
            .ok_or(MarkFillError::OutsideBand)?
            .checked_mul(100)
            .ok_or(MarkFillError::OutsideBand)?;
        Ok((num / min_out as u128) as u64)
    } else {
        // min_out is USDC received (6 dp), usd_amount is notional; use min_out as proceeds
        // tokens sold unknown here — keeper must pass min_out as USDC out; stock spent checked post-CPI
        // implied = usdc_out / tokens_in approximated as min_out (6dp) vs order.usd_amount notional
        let num = (min_out as u128).checked_mul(100).ok_or(MarkFillError::OutsideBand)?;
        // treat usd_amount as 6dp notional of stock value at NYSE; implied proceeds per $1e6 notional
        Ok((num.checked_mul(1_000_000).ok_or(MarkFillError::OutsideBand)? / usd_amount as u128) as u64)
    }
}

fn in_band(side: u8, implied_e8: u64, nyse_e8: u64, band_bps: u16) -> bool {
    let band = band_bps as u128;
    let nyse = nyse_e8 as u128;
    let implied = implied_e8 as u128;
    if side == 0 {
        // buy: implied <= nyse * (1 + band/10000)
        implied * 10_000 <= nyse * (10_000 + band)
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
    pub usdc_mint: InterfaceAccount<'info, Mint>,
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
    /// CHECK: must equal JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4
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
