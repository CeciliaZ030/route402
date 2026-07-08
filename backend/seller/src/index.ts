import express from "express";
import cors from "cors";
import { Connection } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import { PORT, RPC_URL, USDC_MINT, SERVICE_PRICE } from "./config.js";
import { buildPaymentRequirements, verifyPayment } from "./x402.js";
import {
  loadKeypair,
  recordFailure,
  listSellerProfiles,
  ensureSellerProfile,
  getProtocolConfig,
} from "./anchorClient.js";
import { performService, isSupportedTask, SUPPORTED_TASKS } from "./service.js";

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

// Self-heal the on-chain profile at boot: creates it if missing, or migrates
// it (close + re-init, counters reset) if it predates the 2026-07 account
// layout change. Runs before the server accepts traffic so /agents and
// pay_and_record never see a stale-layout own-profile.
const profileState = await ensureSellerProfile(sellerAuthority, SERVICE_PRICE);
if (profileState !== "exists") {
  console.warn(
    `SellerProfile ${profileState === "migrated" ? "MIGRATED to new layout — counters reset to zero" : "created fresh"}`
  );
}

// Fee rate comes from the on-chain ProtocolConfig; 0 if not yet initialized.
const protocolConfig = await getProtocolConfig(sellerAuthority);
const protocolFeeBps = protocolConfig?.protocolFeeBps ?? 0;
console.log(`Protocol fee: ${protocolFeeBps} bps${protocolConfig ? "" : " (ProtocolConfig not initialized)"}`);

const seenSignatures = new Set<string>();

interface ActivityEvent {
  id: number;
  timestamp: string;
  step: string;
  message: string;
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

/**
 * Loop A, steps 1-6, unchanged. Loop B changed: the seller no longer calls
 * record_payment itself (see security note in the Anchor program — that
 * instruction is now buyer-signed). The seller just tells the buyer it's
 * their turn to submit the reputation update, via sellerAuthority in the
 * response body.
 */
app.post("/service", async (req, res) => {
  const { paymentSignature, task: requestedTask, params } = req.body ?? {};

  // The request now carries a real input: which task to perform. Defaults to
  // network-report so older clients that POST an empty body still get real
  // work rather than an error.
  const task = requestedTask ?? "network-report";
  if (!isSupportedTask(task)) {
    logEvent("receive_request", `Rejected unknown task "${String(task).slice(0, 40)}"`);
    return res.status(400).json({
      error: "unsupported task",
      supportedTasks: SUPPORTED_TASKS,
    });
  }

  if (!paymentSignature) {
    logEvent("receive_request", "Buyer requested service, no payment attached");
    logEvent("402_challenge", `Sent 402 — price ${buildPaymentRequirements(sellerTokenAccount, sellerAuthority.publicKey.toBase58(), protocolFeeBps).amount} base units`);
    return res.status(402).json({
      error: "payment required",
      paymentRequirements: buildPaymentRequirements(sellerTokenAccount, sellerAuthority.publicKey.toBase58(), protocolFeeBps),
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
      logEvent("reputation_update", "Recorded failure on-chain (seller self-reported)");
    } catch (err) {
      console.error("record_failure failed:", err);
      logEvent("reputation_update", "Failed to record failure on-chain");
    }
    return res.status(402).json({
      error: "payment verification failed",
      reason: result.reason,
      paymentRequirements: buildPaymentRequirements(sellerTokenAccount, sellerAuthority.publicKey.toBase58(), protocolFeeBps),
    });
  }

  logEvent("verify_payment", `Verified — ${result.amountPaid} base units received`, paymentSignature);
  seenSignatures.add(paymentSignature);

  // The paid work happens here — real computation over live network data,
  // not a canned string. If it fails after payment verified, that's the
  // seller's failure to deliver: refuse cleanly and self-report on-chain.
  let output;
  try {
    output = await performService(connection, task, params);
  } catch (err) {
    console.error("service execution failed:", err);
    logEvent("deliver_result", `Failed to perform task "${task}" after verified payment`);
    try {
      await recordFailure(sellerAuthority);
      logEvent("reputation_update", "Recorded failure on-chain (seller self-reported)");
    } catch (recordErr) {
      console.error("record_failure failed:", recordErr);
      logEvent("reputation_update", "Failed to record failure on-chain");
    }
    return res.status(500).json({ error: "service execution failed" });
  }

  logEvent(
    "deliver_result",
    `Delivered "${task}" (slot ${output.data.slot}, avg ${output.data.avgTps} TPS) — buyer will record reputation on-chain`,
    paymentSignature
  );

  return res.status(200).json({
    task,
    result: output.summary,
    data: output.data,
    generatedAt: output.data.generatedAt,
    // The buyer needs these two to submit the reputation update itself.
    sellerAuthority: sellerAuthority.publicKey.toBase58(),
    amountPaid: result.amountPaid,
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
