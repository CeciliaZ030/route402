import { Connection, Keypair } from "@solana/web3.js";
import { RPC_URL, SERVICE_PRICE, USDC_MINT } from "./config.js";

const connection = new Connection(RPC_URL, "confirmed");

export interface PaymentRequirements {
  scheme: "exact";
  network: "solana-devnet";
  /** What the seller must RECEIVE, in base units — the service's net price. */
  amount: number;
  asset: string;
  /** The seller's token account address — where the payment itself goes. */
  payTo: string;
  /** The seller's wallet pubkey (not token account) — the buyer needs this
   * to derive the correct SellerProfile PDA for the pay_and_record call. */
  sellerAuthority: string;
  /** Protocol fee in basis points, taken out of the gross amount by the
   * on-chain program. Surfaced here for transparency — the buyer can see
   * exactly what the protocol takes before paying. */
  protocolFeeBps: number;
  /** What the buyer should send via pay_and_record so that the seller nets
   * `amount` after the program's fee split. */
  grossAmount: number;
}

export function buildPaymentRequirements(
  sellerTokenAccount: string,
  sellerAuthority: string,
  protocolFeeBps: number
): PaymentRequirements {
  // Gross-up so the seller still nets the full price after the fee split:
  // program computes fee = floor(gross * bps / 10000), seller gets the rest.
  const grossAmount =
    protocolFeeBps > 0
      ? Math.ceil((SERVICE_PRICE * 10_000) / (10_000 - protocolFeeBps))
      : SERVICE_PRICE;

  return {
    scheme: "exact",
    network: "solana-devnet",
    amount: SERVICE_PRICE,
    asset: USDC_MINT.toBase58(),
    payTo: sellerTokenAccount,
    sellerAuthority,
    protocolFeeBps,
    grossAmount,
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

  // Scan top-level AND inner instructions: with pay_and_record the token
  // transfer happens via CPI inside the program instruction, so it only
  // appears in meta.innerInstructions. Legacy plain transfers stay top-level.
  const instructions = [
    ...(tx.transaction.message.instructions as any[]),
    ...(tx.meta?.innerInstructions ?? []).flatMap((inner: any) => inner.instructions),
  ];

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
