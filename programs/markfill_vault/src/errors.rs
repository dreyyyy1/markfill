use anchor_lang::prelude::*;

#[error_code]
pub enum MarkFillError {
    #[msg("vault owner mismatch")]
    BadOwner,
    #[msg("insufficient vault USDC for this buy")]
    InsufficientUsdc,
    #[msg("insufficient vault stock for this sell")]
    InsufficientStock,
    #[msg("order already filled or cancelled")]
    OrderClosed,
    #[msg("order expired")]
    OrderExpired,
    #[msg("Pyth feed id does not match this order")]
    BadPythFeed,
    #[msg("Pyth equity price is stale or invalid")]
    BadPythPrice,
    #[msg("on-chain fill price is outside the order band")]
    OutsideBand,
    #[msg("Jupiter program id mismatch")]
    BadJupiter,
    #[msg("swap source/destination is not this vault's ATA")]
    BadSwapAccounts,
    #[msg("vault token balance did not move as required")]
    BadFillBalance,
    #[msg("withdraw destination must be the owner's ATA")]
    BadWithdrawDest,
    #[msg("side must be 0 (buy) or 1 (sell)")]
    BadSide,
}
