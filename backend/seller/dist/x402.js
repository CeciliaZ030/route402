import { Connection } from "@solana/web3.js";
import { RPC_URL, SERVICE_PRICE, USDC_MINT } from "./config.js";
const connection = new Connection(RPC_URL, "confirmed");
export function buildPaymentRequirements(sellerTokenAccount, sellerAuthority, protocolFeeBps) {
    // Gross-up so the seller still nets the full price after the fee split:
    // program computes fee = floor(gross * bps / 10000), seller gets the rest.
    const grossAmount = protocolFeeBps > 0
        ? Math.ceil((SERVICE_PRICE * 10_000) / (10_000 - protocolFeeBps))
        : SERVICE_PRICE;
    return {
        scheme: "exact",
        network: "solana-devnet",
        amount: SERVICE_PRICE,
        asset: USDC_MINT.toBase58(),
        payTo: sellerTokenAccount,
        sellerAuthority,
        protocolFeeBps,
        grossAmount,
    };
}
export async function verifyPayment(signature, sellerTokenAccount) {
    const tx = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
    });
    if (!tx) {
        return { ok: false, reason: "transaction not found on devnet" };
    }
    if (tx.meta?.err) {
        return { ok: false, reason: "transaction failed on-chain" };
    }
    // Scan top-level AND inner instructions: with pay_and_record the token
    // transfer happens via CPI inside the program instruction, so it only
    // appears in meta.innerInstructions. Legacy plain transfers stay top-level.
    const instructions = [
        ...tx.transaction.message.instructions,
        ...(tx.meta?.innerInstructions ?? []).flatMap((inner) => inner.instructions),
    ];
    for (const ix of instructions) {
        if (ix.program !== "spl-token")
            continue;
        const parsed = ix.parsed;
        if (!parsed || (parsed.type !== "transferChecked" && parsed.type !== "transfer"))
            continue;
        const info = parsed.info;
        const mint = info.mint;
        if (mint && mint !== USDC_MINT.toBase58())
            continue;
        const rawAmount = info.tokenAmount?.amount ?? info.amount;
        const amountPaid = Number(rawAmount);
        if (info.destination !== sellerTokenAccount)
            continue;
        if (amountPaid < SERVICE_PRICE) {
            return { ok: false, reason: "amount below required price", amountPaid };
        }
        return { ok: true, amountPaid };
    }
    return { ok: false, reason: "no matching token transfer found in transaction" };
}
export { connection };
