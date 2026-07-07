# Route402

## Purpose
Two AI agents transact autonomously on Solana devnet over an x402-style HTTP 402 payment
flow, with on-chain seller reputation. A buyer agent requests a service, gets a 402 +
payment requirements, pays in SPL tokens, retries with proof, and the seller delivers and
records reputation on-chain. It's a hackathon demo of an agent-to-agent "pay-per-call"
economy with a public trust signal. Live demo: https://route402.onrender.com.

## Tech stack / conventions
- **On-chain:** Anchor **0.30.1** (pinned — `avm use 0.30.1`), Rust, single program
  `agent_economy` at `6pp5jDS23FBcwtqe8pTiBJw3osyHZQPENr9bK3P62vjt` (devnet).
- **Backends:** Node 18+, TypeScript (ESM, `"type": "module"`), Express, `@coral-xyz/anchor`,
  `@solana/web3.js` 1.x, `@solana/spl-token` 0.4.x. Run with `tsx`.
- **Frontend:** vanilla HTML/CSS/JS, no framework, no build step. Polls the seller every 3s.
- **Token:** project-owned throwaway 6-decimal SPL mint `EKFUzCYkafhGWDArX2QVr1E4cGydnyk1R6pwP9j3ztFC`
  (labelled "USDC" in code but is **not** real USDC).
- **Deploy:** Render — seller (web), buyer (web), frontend (static). Keypairs via env var.
- **Conventions:** PDA seeds `["seller", authority_pubkey]`; amounts in base units (6 dp);
  keypairs load env-var-first then local file; devnet only.

## Key rules (Do)
- Keep Anchor at exactly 0.30.1; the IDL is copied into **both** `backend/seller/src/idl/`
  and `backend/buyer/src/idl/` — regenerate and update **both** when the program changes.
- Load keypairs via `loadKeypair(ENV_VAR, filePath)`; set `SELLER_KEYPAIR_SECRET` /
  `BUYER_KEYPAIR_SECRET` as a JSON secret-key array in prod. Log only pubkeys.
- Derive the `SellerProfile` PDA from `["seller", authority]` everywhere (seller, buyer,
  seed, init all repeat this — keep them identical).
- Denominate every amount in base units (6 decimals). `SERVICE_PRICE = 10_000` = 0.01 token.
- Verify payments in `x402.ts` against destination token account, mint, and `>= price`.
- Treat all reputation/leaderboard data as **partly synthetic** (seeded) and **unproven** by
  the chain — see gotchas.

## Anti-patterns (Do NOT)
- **Do NOT** trust the on-chain reputation numbers as proof of real settled payments —
  `record_payment` verifies no payment (see roadmap). Do not build value-bearing logic on it.
- **Do NOT** commit keypair files. `.gitignore` covers `*-keypair.json`; history is clean —
  keep it that way. Do not paste secret-key arrays into logs, issues, or the frontend.
- **Do NOT** assume `SellerProfile.price` is authoritative — the running backend uses its own
  `config.ts` constant, not the on-chain field. The on-chain price is effectively dead state.
- **Do NOT** point any RPC/config at mainnet (`config.ts` says devnet-only for a reason).
- **Do NOT** add unbound user strings into the frontend's `innerHTML` interpolations.
- **Do NOT** rely on the in-memory `seenSignatures` set as real replay protection.
- **Do NOT** duplicate config constants further — they're already triplicated (seller config,
  buyer purchase, init-seller); consolidate rather than add a fourth copy.

## Build/test commands
```bash
# Seller backend
cd backend/seller && npm install && npm run dev      # tsx watch on :4021
npm run build && npm run start                        # tsc -> node dist

# Buyer backend
cd backend/buyer && npm install && npm run serve      # demo server on :4022
npm run buy                                           # one-shot CLI purchase

# Frontend
cd frontend && npx http-server -p 5173

# One-time on-chain setup / demo seeding
cd backend/seller && npx tsx init-seller.ts
npx tsx scripts/seed-agent.ts <keypair> <price> <completed> <failed>

# Anchor program
cd program && anchor build && anchor deploy           # devnet
```
There is **no test suite** and **no CI** despite `Anchor.toml` referencing `tests/**`.
`anchor test` currently has nothing to run. Verification today is manual via the demo button.

## Known gotchas / unfinished areas
- **The chain does not verify payments.** `record_payment(amount)` records a caller-supplied
  number with no proof — off-chain HTTP verification and on-chain reputation are decoupled.
- **`scripts/seed-agent.ts` fabricates history** by calling `record_payment` with no real
  transfers. On-chain counts for demo agents are partly synthetic. Demo agent names are
  hardcoded in `frontend/app.js` (`AGENT_NAMES`) keyed by pubkey.
- **Replay dedupe is in-memory, non-atomic (check-then-act race), and per-process** — resets
  on every Render cold start (~15 min idle → 10–30s wake). Documented sleep behavior is
  expected, not a bug; the dedupe reset that comes with it is not documented to users.
- **No payment↔request binding:** the 402 challenge has no nonce/expiry/payer; any observed
  public signature can be replayed to a fresh seller process. Requester ≠ proven payer.
- **Mint check is skipped for plain `transfer`** (only enforced for `transferChecked`, since
  `info.mint` is undefined otherwise). Not currently exploitable (ATA is mint-specific) but
  fragile.
- **`Number(rawAmount)` / `Number(price)`** lose precision above 2^53 — fine for demo sizes.
- **Verification uses `confirmed`, not `finalized`** — acceptable on devnet, not for value.
- **Duplicated IDLs and config constants** across seller/buyer/init — keep in sync manually.
- **Untracked cruft** at repo root: `seed-agent-v2.ts`, `seed-agent-WITH-DELAYS-v2.ts`, and
  `backend/seller/scripts/` — near-duplicates of the committed seed script; clean up.
- **`~/.claude/SOLANA.md` (the shared reference the audit was told to diff against) does not
  exist** on this machine — no project-specific security checklist is actually in place.

## Security hardening roadmap (ranked)
Full detail in [SECURITY_ROADMAP.md](SECURITY_ROADMAP.md). Ranked by risk if real value flowed:
1. **Prove payment on-chain before recording reputation** (CPI transfer, or instructions-sysvar
   introspection; record the *verified* amount, derive seller from the payment). — Critical
2. **Bind payment to request:** nonce + expiry + payer identity in the 402 challenge, redeemed
   single-use. — Critical
3. **Durable, atomic replay protection** (Redis `SET NX` / DB unique constraint; ideally an
   on-chain redeemed-nonce PDA). — High
4. **`require_keys_neq!(buyer, seller)`** in `record_payment` — one line, closes self-vouch. — High
5. **Verify at `finalized`** for value-gating checks; consider a real x402 facilitator. — Medium
6. **Reputation formula v2** (see below). — Medium
7. **Real key custody** (KMS/HSM; no hot key with real funds in a dashboard env var); rotation
   runbook. — Medium (ops)
8. **Tests + CI + `overflow-checks = true`**; cover negative cases (no payment, wrong mint,
   self-vouch must reject). — Medium
9. **De-duplicate** config + IDL into single sources. — Low

Fine to leave for a devnet demo: no facilitator, `confirmed` commitment, in-memory replay set,
simple formula, seeded history, Render sleep, throwaway env-var keys.

## Reputation system notes
- **Current formula:** `score = completed * 100 / (completed + failed)`, 0–100, no decay, no
  recency, no value or counterparty weighting. Frontend `getTier` adds a display-only gate
  (needs both count ≥ N and score ≥ threshold) — not part of the on-chain signal.
- **Gameability:** trivially gameable today. (a) Free minting — `record_payment` needs no
  payment, so 100% at any count with zero money moved. (b) Wash trading — one actor, two
  wallets, self-pay dust. (c) Self-vouch — no buyer≠seller guard, so no second wallet even
  needed. (d) Cheap-price farming — no value weighting.
- **v2 direction** (only meaningful *after* provenance fixes 1–3 above): Wilson-score lower
  bound (so 1/1 ranks below 95/100) × exponential recency decay, over
  **distinct-counterparty**, **value-weighted** completions; buyer-attested failures; optional
  bonded stake + off-chain wash-trading graph detection. Pragmatic first step: Wilson lower
  bound × recency decay over distinct-counterparty value-weighted completions.

## Part 4 note — code quality, deployment, demo-ability
- **Code quality:** clean and readable for a hackathon; well-commented intent. Main debts are
  the triplicated config/IDL, no tests/CI, `any`-typed Anchor programs, and dead on-chain
  `price`. `checked_add().unwrap()` panics are acceptable; `compute_reputation` uses unchecked
  `completed + failed` and there's no release-profile `overflow-checks`.
- **Deployment robustness:** Render free-tier sleep is documented; add a lightweight keep-warm
  ping or a "waking up…" UI state so the first-click delay reads as intentional. Env-var
  keypair handling is the right call for Render but treat those keys as low-value devnet only
  (dashboard-readable). Validate the secret parses at boot and fail fast with a clear message.
- **Demo-ability / extensibility:** move demo agent names + backend URLs out of hardcoded JS
  into a small config/JSON so new agents don't require code edits; surface the on-chain
  program link and per-tx Solscan links (already partly done); add a visible "synthetic vs.
  live" badge so viewers know which history is seeded. The `verifyPayment` boundary is a clean
  seam for slotting in a real facilitator later.
