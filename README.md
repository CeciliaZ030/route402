# Route402 — Solana devnet starter

Two AI agents transacting autonomously on Solana devnet via an x402-style HTTP 402
payment flow, with an on-chain reputation system. See `agent-economy-build-spec.md`
for the full design rationale — this README is just the "how to actually run it" part.

## What's here

```
program/            Anchor program: SellerProfile PDA + reputation logic
backend/seller/      Express server implementing the 402 challenge + verification
backend/buyer/        Script that pays the seller and completes Loop A
frontend/            Plain HTML/CSS/JS UI: highway, leaderboard, expanded agent view
```

Everything under `backend/` has already been installed and type-checked (`tsc --noEmit`
passes clean on both). The Anchor program has **not** been compiled — this sandbox has
no Rust/Solana toolchain, so that step is on you, locally.

## Setup

### 1. Install the Solana + Anchor toolchain (if you don't have it)

Follow https://www.anchor-lang.com/docs/installation — you need `solana-cli`,
`anchor-cli`, and Rust.

### 2. Build and deploy the program

```bash
cd program
anchor keys sync        # replaces the placeholder program ID with a real one
anchor build
anchor deploy --provider.cluster devnet
```

After `anchor build`, copy the generated IDL over the placeholder one:

```bash
cp target/idl/agent_economy.json ../backend/seller/src/idl/agent_economy.json
```

The placeholder IDL in `backend/seller/src/idl/` exists only so the TypeScript
type-checks before you've built the program — replace it, don't just add to it.

Also update `PROGRAM_ID` in `backend/seller/src/anchorClient.ts` and the `programs.devnet`
entry in `program/Anchor.toml` to match whatever `anchor keys sync` generates.

### 3. Create devnet keypairs and fund them

```bash
solana-keygen new -o backend/seller/seller-keypair.json
solana-keygen new -o backend/buyer/buyer-keypair.json
solana airdrop 2 <seller pubkey> --url devnet
solana airdrop 2 <buyer pubkey> --url devnet
```

Both agents also need devnet USDC. Use the Circle devnet faucet
(https://faucet.circle.com) against the mint in `backend/seller/src/config.ts`
(`USDC_MINT`), or mint your own test SPL token on devnet and swap the mint address
everywhere it's referenced if you'd rather not depend on Circle's faucet.

### 4. Initialize the seller's on-chain profile

Before the seller can accept payments, its `SellerProfile` PDA needs to exist. Easiest
path: write a one-off script (or use `anchor test`/a REPL) calling
`initialize_seller` with the seller's keypair — see `program/programs/agent_economy/src/lib.rs`
for the instruction signature. This isn't scripted here because it's a one-time setup
step, not part of the runtime loop.

### 5. Run the seller

```bash
cd backend/seller
npm install   # already run in the sandbox, but do it again after cloning
npm run dev
```

Confirm you see both the seller wallet and its USDC token account logged on startup.

### 6. Run the buyer

```bash
cd backend/buyer
npm install
npm run buy
```

This should print the 402 challenge, send the payment, retry, and print the result.
If it works end-to-end, Loop A is done — check the seller's terminal for the
`record_payment` call succeeding, which is Loop B.

### 7. Run the frontend

Any static file server works, e.g.:

```bash
cd frontend
npx http-server -p 5173
```

Open it in a browser. It polls `http://localhost:4021/agents` every 4 seconds — if
you're running the seller on a different host/port, set `window.SELLER_URL` in a
`<script>` tag before `app.js` loads in `index.html`.

## What's deliberately not built yet

- Only one seller profile is demonstrated — the leaderboard code supports many, but
  you only need to `initialize_seller` for your one demo seller.
- No wallet-adapter UI — the buyer is a script, not a browser wallet flow. Fine for a
  hackathon demo; add wallet-adapter only if you have time left after Loop A + B work.
- No facilitator — verification is done directly against devnet RPC in
  `backend/seller/src/x402.ts`. See the build spec for why.

## Known rough edges to be aware of

- `record_payment`'s account constraints trust whoever signs as `authority` — for a
  hackathon demo this is fine, but note it in your pitch as a known simplification
  rather than pretending it's production-hardened.
- Replay protection (`seenSignatures`) is in-memory and resets if the seller restarts.
  Fine for a demo, not for anything real.
