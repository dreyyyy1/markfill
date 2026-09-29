use anchor_lang::prelude::*;

pub const VAULT_SEED: &[u8] = b"vault";
pub const ORDER_SEED: &[u8] = b"order";

/// Jupiter Swap Aggregator v6 — verified 2026-09 against JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4
pub const JUPITER_V6: Pubkey = pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

// Mainnet USDC
pub const USDC_MINT: Pubkey = pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

#[account]
pub struct Vault {
    pub owner: Pubkey,
    pub bump: u8,
    pub next_order_id: u64,
    pub reserved: [u8; 32],
}

impl Vault {
    pub const SIZE: usize = 8 + 32 + 1 + 8 + 32;
}

#[account]
pub struct Order {
    pub owner: Pubkey,
    pub vault: Pubkey,
    pub order_id: u64,
    pub stock_mint: Pubkey,
    pub pyth_feed_id: [u8; 32],
    pub usd_amount: u64, // USDC native (6 decimals)
    pub band_bps: u16,
    pub side: u8, // 0 buy, 1 sell
    pub expiry_ts: i64,
    pub filled: bool,
    pub bump: u8,
}

impl Order {
    pub const SIZE: usize = 8 + 32 + 32 + 8 + 32 + 32 + 8 + 2 + 1 + 8 + 1 + 1;
}

#[event]
pub struct FillEvent {
    pub owner: Pubkey,
    pub order_id: u64,
    pub side: u8,
    pub usd_amount: u64,
    pub min_out: u64,
    pub nyse_e8: u64,
}
