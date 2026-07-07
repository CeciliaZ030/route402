/**
 * Seeds one demo seller agent with real on-chain history: creates its
 * SellerProfile PDA if it doesn't exist, then submits real record_payment
 * (buyer-signed, same as the real flow) and record_failure calls to build up
 * a believable transaction history for the demo highway/leaderboard.
 *
 * This does NOT run as a live service — it's a one-time script. The resulting
 * on-chain accounts and history are completely real (same program, same
 * instructions a live agent would use), just not backed by a 24/7 backend.
 *
 * Usage:
 *   npx tsx scripts/seed-agent.ts <keypair-path> <price> <completed> <failed>
 *
 * Example:
 *   npx tsx scripts/seed-agent.ts ./seller-beta-keypair.json 20000 12 2
 */
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import BN from "bn.js";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import fs from "node:fs";
import idl from "../src/idl/agent_economy.json" with { type: "json" };

const RPC_URL = "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey("6pp5jDS23FBcwtqe8pTiBJw3osyHZQPENr9bK3P62vjt");

const [, , keypairPath, priceArg, completedArg, failedArg] = process.argv;

if (!keypairPath) {
  console.error("Usage: npx tsx scripts/seed-agent.ts <keypair-path> <price> <completed> <failed>");
  process.exit(1);
}

const PRICE = Number(priceArg ?? 10000);
const TARGET_COMPLETED = Number(completedArg ?? 10);
const TARGET_FAILED = Number(failedArg ?? 1);
const BUYER_KEYPAIR_PATH = process.env.BUYER_KEYPAIR_PATH ?? "../buyer/buyer-keypair.json";

function loadOrCreateKeypair(path: string): Keypair {
  if (fs.existsSync(path)) {
    const raw = JSON.parse(fs.readFileSync(path, "utf-8"));
    return Keypair.fromSecretKey(Uint8Array.from(raw));
  }
  const kp = Keypair.generate();
  fs.writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)));
  console.log(`Generated new keypair, saved to ${path}`);
  return kp;
}

async function airdropIfLow(connection: Connection, pubkey: PublicKey, label: string) {
  const bal = await connection.getBalance(pubkey);
  if (bal < 0.05 * 1e9) {
    console.log(`Airdropping SOL to ${label} (${pubkey.toBase58()})...`);
    const sig = await connection.requestAirdrop(pubkey, 1e9);
    await connection.confirmTransaction(sig, "confirmed");
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const seller = loadOrCreateKeypair(keypairPath);
  const buyer = loadOrCreateKeypair(BUYER_KEYPAIR_PATH);

  console.log(`Seller pubkey: ${seller.publicKey.toBase58()}`);
  console.log(`Buyer pubkey (vouching): ${buyer.publicKey.toBase58()}`);

  await airdropIfLow(connection, seller.publicKey, "seller");
  await airdropIfLow(connection, buyer.publicKey, "buyer");

  const sellerProvider = new AnchorProvider(connection, new Wallet(seller), { commitment: "confirmed" });
  const sellerProgram = new Program(idl as any, sellerProvider) as any;

  const [sellerProfile] = PublicKey.findProgramAddressSync(
    [Buffer.from("seller"), seller.publicKey.toBuffer()],
    PROGRAM_ID
  );

  const existing = await connection.getAccountInfo(sellerProfile);
  if (!existing) {
    console.log("Initializing seller profile...");
    await sellerProgram.methods
      .initializeSeller(new BN(PRICE))
      .accounts({ authority: seller.publicKey, sellerProfile, systemProgram: SystemProgram.programId })
      .rpc();
  } else {
    console.log("Seller profile already exists — will add more history to it.");
  }

  const buyerProvider = new AnchorProvider(connection, new Wallet(buyer), { commitment: "confirmed" });
  const buyerProgram = new Program(idl as any, buyerProvider) as any;

  for (let i = 0; i < TARGET_COMPLETED; i++) {
    process.stdout.write(`Recording completed payment ${i + 1}/${TARGET_COMPLETED}...\r`);
    await buyerProgram.methods
      .recordPayment(new BN(PRICE))
      .accounts({ buyer: buyer.publicKey, seller: seller.publicKey, sellerProfile })
      .rpc();
    await sleep(600);
  }
  console.log(`\nRecorded ${TARGET_COMPLETED} completed payments.`);

  for (let i = 0; i < TARGET_FAILED; i++) {
    process.stdout.write(`Recording failure ${i + 1}/${TARGET_FAILED}...\r`);
    await sellerProgram.methods
      .recordFailure()
      .accounts({ authority: seller.publicKey, sellerProfile })
      .rpc();
    await sleep(600);
  }
  console.log(`\nRecorded ${TARGET_FAILED} failures.`);

  const profile = await (sellerProgram.account as any).sellerProfile.fetch(sellerProfile);
  console.log("\nFinal profile:");
  console.log(`  Reputation: ${profile.reputationScore.toString()}`);
  console.log(`  Completed: ${profile.completedCount.toString()}`);
  console.log(`  Failed: ${profile.failedCount.toString()}`);
  console.log(`  Seller pubkey (save this for the frontend name mapping): ${seller.publicKey.toBase58()}`);
}

main().catch((err) => {
  console.error("Seeding failed:", err);
  process.exit(1);
});
