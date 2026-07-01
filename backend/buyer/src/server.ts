import express from "express";
import cors from "cors";
import { runPurchase } from "./purchase.js";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.BUYER_SERVER_PORT ?? 4022);

app.post("/purchase", async (_req, res) => {
  try {
    const outcome = await runPurchase();
    res.status(outcome.success ? 200 : 502).json(outcome);
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message ?? "Unknown error" });
  }
});

app.listen(PORT, () => {
  console.log(`Buyer demo server listening on http://localhost:${PORT}`);
  console.log(`POST /purchase to trigger a purchase.`);
});
