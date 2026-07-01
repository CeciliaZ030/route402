import { Connection, PublicKey } from "@solana/web3.js";
import { RPC_URL, SERVICE_PRICE, USDC_MINT } from "./config.js";

const connection = new Connection(RPC_URL, "confirmed");

export interface PaymentRequirements {
  scheme: "exact";
  network: "solana-devnet";
  amount: number;
  asset: string;
  /** The seller's USDC associated token account address, not their wallet pubkey. */
  payTo: string;
}

/** Builds the payload that goes in the 402 response body. */
export function buildPaymentRequirements(sellerTokenAccount: string): PaymentRequirements {
  return {
    scheme: "exact",
    network: "solana-devnet",
    amount: SERVICE_PRICE,
    asset: USDC_MINT.toBase58(),
    payTo: sellerTokenAccount,
  };
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
  amountPaid?: number;
}

/**
 * Verifies a claimed payment directly against Solana devnet — no facilitator.
 * Confirms: the transaction exists and succeeded, it transferred at least the
 * required USDC amount, and it paid the expected seller wallet.
 *
 * This is intentionally the simplest correct implementation, not a hardened one.
 * A production version would also guard against replay (reusing the same
 * signature twice) — for the hackathon demo, checking the signature hasn't been
 * seen before is enough; see the in-memory set in index.ts.
 */
export async function verifyPayment(
  signature: string,
  sellerTokenAccount: string
): Promise<VerifyResult> {
  const tx = await connection.getParsedTransaction(signature, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });

  if (!tx) {
    return { ok: false, reason: "transaction not found on devnet" };
  }
  if (tx.meta?.err) {
    return { ok: false, reason: "transaction failed on-chain" };
  }

  // Look for an SPL token transfer instruction (parsed) that matches our mint,
  // destination wallet, and minimum amount.
  const instructions = tx.transaction.message.instructions as any[];

  for (const ix of instructions) {
    if (ix.program !== "spl-token") continue;
    const parsed = ix.parsed;
    if (!parsed || (parsed.type !== "transferChecked" && parsed.type !== "transfer")) continue;

    const info = parsed.info;
    const mint = info.mint as string | undefined;
    if (mint && mint !== USDC_MINT.toBase58()) continue;

    // transferChecked gives tokenAmount.amount, plain transfer gives amount.
    const rawAmount = info.tokenAmount?.amount ?? info.amount;
    const amountPaid = Number(rawAmount);

    // Destination is the token account, not the wallet directly — resolving the
    // owning wallet from a token account requires an extra lookup. For devnet
    // simplicity we compare against the associated token account address you
    // pass in as sellerWallet from the frontend/backend config (see README).
    if (info.destination !== sellerTokenAccount) continue;

    if (amountPaid < SERVICE_PRICE) {
      return { ok: false, reason: "amount below required price", amountPaid };
    }

    return { ok: true, amountPaid };
  }

  return { ok: false, reason: "no matching USDC transfer found in transaction" };
}

export { connection };
