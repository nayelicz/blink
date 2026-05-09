use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Reservation is not in Active status")]
    ReservationNotActive,
    #[msg("Merchant is not whitelisted or does not match the locked merchant")]
    InvalidMerchant,
    #[msg("Reservation has already expired")]
    ReservationExpired,
    #[msg("Caller is not authorized to cancel this reservation")]
    UnauthorizedCancellation,
    #[msg("Sender must wait until expiration to cancel")]
    WaitUntilExpiration,
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Expiry duration is invalid")]
    InvalidExpiry,
    #[msg("Provided sender does not match the reservation sender")]
    SenderMismatch,
    #[msg("Provided receiver does not match the reservation receiver")]
    ReceiverMismatch,
    #[msg("Provided mint does not match the reservation mint")]
    MintMismatch,
    #[msg("Numeric overflow")]
    NumericOverflow,
}
