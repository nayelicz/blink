use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod instructions;
pub mod state;

pub use instructions::*;

declare_id!("Fprb6jTLfjXfZ6yuWzS7LVXxwVvPbPgPZiEqDEL9bRfj");

#[program]
pub mod remesa_liquidez {
    use super::*;

    /// Sender locks `amount` SPL tokens into a PDA-controlled vault for the
    /// receiver. Optionally pre-selects a merchant; otherwise the merchant
    /// slot is locked-on-claim during `validate_cashout`.
    pub fn initialize_reservation(
        ctx: Context<InitializeReservation>,
        amount: u64,
        expiry_seconds: i64,
        preferred_merchant: Option<Pubkey>,
    ) -> Result<()> {
        instructions::initialize_reservation::handler(
            ctx,
            amount,
            expiry_seconds,
            preferred_merchant,
        )
    }

    /// Records that the receiver has completed off-chain humanity verification
    /// (World ID). Signed by the sender — whose backend integrates with the
    /// World ID API and is therefore the trust anchor for the proof. Once
    /// flipped, `validate_cashout` no longer requires the receiver's signature.
    pub fn mark_verified(ctx: Context<MarkVerified>) -> Result<()> {
        instructions::mark_verified::handler(ctx)
    }

    /// Merchant-only settlement that releases the vault tokens to a whitelisted
    /// merchant. Requires `is_verified == true` (set by `mark_verified`) so the
    /// receiver does not need to sign at the point of sale.
    pub fn validate_cashout(ctx: Context<ValidateCashout>) -> Result<()> {
        instructions::validate_cashout::handler(ctx)
    }

    /// Refund path. Receiver may cancel anytime while Active; sender may only
    /// cancel after `expires_at`.
    pub fn cancel_reservation(ctx: Context<CancelReservation>) -> Result<()> {
        instructions::cancel_reservation::handler(ctx)
    }

    /// Whitelist a merchant pubkey so it can be a counterparty in
    /// `validate_cashout`.
    pub fn register_merchant(ctx: Context<RegisterMerchant>, merchant: Pubkey) -> Result<()> {
        instructions::register_merchant::register_handler(ctx, merchant)
    }

    /// Toggle a merchant's active flag (admin-only).
    pub fn set_merchant_status(ctx: Context<SetMerchantStatus>, active: bool) -> Result<()> {
        instructions::register_merchant::set_status_handler(ctx, active)
    }

    /// One-shot bootstrap: persists the protocol admin pubkey in a singleton
    /// Config PDA. Required before any treasury withdrawal.
    pub fn initialize_config(ctx: Context<InitializeConfig>) -> Result<()> {
        instructions::initialize_config::handler(ctx)
    }

    /// Drain accumulated fees from the per-mint treasury vault. Admin-only.
    pub fn withdraw_treasury(ctx: Context<WithdrawTreasury>, amount: u64) -> Result<()> {
        instructions::withdraw_treasury::handler(ctx, amount)
    }
}
