use anchor_lang::prelude::*;

use crate::state::{AssetStrategy, YieldVault};
use crate::YieldAggregatorError;

const REBALANCE_COOLDOWN_SECONDS: i64 = 60;

#[derive(Accounts)]
pub struct Rebalance<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut)]
    pub vault: Account<'info, YieldVault>,
    #[account(mut)]
    pub from_strategy: Account<'info, AssetStrategy>,
    #[account(mut)]
    pub to_strategy: Account<'info, AssetStrategy>,
}

pub fn handle_rebalance(ctx: Context<Rebalance>) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.admin.key(),
        ctx.accounts.vault.admin,
        YieldAggregatorError::Unauthorized
    );
    require_keys_eq!(
        ctx.accounts.from_strategy.vault,
        ctx.accounts.vault.key(),
        YieldAggregatorError::InvalidStrategyVault
    );
    require_keys_eq!(
        ctx.accounts.to_strategy.vault,
        ctx.accounts.vault.key(),
        YieldAggregatorError::InvalidStrategyVault
    );
    require!(
        ctx.accounts.from_strategy.is_active && ctx.accounts.to_strategy.is_active,
        YieldAggregatorError::InactiveStrategy
    );

    let now = Clock::get()?.unix_timestamp;
    if ctx.accounts.vault.last_rebalance_timestamp != 0 {
        require!(
            now - ctx.accounts.vault.last_rebalance_timestamp >= REBALANCE_COOLDOWN_SECONDS,
            YieldAggregatorError::RebalanceCooldown
        );
    }

    let total_assets = ctx.accounts.vault.total_managed_assets as u128;
    let from_target =
        total_assets * ctx.accounts.from_strategy.target_bps as u128 / 10_000_u128;
    let to_target = total_assets * ctx.accounts.to_strategy.target_bps as u128 / 10_000_u128;

    let from_current = ctx.accounts.from_strategy.current_allocation as u128;
    let to_current = ctx.accounts.to_strategy.current_allocation as u128;

    require!(
        from_current > from_target && to_current < to_target,
        YieldAggregatorError::NoRebalanceNeeded
    );

    let from_excess = from_current
        .checked_sub(from_target)
        .ok_or(YieldAggregatorError::MathOverflow)?;
    let to_deficit = to_target
        .checked_sub(to_current)
        .ok_or(YieldAggregatorError::MathOverflow)?;
    let rebalance_amount = from_excess.min(to_deficit);
    require!(rebalance_amount > 0, YieldAggregatorError::NoRebalanceNeeded);

    let amount = u64::try_from(rebalance_amount).map_err(|_| YieldAggregatorError::MathOverflow)?;
    ctx.accounts.from_strategy.current_allocation = ctx
        .accounts
        .from_strategy
        .current_allocation
        .checked_sub(amount)
        .ok_or(YieldAggregatorError::MathOverflow)?;
    ctx.accounts.to_strategy.current_allocation = ctx
        .accounts
        .to_strategy
        .current_allocation
        .checked_add(amount)
        .ok_or(YieldAggregatorError::MathOverflow)?;
    ctx.accounts.vault.last_rebalance_timestamp = now;

    Ok(())
}
