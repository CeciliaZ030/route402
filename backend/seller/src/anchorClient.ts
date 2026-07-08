import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import fs from "node:fs";
import { RPC_URL } from "./config.js";

import idl from "./idl/agent_economy.json" with { type: "json" };

const PROGRAM_ID = new PublicKey("6pp5jDS23FBcwtqe8pTiBJw3osyHZQPENr9bK3P62vjt");

export function loadKeypair(envVarName: string, filePath: string): Keypair {
  const fromEnv = process.env[envVarName];
  if (fromEnv) {
    const secret = JSON.parse(fromEnv);
    return Keypair.fromSecretKey(Uint8Array.from(secret));
  }
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export function getProgram(authority: Keypair): Program {
  const connection = new Connection(RPC_URL, "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(authority), {
    commitment: "confirmed",
  });
  return new Program(idl as any, provider) as Program;
}

export function sellerProfilePda(authority: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("seller"), authority.toBuffer()],
    PROGRAM_ID
  );
}

export function configPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID);
}

export interface ProtocolConfigInfo {
  admin: string;
  treasuryTokenAccount: string;
  protocolFeeBps: number;
}

/** Reads the singleton ProtocolConfig, or null if it hasn't been initialized. */
export async function getProtocolConfig(
  authority: Keypair
): Promise<ProtocolConfigInfo | null> {
  const program = getProgram(authority);
  const [pda] = configPda();
  try {
    const config = await (program.account as any).protocolConfig.fetch(pda);
    return {
      admin: config.admin.toBase58(),
      treasuryTokenAccount: config.treasuryTokenAccount.toBase58(),
      protocolFeeBps: Number(config.protocolFeeBps),
    };
  } catch {
    return null;
  }
}

/**
 * Makes sure this seller's on-chain profile exists AND uses the current
 * account layout, creating or migrating it if not.
 *
 * The 2026-07 program upgrade grew SellerProfile (distinct_buyers,
 * weighted_completed, last_updated), so profiles created before it fail to
 * deserialize. The only migration path is close + re-initialize (the program's
 * close_seller instruction exists for exactly this), which RESETS the
 * profile's counters — acceptable for devnet, logged loudly so nobody is
 * surprised. Both instructions run in one transaction so the profile can't be
 * left closed-but-not-recreated.
 */
export async function ensureSellerProfile(
  authority: Keypair,
  price: number
): Promise<"exists" | "created" | "migrated"> {
  const program = getProgram(authority);
  const [pda] = sellerProfilePda(authority.publicKey);
  const accounts = program.account as any;

  try {
    await accounts.sellerProfile.fetch(pda);
    return "exists";
  } catch {
    // Fall through: either the account is missing or it's the old layout.
  }

  const connection = program.provider.connection;
  const info = await connection.getAccountInfo(pda);

  if (info) {
    // Account exists but failed to deserialize with the current IDL — it's
    // almost certainly the old, pre-migration layout. Do NOT auto-migrate:
    // close+init would reset completed_count/reputation_score to zero, and
    // doing that silently on every server boot risks destroying real demo
    // history. Migration (if ever wanted) should be a deliberate, one-off,
    // manually-run action — never automatic. Leave the account as-is.
    console.warn(
      "WARNING: SellerProfile exists but uses an old account layout " +
      "(deserialization failed). Not auto-migrating to avoid resetting " +
      "real history. Run a manual migration script if this seller needs " +
      "updating to the new layout."
    );
    return "exists";
  }

  // Genuinely missing — safe to create fresh.
  const initIx = await program.methods
    .initializeSeller(new BN(price))
    .accounts({ authority: authority.publicKey, sellerProfile: pda })
    .instruction();
  const tx = new Transaction().add(initIx);

  await sendAndConfirmTransaction(connection, tx, [authority], {
    commitment: "confirmed",
  });
  return "created";
}

/**
 * record_payment moved to the buyer side (see lib.rs security note) — sellers
 * can no longer self-attest their own successful transactions. This file only
 * keeps record_failure, which stays seller-signed since self-reporting a
 * failure only ever hurts the seller's own score.
 */
export async function recordFailure(authority: Keypair) {
  const program = getProgram(authority);
  const [sellerProfile] = sellerProfilePda(authority.publicKey);
  return program.methods
    .recordFailure()
    .accounts({ authority: authority.publicKey, sellerProfile })
    .rpc();
}

export async function getSellerProfile(authority: Keypair, wallet: PublicKey) {
  const program = getProgram(authority);
  const [pda] = sellerProfilePda(wallet);
  const accounts = program.account as any;
  return accounts.sellerProfile.fetch(pda);
}

/**
 * Fetches every SellerProfile account the program owns — powers the leaderboard.
 * Decodes account-by-account and skips any that fail (pre-upgrade-layout
 * profiles still exist on devnet and are undecodable by design) rather than
 * letting one stale account take down the whole leaderboard.
 */
export async function listSellerProfiles(authority: Keypair) {
  const program = getProgram(authority);
  const connection = program.provider.connection;
  const raw = await connection.getProgramAccounts(PROGRAM_ID);

  const profiles = [];
  for (const { pubkey, account } of raw) {
    try {
      const decoded = program.coder.accounts.decode("sellerProfile", account.data);
      profiles.push({
        pubkey: pubkey.toBase58(),
        authority: decoded.authority.toBase58(),
        price: Number(decoded.price),
        reputationScore: Number(decoded.reputationScore),
        completedCount: Number(decoded.completedCount),
        failedCount: Number(decoded.failedCount),
        totalVolume: Number(decoded.totalVolume),
        distinctBuyers: Number(decoded.distinctBuyers),
        lastUpdated: Number(decoded.lastUpdated),
      });
    } catch {
      // Not a (current-layout) SellerProfile — old-layout profile, a
      // ProtocolConfig, or a BuyerSellerLink. Skip.
    }
  }
  return profiles;
}
