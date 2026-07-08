import { Connection } from "@solana/web3.js";

/**
 * The actual paid service. Replaces the original hardcoded string response —
 * "pay an agent for a task" should be concretely true, not illustrative.
 *
 * The work is deliberately deterministic-compute over a live data feed the
 * seller already depends on (its own Solana RPC connection): fetch recent
 * network performance samples and summarize them into a report. Real work,
 * zero new external dependencies, no per-call API cost.
 */

export const SUPPORTED_TASKS = ["network-report"] as const;
export type Task = (typeof SUPPORTED_TASKS)[number];

export interface ServiceParams {
  /** How many recent 60s performance samples to aggregate (1-10, default 5). */
  sampleCount?: number;
}

export interface NetworkReport {
  cluster: string;
  slot: number;
  blockHeight: number;
  epoch: number;
  epochProgressPct: number;
  samples: number;
  avgTps: number;
  peakTps: number;
  generatedAt: string;
}

export function isSupportedTask(task: string): task is Task {
  return (SUPPORTED_TASKS as readonly string[]).includes(task);
}

export async function performService(
  connection: Connection,
  task: Task,
  params: ServiceParams = {}
): Promise<{ summary: string; data: NetworkReport }> {
  // Only one task today; the switch keeps the seam obvious for adding more.
  switch (task) {
    case "network-report":
      return networkReport(connection, params);
  }
}

async function networkReport(
  connection: Connection,
  params: ServiceParams
): Promise<{ summary: string; data: NetworkReport }> {
  const sampleCount = Math.min(Math.max(Math.trunc(params.sampleCount ?? 5), 1), 10);

  const [slot, blockHeight, epochInfo, samples] = await Promise.all([
    connection.getSlot(),
    connection.getBlockHeight(),
    connection.getEpochInfo(),
    connection.getRecentPerformanceSamples(sampleCount),
  ]);

  const tpsValues = samples
    .filter((s) => s.samplePeriodSecs > 0)
    .map((s) => s.numTransactions / s.samplePeriodSecs);
  const avgTps =
    tpsValues.length > 0
      ? tpsValues.reduce((sum, v) => sum + v, 0) / tpsValues.length
      : 0;
  const peakTps = tpsValues.length > 0 ? Math.max(...tpsValues) : 0;

  const epochProgressPct = (epochInfo.slotIndex / epochInfo.slotsInEpoch) * 100;

  const data: NetworkReport = {
    cluster: "devnet",
    slot,
    blockHeight,
    epoch: epochInfo.epoch,
    epochProgressPct: Number(epochProgressPct.toFixed(2)),
    samples: tpsValues.length,
    avgTps: Number(avgTps.toFixed(1)),
    peakTps: Number(peakTps.toFixed(1)),
    generatedAt: new Date().toISOString(),
  };

  const summary =
    `Devnet network report: slot ${slot}, epoch ${data.epoch} ` +
    `(${data.epochProgressPct}% complete), avg ${data.avgTps} TPS ` +
    `(peak ${data.peakTps}) over the last ${data.samples} minute(s).`;

  return { summary, data };
}
