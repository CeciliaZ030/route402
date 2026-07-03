import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
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

/** Fetches every SellerProfile account the program owns — powers the leaderboard. */
export async function listSellerProfiles(authority: Keypair) {
  const program = getProgram(authority);
  const accounts = program.account as any;
  const all = await accounts.sellerProfile.all();
  return all.map((a: any) => ({
    pubkey: a.publicKey.toBase58(),
    authority: a.account.authority.toBase58(),
    price: Number(a.account.price),
    reputationScore: Number(a.account.reputationScore),
    completedCount: Number(a.account.completedCount),
    failedCount: Number(a.account.failedCount),
    totalVolume: Number(a.account.totalVolume),
  }));
}
