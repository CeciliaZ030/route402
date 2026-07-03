import fs from "node:fs";
import {
  AnchorProvider,
  Program,
  Wallet,
} from "@coral-xyz/anchor";
import BN from "bn.js";
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
import idl from "./idl/agent_economy.json" with { type: "json" };

const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const SELLER_URL = process.env.SELLER_URL ?? "http://localhost:4021";
const USDC_MINT = new PublicKey("EKFUzCYkafhGWDArX2QVr1E4cGydnyk1R6pwP9j3ztFC");
const PROGRAM_ID = new PublicKey("6pp5jDS23FBcwtqe8pTiBJw3osyHZQPENr9bK3P62vjt");

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
  /** Signature of the buyer's own on-chain reputation-vouching transaction —
   * separate from the payment signature. Present only on a full success. */
  reputationTxSignature?: string;
}

/**
 * Runs the full Loop A + Loop B buyer flow once.
 *
 * Loop B changed from the original design: the buyer now submits the
 * record_payment call itself, signed with its own key, rather than trusting
 * the seller to self-report. See the security note in the Anchor program's
 * lib.rs for why — a seller self-attesting its own success is trivially
 * gameable; an independent buyer's signature is a real (if imperfect) check.
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
  const sellerAuthority = new PublicKey(paymentRequirements.sellerAuthority);

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

  if (secondResponse.status !== 200) {
    return { success: false, message: `Purchase failed (${secondResponse.status})`, signature };
  }

  // Loop B: the buyer itself now vouches for the seller on-chain.
  let reputationTxSignature: string | undefined;
  try {
    const provider = new AnchorProvider(connection, new Wallet(buyer), { commitment: "confirmed" });
    const program = new Program(idl as any, provider) as any;

    const [sellerProfile] = PublicKey.findProgramAddressSync(
      [Buffer.from("seller"), sellerAuthority.toBuffer()],
      PROGRAM_ID
    );

    reputationTxSignature = await program.methods
      .recordPayment(new BN(body.amountPaid ?? paymentRequirements.amount))
      .accounts({
        buyer: buyer.publicKey,
        seller: sellerAuthority,
        sellerProfile,
      })
      .rpc();
  } catch (err) {
    // The purchase itself already succeeded even if this vouching step fails —
    // don't fail the whole purchase over it, but do surface it clearly.
    console.error("Failed to record reputation on-chain:", err);
  }

  return {
    success: true,
    message: "Purchase complete",
    signature,
    result: body.result,
    reputationTxSignature,
  };
}
