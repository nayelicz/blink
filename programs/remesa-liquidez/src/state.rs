use anchor_lang::prelude::*;

/// Lifecycle of a turn-based remittance reservation.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum ReservationStatus {
    Active,
    Completed,
    Cancelled,
}

/// Escrow record that bridges a digital remittance with a physical cash-out.
///
/// PDA seeds: `[b"reservation", receiver.key().as_ref()]`. This implies a
/// single active reservation per receiver at a time, which is the "turn"
/// abstraction the program is named after.
#[account]
#[derive(Debug)]
pub struct TurnReservation {
    /// Funder of the remittance (pays the SPL tokens, also pays rent).
    pub sender: Pubkey,
    /// World-ID-bound recipient that will collect cash at the merchant.
    pub receiver: Pubkey,
    /// Locked merchant pubkey. `Pubkey::default()` means the slot is open and
    /// will be locked-on-claim during `validate_cashout`.
    pub merchant: Pubkey,
    /// SPL mint backing the escrow (USDC, MXNe, etc.).
    pub mint: Pubkey,
    /// Tokens held in escrow.
    pub amount: u64,
    /// Unix timestamp after which the sender may cancel.
    pub expires_at: i64,
    /// Off-chain humanity verification flag (e.g. World ID). When true, the
    /// receiver no longer needs to sign at the merchant's point of sale.
    /// Flipped by `mark_verified` after the sender's backend validates the
    /// World ID proof.
    pub is_verified: bool,
    /// Lifecycle status.
    pub status: ReservationStatus,
    /// Bump for the reservation PDA.
    pub bump: u8,
    /// Bump for the vault token account PDA.
    pub vault_bump: u8,
}

impl TurnReservation {
    /// 8 (disc) + 32*4 (pubkeys) + 8 (amount) + 8 (expires_at)
    /// + 1 (is_verified) + 1 (status) + 1 (bump) + 1 (vault_bump).
    pub const SPACE: usize = 8 + 32 * 4 + 8 + 8 + 1 + 1 + 1 + 1;

    pub const SEED_PREFIX: &'static [u8] = b"reservation";
    pub const VAULT_SEED_PREFIX: &'static [u8] = b"vault";
}

/// Whitelist entry that authorizes a merchant pubkey to settle reservations.
///
/// PDA seeds: `[b"merchant", merchant.key().as_ref()]`.
#[account]
#[derive(Debug)]
pub struct MerchantAccount {
    pub merchant: Pubkey,
    pub admin: Pubkey,
    pub active: bool,
    pub bump: u8,
}

impl MerchantAccount {
    /// 8 (disc) + 32 + 32 + 1 + 1.
    pub const SPACE: usize = 8 + 32 + 32 + 1 + 1;

    pub const SEED_PREFIX: &'static [u8] = b"merchant";
}

/// Singleton governance account that owns the protocol treasury. Its pubkey
/// is `[CONFIG_SEED]`. The `admin` is the only account allowed to drain the
/// per-mint treasury vaults via `withdraw_treasury`.
#[account]
#[derive(Debug)]
pub struct Config {
    pub admin: Pubkey,
    pub bump: u8,
}

impl Config {
    /// 8 (disc) + 32 (admin) + 1 (bump).
    pub const SPACE: usize = 8 + 32 + 1;

    pub const SEED_PREFIX: &'static [u8] = b"config";
}
