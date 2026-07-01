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

const sellerAuthority = loadKeypair(
  "SELLER_KEYPAIR_SECRET",
  process.env.SELLER_KEYPAIR_PATH ?? "./seller-keypair.json"
);

const connection = new Connection(RPC_URL, "confirmed");

const sellerTokenAccount = (
  await getOrCreateAssociatedTokenAccount(
    connection,
    sellerAuthority,
    USDC_MINT,
    sellerAuthority.publicKey
  )
).address.toBase58();

const seenSignatures = new Set<string>();

// --- Live activity feed for the frontend ---
interface ActivityEvent {
  id: number;
  timestamp: string;
  step: string;
  message: string;
  /** Solana transaction signature, if this event is tied to one — lets the
   * frontend link straight to Solscan for on-chain proof. */
  signature?: string;
}
const events: ActivityEvent[] = [];
let eventId = 0;
function logEvent(step: string, message: string, signature?: string) {
  events.unshift({ id: eventId++, timestamp: new Date().toISOString(), step, message, signature });
  if (events.length > 30) events.length = 30;
  console.log(`[${step}] ${message}`);
}

app.get("/events", (_req, res) => {
  res.json(events);
});

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

  logEvent("verify_payment", `Verifying signature ${paymentSignature.slice(0, 12)}...`, paymentSignature);

  if (seenSignatures.has(paymentSignature)) {
    logEvent("verify_payment", "Rejected — signature already used", paymentSignature);
    return res.status(409).json({ error: "payment signature already used" });
  }

  const result = await verifyPayment(paymentSignature, sellerTokenAccount);

  if (!result.ok) {
    logEvent("verify_payment", `Failed — ${result.reason}`, paymentSignature);
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

  logEvent("verify_payment", `Verified — ${result.amountPaid} base units received`, paymentSignature);
  seenSignatures.add(paymentSignature);

  let reputationTxSignature: string | undefined;
  try {
    reputationTxSignature = await recordPayment(sellerAuthority, result.amountPaid ?? 0);
    logEvent("reputation_update", "Recorded payment on-chain, reputation updated", reputationTxSignature);
  } catch (err) {
    console.error("record_payment failed:", err);
    logEvent("reputation_update", "Payment succeeded but on-chain record failed");
  }

  logEvent("deliver_result", "Sent result to buyer", paymentSignature);

  return res.status(200).json({
    result: "Here is your paid response.",
    generatedAt: new Date().toISOString(),
  });
});

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
  console.log(`Seller token account: ${sellerTokenAccount}`);
});
