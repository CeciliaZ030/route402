#!/usr/bin/env tsx
/**
 * One-off: move devnet SOL + USDC from the old buyer keypair to a new one.
 * Both key files must exist in the current directory.
 *   OLD:  ./buyer-keypair.json
 *   NEW:  ./new-buyer-keypair.json
 * After this runs, update BUYER_KEYPAIR_SECRET on Render to the contents
 * of new-buyer-keypair.json, then delete the old file locally.
 */
import fs from "node:fs";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  LAMPORTS_PER_SOL, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount, createTransferInstruction,
  getAccount, getAssociatedTokenAddress,
} from "@solana/spl-token";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const USDC_MINT = new PublicKey("EKFUzCYkafhGWDArX2QVr1E4cGydnyk1R6pwP9j3ztFC");
const LEAVE_SOL = 2_000_000; // 0.002 SOL left in old wallet (rent-free close after)

const loadKp = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf-8"))));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  const from = loadKp("./buyer-keypair.json");
  const to = loadKp("./new-buyer-keypair.json");
  const conn = new Connection(RPC, "confirmed");

  console.log(`FROM (old): ${from.publicKey.toBase58()}`);
  console.log(`TO   (new): ${to.publicKey.toBase58()}`);
  if (process.argv.includes("--dry-run")) {
    const sol = await conn.getBalance(from.publicKey);
    const addr = await getAssociatedTokenAddress(USDC_MINT, from.publicKey);
    let usdc = 0;
    try { usdc = Number((await getAccount(conn, addr)).amount); } catch {}
    console.log(`SOL: ${(sol/LAMPORTS_PER_SOL).toFixed(4)}  USDC: ${usdc}`);
    console.log("Would transfer all USDC and SOL minus 0.002 buffer. (dry run)");
    return;
  }

  // 1) Create USDC ATA on the new wallet (old wallet pays the rent)
  const fromUsdc = await getAssociatedTokenAddress(USDC_MINT, from.publicKey);
  const toUsdcAcc = await getOrCreateAssociatedTokenAccount(conn, from, USDC_MINT, to.publicKey);
  console.log(`New USDC ATA ready: ${toUsdcAcc.address.toBase58()}`);
  await sleep(4000);

  // 2) Transfer all USDC
  const usdcBal = Number((await getAccount(conn, fromUsdc)).amount);
  if (usdcBal > 0) {
    const tx = new Transaction().add(createTransferInstruction(fromUsdc, toUsdcAcc.address, from.publicKey, usdcBal));
    const sig = await sendAndConfirmTransaction(conn, tx, [from]);
    console.log(`USDC moved (${usdcBal}): ${sig}`);
  } else {
    console.log("No USDC to move.");
  }
  await sleep(4000);

  // 3) Transfer SOL minus small buffer
  const solBal = await conn.getBalance(from.publicKey);
  const sendLamports = solBal - LEAVE_SOL;
  if (sendLamports > 5000) {
    const tx = new Transaction().add(SystemProgram.transfer({
      fromPubkey: from.publicKey, toPubkey: to.publicKey, lamports: sendLamports,
    }));
    const sig = await sendAndConfirmTransaction(conn, tx, [from]);
    console.log(`SOL moved (${(sendLamports/LAMPORTS_PER_SOL).toFixed(4)}): ${sig}`);
  } else {
    console.log("No SOL to move.");
  }

  console.log("\nDone. Next:");
  console.log("  1. Open Render → route402-buyer → Environment");
  console.log("  2. Replace BUYER_KEYPAIR_SECRET with the contents of new-buyer-keypair.json");
  console.log("  3. Save (service redeploys)");
  console.log("  4. Verify Render logs show the new buyer pubkey");
  console.log("  5. Delete ./buyer-keypair.json");
  console.log("  6. Rename new-buyer-keypair.json → buyer-keypair.json");
}
main().catch(e => { console.error("Fatal:", e); process.exit(1); });
