import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import BN from "bn.js";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import fs from "node:fs";
import idl from "./src/idl/agent_economy.json" with { type: "json" };

const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey("6pp5jDS23FBcwtqe8pTiBJw3osyHZQPENr9bK3P62vjt");

// Price for the seller's service, in USDC base units (6 decimals). 0.01 USDC.
const SERVICE_PRICE = 10_000;

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(path, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main() {
  const authority = loadKeypair("./seller-keypair.json");
  const connection = new Connection(RPC_URL, "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(authority), {
    commitment: "confirmed",
  });
  const program = new Program(idl as any, provider) as any;

  const [sellerProfile] = PublicKey.findProgramAddressSync(
    [Buffer.from("seller"), authority.publicKey.toBuffer()],
    PROGRAM_ID
  );

  console.log(`Seller wallet: ${authority.publicKey.toBase58()}`);
  console.log(`SellerProfile PDA: ${sellerProfile.toBase58()}`);

  const existing = await connection.getAccountInfo(sellerProfile);
  if (existing) {
    console.log("SellerProfile already exists — nothing to do.");
    return;
  }

  const sig = await program.methods
    .initializeSeller(new BN(SERVICE_PRICE))
    .accounts({
      authority: authority.publicKey,
      sellerProfile,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log(`SellerProfile initialized. Signature: ${sig}`);
}

main().catch((err) => {
  console.error("Failed to initialize seller profile:", err);
  process.exit(1);
});