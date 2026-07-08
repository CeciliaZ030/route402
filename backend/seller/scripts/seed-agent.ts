/**
 * Seeds one demo seller agent with synthetic on-chain history: creates its
 * SellerProfile PDA if it doesn't exist, then submits record_payment
 * (ADMIN-signed — since the 2026-07 upgrade that instruction is admin-gated,
 * existing precisely so that unverified history can only be written by the
 * protocol admin for demo seeding) and record_failure calls.
 *
 * This does NOT run as a live service — it's a one-time script, and history
 * written this way is synthetic by definition: no payment backs it. Live
 * reputation flows exclusively through pay_and_record.
 *
 * Usage (admin keypair from ADMIN_KEYPAIR_SECRET / ADMIN_KEYPAIR_PATH /
 * default solana CLI wallet):
 *   npx tsx scripts/seed-agent.ts <seller-keypair-path> <price> <completed> <failed>
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

function loadAdminKeypair(): Keypair {
  const fromEnv = process.env.ADMIN_KEYPAIR_SECRET;
  if (fromEnv) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fromEnv)));
  }
  const keyPath =
    process.env.ADMIN_KEYPAIR_PATH ??
    `${process.env.HOME}/.config/solana/id.json`;
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, "utf-8")))
  );
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
  const admin = loadAdminKeypair();

  console.log(`Seller pubkey: ${seller.publicKey.toBase58()}`);
  console.log(`Admin pubkey (seeding): ${admin.publicKey.toBase58()}`);

  await airdropIfLow(connection, seller.publicKey, "seller");

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

  const adminProvider = new AnchorProvider(connection, new Wallet(admin), { commitment: "confirmed" });
  const adminProgram = new Program(idl as any, adminProvider) as any;

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    PROGRAM_ID
  );

  for (let i = 0; i < TARGET_COMPLETED; i++) {
    process.stdout.write(`Recording completed payment ${i + 1}/${TARGET_COMPLETED}...\r`);
    await adminProgram.methods
      .recordPayment(new BN(PRICE))
      .accounts({ admin: admin.publicKey, config: configPda, seller: seller.publicKey, sellerProfile })
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
