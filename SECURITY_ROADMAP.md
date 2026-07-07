# Route402 — Production-Readiness & Security Roadmap

*Read-only audit, 2026-07-06. This is a hackathon devnet build; the goal here is a staged
path toward production-safe, not an immediate mainnet plan.*

---

## Part 2 — Production-readiness path

### 1. Known simplifications, ranked by actual risk if this saw real value

Ranking blends the README's stated simplifications with the undocumented findings from the
audit (SUMMARY §2–§3), because the biggest risks are the ones the README does *not* list.

| # | Risk | Severity if real value flows | Documented? |
|---|------|------------------------------|-------------|
| 1 | **`record_payment` records reputation with no proof of payment** | Critical | No |
| 2 | **No payment↔request binding** (any observed signature replays to a fresh seller process; requester ≠ payer) | Critical | No |
| 3 | **Replay dedupe is in-memory, non-atomic, and per-process** | High | Partly (in-memory noted; race + cross-process not) |
| 4 | **No buyer ≠ seller guard** — self-vouch in one tx | High | Partly (acknowledged in code comment, not fixed) |
| 5 | **No facilitator** — direct RPC verification, `confirmed` not `finalized` | Medium | Yes |
| 6 | **Reputation formula is trivially gameable** (see Part 3) | Medium | Yes (formula), No (gameability depth) |
| 7 | **`record_failure` griefing / no rate limit** | Low–Medium | No |
| 8 | **Env-var keypair handling, no key rotation, single hot key** | Medium (ops) | Partly |
| 9 | **No tests, no CI, no overflow-checks in release** | Medium (quality) | No |
| 10 | Two duplicated IDLs + duplicated config constants | Low | No |

The reordering matters: the README leads with "trusts the `authority` signer" as the headline
simplification, but that instruction is now buyer-signed. The **actual** headline risk is that
the on-chain program records reputation without verifying any payment at all — a different and
larger problem.

### 2. Minimum viable hardening per item

**#1 — Prove payment on-chain before recording reputation.**
Minimum viable: `record_payment` should not accept a bare `amount`. Instead, take the token
transfer as part of the *same transaction* and verify it on-chain, one of:
- **CPI approach:** have `record_payment` itself perform the SPL token transfer via CPI
  (buyer → seller ATA), so the recorded amount *is* the transferred amount. Atomic, no
  external proof needed. This is the cleanest real fix.
- **Introspection approach:** use the `instructions` sysvar to assert that a sibling SPL
  `transfer`/`transferChecked` to the seller ATA of ≥ `price` exists in the same tx.
- Either way, record `amount` = the *verified* transferred amount, not a caller-supplied
  number, and derive `seller` from the payment destination, not from a free parameter.

**#2 — Bind payment to the request (nonce + expiry + payer).**
Minimum viable: the 402 challenge issues a `nonce` and `expiresAt`. The buyer includes the
nonce in the payment (SPL `memo` instruction, or as an argument to the on-chain
`record_payment`). The seller verifies (a) the nonce it issued, (b) not expired, (c) the
payer's wallet matches the requester, (d) nonce not previously redeemed. This kills
third-party replay of a public signature and unbound payments.

**#3 — Real replay protection.**
Minimum viable off-chain: move dedupe out of process memory into shared durable storage
(Redis `SET NX`, or Postgres unique constraint on signature) so it survives restarts and is
atomic across concurrent requests and multiple instances. Do the insert *before* serving, and
make check+insert a single atomic op (fixes the race in SUMMARY §3a).
Stronger: enforce single-use on-chain — a redeemed-nonce PDA (or a bitmap) so a given payment
nonce can be recorded exactly once, program-enforced, independent of any server's memory.

**#4 — buyer ≠ seller guard.**
Minimum viable, one line: `require_keys_neq!(ctx.accounts.buyer.key(),
ctx.accounts.seller.key());` in `record_payment`. Cheap, immediate, closes the trivial
self-vouch. Deeper: counterparty-uniqueness weighting (Part 3).

**#5 — Facilitator / settlement assurance.**
Minimum viable: verify at `finalized` commitment for anything that gates value; keep
`confirmed` only for UI optimism. A real facilitator (x402 spec) would centralize
verification, handle settlement, retries, and multi-scheme support — a larger build, not
required for devnet, but the boundary (`verifyPayment`) is already a clean seam to slot one in.

**#6 / Part 3 — reputation formula.** See Part 3.

**#7 — `record_failure` abuse.**
Minimum viable: since it only self-harms, leave it — but once reputation is a real trust
signal, failures should be *attested by the buyer* (the counterparty who experienced the
failure), not self-reported, and rate-limited via the same nonce mechanism as #2.

**#8 — key handling.**
Minimum viable: keep env-var loading but (a) validate the secret parses and log only the
pubkey, never the secret; (b) document that Render env vars are readable by anyone with
dashboard access — treat these as low-value devnet keys only; (c) for production, move signing
to a KMS/HSM or a dedicated signer service, and never let a single hot key hold both real
funds and signing authority. Add key rotation runbook.

**#9 — tests + CI + overflow.**
Minimum viable: add an Anchor test that (a) initializes a seller, (b) proves a real payment
records correctly, (c) proves the negative cases (no payment, wrong mint, self-vouch)
*reject*. Add `[profile.release] overflow-checks = true` to a workspace `Cargo.toml`. Add a
GitHub Action running `anchor test` + `tsc --noEmit`.

**#10 — de-duplicate.** Single shared config module and a single generated IDL (Anchor emits
one — import it, don't hand-copy into two `idl/` folders).

### 3. Fine to leave for a devnet demo vs. blocker for real funds

**Genuinely fine for a devnet demo (leave as-is):**
- No facilitator; direct RPC verification.
- `confirmed` commitment.
- In-memory replay set (it demos correctly; cold-start reset is cosmetic on devnet).
- Simple reputation formula.
- Synthetic seeded history via `seed-agent.ts`.
- Render free-tier sleep (just document it — already done).
- Env-var keypairs holding throwaway devnet keys.
- Hardcoded demo agent names in the frontend.

**Hard blockers before handling any real value:**
- **#1** — must verify payment on-chain (or via a trusted facilitator) before recording
  reputation. Non-negotiable; today reputation is free to mint.
- **#2** — must bind payment to request (nonce/expiry/payer). Without this, payments are
  replayable and unowned.
- **#3** — replay protection must be durable, atomic, and ideally on-chain.
- **#4** — buyer ≠ seller guard (trivial to add, no excuse to ship without it).
- **#8** — real key custody; no hot key with real funds in a dashboard env var.
- Verify at **`finalized`** for value-gating checks.
- A test suite covering the negative cases above.

---

## Part 3 — Reputation system: gameability and next iteration

### Is the current formula gameable?
`score = completed * 100 / (completed + failed)`. **Yes, trivially — and more deeply than the
README's "no decay/recency" note implies.** Distinct attacks:

1. **Free minting (the real one):** because `record_payment` verifies no payment (SUMMARY
   §2.1), an attacker calls it in a loop and reaches 100% with any `completed_count`. No money
   moves. This is not "wash trading is possible" — it's "reputation is a free-write counter."
2. **Wash trading:** even after payment is enforced, one actor with two wallets pays itself
   0.01 tokens repeatedly. Cost per fake point ≈ tx fees + a self-recycled token. The
   buyer-signature requirement raises the bar only to "needs a second wallet."
3. **Self-vouch:** with no buyer ≠ seller check, not even a second wallet is required today.
4. **Cold-start / cheap-service inflation:** a seller can set a trivially small `price` and
   rack up completions cheaply; the formula doesn't weight by amount, counterparty diversity,
   or recency. The frontend's tier logic (`getTier`, requiring both count ≥ N and score) is a
   reasonable *display* patch but lives off-chain and is not part of the trust signal itself.

### A reasonable next iteration
If this became a real trust signal for agents choosing sellers, move from a raw ratio to a
**counterparty-and-value-weighted, time-decayed, uncertainty-aware** score:

1. **Provenance first (prerequisite):** reputation must only be writable by a verified,
   payment-bound, single-use event (Part 2 #1–#3). Everything below is meaningless without it.
2. **Counterparty uniqueness weighting:** weight by the number of *distinct* buyers, not raw
   transaction count. 20 payments from 20 wallets ≫ 20 payments from 1 wallet. Track distinct
   payer set (or a HyperLogLog-style sketch on-chain) and down-weight repeat counterparties.
3. **Value weighting:** weight completions by amount transferred (bounded/log-scaled to avoid
   a single whale dominating), so a seller can't farm reputation with dust.
4. **Recency / decay:** exponential time decay so stale reputation fades and recent behavior
   dominates — prevents "earn trust once, coast forever, then rug."
5. **Uncertainty-aware smoothing:** use a Bayesian lower bound (e.g. Wilson score interval on
   the success proportion) instead of a raw percentage, so 1/1 (100%) ranks *below* 95/100.
   This is the principled version of the frontend's ad-hoc tier gating.
6. **Counterparty-attested failures:** let buyers attest failures (not just sellers
   self-report), so the failure signal is real.
7. **Optional economic skin-in-the-game:** bonded stake a seller forfeits on adjudicated
   non-delivery, and/or off-chain wash-trading detection (graph analysis of payer/seller
   clustering) feeding a penalty. These are the "raise cost of faking above value gained"
   mitigations the program comment already gestures at.

A pragmatic v2 that's implementable soon: **Wilson lower bound × recency decay, over
distinct-counterparty value-weighted completions.** That single change neutralizes attacks
2 and 4 and blunts 1/3 (combined with the Part 2 provenance fixes).
