/**
 * One-time protocol setup: creates the singleton ProtocolConfig PDA that
 * pay_and_record requires — admin pubkey, treasury token account (where
 * protocol fees accumulate), and the fee rate in basis points.
 *
 * Run once per program deployment, signed by the program's admin wallet:
 *   npx tsx scripts/init-config.ts [feeBps]
 *
 * The admin keypair loads from ADMIN_KEYPAIR_SECRET (JSON secret-key array),
 * else ADMIN_KEYPAIR_PATH, else the default Solana CLI wallet. The treasury
 * is the admin wallet's ATA for the project mint (created if missing).
 * Idempotent: exits cleanly if the config already exists.
 */
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RPC_URL, USDC_MINT } from "../src/config.js";
import idl from "../src/idl/agent_economy.json" with { type: "json" };

const PROGRAM_ID = new PublicKey("6pp5jDS23FBcwtqe8pTiBJw3osyHZQPENr9bK3P62vjt");
const DEFAULT_FEE_BPS = 250; // 2.5% — mid of the 1-3% starting range from the plan

function loadAdminKeypair(): Keypair {
  const fromEnv = process.env.ADMIN_KEYPAIR_SECRET;
  if (fromEnv) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fromEnv)));
  }
  const keyPath =
    process.env.ADMIN_KEYPAIR_PATH ??
    path.join(os.homedir(), ".config", "solana", "id.json");
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, "utf-8")))
  );
}

const feeBps = Number(process.argv[2] ?? DEFAULT_FEE_BPS);
if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 1000) {
  console.error(`Invalid feeBps "${process.argv[2]}" — must be an integer 0-1000`);
  process.exit(1);
}

const admin = loadAdminKeypair();
const connection = new Connection(RPC_URL, "confirmed");
const provider = new AnchorProvider(connection, new Wallet(admin), {
  commitment: "confirmed",
});
const program = new Program(idl as any, provider) as any;

const [configPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("config")],
  PROGRAM_ID
);

const existing = await connection.getAccountInfo(configPda);
if (existing) {
  const config = await program.account.protocolConfig.fetch(configPda);
  console.log("ProtocolConfig already initialized — nothing to do.");
  console.log(`  admin:    ${config.admin.toBase58()}`);
  console.log(`  treasury: ${config.treasuryTokenAccount.toBase58()}`);
  console.log(`  fee:      ${config.protocolFeeBps} bps`);
  process.exit(0);
}

const treasury = await getOrCreateAssociatedTokenAccount(
  connection,
  admin,
  USDC_MINT,
  admin.publicKey
);

const signature = await program.methods
  .initializeConfig(feeBps)
  .accounts({
    admin: admin.publicKey,
    config: configPda,
    treasuryTokenAccount: treasury.address,
  })
  .rpc();

console.log("ProtocolConfig initialized.");
console.log(`  admin:    ${admin.publicKey.toBase58()}`);
console.log(`  treasury: ${treasury.address.toBase58()}`);
console.log(`  fee:      ${feeBps} bps`);
console.log(`  tx:       ${signature}`);
