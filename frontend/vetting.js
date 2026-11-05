// Routex402 vetting helpers. Uses only fields the seller API returns.
// distinctBuyers === 0 with completedCount > 0 is a known data gap from an
// earlier migration, so it is reported as "unknown", never as a failure.

function getConfidence(agent) {
  const c = agent.completedCount;
  const b = agent.distinctBuyers;
  if (c < 5) return "Unrated";
  if (b === 0) return "Unknown";
  if (c >= 15 && b >= 5) return "High";
  if (b >= 2) return "Medium";
  return "Low";
}

function runVettingChecks(agent, nowSec) {
  const now = nowSec || Math.floor(Date.now() / 1000);
  const c = agent.completedCount;
  const f = agent.failedCount;
  const b = agent.distinctBuyers;
  const total = c + f;
  const rate = total === 0 ? 0 : (c / total) * 100;
  const ageDays = (now - agent.lastUpdated) / 86400;
  const checks = [];

  checks.push({
    id: "track-record",
    label: "Track record",
    status: c >= 15 ? "pass" : c >= 5 ? "caution" : "fail",
    detail: c + " completed payments" + (c < 5 ? " (not enough history to rate)" : ""),
  });

  checks.push({
    id: "success-rate",
    label: "Success rate",
    status: total === 0 ? "unknown" : rate >= 95 ? "pass" : rate >= 80 ? "caution" : "fail",
    detail: total === 0 ? "No payments recorded yet" : rate.toFixed(1) + "% (" + c + " ok, " + f + " failed)",
  });

  let bStatus;
  let bDetail;
  if (c > 0 && b === 0) {
    bStatus = "unknown";
    bDetail = "Distinct buyer count not recorded for this agent";
  } else if (b >= 5) {
    bStatus = "pass";
    bDetail = b + " distinct buyers";
  } else if (b >= 2) {
    bStatus = "caution";
    bDetail = "Only " + b + " distinct buyers";
  } else if (b === 1 && c >= 10) {
    bStatus = "fail";
    bDetail = c + " payments from a single buyer";
  } else {
    bStatus = "unknown";
    bDetail = "Too little history to judge";
  }
  checks.push({ id: "buyer-independence", label: "Buyer independence", status: bStatus, detail: bDetail });

  // Volume consistency: totalVolume should be close to price * completed.
  // Allow 5% drift for protocol fees.
  const expected = agent.price * c;
  if (!agent.price || c === 0) {
    checks.push({ id: "volume", label: "Volume consistency", status: "unknown", detail: "Not enough data to compare" });
  } else {
    const drift = Math.abs(agent.totalVolume - expected) / expected;
    checks.push({
      id: "volume",
      label: "Volume consistency",
      status: drift <= 0.05 ? "pass" : "caution",
      detail: "Volume is within " + (drift * 100).toFixed(1) + "% of price x payments",
    });
  }

  checks.push({
    id: "recency",
    label: "Recent activity",
    status: ageDays <= 7 ? "pass" : ageDays <= 30 ? "caution" : "fail",
    detail: "Last update " + Math.floor(ageDays) + " days ago",
  });

  return checks;
}

if (typeof module !== "undefined") module.exports = { getConfidence, runVettingChecks };
