import { Connection, Keypair } from "@solana/web3.js";
import { RPC_URL, SERVICE_PRICE, USDC_MINT } from "./config.js";

const connection = new Connection(RPC_URL, "confirmed");

export interface PaymentRequirements {
  scheme: "exact";
  network: "solana-devnet";
  amount: number;
  asset: string;
  /** The seller's token account address — where the payment itself goes. */
  payTo: string;
  /** The seller's wallet pubkey (not token account) — the buyer needs this
   * to derive the correct SellerProfile PDA when it submits the reputation
   * update itself. See the security note in the Anchor program: record_payment
   * is buyer-signed, so the buyer needs to know which seller it's vouching for. */
  sellerAuthority: string;
}

export function buildPaymentRequirements(
  sellerTokenAccount: string,
  sellerAuthority: string
): PaymentRequirements {
  return {
    scheme: "exact",
    network: "solana-devnet",
    amount: SERVICE_PRICE,
    asset: USDC_MINT.toBase58(),
    payTo: sellerTokenAccount,
    sellerAuthority,
  };
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
  amountPaid?: number;
}

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

  const instructions = tx.transaction.message.instructions as any[];

  for (const ix of instructions) {
    if (ix.program !== "spl-token") continue;
    const parsed = ix.parsed;
    if (!parsed || (parsed.type !== "transferChecked" && parsed.type !== "transfer")) continue;

    const info = parsed.info;
    const mint = info.mint as string | undefined;
    if (mint && mint !== USDC_MINT.toBase58()) continue;

    const rawAmount = info.tokenAmount?.amount ?? info.amount;
    const amountPaid = Number(rawAmount);

    if (info.destination !== sellerTokenAccount) continue;

    if (amountPaid < SERVICE_PRICE) {
      return { ok: false, reason: "amount below required price", amountPaid };
    }

    return { ok: true, amountPaid };
  }

  return { ok: false, reason: "no matching token transfer found in transaction" };
}

export { connection };
