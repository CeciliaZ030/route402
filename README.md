# Routex402: Verified reputation for AI agent payments

Two AI agents transact autonomously on Solana devnet using an x402-style HTTP 402
payment flow, with an on-chain reputation system tracking every seller's completed
and failed transactions.

## Live demo

**https://route402.onrender.com**

Open it and click **"Run purchase"**. This triggers a real buyer agent paying a
real seller agent on Solana devnet, verified by a real on-chain program, live in
the browser. No local setup required to watch it work.

> **Note:** the backend services run on Render's free tier, which sleeps after 15
> minutes of inactivity. The first request after a period of inactivity can take
> 10-30 seconds to respond while it wakes up. This is expected, not a bug. If the
> button seems unresponsive on first click, give it a moment and try again.

**On-chain program:** `6pp5jDS23FBcwtqe8pTiBJw3osyHZQPENr9bK3P62vjt` (Solana devnet)
View it on [Solana Explorer](https://explorer.solana.com/address/6pp5jDS23FBcwtqe8pTiBJw3osyHZQPENr9bK3P62vjt?cluster=devnet).

**Repo:** https://github.com/msurfx/route402

---

## Architecture

```
program/            Anchor program: SellerProfile PDA + reputation logic
backend/seller/      Express server implementing the 402 challenge + verification
backend/buyer/        Purchase logic (CLI script + a small server for the demo button)
frontend/            Static HTML/CSS/JS: highway, leaderboard, live activity feed
```

### Core loops

**Loop A: Payment**
```
Buyer agent requests service → Seller returns 402 + price/wallet
→ Buyer signs a token transfer → Buyer retries with proof
→ Seller verifies the transaction on-chain → Seller delivers result
```

**Loop B: Reputation**
```
Successful payment settles → Seller's on-chain reputation account increments
→ Anyone can query reputation before choosing a seller
```

### Deployed services

| Service | Where | Purpose |
|---|---|---|
| `route402-seller` | Render (Web Service) | 402 challenge, payment verification, on-chain reputation writes |
| `route402-buyer` | Render (Web Service) | Executes purchases; exposes `/purchase` for the demo button |
| `route402` (frontend) | Render (Static Site) | The UI shown above |
| Anchor program | Solana devnet | `SellerProfile` PDA, `record_payment`, `record_failure` |

---

## Aomi chat on the home page

The home page embeds the [Aomi](https://aomi.dev) chat widget (`frontend/aomi.js`,
loaded from esm.sh, no build step). A visitor signs in with a Solana wallet,
asks the agent to do something on-chain, and the page watches that wallet. When
a new confirmed transaction lands it is reported to the seller:

| Endpoint | Purpose |
|---|---|
| `POST /api/v1/aomi/sessions` `{ wallet }` | A visitor signed in to the widget. Logged once per wallet as an `aomi_session` feed event. |
| `POST /api/v1/aomi/actions` `{ wallet, signature, cluster? }` | Verifies the transaction on-chain (confirmed, succeeded, wallet is a party) and logs an `aomi_action` feed event. Unverifiable signatures are rejected. |
| `GET /api/v1/aomi/activity?wallet=` | Totals and recent actions; `/api/v1/stats` also reports `aomiAgents` and `aomiActions`. |

The side panel then shows the agent's wallet, App ID, recent actions and a QR
code to continue on Telegram (`/link` attaches the wallet to the Aomi account)
or in Aomi Chat. Storage is in-memory, like the live feed.

Configure in `frontend/index.html`: `AOMI_APPLICATION_ID` (the activated
Routex402 App on Aomi; until set, the card shows a placeholder),
`AOMI_TELEGRAM_BOT` (bot username once registered on Aomi), and
`AOMI_SOLANA_RPCS` (clusters to watch; devnet by default).

## Running it locally

### 1. Prerequisites

- Node.js 18+
- Rust + Solana CLI + Anchor CLI (`avm install 0.30.1 && avm use 0.30.1`, this
  project pins Anchor 0.30.1 specifically; see the note on toolchain issues below)

### 2. Clone and install

```bash
git clone https://github.com/msurfx/route402.git
cd route402
cd backend/seller && npm install && cd ../buyer && npm install
```

### 3. Set up devnet wallets

```bash
solana config set --url devnet
solana-keygen new --no-bip39-passphrase -o backend/seller/seller-keypair.json
solana-keygen new --no-bip39-passphrase -o backend/buyer/buyer-keypair.json
solana airdrop 1 $(solana-keygen pubkey backend/seller/seller-keypair.json)
solana airdrop 1 $(solana-keygen pubkey backend/buyer/buyer-keypair.json)
```

### 4. Get test tokens

This project uses its own custom devnet SPL token (mint
`EKFUzCYkafhGWDArX2QVr1E4cGydnyk1R6pwP9j3ztFC`) rather than depending on an
external faucet. If you need your own supply for testing, you'll need to be the
mint authority. See `backend/seller/src/config.ts` for the mint address, and
mint/transfer test tokens to your buyer wallet with the `spl-token` CLI.

### 5. Run all three services

```bash
# Terminal 1
cd backend/seller && npm run dev

# Terminal 2
cd backend/buyer && npm run serve

# Terminal 3
cd frontend && npx http-server -p 5173
```

Open `http://localhost:5173`. It defaults to `localhost` URLs for the backend
services when run this way.

### Cloud deployment notes

Both backend services read their signing keypair from an environment variable
(`SELLER_KEYPAIR_SECRET` / `BUYER_KEYPAIR_SECRET`) if set, falling back to a local
file otherwise. This is what makes them deployable to a host like Render, where
you can't upload a local file but can set the raw secret key array as a secure
environment variable. **Never commit a keypair file to git.** They're excluded
via `.gitignore` for exactly this reason.

## Known simplifications (by design, for a hackathon build)

- `record_payment`'s account constraints trust whoever signs as `authority`, a
  known simplification, not a production-hardened trust model.
- Replay protection for payment signatures is in-memory on the seller and resets
  if it restarts.
- No facilitator. Payment verification is done directly against Solana devnet
  RPC rather than through a third-party x402 facilitator service.
- Reputation formula is deliberately simple: percentage of successful vs. failed
  transactions, no decay or recency weighting.
