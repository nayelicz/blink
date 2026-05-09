use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Token, TokenAccount, Transfer};

use crate::errors::ErrorCode;
use crate::state::{ReservationStatus, TurnReservation};

#[derive(Accounts)]
pub struct CancelReservation<'info> {
    /// Either the receiver (anytime) or the sender (post-expiry).
    #[account(mut)]
    pub signer: Signer<'info>,

    /// CHECK: receives lamports from `close = sender`. Validated via has_one.
    #[account(mut)]
    pub sender: UncheckedAccount<'info>,

    #[account(
        mut,
        close = sender,
        seeds = [TurnReservation::SEED_PREFIX, reservation.receiver.as_ref()],
        bump = reservation.bump,
        has_one = sender @ ErrorCode::SenderMismatch,
        has_one = mint @ ErrorCode::MintMismatch,
    )]
    pub reservation: Account<'info, TurnReservation>,

    /// CHECK: validated via `has_one = mint` on the reservation.
    pub mint: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [TurnReservation::VAULT_SEED_PREFIX, reservation.key().as_ref()],
        bump = reservation.vault_bump,
        constraint = vault.mint == reservation.mint @ ErrorCode::MintMismatch,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = sender_token_account.owner == sender.key(),
        constraint = sender_token_account.mint == reservation.mint @ ErrorCode::MintMismatch,
    )]
    pub sender_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<CancelReservation>) -> Result<()> {
    let clock = Clock::get()?;

    {
        let reservation = &ctx.accounts.reservation;
        require!(
            reservation.status == ReservationStatus::Active,
            ErrorCode::ReservationNotActive
        );

        let signer_key = ctx.accounts.signer.key();
        if signer_key == reservation.receiver {
            // Receiver may cancel anytime while Active.
        } else if signer_key == reservation.sender {
            require!(
                clock.unix_timestamp > reservation.expires_at,
                ErrorCode::WaitUntilExpiration
            );
        } else {
            return err!(ErrorCode::UnauthorizedCancellation);
        }
    }

    let amount = ctx.accounts.reservation.amount;
    let receiver_key = ctx.accounts.reservation.receiver;
    let reservation_bump = ctx.accounts.reservation.bump;

    let signer_seeds: &[&[&[u8]]] = &[&[
        TurnReservation::SEED_PREFIX,
        receiver_key.as_ref(),
        std::slice::from_ref(&reservation_bump),
    ]];

    if amount > 0 {
        let cpi_accounts = Transfer {
            from: ctx.accounts.vault.to_account_info(),
            to: ctx.accounts.sender_token_account.to_account_info(),
            authority: ctx.accounts.reservation.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        token::transfer(cpi_ctx, amount)?;
    }

    let close_accounts = CloseAccount {
        account: ctx.accounts.vault.to_account_info(),
        destination: ctx.accounts.sender.to_account_info(),
        authority: ctx.accounts.reservation.to_account_info(),
    };
    let close_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        close_accounts,
        signer_seeds,
    );
    token::close_account(close_ctx)?;

    let reservation = &mut ctx.accounts.reservation;
    reservation.status = ReservationStatus::Cancelled;

    msg!(
        "Reservation cancelled by {} for receiver {} (refunded {} tokens)",
        ctx.accounts.signer.key(),
        receiver_key,
        amount
    );

    Ok(())
}
