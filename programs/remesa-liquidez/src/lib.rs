use anchor_lang::prelude::*;

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

    /// Co-signed (receiver + merchant) settlement that releases the vault
    /// tokens to a whitelisted merchant after physical cash delivery.
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
}
