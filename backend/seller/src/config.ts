import { PublicKey } from "@solana/web3.js";

// --- Devnet-only config. Do not point this at mainnet for the hackathon build. ---

export const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

// Devnet USDC mint (Circle's official devnet mint).
export const USDC_MINT = new PublicKey("EKFUzCYkafhGWDArX2QVr1E4cGydnyk1R6pwP9j3ztFC");

// Price for the seller's service, in USDC base units (6 decimals). 0.01 USDC.
export const SERVICE_PRICE = 10_000;

export const PORT = Number(process.env.PORT ?? 4021);
