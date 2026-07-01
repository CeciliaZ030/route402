import express from "express";
import cors from "cors";
import { Connection } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import { PORT, RPC_URL, USDC_MINT } from "./config.js";
import { buildPaymentRequirements, verifyPayment } from "./x402.js";
import { loadKeypair, recordPayment, recordFailure, listSellerProfiles } from "./anchorClient.js";

const app = express();
app.use(cors());
app.use(express.json());

// Seller's own signing keypair — used both to receive payment (via its ATA) and
// to sign the record_payment/record_failure calls into the Anchor program.
// Point SELLER_KEYPAIR_PATH at a devnet keypair file, e.g. ~/.config/solana/id.json
const sellerAuthority = loadKeypair(
  process.env.SELLER_KEYPAIR_PATH ?? "./seller-keypair.json"
);

const connection = new Connection(RPC_URL, "confirmed");

// Resolved once at startup — the actual token account payments land in.
const sellerTokenAccount = (
  await getOrCreateAssociatedTokenAccount(
    connection,
    sellerAuthority,
    USDC_MINT,
    sellerAuthority.publicKey
  )
).address.toBase58();

// Replay protection: don't let the same payment signature settle twice.
// In-memory is fine for a hackathon demo; swap for a persisted set in production.
const seenSignatures = new Set<string>();

// --- Live activity feed for the frontend ---
interface ActivityEvent {
  id: number;
  timestamp: string;
  step: string;
  message: string;
}
const events: ActivityEvent[] = [];
let eventId = 0;
function logEvent(step: string, message: string) {
  events.unshift({ id: eventId++, timestamp: new Date().toISOString(), step, message });
  if (events.length > 30) events.length = 30;
  console.log(`[${step}] ${message}`);
}

app.get("/events", (_req, res) => {
  res.json(events);
});

/**
 * Loop A, step 1-2: client hits the service, gets a 402 with payment terms
 * unless it already attached a valid payment signature.
 *
 * Loop A, step 4-6: client retries with `paymentSignature` in the body, we
 * verify it landed on-chain, then serve the (mocked) result.
 *
 * Loop B: on a verified payment, call into the Anchor program to update
 * reputation. On a rejected payment, record_failure keeps the score honest.
 */
app.post("/service", async (req, res) => {
  const { paymentSignature } = req.body ?? {};

  if (!paymentSignature) {
    logEvent("receive_request", "Buyer requested service, no payment attached");
    logEvent("402_challenge", `Sent 402 — price ${buildPaymentRequirements(sellerTokenAccount).amount} base units`);
    return res.status(402).json({
      error: "payment required",
      paymentRequirements: buildPaymentRequirements(sellerTokenAccount),
    });
  }

  logEvent("verify_payment", `Verifying signature ${paymentSignature.slice(0, 12)}...`);

  if (seenSignatures.has(paymentSignature)) {
    logEvent("verify_payment", "Rejected — signature already used");
    return res.status(409).json({ error: "payment signature already used" });
  }

  const result = await verifyPayment(paymentSignature, sellerTokenAccount);

  if (!result.ok) {
    logEvent("verify_payment", `Failed — ${result.reason}`);
    try {
      await recordFailure(sellerAuthority);
      logEvent("reputation_update", "Recorded failure on-chain");
    } catch (err) {
      console.error("record_failure failed:", err);
      logEvent("reputation_update", "Failed to record failure on-chain");
    }
    return res.status(402).json({
      error: "payment verification failed",
      reason: result.reason,
      paymentRequirements: buildPaymentRequirements(sellerTokenAccount),
    });
  }

  logEvent("verify_payment", `Verified — ${result.amountPaid} base units received`);
  seenSignatures.add(paymentSignature);

  try {
    await recordPayment(sellerAuthority, result.amountPaid ?? 0);
    logEvent("reputation_update", "Recorded payment on-chain, reputation updated");
  } catch (err) {
    // The payment already landed on-chain even if this bookkeeping call fails —
    // log it, but still serve the result rather than making the buyer re-pay.
    console.error("record_payment failed:", err);
    logEvent("reputation_update", "Payment succeeded but on-chain record failed");
  }

  logEvent("deliver_result", "Sent result to buyer");

  // Mocked service output — swap for whatever this seller actually does.
  return res.status(200).json({
    result: "Here is your paid response.",
    generatedAt: new Date().toISOString(),
  });
});

/** Powers the leaderboard view — reads every SellerProfile PDA the program owns. */
app.get("/agents", async (_req, res) => {
  try {
    const profiles = await listSellerProfiles(sellerAuthority);
    profiles.sort((a: { reputationScore: number }, b: { reputationScore: number }) => b.reputationScore - a.reputationScore);
    res.json(profiles);
  } catch (err) {
    console.error("failed to list seller profiles:", err);
    res.status(500).json({ error: "could not load agent stats" });
  }
});

app.listen(PORT, () => {
  console.log(`Seller agent listening on http://localhost:${PORT}`);
  console.log(`Seller wallet: ${sellerAuthority.publicKey.toBase58()}`);
  console.log(`Seller USDC token account: ${sellerTokenAccount}`);
});
