# Route402 — Technical Audit (SUMMARY)

*Read-only audit, 2026-07-06. Senior Solana engineer / security reviewer perspective.*
*Program reviewed: `6pp5jDS23FBcwtqe8pTiBJw3osyHZQPENr9bK3P62vjt` (devnet).*

> **Note on the shared reference file:** the audit brief pointed to `~/.claude/SOLANA.md`
> as a conventions/security checklist to diff against. That file does **not exist** on this
> machine (`~/.claude/*.md` — no matches). This audit therefore applies standard Solana /
> Anchor security conventions directly rather than a project-specific checklist. If the
> reference file is expected, its absence is itself worth flagging — a "check against our
> shared standards" gate that silently finds no standards will pass anything.

---

## 1. Architecture and current state (~300 words)

Route402 is a three-tier demo of two AI agents transacting autonomously on Solana devnet
over an x402-style HTTP 402 flow, with on-chain seller reputation.

**On-chain (`program/`)** — a single Anchor 0.30.1 program, `agent_economy`, with one
account type, `SellerProfile` (a PDA seeded `["seller", authority]`). Three instructions:
`initialize_seller` (creates the profile with a price), `record_payment` (buyer-signed;
increments `completed_count` / `total_volume` and recomputes score), and `record_failure`
(seller-signed; increments `failed_count`). Reputation is `completed * 100 / (completed + failed)`.

**Seller backend (`backend/seller/`)** — an Express server. `POST /service` with no proof
returns HTTP 402 plus `paymentRequirements` (price, mint, seller token account, seller
authority pubkey). On retry with a `paymentSignature` it verifies the transfer on devnet via
`getParsedTransaction`, checks destination + amount, dedupes signatures in an in-memory
`Set`, and returns the result. It self-reports failures on-chain but no longer self-reports
successes. `GET /agents` and `GET /events` power the UI.

**Buyer backend (`backend/buyer/`)** — `runPurchase()` does the full loop: fetch 402, send an
SPL token transfer, retry with the signature, then submit the buyer-signed `record_payment`
itself. Exposed via `POST /purchase` for the demo button and a CLI entry point.

**Frontend (`frontend/`)** — static HTML/CSS/JS "highway" visualization, leaderboard, and
live activity feed, polling the seller every 3s. Switches to Render URLs in production.

**State:** deployed to Render free tier (three services), functional end-to-end on devnet.
Uses a project-owned 6-decimal SPL token (`EKFU…ztFC`) rather than a faucet. Keypairs load
from env var or local file. **No test suite exists** despite `Anchor.toml` referencing
`tests/**`. The most recent commit hardened `record_payment` to be buyer-signed; this audit
finds that hardening is incomplete (see §3).

---

## 2. Anchor program review — beyond the documented simplifications

The README already flags: "`record_payment` trusts whoever signs as `authority`." That
description is actually *out of date* — the current code moved `record_payment` to be
**buyer-signed** (commit b561266). The real issues below are **not** in the README.

### 2.1 `record_payment` verifies no payment at all — CRITICAL, undocumented
`record_payment(amount)` takes an arbitrary `amount: u64` and does nothing to prove a payment
occurred. It has no reference to a token transfer, no CPI, no signature, no transaction
introspection. Any account that can sign as `buyer` can call it directly, any number of
times, with any `amount`, and inflate a seller's `completed_count`, `total_volume`, and score.
The on-chain program and the off-chain HTTP verification in `x402.ts` are completely
decoupled — the chain never checks that the thing the seller verified is the thing being
recorded. **The seed script `scripts/seed-agent.ts` is a working demonstration of this
exploit**: it calls `record_payment` in a loop with no real transfers to manufacture history.
The README frames the trust gap as "trusts the authority signer"; the actual gap is that
*reputation is writable by anyone with no payment whatsoever.*

### 2.2 No buyer ≠ seller enforcement — HIGH, partially acknowledged
The instruction comment acknowledges "a single actor can still control both a buyer and
seller wallet." But there is not even a cheap on-chain guard against `buyer.key() ==
seller.key()` — a seller can literally pass its own pubkey as `buyer` and self-vouch in one
transaction. A `require_keys_neq!(buyer.key(), seller.key())` is a one-liner that raises the
floor and is currently absent.

### 2.3 `record_failure` griefing — MEDIUM, undocumented
The README's threat model is entirely about *inflating* reputation. `record_failure` is
seller-signed on the theory that "self-reporting failures only ever hurts you." That's true
for the seller's *own* profile, but combined with §2.1 the score is meaningless anyway.
More importantly there is no rate limiting or cost beyond the tx fee, and the score formula
treats one real completed + zero failures identically to a freshly gamed profile.

### 2.4 `initialize_seller` has no re-init or price-change control — LOW
`price` is set once at init and never used on-chain (the seller backend reads its own config
constant, not the PDA's `price`). It is dead-ish state: written, surfaced in the leaderboard,
but not enforced anywhere. A contributor may reasonably assume price is authoritative — it is
not.

### 2.5 `checked_add(...).unwrap()` panics — LOW
Counters use `checked_add(1).unwrap()`. `unwrap()` panicking is acceptable-ish (aborts the
tx) but `u64` counters realistically never overflow; the bigger issue is `compute_reputation`
uses **unchecked** `completed + failed`, which *can* wrap in debug but saturates fine in
practice. Workspace has no `overflow-checks = true` set in a release profile (there's no
root `Cargo.toml [profile.release]`), so release builds do not trap arithmetic overflow.
Not exploitable at realistic counts, but it's a convention gap.

### 2.6 PDA derivation and constraints — CORRECT
Credit where due: the `seeds + bump` constraints are right. `seller_profile` is tied to
`["seller", seller.key()]` with a stored `bump`, so you cannot pass a mismatched profile.
The `UncheckedAccount` on `seller` is genuinely safe here because it's only a seed input and
the constraint cryptographically binds it. `has_one = authority` on `record_failure` is
correct. This part of the code is sound; the problem is what the instructions *don't* verify,
not their account plumbing.

---

## 3. Payment verification flow — replay, races, malformed proofs

The **off-chain** verification in `x402.ts` / `index.ts` is where real payment checking
happens (the chain does none — see §2.1). Robustness assessment:

- **Replay (documented, but worse than described):** The README says replay protection is
  in-memory and resets on restart. True, and that's the *smallest* problem. Two bigger,
  undocumented ones: **(a)** the check-and-add is not atomic — `seenSignatures.has()` is
  checked at line 71, but `.add()` only happens at line 95, *after* the `await
  verifyPayment()` RPC round-trip. Two concurrent `/service` requests with the same signature
  can both pass the `.has()` check before either adds it, and both get served. **(b)** Even
  with perfect dedupe, a signature is only "used" against *this one seller process*. The
  on-chain `record_payment` has no replay protection at all, so the same real transfer can be
  recorded as reputation any number of times.
- **Payment ↔ request binding: NONE — undocumented and important.** The 402 challenge does
  not include a nonce, memo, or expected buyer. `verifyPayment` accepts *any* transaction
  that transfers ≥ price of the mint to the seller's token account. So: a buyer makes one
  legitimate payment; anyone who observes that signature (it's public on devnet) can replay
  it against a *fresh* seller process (which has an empty `seenSignatures`) to get served for
  free. There is no proof the requester is the payer. A real x402 flow binds the payment to
  the request (nonce/expiry/payer identity).
- **Amount check is `>=`, mint check is skippable:** `amountPaid < SERVICE_PRICE` rejects
  underpayment (good), but overpayment is silently accepted with no refund concept. The mint
  guard is `if (mint && mint !== USDC_MINT) continue` — for a plain `transfer` (not
  `transferChecked`), `info.mint` is `undefined`, so the `mint &&` short-circuits and the
  mint check is **skipped entirely**. A `transfer` of the *wrong* SPL token to the seller's
  ATA would not match destination (ATAs are mint-specific), so this isn't directly
  exploitable today, but the code path is fragile and the intent ("only accept our mint") is
  not actually enforced for the `transfer` variant.
- **Malformed proofs:** handled reasonably — missing tx, `meta.err`, and no-matching-transfer
  all return clean failures. `Number(rawAmount)` risks precision loss above 2^53 base units
  (~9 billion tokens at 6 decimals) — fine for a demo, wrong for large real amounts.
- **Confirmation depth:** `"confirmed"` commitment, not `"finalized"`. On devnet a confirmed
  tx can in principle be dropped by a fork before finalization. For real value you verify at
  `finalized`.

**Bottom line:** the flow is robust enough to *demo* correctly but provides essentially no
security if it saw real value: the chain records reputation without proof, and the off-chain
verifier can be replayed across process restarts and accepts unbound third-party payments.

---

## 4. What a new contributor most needs to know

1. **The chain does not verify payments.** `record_payment` records whatever `amount` you
   pass with no proof. Off-chain HTTP verification (`x402.ts`) and on-chain reputation are
   two unlinked systems. Do not assume the leaderboard reflects real settled money.
2. **`scripts/seed-agent.ts` is intentionally faking history** by calling `record_payment`
   with no transfers. That's fine for a demo but means on-chain counts are partly synthetic.
   The demo agent pubkeys are hardcoded in `frontend/app.js` (`AGENT_NAMES`).
3. **Two config sources for the same constants.** `SERVICE_PRICE`, `USDC_MINT`, `PROGRAM_ID`,
   and `loadKeypair` are duplicated across `backend/seller/src/config.ts`,
   `backend/buyer/src/purchase.ts`, and `init-seller.ts`. Change one, change all. The PDA's
   on-chain `price` field is **not** used by the running code.
4. **The "USDC" mint is a project-owned throwaway token** (`EKFU…ztFC`), 6 decimals, not real
   USDC. You must be its mint authority to get more test supply.
5. **Keypairs load from env var first, file second** (`loadKeypair`). On Render the secret key
   array is set as `SELLER_KEYPAIR_SECRET` / `BUYER_KEYPAIR_SECRET`. Never commit keypair
   files — `.gitignore` covers `*-keypair.json`. (History is clean; verified no keypair was
   ever committed.)
6. **Anchor is pinned to exactly 0.30.1** (`avm use 0.30.1`). The IDL is hand-maintained /
   copied into `backend/seller/src/idl/` *and* `backend/buyer/src/idl/` — two copies that must
   stay in sync with the program.
7. **No tests exist.** `Anchor.toml` references `tests/**/*.ts` but there is no `tests/`
   directory. There is no CI. Verification is manual via the demo button.
8. **Render free tier sleeps after ~15 min.** First request cold-starts for 10–30s; the
   frontend and README both call this out. Replay dedupe state is lost on every cold start
   (see §3).
9. **Frontend uses `innerHTML` with on-chain-derived strings.** Pubkeys and display names are
   interpolated into `innerHTML` in several places; low risk today (pubkeys are constrained
   charsets) but not a safe pattern if any user-controlled string ever reaches it.
10. **Untracked working files exist:** `seed-agent-v2.ts`, `seed-agent-WITH-DELAYS-v2.ts` at
    repo root, and `backend/seller/scripts/` — near-duplicates of the committed seed script.
    Clean these up before they rot.
