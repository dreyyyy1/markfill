//! In-process program tests (solana-program-test, the bankrun-style harness).
//! Jupiter is a local mock at state::JUPITER_V6. Pyth is a crafted PriceUpdateV2.
//!
//! Build and run with the host linker that can actually link Rust. On this
//! machine that is the GNU toolchain, because `link.exe` on PATH is Git's link:
//!
//!   cargo +stable-x86_64-pc-windows-gnu test --manifest-path programs/markfill_vault/Cargo.toml --features no-entrypoint -- --test-threads=1
//!
//! `no-entrypoint` keeps Anchor's BPF entrypoint out of the test binary.
//! tests/band.test.ts is only a formula sanity check.

use anchor_lang::solana_program::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    hash::hash,
    instruction::{AccountMeta, Instruction},
    program::invoke,
    program_error::ProgramError,
    program_option::COption,
    program_pack::Pack,
    pubkey::Pubkey,
};
use anchor_lang::{AccountDeserialize, AccountSerialize};
use markfill_vault::state::{JUPITER_V6, Order, ORDER_SEED, USDC_MINT, VAULT_SEED};
use pyth_solana_receiver_sdk::price_update::{PriceFeedMessage, PriceUpdateV2, VerificationLevel};
use solana_program_test::{processor, BanksClientError, ProgramTest, ProgramTestContext};
use solana_sdk::{
    account::Account,
    clock::Clock,
    instruction::InstructionError,
    signature::{Keypair, Signer},
    system_program,
    transaction::{Transaction, TransactionError},
};
use spl_associated_token_account::get_associated_token_address;
use spl_token::{
    instruction::transfer_checked,
    processor::Processor as TokenProcessor,
    state::{Account as TokenAccount, AccountState, Mint},
};

const NOW: i64 = 1_700_000_000;
const USDC_DECIMALS: u8 = 6;
const STOCK_DECIMALS: u8 = 8;
/// $100 USDC and 1.0 stock atom count. At 8 decimals that is one whole token, so the fill is $100.
const ONE_HUNDRED_USDC: u64 = 100_000_000;
const ONE_STOCK: u64 = 100_000_000;

fn disc(name: &str) -> [u8; 8] {
    let hashed = hash(format!("global:{name}").as_bytes());
    let mut out = [0u8; 8];
    out.copy_from_slice(&hashed.to_bytes()[..8]);
    out
}

fn ix(program: Pubkey, accounts: Vec<AccountMeta>, data: Vec<u8>) -> Instruction {
    Instruction { program_id: program, accounts, data }
}

fn funded(lamports: u64) -> Account {
    Account { lamports, data: vec![], owner: system_program::id(), executable: false, rent_epoch: 0 }
}

fn mint_account(decimals: u8, supply: u64) -> Account {
    let mint = Mint {
        mint_authority: COption::None,
        supply,
        decimals,
        is_initialized: true,
        freeze_authority: COption::None,
    };
    let mut data = vec![0u8; Mint::LEN];
    Mint::pack(mint, &mut data).unwrap();
    Account { lamports: 1_000_000_000, data, owner: spl_token::id(), executable: false, rent_epoch: 0 }
}

fn token_account(mint: Pubkey, owner: Pubkey, amount: u64) -> Account {
    let account = TokenAccount {
        mint,
        owner,
        amount,
        delegate: COption::None,
        state: AccountState::Initialized,
        is_native: COption::None,
        delegated_amount: 0,
        close_authority: COption::None,
    };
    let mut data = vec![0u8; TokenAccount::LEN];
    TokenAccount::pack(account, &mut data).unwrap();
    Account { lamports: 1_000_000_000, data, owner: spl_token::id(), executable: false, rent_epoch: 0 }
}

fn price_account(feed: [u8; 32], price: i64) -> Account {
    let update = PriceUpdateV2 {
        write_authority: Pubkey::new_unique(),
        verification_level: VerificationLevel::Full,
        price_message: PriceFeedMessage {
            feed_id: feed,
            price,
            conf: 0,
            exponent: 0,
            publish_time: NOW,
            prev_publish_time: NOW - 1,
            ema_price: price,
            ema_conf: 0,
        },
        posted_slot: 1,
    };
    let mut data = Vec::new();
    update.try_serialize(&mut data).unwrap();
    Account {
        lamports: 1_000_000_000,
        data,
        owner: pyth_solana_receiver_sdk::id(),
        executable: false,
        rent_epoch: 0,
    }
}

/// Mock Jupiter. Remaining-account order is fixed by the tests:
/// 0 vault (PDA signer), 1 vault_usdc, 2 vault_stock, 3 usdc mint, 4 stock mint,
/// 5 market maker (signer), 6 mm_usdc, 7 mm_stock, 8 attacker_stock, 9 token program.
/// data: op u8, usdc u64 le, stock u64 le.
/// op 0 delivers stock to the vault. op 1 delivers it to the attacker.
fn mock_jupiter(_program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() != 17 || accounts.len() < 10 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let op = data[0];
    let usdc_amount = u64::from_le_bytes(data[1..9].try_into().unwrap());
    let stock_amount = u64::from_le_bytes(data[9..17].try_into().unwrap());
    let vault = &accounts[0];
    let vault_usdc = &accounts[1];
    let vault_stock = &accounts[2];
    let usdc_mint = &accounts[3];
    let stock_mint = &accounts[4];
    let mm = &accounts[5];
    let mm_usdc = &accounts[6];
    let mm_stock = &accounts[7];
    let attacker_stock = &accounts[8];
    let token_program = &accounts[9];
    let stock_dest = if op == 1 { attacker_stock } else { vault_stock };

    let take_usdc = transfer_checked(
        token_program.key,
        vault_usdc.key,
        usdc_mint.key,
        mm_usdc.key,
        vault.key,
        &[],
        usdc_amount,
        USDC_DECIMALS,
    )?;
    invoke(&take_usdc, &[vault_usdc.clone(), usdc_mint.clone(), mm_usdc.clone(), vault.clone(), token_program.clone()])?;

    let give_stock = transfer_checked(
        token_program.key,
        mm_stock.key,
        stock_mint.key,
        stock_dest.key,
        mm.key,
        &[],
        stock_amount,
        STOCK_DECIMALS,
    )?;
    invoke(&give_stock, &[mm_stock.clone(), stock_mint.clone(), stock_dest.clone(), mm.clone(), token_program.clone()])?;
    Ok(())
}

fn noop(_program_id: &Pubkey, _accounts: &[AccountInfo], _data: &[u8]) -> ProgramResult {
    Ok(())
}

struct World {
    user: Keypair,
    keeper: Keypair,
    mm: Keypair,
    attacker: Keypair,
    usdc_mint: Pubkey,
    stock_mint: Pubkey,
    vault: Pubkey,
    order: Pubkey,
    pyth: Pubkey,
    feed: [u8; 32],
}

fn world() -> World {
    let user = Keypair::new();
    let (vault, _) = Pubkey::find_program_address(&[VAULT_SEED, user.pubkey().as_ref()], &markfill_vault::id());
    let order_id = 0u64.to_le_bytes();
    let (order, _) = Pubkey::find_program_address(&[ORDER_SEED, user.pubkey().as_ref(), &order_id], &markfill_vault::id());
    World {
        user,
        keeper: Keypair::new(),
        mm: Keypair::new(),
        attacker: Keypair::new(),
        usdc_mint: USDC_MINT,
        stock_mint: Pubkey::new_unique(),
        vault,
        order,
        pyth: Pubkey::new_unique(),
        feed: [7u8; 32],
    }
}

/// Anchor's generated `entry` ties the accounts-slice lifetime to `AccountInfo`.
/// ProgramTest keeps those lifetimes independent. They are one borrow for this call.
fn vault_entry<'pid, 'slice, 'info, 'data>(
    program_id: &'pid Pubkey,
    accounts: &'slice [AccountInfo<'info>],
    instruction_data: &'data [u8],
) -> ProgramResult {
    let accounts: &'info [AccountInfo<'info>] = unsafe { std::mem::transmute(accounts) };
    markfill_vault::entry(program_id, accounts, instruction_data)
}

fn start(w: &World, nyse_price: i64, vault_usdc: u64) -> ProgramTest {
    let mut pt = ProgramTest::default();
    pt.prefer_bpf(false);
    pt.set_compute_max_units(1_400_000);
    pt.add_program("markfill_vault", markfill_vault::id(), processor!(vault_entry));
    pt.add_program("spl_token", spl_token::id(), processor!(TokenProcessor::process));
    pt.add_program("ata_noop", spl_associated_token_account::id(), processor!(noop));
    pt.add_program("mock_jupiter", JUPITER_V6, processor!(mock_jupiter));

    for kp in [&w.user, &w.keeper, &w.mm, &w.attacker] {
        pt.add_account(kp.pubkey(), funded(10_000_000_000));
    }
    pt.add_account(w.usdc_mint, mint_account(USDC_DECIMALS, 10_000_000_000));
    pt.add_account(w.stock_mint, mint_account(STOCK_DECIMALS, 10_000_000_000));
    let vault_usdc_ata = get_associated_token_address(&w.vault, &w.usdc_mint);
    let vault_stock_ata = get_associated_token_address(&w.vault, &w.stock_mint);
    let mm_usdc = get_associated_token_address(&w.mm.pubkey(), &w.usdc_mint);
    let mm_stock = get_associated_token_address(&w.mm.pubkey(), &w.stock_mint);
    let attacker_stock = get_associated_token_address(&w.attacker.pubkey(), &w.stock_mint);
    pt.add_account(vault_usdc_ata, token_account(w.usdc_mint, w.vault, vault_usdc));
    pt.add_account(vault_stock_ata, token_account(w.stock_mint, w.vault, 0));
    pt.add_account(mm_usdc, token_account(w.usdc_mint, w.mm.pubkey(), 0));
    pt.add_account(mm_stock, token_account(w.stock_mint, w.mm.pubkey(), 1_000 * ONE_STOCK));
    pt.add_account(attacker_stock, token_account(w.stock_mint, w.attacker.pubkey(), 0));
    pt.add_account(
        get_associated_token_address(&w.attacker.pubkey(), &w.usdc_mint),
        token_account(w.usdc_mint, w.attacker.pubkey(), 0),
    );
    pt.add_account(w.pyth, price_account(w.feed, nyse_price));
    pt
}

async fn boot(w: &World, nyse_price: i64, vault_usdc: u64) -> ProgramTestContext {
    let mut context = start(w, nyse_price, vault_usdc).start_with_context().await;
    // ProgramTest's genesis clock is wall time. Pin it so the Pyth update is fresh.
    context.set_sysvar(&Clock {
        slot: 1,
        epoch_start_timestamp: NOW,
        epoch: 0,
        leader_schedule_epoch: 0,
        unix_timestamp: NOW,
    });
    context
}

async fn send(context: &mut ProgramTestContext, payer: &Keypair, ix: Instruction, signers: &[&Keypair]) -> Result<(), BanksClientError> {
    let blockhash = context.banks_client.get_latest_blockhash().await.unwrap();
    let mut all = vec![payer];
    all.extend(signers);
    let tx = Transaction::new_signed_with_payer(&[ix], Some(&payer.pubkey()), &all, blockhash);
    context.banks_client.process_transaction(tx).await
}

fn custom_code(err: BanksClientError) -> u32 {
    match err {
        BanksClientError::TransactionError(TransactionError::InstructionError(_, InstructionError::Custom(code))) => code,
        other => panic!("expected a custom program error, got {other:?}"),
    }
}

fn initialize_ix(w: &World) -> Instruction {
    ix(
        markfill_vault::id(),
        vec![
            AccountMeta::new(w.user.pubkey(), true),
            AccountMeta::new(w.vault, false),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        disc("initialize_vault").to_vec(),
    )
}

fn place_order_ix(w: &World, usd_amount: u64) -> Instruction {
    let mut data = disc("place_order").to_vec();
    data.extend(usd_amount.to_le_bytes());
    data.extend(50u16.to_le_bytes());
    data.push(0); // buy
    data.extend(2_000_000_000i64.to_le_bytes());
    data.extend(w.feed);
    ix(
        markfill_vault::id(),
        vec![
            AccountMeta::new(w.user.pubkey(), true),
            AccountMeta::new(w.vault, false),
            AccountMeta::new_readonly(w.stock_mint, false),
            AccountMeta::new_readonly(w.usdc_mint, false),
            AccountMeta::new_readonly(get_associated_token_address(&w.vault, &w.usdc_mint), false),
            AccountMeta::new_readonly(get_associated_token_address(&w.vault, &w.stock_mint), false),
            AccountMeta::new(w.order, false),
            AccountMeta::new_readonly(spl_token::id(), false),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data,
    )
}

fn execute_fill_ix(w: &World, op: u8, usdc_amount: u64, stock_amount: u64, min_out: u64) -> Instruction {
    let mut jup = vec![op];
    jup.extend(usdc_amount.to_le_bytes());
    jup.extend(stock_amount.to_le_bytes());
    let mut data = disc("execute_fill").to_vec();
    data.extend((jup.len() as u32).to_le_bytes());
    data.extend(&jup);
    data.extend(min_out.to_le_bytes());
    let token_program = spl_token::id();
    ix(
        markfill_vault::id(),
        vec![
            AccountMeta::new(w.keeper.pubkey(), true),
            AccountMeta::new_readonly(w.vault, false),
            AccountMeta::new(w.order, false),
            AccountMeta::new_readonly(w.usdc_mint, false),
            AccountMeta::new_readonly(w.stock_mint, false),
            AccountMeta::new(get_associated_token_address(&w.vault, &w.usdc_mint), false),
            AccountMeta::new(get_associated_token_address(&w.vault, &w.stock_mint), false),
            AccountMeta::new_readonly(w.pyth, false),
            AccountMeta::new_readonly(JUPITER_V6, false),
            AccountMeta::new_readonly(token_program, false),
            AccountMeta::new_readonly(w.vault, false),
            AccountMeta::new(get_associated_token_address(&w.vault, &w.usdc_mint), false),
            AccountMeta::new(get_associated_token_address(&w.vault, &w.stock_mint), false),
            AccountMeta::new_readonly(w.usdc_mint, false),
            AccountMeta::new_readonly(w.stock_mint, false),
            AccountMeta::new_readonly(w.mm.pubkey(), true),
            AccountMeta::new(get_associated_token_address(&w.mm.pubkey(), &w.usdc_mint), false),
            AccountMeta::new(get_associated_token_address(&w.mm.pubkey(), &w.stock_mint), false),
            AccountMeta::new(get_associated_token_address(&w.attacker.pubkey(), &w.stock_mint), false),
            AccountMeta::new_readonly(token_program, false),
        ],
        data,
    )
}

fn withdraw_ix(user: Pubkey, vault: Pubkey, mint: Pubkey, owner_ata: Pubkey, amount: u64) -> Instruction {
    let mut data = disc("withdraw").to_vec();
    data.extend(amount.to_le_bytes());
    ix(
        markfill_vault::id(),
        vec![
            AccountMeta::new(user, true),
            AccountMeta::new_readonly(vault, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new(get_associated_token_address(&vault, &mint), false),
            AccountMeta::new(owner_ata, false),
            AccountMeta::new_readonly(spl_token::id(), false),
        ],
        data,
    )
}

async fn token_amount(context: &mut ProgramTestContext, ata: Pubkey) -> u64 {
    let account = context.banks_client.get_account(ata).await.unwrap().unwrap();
    TokenAccount::unpack(&account.data).unwrap().amount
}

async fn open_buy(context: &mut ProgramTestContext, w: &World, usd_amount: u64) {
    send(context, &w.user, initialize_ix(w), &[]).await.unwrap();
    send(context, &w.user, place_order_ix(w, usd_amount), &[]).await.unwrap();
}

#[tokio::test]
async fn execute_fill_succeeds() {
    let w = world();
    let mut context = boot(&w, 100, 1_000 * ONE_HUNDRED_USDC / 100).await;
    // vault funded with 1000 USDC; order spends 100.
    open_buy(&mut context, &w, ONE_HUNDRED_USDC).await;
    send(&mut context, &w.keeper, execute_fill_ix(&w, 0, ONE_HUNDRED_USDC, ONE_STOCK, ONE_STOCK), &[&w.mm]).await.unwrap();

    let order_account = context.banks_client.get_account(w.order).await.unwrap().unwrap();
    let order = Order::try_deserialize(&mut order_account.data.as_slice()).unwrap();
    assert!(order.filled);
    let usdc = token_amount(&mut context, get_associated_token_address(&w.vault, &w.usdc_mint)).await;
    let stock = token_amount(&mut context, get_associated_token_address(&w.vault, &w.stock_mint)).await;
    assert_eq!(usdc, 1_000 * ONE_HUNDRED_USDC / 100 - ONE_HUNDRED_USDC);
    assert_eq!(stock, ONE_STOCK);
}

#[tokio::test]
async fn execute_fill_rejects_price_outside_band() {
    let w = world();
    // NYSE $50. The order pays $100 for one token, which is outside a 50 bps band.
    let mut context = boot(&w, 50, 1_000 * ONE_HUNDRED_USDC / 100).await;
    open_buy(&mut context, &w, ONE_HUNDRED_USDC).await;
    let err = send(&mut context, &w.keeper, execute_fill_ix(&w, 0, ONE_HUNDRED_USDC, ONE_STOCK, ONE_STOCK), &[&w.mm]).await.unwrap_err();
    assert_eq!(custom_code(err), 6000 + 7, "OutsideBand");
    let usdc = token_amount(&mut context, get_associated_token_address(&w.vault, &w.usdc_mint)).await;
    assert_eq!(usdc, 1_000 * ONE_HUNDRED_USDC / 100, "rejected fill must not move USDC");
}

#[tokio::test]
async fn execute_fill_rejects_non_vault_destination() {
    let w = world();
    let mut context = boot(&w, 100, 1_000 * ONE_HUNDRED_USDC / 100).await;
    open_buy(&mut context, &w, ONE_HUNDRED_USDC).await;
    let err = send(&mut context, &w.keeper, execute_fill_ix(&w, 1, ONE_HUNDRED_USDC, ONE_STOCK, ONE_STOCK), &[&w.mm]).await.unwrap_err();
    assert_eq!(custom_code(err), 6000 + 10, "BadFillBalance");
    let vault_stock = token_amount(&mut context, get_associated_token_address(&w.vault, &w.stock_mint)).await;
    let attacker_stock = token_amount(&mut context, get_associated_token_address(&w.attacker.pubkey(), &w.stock_mint)).await;
    assert_eq!(vault_stock, 0);
    assert_eq!(attacker_stock, 0, "reverted cpi must not leave stock with the attacker");
}

#[tokio::test]
async fn execute_fill_rejects_overspend() {
    let w = world();
    let mut context = boot(&w, 100, 1_000 * ONE_HUNDRED_USDC / 100).await;
    open_buy(&mut context, &w, ONE_HUNDRED_USDC).await;
    // min_out still prices the order at $100, so the band passes. The mock debits 400 USDC.
    let err = send(&mut context, &w.keeper, execute_fill_ix(&w, 0, 4 * ONE_HUNDRED_USDC, ONE_STOCK, ONE_STOCK), &[&w.mm]).await.unwrap_err();
    assert_eq!(custom_code(err), 6000 + 13, "OverspendCap");
    let usdc = token_amount(&mut context, get_associated_token_address(&w.vault, &w.usdc_mint)).await;
    assert_eq!(usdc, 1_000 * ONE_HUNDRED_USDC / 100, "overspend must revert");
}

#[tokio::test]
async fn withdraw_rejects_non_owner() {
    let w = world();
    let mut context = boot(&w, 100, ONE_HUNDRED_USDC).await;
    send(&mut context, &w.user, initialize_ix(&w), &[]).await.unwrap();
    let attacker_ata = get_associated_token_address(&w.attacker.pubkey(), &w.usdc_mint);
    let err = send(
        &mut context,
        &w.attacker,
        withdraw_ix(w.attacker.pubkey(), w.vault, w.usdc_mint, attacker_ata, ONE_HUNDRED_USDC),
        &[],
    )
    .await
    .unwrap_err();
    let code = custom_code(err);
    assert!(code == 2006 || code == 6000, "seeds or BadOwner, got {code}");
}

#[tokio::test]
async fn place_order_rejects_buy_over_balance() {
    let w = world();
    // Vault holds $50. The buy asks for $100.
    let mut context = boot(&w, 100, ONE_HUNDRED_USDC / 2).await;
    send(&mut context, &w.user, initialize_ix(&w), &[]).await.unwrap();
    let err = send(&mut context, &w.user, place_order_ix(&w, ONE_HUNDRED_USDC), &[]).await.unwrap_err();
    assert_eq!(custom_code(err), 6000 + 1, "InsufficientUsdc");
}
