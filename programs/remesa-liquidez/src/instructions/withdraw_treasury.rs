use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::constants::{TREASURY_AUTHORITY_SEED, TREASURY_VAULT_SEED};
use crate::errors::ErrorCode;
use crate::state::Config;

/// Drain accumulated fees for a given mint from the treasury vault to a
/// destination token account chosen by the admin (e.g. a Squads multisig).
#[derive(Accounts)]
pub struct WithdrawTreasury<'info> {
    /// Must match `config.admin`.
    pub admin: Signer<'info>,

    #[account(
        seeds = [Config::SEED_PREFIX],
        bump = config.bump,
        constraint = config.admin == admin.key() @ ErrorCode::UnauthorizedAdmin,
    )]
    pub config: Account<'info, Config>,

    pub mint: Box<Account<'info, Mint>>,

    /// CHECK: PDA validated by seeds; signs the CPI via reservation seeds.
    #[account(
        seeds = [TREASURY_AUTHORITY_SEED],
        bump,
    )]
    pub treasury_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [TREASURY_VAULT_SEED, mint.key().as_ref()],
        bump,
        constraint = treasury_token_account.mint == mint.key() @ ErrorCode::MintMismatch,
    )]
    pub treasury_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = destination_token_account.mint == mint.key() @ ErrorCode::MintMismatch,
    )]
    pub destination_token_account: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<WithdrawTreasury>, amount: u64) -> Result<()> {
    require!(amount > 0, ErrorCode::InvalidAmount);
    require!(
        ctx.accounts.treasury_token_account.amount >= amount,
        ErrorCode::InsufficientTreasury
    );

    let treasury_bump = ctx.bumps.treasury_authority;
    let signer_seeds: &[&[&[u8]]] = &[&[
        TREASURY_AUTHORITY_SEED,
        std::slice::from_ref(&treasury_bump),
    ]];

    let cpi_accounts = Transfer {
        from: ctx.accounts.treasury_token_account.to_account_info(),
        to: ctx.accounts.destination_token_account.to_account_info(),
        authority: ctx.accounts.treasury_authority.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        cpi_accounts,
        signer_seeds,
    );
    token::transfer(cpi_ctx, amount)?;

    msg!(
        "Treasury withdrawal: mint={}, amount={}, destination={}",
        ctx.accounts.mint.key(),
        amount,
        ctx.accounts.destination_token_account.key()
    );

    Ok(())
}
