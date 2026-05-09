use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::errors::ErrorCode;
use crate::state::{ReservationStatus, TurnReservation};

#[derive(Accounts)]
pub struct InitializeReservation<'info> {
    #[account(mut)]
    pub sender: Signer<'info>,

    /// CHECK: The receiver does not need to sign at init time. The pubkey is
    /// recorded on the reservation and is validated on subsequent ixs.
    pub receiver: UncheckedAccount<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = sender_token_account.owner == sender.key(),
        constraint = sender_token_account.mint == mint.key() @ ErrorCode::MintMismatch,
    )]
    pub sender_token_account: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = sender,
        space = TurnReservation::SPACE,
        seeds = [TurnReservation::SEED_PREFIX, receiver.key().as_ref()],
        bump,
    )]
    pub reservation: Account<'info, TurnReservation>,

    #[account(
        init,
        payer = sender,
        seeds = [TurnReservation::VAULT_SEED_PREFIX, reservation.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = reservation,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<InitializeReservation>,
    amount: u64,
    expiry_seconds: i64,
    preferred_merchant: Option<Pubkey>,
) -> Result<()> {
    require!(amount > 0, ErrorCode::InvalidAmount);
    require!(expiry_seconds > 0, ErrorCode::InvalidExpiry);

    let clock = Clock::get()?;
    let expires_at = clock
        .unix_timestamp
        .checked_add(expiry_seconds)
        .ok_or(ErrorCode::NumericOverflow)?;

    let reservation = &mut ctx.accounts.reservation;
    reservation.sender = ctx.accounts.sender.key();
    reservation.receiver = ctx.accounts.receiver.key();
    reservation.merchant = preferred_merchant.unwrap_or_default();
    reservation.mint = ctx.accounts.mint.key();
    reservation.amount = amount;
    reservation.expires_at = expires_at;
    reservation.status = ReservationStatus::Active;
    reservation.bump = ctx.bumps.reservation;
    reservation.vault_bump = ctx.bumps.vault;

    let cpi_accounts = Transfer {
        from: ctx.accounts.sender_token_account.to_account_info(),
        to: ctx.accounts.vault.to_account_info(),
        authority: ctx.accounts.sender.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
    token::transfer(cpi_ctx, amount)?;

    msg!(
        "Reservation initialized: receiver={}, amount={}, expires_at={}",
        reservation.receiver,
        reservation.amount,
        reservation.expires_at
    );

    Ok(())
}
