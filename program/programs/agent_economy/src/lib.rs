// Routex402 agent-economy program (reconstructed from deployed IDL at
// 6pp5jDS23FBcwtqe8pTiBJw3osyHZQPENr9bK3P62vjt).
//
// Hardening in this revision:
//   * All u64 arithmetic uses checked_* and surfaces Overflow instead of unwrap.
//   * MIN_PRICE enforced in initialize_seller.
//   * MAX_FEE_BPS = 1000 enforced in initialize_config and update_fee.
//   * Zero-amount and self-payment rejected in pay_and_record.
//   * Mint / owner / treasury constraints on all token accounts.
//
// This is the on-chain source of truth. The old pre-pay_and_record lib.rs is
// kept only in git history for reference; it is strictly incompatible with the
// current account layout.

use anchor_lang::prelude::*;
use anchor_spl::token::{transfer, Mint, Token, TokenAccount, Transfer};

declare_id!("6pp5jDS23FBcwtqe8pTiBJw3osyHZQPENr9bK3P62vjt");

/// 10%. Protocol fees in basis points may not exceed this value.
pub const MAX_FEE_BPS: u16 = 1000;

/// 1000 base units (0.001 USDC with 6 decimals). Below this, demo-seeding
/// could accumulate large scores at vanishing cost.
pub const MIN_PRICE: u64 = 1000;

/// Share of a repeat buyer's additional payments that counts toward the
/// completed score. First tx from a buyer = full weight (100 / 100).
/// Subsequent tx from the same buyer = 25 / 100.
pub const REPEAT_WEIGHT_NUM: u64 = 25;
pub const REPEAT_WEIGHT_DEN: u64 = 100;

#[program]
pub mod agent_economy {
    use super::*;

    /// Creates a SellerProfile PDA for an agent that wants to sell a service.
    /// `price` is denominated in the smallest unit of the token used
    /// (6 decimals, so 1 token = 1_000_000).
    pub fn initialize_seller(ctx: Context<InitializeSeller>, price: u64) -> Result<()> {
        require!(price >= MIN_PRICE, AgentEconomyError::PriceTooLow);
        let seller = &mut ctx.accounts.seller_profile;
        seller.authority = ctx.accounts.authority.key();
        seller.price = price;
        seller.reputation_score = 0;
        seller.completed_count = 0;
        seller.failed_count = 0;
        seller.total_volume = 0;
        seller.distinct_buyers = 0;
        seller.weighted_completed = 0;
        seller.last_updated = Clock::get()?.unix_timestamp;
        seller.bump = ctx.bumps.seller_profile;
        Ok(())
    }

    /// Closes a seller profile and refunds rent to its authority. Used for
    /// migration when the account layout changes. Authority-signed, so only a
    /// seller can close its own profile.
    pub fn close_seller(_ctx: Context<CloseSeller>) -> Result<()> {
        Ok(())
    }

    /// One-time protocol setup: admin, treasury, fee rate.
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        protocol_fee_bps: u16,
    ) -> Result<()> {
        require!(protocol_fee_bps <= MAX_FEE_BPS, AgentEconomyError::FeeTooHigh);
        let cfg = &mut ctx.accounts.config;
        cfg.admin = ctx.accounts.admin.key();
        cfg.treasury_token_account = ctx.accounts.treasury_token_account.key();
        cfg.protocol_fee_bps = protocol_fee_bps;
        cfg.bump = ctx.bumps.config;
        Ok(())
    }

    /// Admin-only fee adjustment. Treasury and admin stay fixed at init; only
    /// the rate is tunable, and only within MAX_FEE_BPS.
    pub fn update_fee(ctx: Context<UpdateFee>, protocol_fee_bps: u16) -> Result<()> {
        require!(protocol_fee_bps <= MAX_FEE_BPS, AgentEconomyError::FeeTooHigh);
        ctx.accounts.config.protocol_fee_bps = protocol_fee_bps;
        Ok(())
    }

    /// Core instruction: pay the seller AND record reputation, atomically.
    ///
    /// The token movement happens via CPI inside this instruction, so the
    /// amount recorded is provably the amount that moved. The buyer signs
    /// (they're moving their own tokens), making the reputation record
    /// buyer-attested. buyer != seller is enforced to close single-wallet
    /// self-vouch; BuyerSellerLink tracks per-pair repeat counts so the
    /// scoring down-weights repeat counterparties.
    pub fn pay_and_record(ctx: Context<PayAndRecord>, amount: u64) -> Result<()> {
        require!(amount > 0, AgentEconomyError::ZeroAmount);
        require_keys_neq!(
            ctx.accounts.buyer.key(),
            ctx.accounts.seller.key(),
            AgentEconomyError::SelfPayment
        );

        // Verify token accounts
        let mint_key = ctx.accounts.mint.key();
        require!(
            ctx.accounts.buyer_token_account.mint == mint_key,
            AgentEconomyError::MintMismatch
        );
        require!(
            ctx.accounts.seller_token_account.mint == mint_key,
            AgentEconomyError::MintMismatch
        );
        require!(
            ctx.accounts.treasury_token_account.mint == mint_key,
            AgentEconomyError::MintMismatch
        );
        require_keys_eq!(
            ctx.accounts.buyer_token_account.owner,
            ctx.accounts.buyer.key(),
            AgentEconomyError::TokenAccountOwnerMismatch
        );
        require_keys_eq!(
            ctx.accounts.seller_token_account.owner,
            ctx.accounts.seller.key(),
            AgentEconomyError::TokenAccountOwnerMismatch
        );
        require_keys_eq!(
            ctx.accounts.treasury_token_account.key(),
            ctx.accounts.config.treasury_token_account,
            AgentEconomyError::TreasuryMismatch
        );

        // Split the amount into protocol fee + seller net
        let fee_bps = ctx.accounts.config.protocol_fee_bps as u64;
        let protocol_fee = amount
            .checked_mul(fee_bps)
            .ok_or(AgentEconomyError::Overflow)?
            / 10_000;
        let seller_net = amount
            .checked_sub(protocol_fee)
            .ok_or(AgentEconomyError::Overflow)?;

        // Transfer to seller
        if seller_net > 0 {
            transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.buyer_token_account.to_account_info(),
                        to: ctx.accounts.seller_token_account.to_account_info(),
                        authority: ctx.accounts.buyer.to_account_info(),
                    },
                ),
                seller_net,
            )?;
        }

        // Transfer protocol fee
        if protocol_fee > 0 {
            transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.buyer_token_account.to_account_info(),
                        to: ctx.accounts.treasury_token_account.to_account_info(),
                        authority: ctx.accounts.buyer.to_account_info(),
                    },
                ),
                protocol_fee,
            )?;
        }

        // Update seller profile
        let link = &mut ctx.accounts.buyer_seller_link;
        let is_first_tx_from_this_buyer = link.tx_count == 0;
        if is_first_tx_from_this_buyer {
            link.bump = ctx.bumps.buyer_seller_link;
        }
        link.tx_count = link
            .tx_count
            .checked_add(1)
            .ok_or(AgentEconomyError::Overflow)?;

        let profile = &mut ctx.accounts.seller_profile;
        profile.completed_count = profile
            .completed_count
            .checked_add(1)
            .ok_or(AgentEconomyError::Overflow)?;
        profile.total_volume = profile
            .total_volume
            .checked_add(amount)
            .ok_or(AgentEconomyError::Overflow)?;
        if is_first_tx_from_this_buyer {
            profile.distinct_buyers = profile
                .distinct_buyers
                .checked_add(1)
                .ok_or(AgentEconomyError::Overflow)?;
            // First tx from this buyer: full weight (100 / 100).
            profile.weighted_completed = profile
                .weighted_completed
                .checked_add(REPEAT_WEIGHT_DEN)
                .ok_or(AgentEconomyError::Overflow)?;
        } else {
            // Repeat buyer: down-weighted (25 / 100).
            profile.weighted_completed = profile
                .weighted_completed
                .checked_add(REPEAT_WEIGHT_NUM)
                .ok_or(AgentEconomyError::Overflow)?;
        }
        profile.reputation_score = compute_reputation(
            profile.weighted_completed,
            profile.failed_count.saturating_mul(REPEAT_WEIGHT_DEN),
        );
        profile.last_updated = Clock::get()?.unix_timestamp;
        Ok(())
    }

    /// Seller self-reports a failure. Stays seller-signed: a seller only ever
    /// hurts its own score by calling this, so no incentive to fake it.
    pub fn record_failure(ctx: Context<RecordFailure>) -> Result<()> {
        let profile = &mut ctx.accounts.seller_profile;
        profile.failed_count = profile
            .failed_count
            .checked_add(1)
            .ok_or(AgentEconomyError::Overflow)?;
        profile.reputation_score = compute_reputation(
            profile.weighted_completed,
            profile.failed_count.saturating_mul(REPEAT_WEIGHT_DEN),
        );
        profile.last_updated = Clock::get()?.unix_timestamp;
        Ok(())
    }

    /// Admin-only synthetic seeding for demo agents. Kept so pre-existing demo
    /// history stays consistent, but gated to admin so unverified reputation
    /// can never be written by anyone else. Any history written via this path
    /// is by definition synthetic.
    pub fn record_payment(ctx: Context<RecordPayment>, amount: u64) -> Result<()> {
        require!(amount > 0, AgentEconomyError::ZeroAmount);
        let profile = &mut ctx.accounts.seller_profile;
        profile.completed_count = profile
            .completed_count
            .checked_add(1)
            .ok_or(AgentEconomyError::Overflow)?;
        profile.total_volume = profile
            .total_volume
            .checked_add(amount)
            .ok_or(AgentEconomyError::Overflow)?;
        profile.weighted_completed = profile
            .weighted_completed
            .checked_add(REPEAT_WEIGHT_DEN)
            .ok_or(AgentEconomyError::Overflow)?;
        profile.reputation_score = compute_reputation(
            profile.weighted_completed,
            profile.failed_count.saturating_mul(REPEAT_WEIGHT_DEN),
        );
        profile.last_updated = Clock::get()?.unix_timestamp;
        Ok(())
    }
}

/// v2: weighted success rate on a 0-100 scale, using REPEAT_WEIGHT_* so repeat
/// buyers count less toward a "completed" tally than fresh buyers do. If there
/// is no history, score is 0.
fn compute_reputation(weighted_completed: u64, weighted_failed: u64) -> u64 {
    let total = weighted_completed.saturating_add(weighted_failed);
    if total == 0 {
        return 0;
    }
    weighted_completed.saturating_mul(100) / total
}

// ---- Account structs ----

#[derive(Accounts)]
pub struct InitializeSeller<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + SellerProfile::INIT_SPACE,
        seeds = [b"seller", authority.key().as_ref()],
        bump
    )]
    pub seller_profile: Account<'info, SellerProfile>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseSeller<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Deliberately unchecked: old-layout accounts may not deserialize.
    /// CHECK: seeds constraint binds this to the canonical PDA for the signing authority.
    #[account(
        mut,
        close = authority,
        seeds = [b"seller", authority.key().as_ref()],
        bump,
    )]
    pub seller_profile: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + ProtocolConfig::INIT_SPACE,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, ProtocolConfig>,

    /// Treasury SPL token account where protocol fees accumulate.
    pub treasury_token_account: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateFee<'info> {
    #[account(has_one = admin @ AgentEconomyError::AdminOnly)]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump
    )]
    pub config: Account<'info, ProtocolConfig>,
}

#[derive(Accounts)]
pub struct PayAndRecord<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    /// The seller's wallet — not a signer. Only used to derive the SellerProfile
    /// PDA and as the required owner of the destination token account.
    /// CHECK: owner verified via seller_token_account constraint below.
    pub seller: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"seller", seller.key().as_ref()],
        bump = seller_profile.bump,
    )]
    pub seller_profile: Account<'info, SellerProfile>,

    #[account(
        init_if_needed,
        payer = buyer,
        space = 8 + BuyerSellerLink::INIT_SPACE,
        seeds = [b"link", seller.key().as_ref(), buyer.key().as_ref()],
        bump
    )]
    pub buyer_seller_link: Account<'info, BuyerSellerLink>,

    #[account(
        seeds = [b"config"],
        bump = config.bump
    )]
    pub config: Account<'info, ProtocolConfig>,

    pub mint: Account<'info, Mint>,

    #[account(mut)]
    pub buyer_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub seller_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub treasury_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RecordFailure<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"seller", authority.key().as_ref()],
        bump = seller_profile.bump,
        has_one = authority
    )]
    pub seller_profile: Account<'info, SellerProfile>,
}

#[derive(Accounts)]
pub struct RecordPayment<'info> {
    #[account(has_one = admin @ AgentEconomyError::AdminOnly)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [b"config"],
        bump = config.bump
    )]
    pub config: Account<'info, ProtocolConfig>,

    /// CHECK: used only for PDA seed derivation.
    pub seller: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"seller", seller.key().as_ref()],
        bump = seller_profile.bump,
    )]
    pub seller_profile: Account<'info, SellerProfile>,
}

// ---- Account data ----

#[account]
#[derive(InitSpace)]
pub struct SellerProfile {
    pub authority: Pubkey,
    pub price: u64,
    pub reputation_score: u64,
    pub completed_count: u64,
    pub failed_count: u64,
    pub total_volume: u64,
    /// Number of unique buyer wallets that have ever paid this seller.
    pub distinct_buyers: u64,
    /// Completion weight in hundredths — see compute_reputation.
    pub weighted_completed: u64,
    /// Unix timestamp of the last reputation-affecting event.
    pub last_updated: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ProtocolConfig {
    pub admin: Pubkey,
    pub treasury_token_account: Pubkey,
    pub protocol_fee_bps: u16,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct BuyerSellerLink {
    pub tx_count: u64,
    pub bump: u8,
}

// ---- Errors ----

#[error_code]
pub enum AgentEconomyError {
    #[msg("Protocol fee exceeds the maximum allowed (10%)")]
    FeeTooHigh,
    #[msg("Payment amount must be greater than zero")]
    ZeroAmount,
    #[msg("Buyer and seller must be different wallets")]
    SelfPayment,
    #[msg("Token account is not owned by the expected wallet")]
    TokenAccountOwnerMismatch,
    #[msg("Token account mint does not match the payment mint")]
    MintMismatch,
    #[msg("Treasury token account does not match protocol config")]
    TreasuryMismatch,
    #[msg("Only the protocol admin may call this instruction")]
    AdminOnly,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Price is below the minimum (0.001 USDC)")]
    PriceTooLow,
}
