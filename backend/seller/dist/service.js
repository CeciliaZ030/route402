/**
 * The actual paid service. Replaces the original hardcoded string response —
 * "pay an agent for a task" should be concretely true, not illustrative.
 *
 * The work is deliberately deterministic-compute over a live data feed the
 * seller already depends on (its own Solana RPC connection): fetch recent
 * network performance samples and summarize them into a report. Real work,
 * zero new external dependencies, no per-call API cost.
 */
export const SUPPORTED_TASKS = ["network-report"];
export function isSupportedTask(task) {
    return SUPPORTED_TASKS.includes(task);
}
export async function performService(connection, task, params = {}) {
    // Only one task today; the switch keeps the seam obvious for adding more.
    switch (task) {
        case "network-report":
            return networkReport(connection, params);
    }
}
async function networkReport(connection, params) {
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
    const avgTps = tpsValues.length > 0
        ? tpsValues.reduce((sum, v) => sum + v, 0) / tpsValues.length
        : 0;
    const peakTps = tpsValues.length > 0 ? Math.max(...tpsValues) : 0;
    const epochProgressPct = (epochInfo.slotIndex / epochInfo.slotsInEpoch) * 100;
    const data = {
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
    const summary = `Devnet network report: slot ${slot}, epoch ${data.epoch} ` +
        `(${data.epochProgressPct}% complete), avg ${data.avgTps} TPS ` +
        `(peak ${data.peakTps}) over the last ${data.samples} minute(s).`;
    return { summary, data };
}
