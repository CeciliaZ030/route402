import { runPurchase } from "./purchase.js";

async function main() {
  console.log("Requesting service...");
  const outcome = await runPurchase();

  if (outcome.success) {
    console.log(`Payment sent, signature: ${outcome.signature}`);
    console.log(`Purchase complete. Result: ${outcome.result}`);
  } else {
    console.log(outcome.message);
  }
}

main().catch((err) => {
  console.error("Buyer script failed:", err);
  process.exit(1);
});
