use anchor_lang::prelude::*;

pub mod state;
pub mod instructions;

pub use instructions::*;

declare_id!("HvHVy1TS84syBJ6aFGRUUn7Q9txtDuvbKzEitaPkAjxp");

#[program]
pub mod yield_aggregator {
    use super::*;

    pub fn initialize_vault(ctx: Context<InitializeVault>, name: [u8; 32]) -> Result<()> {
        instructions::admin::handle_initialize_vault(ctx, name)
    }

    pub fn set_emergency_shutdown(
        ctx: Context<SetEmergencyShutdown>,
        emergency_shutdown: bool,
    ) -> Result<()> {
        instructions::admin::handle_set_emergency_shutdown(ctx, emergency_shutdown)
    }

    pub fn initialize_strategy(
        ctx: Context<InitializeStrategy>,
        current_allocation: u64,
        target_bps: u16,
        risk_tier: u8,
    ) -> Result<()> {
        instructions::admin::handle_initialize_strategy(
            ctx,
            current_allocation,
            target_bps,
            risk_tier,
        )
    }

    pub fn set_strategy_active(ctx: Context<SetStrategyActive>, is_active: bool) -> Result<()> {
        instructions::admin::handle_set_strategy_active(ctx, is_active)
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        instructions::deposit::handle_deposit(ctx, amount)
    }

    pub fn rebalance(ctx: Context<Rebalance>) -> Result<()> {
        instructions::rebalance::handle_rebalance(ctx)
    }
}

#[error_code]
pub enum YieldAggregatorError {
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("EmergencyShutdown")]
    EmergencyShutdown,
    #[msg("DepositTooSmall")]
    DepositTooSmall,
    #[msg("InsufficientFunds")]
    InsufficientFunds,
    #[msg("MathOverflow")]
    MathOverflow,
    #[msg("InvalidMintAuthority")]
    InvalidMintAuthority,
    #[msg("InvalidTokenAccount")]
    InvalidTokenAccount,
    #[msg("InvalidTargetBps")]
    InvalidTargetBps,
    #[msg("RebalanceCooldown")]
    RebalanceCooldown,
    #[msg("InactiveStrategy")]
    InactiveStrategy,
    #[msg("InvalidStrategyVault")]
    InvalidStrategyVault,
    #[msg("NoRebalanceNeeded")]
    NoRebalanceNeeded,
}
