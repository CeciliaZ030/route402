#!/usr/bin/env tsx
/**
 * Routex402 seeding script.
 *
 * Creates N fresh devnet buyer wallets, funds them from the main buyer with
 * SOL and USDC, then has each one call pay_and_record against a set of
 * target sellers. Produces real distinct-buyer counts for sellers that have
 * no HTTP endpoint of their own.
 *
 * Run from backend/buyer with the usual env vars (BUYER_KEYPAIR_SECRET or
 * a buyer-keypair.json). New keypairs are saved to .secrets/buyers/ and
 * git-ignored.
 *
 * Usage:
 *   npx tsx src/seed-buyers.ts --dry-run
 *   npx tsx src/seed-buyers.ts --buyers 6 --purchases 3
 *   npx tsx src/seed-buyers.ts --target <sellerAuthorityPubkey>
 */

import fs from "node:fs";
import path from "node:path";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  LAMPORTS_PER_SOL, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount,
  createTransferInstruction, getAccount, getAssociatedTokenAddress,
} from "@solana/spl-token";
import idl from "./idl/agent_economy.json" with { type: "json" };

// ---- config ----
const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const SELLER_URL = process.env.SELLER_URL ?? "https://route402-seller.onrender.com";
const USDC_MINT = new PublicKey("EKFUzCYkafhGWDArX2QVr1E4cGydnyk1R6pwP9j3ztFC");
const PROGRAM_ID = new PublicKey("6pp5jDS23FBcwtqe8pTiBJw3osyHZQPENr9bK3P62vjt");
const SOL_PER_BUYER = Math.round(0.03 * LAMPORTS_PER_SOL);  // fees + ATA rent
const DEFAULT_BUYERS = 6;
const DEFAULT_PURCHASES = 3;
const SECRETS_DIR = path.resolve(".secrets/buyers");

// ---- CLI ----
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const AUTO_YES = argv.includes("--yes");
function arg(name: string, def?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
}
const NUM_BUYERS = parseInt(arg("buyers", String(DEFAULT_BUYERS))!, 10);
const PER = parseInt(arg("purchases", String(DEFAULT_PURCHASES))!, 10);
const TARGET_FLAG = arg("target");

function loadMain(): Keypair {
  const envKey = process.env.BUYER_KEYPAIR_SECRET;
  if (envKey) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(envKey)));
  const p = process.env.BUYER_KEYPAIR_PATH ?? "./buyer-keypair.json";
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf-8"))));
}

function saveKeypair(kp: Keypair, name: string) {
  fs.mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(SECRETS_DIR, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
}

function short(s: string) { return s.slice(0, 4) + ".." + s.slice(-4); }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function askConfirm(prompt: string): Promise<boolean> {
  if (AUTO_YES) return true;
  process.stdout.write(prompt + " [y/N]: ");
  return new Promise(res => {
    process.stdin.resume();
    process.stdin.once("data", (d) => {
      process.stdin.pause();
      res(d.toString().trim().toLowerCase() === "y");
    });
  });
}

interface Seller { pubkey: string; authority: string; price: number; distinctBuyers?: number; }

async function fetchTargets(): Promise<Seller[]> {
  const r = await fetch(`${SELLER_URL}/agents`);
  const all: Seller[] = await r.json();
  if (TARGET_FLAG) {
    const hit = all.find(a => a.authority === TARGET_FLAG || a.pubkey === TARGET_FLAG);
    if (!hit) throw new Error(`Target ${TARGET_FLAG} not found in /agents`);
    return [hit];
  }
  // default: any seller where distinctBuyers is unknown (0) or very low
  const need = all.filter(a => (a.distinctBuyers ?? 0) < 3);
  if (need.length === 0) throw new Error("No sellers need seeding (all have 3+ distinct buyers). Pass --target to force.");
  return need;
}

async function main() {
  console.log(`\n== Routex402 seeding ==`);
  console.log(`  RPC:    ${RPC_URL}`);
  console.log(`  Seller: ${SELLER_URL}`);
  console.log(`  Plan:   ${NUM_BUYERS} new buyers × ${PER} purchases each`);

  const connection = new Connection(RPC_URL, "confirmed");
  const mainKp = loadMain();
  console.log(`  Main:   ${mainKp.publicKey.toBase58()}`);

  const targets = await fetchTargets();
  console.log(`  Targets:`);
  targets.forEach(t => console.log(`    ${t.authority}  price=${t.price}  distinctBuyers=${t.distinctBuyers ?? "?"}`));

  // Load config
  const mainProvider = new AnchorProvider(connection, new Wallet(mainKp), { commitment: "confirmed" });
  const program = new Program(idl as any, mainProvider) as any;
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID);
  const config = await program.account.protocolConfig.fetch(configPda);
  const feeBps = Number(config.protocolFeeBps);
  console.log(`  Fee:    ${feeBps} bps`);

  // Compute budget
  const usdcPerBuyer = Math.ceil(targets.reduce((s, t) => {
    const net = t.price;
    const gross = feeBps > 0 ? Math.ceil((net * 10_000) / (10_000 - feeBps)) : net;
    return s + gross * PER;
  }, 0) * 1.05);
  const solNeeded = NUM_BUYERS * SOL_PER_BUYER;
  const usdcNeeded = NUM_BUYERS * usdcPerBuyer;

  // Check main balances
  const solBal = await connection.getBalance(mainKp.publicKey);
  const mainUsdcAddr = await getAssociatedTokenAddress(USDC_MINT, mainKp.publicKey);
  let usdcBal = 0;
  try { usdcBal = Number((await getAccount(connection, mainUsdcAddr)).amount); } catch {}

  console.log(`\n  Needed: ${(solNeeded/LAMPORTS_PER_SOL).toFixed(4)} SOL, ${usdcNeeded} USDC base units`);
  console.log(`  Have:   ${(solBal/LAMPORTS_PER_SOL).toFixed(4)} SOL, ${usdcBal} USDC base units`);

  if (DRY_RUN) { console.log(`\n(dry run — nothing spent)`); return; }
  if (solBal < solNeeded) { console.error(`\nERROR: need more SOL. Run: solana airdrop 1 ${mainKp.publicKey.toBase58()} --url devnet`); process.exit(1); }
  if (usdcBal < usdcNeeded) { console.error(`\nERROR: need more USDC on main buyer wallet.`); process.exit(1); }

  if (!await askConfirm(`\nProceed?`)) { console.log("Aborted."); return; }

  // Generate buyers
  const buyers: Keypair[] = [];
  const stamp = Date.now();
  for (let i = 0; i < NUM_BUYERS; i++) {
    const kp = Keypair.generate();
    saveKeypair(kp, `buyer-${stamp}-${i + 1}`);
    buyers.push(kp);
    console.log(`  #${i + 1}  ${kp.publicKey.toBase58()}`);
  }

  // Ensure each target seller has a USDC ATA (pay_and_record needs it)
  const mainUsdcAcc = await getOrCreateAssociatedTokenAccount(connection, mainKp, USDC_MINT, mainKp.publicKey);
  const sellerTokenAccounts: Record<string, PublicKey> = {};
  for (const t of targets) {
    const authority = new PublicKey(t.authority);
    const acc = await getOrCreateAssociatedTokenAccount(connection, mainKp, USDC_MINT, authority);
    sellerTokenAccounts[t.authority] = acc.address;
  }

  // Fund buyers
  console.log(`\nFunding...`);
  for (let i = 0; i < buyers.length; i++) {
    const b = buyers[i];
    try {
      const tx1 = new Transaction().add(SystemProgram.transfer({ fromPubkey: mainKp.publicKey, toPubkey: b.publicKey, lamports: SOL_PER_BUYER }));
      await sendAndConfirmTransaction(connection, tx1, [mainKp]);
      const bUsdcAcc = await getOrCreateAssociatedTokenAccount(connection, mainKp, USDC_MINT, b.publicKey);
      const tx2 = new Transaction().add(createTransferInstruction(mainUsdcAcc.address, bUsdcAcc.address, mainKp.publicKey, usdcPerBuyer));
      await sendAndConfirmTransaction(connection, tx2, [mainKp]);
      console.log(`  #${i + 1} funded: ${SOL_PER_BUYER/LAMPORTS_PER_SOL} SOL, ${usdcPerBuyer} USDC`);
    } catch (err: any) {
      console.error(`  #${i + 1} funding failed: ${err?.message ?? err}`);
      process.exit(1);
    }
    await sleep(400);
  }

  // Run purchases
  console.log(`\nRunning purchases...`);
  let ok = 0, fail = 0;
  for (let i = 0; i < buyers.length; i++) {
    const b = buyers[i];
    const bProv = new AnchorProvider(connection, new Wallet(b), { commitment: "confirmed" });
    const bProg = new Program(idl as any, bProv) as any;
    const buyerUsdc = await getAssociatedTokenAddress(USDC_MINT, b.publicKey);

    for (const t of targets) {
      const sellerAuth = new PublicKey(t.authority);
      const sellerTokenAccount = sellerTokenAccounts[t.authority];
      const [sellerProfile] = PublicKey.findProgramAddressSync([Buffer.from("seller"), sellerAuth.toBuffer()], PROGRAM_ID);
      const [buyerSellerLink] = PublicKey.findProgramAddressSync([Buffer.from("link"), sellerAuth.toBuffer(), b.publicKey.toBuffer()], PROGRAM_ID);
      const net = t.price;
      const gross = feeBps > 0 ? Math.ceil((net * 10_000) / (10_000 - feeBps)) : net;

      for (let p = 0; p < PER; p++) {
        try {
          const sig = await bProg.methods.payAndRecord(new BN(gross)).accounts({
            buyer: b.publicKey, seller: sellerAuth, sellerProfile, buyerSellerLink,
            config: configPda, mint: USDC_MINT, buyerTokenAccount: buyerUsdc,
            sellerTokenAccount, treasuryTokenAccount: config.treasuryTokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
          }).rpc();
          ok++;
          console.log(`  ok  #${i+1} → ${short(t.authority)} [${p+1}/${PER}]  ${sig.slice(0,16)}...`);
        } catch (err: any) {
          fail++;
          console.log(`  !!  #${i+1} → ${short(t.authority)} [${p+1}/${PER}]  ${err?.message ?? err}`);
        }
        await sleep(400);
      }
    }
  }

  console.log(`\n== Done ==  succeeded ${ok}  failed ${fail}`);
  console.log(`New buyer keypairs saved to ${SECRETS_DIR}/`);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
