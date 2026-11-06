import { Keypair, Connection, PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddress, createTransferCheckedInstruction, getAccount } from "@solana/spl-token";
import { readFileSync } from "fs";
import { homedir } from "os";

const keyData = JSON.parse(readFileSync(homedir() + "/.config/solana/id.json"));
const buyer = Keypair.fromSecretKey(Uint8Array.from(keyData));
console.log("Wallet:", buyer.publicKey.toBase58());

// Step 1: Get 402 challenge
console.log("\n1. Hitting Bourse endpoint...");
const r = await fetch("https://usebourse.xyz/api/x402/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ model: "any", messages: [{ role: "user", content: "What is x402?" }] })
});
console.log("Status:", r.status);

if (r.status !== 402) {
  console.log("Body:", await r.text());
  process.exit(0);
}

// Decode payment challenge
const pr = JSON.parse(atob(r.headers.get("payment-required")));
const pay = pr.accepts[0];
console.log("Pay:", pay.amount / 1e6, "USDC to", pay.payTo);

// Step 2: Sign USDC transfer on devnet
console.log("\n2. Signing USDC transfer...");
const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const USDC = new PublicKey(pay.asset);
const receiver = new PublicKey(pay.payTo);

const buyerAta = await getAssociatedTokenAddress(USDC, buyer.publicKey);
const receiverAta = await getAssociatedTokenAddress(USDC, receiver);

try {
  const acct = await getAccount(conn, buyerAta);
  console.log("USDC balance:", Number(acct.amount) / 1e6);
} catch {
  console.log("No USDC! Get devnet USDC from https://faucet.payai.network");
  console.log("Your address:", buyer.publicKey.toBase58());
  process.exit(1);
}

const tx = new Transaction().add(
  createTransferCheckedInstruction(buyerAta, USDC, receiverAta, buyer.publicKey, BigInt(pay.amount), 6)
);
tx.feePayer = pay.extra?.feePayer ? new PublicKey(pay.extra.feePayer) : buyer.publicKey;
tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
tx.sign(buyer);

const raw = tx.serialize({ requireAllSignatures: false });
const payment = Buffer.from(raw).toString("base64");

// Step 3: Retry with payment
console.log("\n3. Retrying with payment...");
const paid = await fetch("https://usebourse.xyz/api/x402/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-PAYMENT": payment },
  body: JSON.stringify({ model: "any", messages: [{ role: "user", content: "What is x402?" }] })
});

console.log("Status:", paid.status);
console.log("Response:", await paid.text());
