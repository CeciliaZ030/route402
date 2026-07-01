import fs from "node:fs";
import {
  Connection,
  Keypair,
  Transaction,
  sendAndConfirmTransaction,
  PublicKey,
} from "@solana/web3.js";
import {
  createTransferInstruction,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";

const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const SELLER_URL = process.env.SELLER_URL ?? "http://localhost:4021";
const USDC_MINT = new PublicKey("EKFUzCYkafhGWDArX2QVr1E4cGydnyk1R6pwP9j3ztFC");

/**
 * Same pattern as the seller: check an environment variable holding the raw
 * secret key JSON array first (for cloud hosts), fall back to a local file
 * (for local dev). See anchorClient.ts on the seller side for the original.
 */
function loadKeypair(envVarName: string, filePath: string): Keypair {
  const fromEnv = process.env[envVarName];
  if (fromEnv) {
    const secret = JSON.parse(fromEnv);
    return Keypair.fromSecretKey(Uint8Array.from(secret));
  }
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export interface PurchaseResult {
  success: boolean;
  message: string;
  signature?: string;
  result?: string;
}

/**
 * Runs the full Loop A buyer flow once: request -> 402 -> pay -> retry -> result.
 * Shared by the CLI script (src/index.ts) and the demo-trigger server (src/server.ts).
 */
export async function runPurchase(): Promise<PurchaseResult> {
  const connection = new Connection(RPC_URL, "confirmed");
  const buyer = loadKeypair(
    "BUYER_KEYPAIR_SECRET",
    process.env.BUYER_KEYPAIR_PATH ?? "./buyer-keypair.json"
  );

  const firstResponse = await fetch(`${SELLER_URL}/service`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });

  if (firstResponse.status !== 402) {
    const body = await firstResponse.text();
    return { success: false, message: `Unexpected response (expected 402): ${body}` };
  }

  const { paymentRequirements } = await firstResponse.json();

  const sellerTokenAccount = new PublicKey(paymentRequirements.payTo);
  const buyerTokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    buyer,
    USDC_MINT,
    buyer.publicKey
  );

  const transferIx = createTransferInstruction(
    buyerTokenAccount.address,
    sellerTokenAccount,
    buyer.publicKey,
    paymentRequirements.amount
  );

  const tx = new Transaction().add(transferIx);
  const signature = await sendAndConfirmTransaction(connection, tx, [buyer], {
    commitment: "confirmed",
  });

  const secondResponse = await fetch(`${SELLER_URL}/service`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paymentSignature: signature }),
  });

  const body = await secondResponse.json();

  if (secondResponse.status === 200) {
    return { success: true, message: "Purchase complete", signature, result: body.result };
  }
  return { success: false, message: `Purchase failed (${secondResponse.status})`, signature };
}
