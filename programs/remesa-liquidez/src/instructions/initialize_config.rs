use anchor_lang::prelude::*;

use crate::state::Config;

/// One-shot bootstrap that records the protocol admin pubkey. The first caller
/// becomes the admin; subsequent calls fail because the PDA is already
/// initialized.
#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = Config::SPACE,
        seeds = [Config::SEED_PREFIX],
        bump,
    )]
    pub config: Account<'info, Config>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeConfig>) -> Result<()> {
    let cfg = &mut ctx.accounts.config;
    cfg.admin = ctx.accounts.admin.key();
    cfg.bump = ctx.bumps.config;
    msg!("Protocol Config initialized. Admin = {}", cfg.admin);
    Ok(())
}
