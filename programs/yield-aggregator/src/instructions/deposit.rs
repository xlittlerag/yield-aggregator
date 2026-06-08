use anchor_lang::prelude::*;
use anchor_spl::token::{
    self, Mint, MintTo, Token, TokenAccount, TransferChecked,
};

use crate::state::YieldVault;
use crate::YieldAggregatorError;

const INITIAL_DEAD_SHARES: u64 = 1_000;

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        has_one = asset_mint,
        has_one = lp_mint
    )]
    pub vault: Box<Account<'info, YieldVault>>,
    #[account(
        seeds = [b"vault_authority", vault.key().as_ref()],
        bump
    )]
    /// CHECK: PDA authority derived from the vault key; it only signs LP mint CPIs.
    pub vault_authority: UncheckedAccount<'info>,
    pub asset_mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub lp_mint: Box<Account<'info, Mint>>,
    #[account(
        mut,
        constraint = user_asset_account.mint == asset_mint.key(),
        constraint = user_asset_account.owner == user.key()
    )]
    pub user_asset_account: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = vault_asset_account.mint == asset_mint.key(),
        constraint = vault_asset_account.owner == vault_authority.key()
    )]
    pub vault_asset_account: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = user_lp_account.mint == lp_mint.key(),
        constraint = user_lp_account.owner == user.key()
    )]
    pub user_lp_account: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = locked_lp_token_account.mint == lp_mint.key(),
        constraint = locked_lp_token_account.owner == vault_authority.key()
    )]
    pub locked_lp_token_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(
        !ctx.accounts.vault.emergency_shutdown,
        YieldAggregatorError::EmergencyShutdown
    );
    require!(
        ctx.accounts.user_asset_account.amount >= amount,
        YieldAggregatorError::InsufficientFunds
    );

    ctx.accounts.vault.total_managed_assets = ctx.accounts.vault_asset_account.amount;
    let current_aum = ctx.accounts.vault.total_managed_assets;
    let current_supply = ctx.accounts.lp_mint.supply;
    let user_shares = if current_supply == 0 {
        require!(amount > INITIAL_DEAD_SHARES, YieldAggregatorError::DepositTooSmall);
        amount
            .checked_sub(INITIAL_DEAD_SHARES)
            .ok_or(YieldAggregatorError::MathOverflow)?
    } else {
        require!(current_aum > 0, YieldAggregatorError::MathOverflow);
        ((amount as u128)
            .checked_mul(current_supply as u128)
            .ok_or(YieldAggregatorError::MathOverflow)?
            / current_aum as u128) as u64
    };

    require!(user_shares > 0, YieldAggregatorError::ZeroShares);

    token::transfer_checked(
        CpiContext::new(
            Token::id(),
            TransferChecked {
                from: ctx.accounts.user_asset_account.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                to: ctx.accounts.vault_asset_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.asset_mint.decimals,
    )?;

    let vault_key = ctx.accounts.vault.key();
    let bump = ctx.bumps.vault_authority;
    let signer_seeds: &[&[u8]] = &[b"vault_authority", vault_key.as_ref(), &[bump]];
    let signer = &[signer_seeds];

    if current_supply == 0 {
        token::mint_to(
            CpiContext::new_with_signer(
                Token::id(),
                MintTo {
                    mint: ctx.accounts.lp_mint.to_account_info(),
                    to: ctx.accounts.locked_lp_token_account.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                signer,
            ),
            INITIAL_DEAD_SHARES,
        )?;
    }

    token::mint_to(
        CpiContext::new_with_signer(
            Token::id(),
            MintTo {
                mint: ctx.accounts.lp_mint.to_account_info(),
                to: ctx.accounts.user_lp_account.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            signer,
        ),
        user_shares,
    )?;

    ctx.accounts.vault.total_managed_assets = ctx
        .accounts
        .vault
        .total_managed_assets
        .checked_add(amount)
        .ok_or(YieldAggregatorError::MathOverflow)?;

    Ok(())
}
