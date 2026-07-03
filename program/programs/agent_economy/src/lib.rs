use anchor_lang::prelude::*;

declare_id!("6pp5jDS23FBcwtqe8pTiBJw3osyHZQPENr9bK3P62vjt");

#[program]
pub mod agent_economy {
    use super::*;

    /// Creates a SellerProfile PDA for an agent that wants to sell a service.
    /// price_lamports is denominated in the smallest unit of the token used
    /// (6 decimals, so 1 token = 1_000_000).
    pub fn initialize_seller(ctx: Context<InitializeSeller>, price: u64) -> Result<()> {
        let seller = &mut ctx.accounts.seller_profile;
        seller.authority = ctx.accounts.authority.key();
        seller.price = price;
        seller.reputation_score = 0;
        seller.completed_count = 0;
        seller.failed_count = 0;
        seller.total_volume = 0;
        seller.bump = ctx.bumps.seller_profile;
        Ok(())
    }

    /// SECURITY NOTE: this instruction is signed by the BUYER, not the seller.
    /// This is deliberate. A seller cannot be trusted to self-report its own
    /// successful transactions — nothing would stop a seller from controlling
    /// two wallets, paying itself trivial amounts, and inflating its own
    /// reputation with no real counterparty. Requiring the buyer's signature
    /// means an independent party must vouch for the transaction actually
    /// happening. It's not a complete fix (a single actor can still control
    /// both a "buyer" and "seller" wallet — see the build spec's threat-model
    /// notes for further mitigations: counterparty-uniqueness weighting,
    /// bonded stakes, off-chain wash-trading detection) but it raises the bar
    /// from "trivial to fake" to "requires a genuinely separate wallet."
    pub fn record_payment(ctx: Context<RecordPayment>, amount: u64) -> Result<()> {
        let seller = &mut ctx.accounts.seller_profile;
        seller.completed_count = seller.completed_count.checked_add(1).unwrap();
        seller.total_volume = seller.total_volume.checked_add(amount).unwrap();
        seller.reputation_score = compute_reputation(seller.completed_count, seller.failed_count);
        Ok(())
    }

    /// Unlike record_payment, this stays seller-signed. A seller self-reporting
    /// its OWN failures only ever hurts its score — there's no incentive to
    /// fake this, so the self-attestation risk that applies to record_payment
    /// doesn't apply here.
    pub fn record_failure(ctx: Context<RecordFailure>) -> Result<()> {
        let seller = &mut ctx.accounts.seller_profile;
        seller.failed_count = seller.failed_count.checked_add(1).unwrap();
        seller.reputation_score = compute_reputation(seller.completed_count, seller.failed_count);
        Ok(())
    }
}

/// v1 formula: percentage of successful transactions, 0-100.
/// Deliberately simple — no decay, no recency weighting. See build spec.
fn compute_reputation(completed: u64, failed: u64) -> u64 {
    let total = completed + failed;
    if total == 0 {
        return 0;
    }
    completed.saturating_mul(100) / total
}

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
pub struct RecordPayment<'info> {
    /// The buyer signs — see security note on the instruction above. The buyer
    /// pays their own transaction fee for this call, which is a small, real
    /// cost that itself discourages spamming fake reputation updates.
    #[account(mut)]
    pub buyer: Signer<'info>,

    /// The seller's wallet — deliberately NOT a signer here. It's only used
    /// to derive/validate which SellerProfile PDA this update applies to.
    /// CHECK: only used for PDA seed derivation, safe because the seeds+bump
    /// constraint below cryptographically ties this to the one true PDA for
    /// this pubkey — there's no way to pass a mismatched account and have it
    /// validate.
    pub seller: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"seller", seller.key().as_ref()],
        bump = seller_profile.bump,
    )]
    pub seller_profile: Account<'info, SellerProfile>,
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

#[account]
#[derive(InitSpace)]
pub struct SellerProfile {
    pub authority: Pubkey,
    pub price: u64,
    pub reputation_score: u64,
    pub completed_count: u64,
    pub failed_count: u64,
    pub total_volume: u64,
    pub bump: u8,
}
