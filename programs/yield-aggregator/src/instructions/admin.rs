use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::state::{AssetStrategy, YieldVault};
use crate::YieldAggregatorError;

#[derive(Accounts)]
#[instruction(name: [u8; 32])]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + YieldVault::LEN)]
    pub vault: Account<'info, YieldVault>,
    #[account(
        seeds = [b"vault_authority", vault.key().as_ref()],
        bump
    )]
    /// CHECK: PDA authority derived from the vault key; it only signs token CPIs.
    pub vault_authority: UncheckedAccount<'info>,
    pub asset_mint: Account<'info, Mint>,
    pub lp_mint: Account<'info, Mint>,
    pub vault_asset_account: Account<'info, TokenAccount>,
    pub locked_lp_token_account: Account<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_initialize_vault(ctx: Context<InitializeVault>, name: [u8; 32]) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.lp_mint.mint_authority.unwrap(),
        ctx.accounts.vault_authority.key(),
        YieldAggregatorError::InvalidMintAuthority
    );
    require_keys_eq!(
        ctx.accounts.vault_asset_account.mint,
        ctx.accounts.asset_mint.key(),
        YieldAggregatorError::InvalidTokenAccount
    );
    require_keys_eq!(
        ctx.accounts.vault_asset_account.owner,
        ctx.accounts.vault_authority.key(),
        YieldAggregatorError::InvalidTokenAccount
    );
    require_keys_eq!(
        ctx.accounts.locked_lp_token_account.mint,
        ctx.accounts.lp_mint.key(),
        YieldAggregatorError::InvalidTokenAccount
    );
    require_keys_eq!(
        ctx.accounts.locked_lp_token_account.owner,
        ctx.accounts.vault_authority.key(),
        YieldAggregatorError::InvalidTokenAccount
    );

    let vault = &mut ctx.accounts.vault;
    vault.admin = ctx.accounts.admin.key();
    vault.name = name;
    vault.asset_mint = ctx.accounts.asset_mint.key();
    vault.lp_mint = ctx.accounts.lp_mint.key();
    vault.total_managed_assets = 0;
    vault.strategy_count = 0;
    vault.last_rebalance_timestamp = 0;
    vault.emergency_shutdown = false;

    Ok(())
}

#[derive(Accounts)]
pub struct SetEmergencyShutdown<'info> {
    pub admin: Signer<'info>,
    #[account(mut)]
    pub vault: Account<'info, YieldVault>,
}

pub fn handle_set_emergency_shutdown(
    ctx: Context<SetEmergencyShutdown>,
    emergency_shutdown: bool,
) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.admin.key(),
        ctx.accounts.vault.admin,
        YieldAggregatorError::Unauthorized
    );
    ctx.accounts.vault.emergency_shutdown = emergency_shutdown;
    Ok(())
}

#[derive(Accounts)]
#[instruction(current_allocation: u64, target_bps: u16, risk_tier: u8)]
pub struct InitializeStrategy<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut)]
    pub vault: Account<'info, YieldVault>,
    #[account(
        init,
        payer = admin,
        space = 8 + AssetStrategy::LEN,
        seeds = [b"strategy", vault.key().as_ref(), protocol_id.key().as_ref()],
        bump
    )]
    pub strategy: Account<'info, AssetStrategy>,
    /// CHECK: Protocol id is an external program/address key used in strategy PDA seeds.
    pub protocol_id: UncheckedAccount<'info>,
    /// CHECK: External strategy escrow is protocol-specific in this TDD scaffold.
    pub token_vault_account: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_strategy(
    ctx: Context<InitializeStrategy>,
    current_allocation: u64,
    target_bps: u16,
    risk_tier: u8,
) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.admin.key(),
        ctx.accounts.vault.admin,
        YieldAggregatorError::Unauthorized
    );
    require!(target_bps <= 10_000, YieldAggregatorError::InvalidTargetBps);

    let strategy = &mut ctx.accounts.strategy;
    strategy.vault = ctx.accounts.vault.key();
    strategy.protocol_id = ctx.accounts.protocol_id.key();
    strategy.token_vault_account = ctx.accounts.token_vault_account.key();
    strategy.current_allocation = current_allocation;
    strategy.target_bps = target_bps;
    strategy.risk_tier = risk_tier;
    strategy.is_active = true;

    ctx.accounts.vault.strategy_count = ctx
        .accounts
        .vault
        .strategy_count
        .checked_add(1)
        .ok_or(YieldAggregatorError::MathOverflow)?;

    Ok(())
}

#[derive(Accounts)]
pub struct SetStrategyActive<'info> {
    pub admin: Signer<'info>,
    pub vault: Account<'info, YieldVault>,
    #[account(mut)]
    pub strategy: Account<'info, AssetStrategy>,
}

pub fn handle_set_strategy_active(ctx: Context<SetStrategyActive>, is_active: bool) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.admin.key(),
        ctx.accounts.vault.admin,
        YieldAggregatorError::Unauthorized
    );
    require_keys_eq!(
        ctx.accounts.strategy.vault,
        ctx.accounts.vault.key(),
        YieldAggregatorError::InvalidStrategyVault
    );
    ctx.accounts.strategy.is_active = is_active;
    Ok(())
}
