use anchor_lang::prelude::*;

use crate::errors::ErrorCode;
use crate::state::MerchantAccount;

#[derive(Accounts)]
#[instruction(merchant: Pubkey)]
pub struct RegisterMerchant<'info> {
    /// Admin paying for the whitelist account creation. In a production
    /// deployment this should be gated by a Config PDA / multisig; for the
    /// MVP we trust the first account that registers a given merchant.
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = MerchantAccount::SPACE,
        seeds = [MerchantAccount::SEED_PREFIX, merchant.as_ref()],
        bump,
    )]
    pub merchant_account: Account<'info, MerchantAccount>,

    pub system_program: Program<'info, System>,
}

pub fn register_handler(ctx: Context<RegisterMerchant>, merchant: Pubkey) -> Result<()> {
    let acc = &mut ctx.accounts.merchant_account;
    acc.merchant = merchant;
    acc.admin = ctx.accounts.admin.key();
    acc.active = true;
    acc.bump = ctx.bumps.merchant_account;
    msg!("Merchant registered: {}", merchant);
    Ok(())
}

#[derive(Accounts)]
pub struct SetMerchantStatus<'info> {
    #[account(mut, constraint = admin.key() == merchant_account.admin @ ErrorCode::UnauthorizedCancellation)]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [MerchantAccount::SEED_PREFIX, merchant_account.merchant.as_ref()],
        bump = merchant_account.bump,
    )]
    pub merchant_account: Account<'info, MerchantAccount>,
}

pub fn set_status_handler(ctx: Context<SetMerchantStatus>, active: bool) -> Result<()> {
    ctx.accounts.merchant_account.active = active;
    msg!(
        "Merchant {} active flag set to {}",
        ctx.accounts.merchant_account.merchant,
        active
    );
    Ok(())
}
