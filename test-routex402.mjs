import { Keypair, Connection, PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddress, createTransferCheckedInstruction, getAccount } from "@solana/spl-token";
import { readFileSync } from "fs";
import { homedir } from "os";

const keyData = JSON.parse(readFileSync(homedir() + "/.config/solana/id.json"));
const buyer = Keypair.fromSecretKey(Uint8Array.from(keyData));
const conn = new Connection("https://api.devnet.solana.com", "confirmed");

console.log("Buyer:", buyer.publicKey.toBase58());

// Step 1: Get 402 challenge
console.log("\n1. Requesting service...");
const r = await fetch("http://localhost:4021/service", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ task: "network-report" })
});
const challenge = await r.json();
console.log("Status:", r.status);
console.log("Pay:", challenge.paymentRequirements.amount / 1e6, "USDC to", challenge.paymentRequirements.payTo);

// Step 2: Pay
console.log("\n2. Sending USDC payment...");
const USDC = new PublicKey(challenge.paymentRequirements.asset);
const payTo = new PublicKey(challenge.paymentRequirements.payTo);
const amount = BigInt(challenge.paymentRequirements.grossAmount);

const buyerAta = await getAssociatedTokenAddress(USDC, buyer.publicKey);
const bal = await getAccount(conn, buyerAta);
console.log("Balance:", Number(bal.amount) / 1e6, "USDC");

const tx = new Transaction().add(
  createTransferCheckedInstruction(buyerAta, USDC, payTo, buyer.publicKey, amount, 6)
);
tx.feePayer = buyer.publicKey;
tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
tx.sign(buyer);

const sig = await conn.sendRawTransaction(tx.serialize());
await conn.confirmTransaction(sig, "confirmed");
console.log("Paid! Tx:", sig);

// Step 3: Claim service with payment proof
console.log("\n3. Claiming service with payment proof...");
const paid = await fetch("http://localhost:4021/service", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ task: "network-report", paymentSignature: sig })
});
const result = await paid.json();
console.log("Status:", paid.status);
console.log("Result:", JSON.stringify(result, null, 2));
