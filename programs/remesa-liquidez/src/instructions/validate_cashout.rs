use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::ErrorCode;
use crate::state::{MerchantAccount, ReservationStatus, TurnReservation};

#[derive(Accounts)]
pub struct ValidateCashout<'info> {
    /// World-ID-bound recipient. Must co-sign to authorize the cash-out.
    pub receiver: Signer<'info>,

    /// Merchant providing physical liquidity. Must co-sign.
    #[account(mut)]
    pub merchant: Signer<'info>,

    #[account(
        seeds = [MerchantAccount::SEED_PREFIX, merchant.key().as_ref()],
        bump = merchant_whitelist.bump,
        constraint = merchant_whitelist.merchant == merchant.key() @ ErrorCode::InvalidMerchant,
    )]
    pub merchant_whitelist: Account<'info, MerchantAccount>,

    #[account(
        mut,
        seeds = [TurnReservation::SEED_PREFIX, reservation.receiver.as_ref()],
        bump = reservation.bump,
        has_one = receiver @ ErrorCode::ReceiverMismatch,
        has_one = mint @ ErrorCode::MintMismatch,
    )]
    pub reservation: Account<'info, TurnReservation>,

    /// CHECK: validated via the `has_one = mint` constraint on `reservation`.
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
        constraint = merchant_token_account.owner == merchant.key(),
        constraint = merchant_token_account.mint == reservation.mint @ ErrorCode::MintMismatch,
    )]
    pub merchant_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<ValidateCashout>) -> Result<()> {
    let clock = Clock::get()?;

    require!(
        ctx.accounts.merchant_whitelist.active,
        ErrorCode::InvalidMerchant
    );

    {
        let reservation = &ctx.accounts.reservation;
        require!(
            reservation.status == ReservationStatus::Active,
            ErrorCode::ReservationNotActive
        );
        require!(
            clock.unix_timestamp < reservation.expires_at,
            ErrorCode::ReservationExpired
        );

        if reservation.merchant != Pubkey::default() {
            require_keys_eq!(
                reservation.merchant,
                ctx.accounts.merchant.key(),
                ErrorCode::InvalidMerchant
            );
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

    let cpi_accounts = Transfer {
        from: ctx.accounts.vault.to_account_info(),
        to: ctx.accounts.merchant_token_account.to_account_info(),
        authority: ctx.accounts.reservation.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        cpi_accounts,
        signer_seeds,
    );
    token::transfer(cpi_ctx, amount)?;

    let reservation = &mut ctx.accounts.reservation;
    reservation.merchant = ctx.accounts.merchant.key();
    reservation.status = ReservationStatus::Completed;

    msg!(
        "Cashout validated: receiver={}, merchant={}, amount={}",
        reservation.receiver,
        reservation.merchant,
        amount
    );

    Ok(())
}
