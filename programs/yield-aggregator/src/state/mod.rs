use anchor_lang::prelude::*;

#[account]
pub struct YieldVault {
    pub admin: Pubkey,                 // Governance or keeper authority
    pub name: [u8; 32],                // Human-readable identifier
    pub asset_mint: Pubkey,            // Underlying token mint address (e.g., USDC)
    pub lp_mint: Pubkey,               // Mint address for vault shares issued to depositors
    pub total_managed_assets: u64,     // Total AUM (Requires syncing prior to vault actions)
    pub strategy_count: u8,            // Total number of authorized strategies
    pub last_rebalance_timestamp: i64, // Cooldown tracker to mitigate flash-loan arbitrage
    pub emergency_shutdown: bool,      // Circuit breaker to halt deposits/withdrawals
}

impl YieldVault {
    pub const LEN: usize = 32 + 32 + 32 + 32 + 8 + 1 + 8 + 1;
}

#[account]
pub struct AssetStrategy {
    pub vault: Pubkey,                 // Parent vault authority
    pub protocol_id: Pubkey,           // Target program ID (e.g., Kamino, Marginfi)
    pub token_vault_account: Pubkey,   // Protocol-specific escrow holding the funds
    pub current_allocation: u64,       // Active capital deployed in this specific protocol
    pub target_bps: u16,               // Target allocation in basis points (e.g., 4000 = 40.00%)
    pub risk_tier: u8,                 // Asset Class: 1 (Low), 2 (Medium), 3 (High)
    pub is_active: bool,               // Status flag for deposit eligibility
}

impl AssetStrategy {
    pub const LEN: usize = 32 + 32 + 32 + 8 + 2 + 1 + 1;
}
