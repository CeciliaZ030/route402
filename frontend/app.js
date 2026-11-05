// Production URLs are injected by index.html before this script loads.
// For local dev against a local backend, add ?backend=local to the URL.
// For local dev against production (read-only), no query param needed.
const _params = new URLSearchParams(window.location.search);
const SELLER_URL = _params.get("backend") === "local"
  ? "http://localhost:4021"
  : (window.SELLER_URL || "http://localhost:4021");
const BUYER_SERVER_URL = _params.get("backend") === "local"
  ? "http://localhost:4022"
  : (window.BUYER_SERVER_URL || "http://localhost:4022");
const POLL_INTERVAL_MS = 3000;
const SOLSCAN_CLUSTER = "devnet";

// Off-chain display names for known demo agents. Purely cosmetic, the program
// itself has no concept of names, only pubkeys. Update this after running
// scripts/seed-agent.ts for the two new demo agents with their real pubkeys.
const AGENT_NAMES = {
  "5gseLVMr6PZJmeQ5t56hFbq9G6iXtdcPU4uodzWvZfxm": "Agent Alpha",
  "5hWGqa3VMCawnVTBvf3YVsCPkgpJxAd9QVeehisBUTq5": "Agent Beta",
  "EXzH2oDbHb6a6cAWPdU9Mp42xbKDg8a5gZswtT5Z83d9": "Agent Gamma",
};

const highwayEl = document.getElementById("highway");
const activityListEl = document.getElementById("activity-list");
const leaderboardListEl = document.getElementById("leaderboard-list");
const expandedEl = document.getElementById("expanded");
const expandedContentEl = document.getElementById("expanded-content");
const closeExpandedBtn = document.getElementById("close-expanded");
const runPurchaseBtn = document.getElementById("run-purchase");

let lastCompletedCounts = {};

const STEP_COLORS = {
  receive_request: "var(--step-request)",
  "402_challenge": "var(--step-challenge)",
  verify_payment: "var(--step-verify)",
  reputation_update: "var(--step-reputation)",
  deliver_result: "var(--step-deliver)",
};

async function fetchJson(baseUrl, path, options) {
  try {
    const res = await fetch(`${baseUrl}${path}`, options);
    const body = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    const aborted = err?.name === "AbortError";
    console.error(`Failed to fetch ${path}:`, err);
    return { ok: false, status: 0, body: null, aborted };
  }
}

/**
 * Tier badge based on reputation score AND completed count. A seller needs
 * both a high success rate AND a real amount of history to earn a high tier.
 * This stops a seller with 1 lucky completed transaction (100% reputation)
 * from outranking a seller with 20 completed transactions at 90%.
 */
function getTier(agent) {
  if (agent.completedCount >= 15 && agent.reputationScore >= 90) {
    return { label: "Elite", color: "var(--accent-purple)" };
  }
  if (agent.completedCount >= 5 && agent.reputationScore >= 70) {
    return { label: "Trusted", color: "var(--accent-green)" };
  }
  return { label: "New", color: "var(--text-muted)" };
}

function displayName(pubkey) {
  return AGENT_NAMES[pubkey] || shortAddr(pubkey);
}

function renderHighway(agents) {
  highwayEl.innerHTML = "";
  const spacing = 100 / (agents.length + 1);

  agents.forEach((agent, i) => {
    const tier = getTier(agent);
    const node = document.createElement("div");
    node.className = "agent-node";
    node.style.left = `${spacing * (i + 1)}%`;
    node.innerHTML = `
      <div class="badge">${initials(agent.pubkey)}</div>
      <div class="name">${displayName(agent.pubkey)}</div>
      <div class="node-tier" style="color:${tier.color}">${tier.label}</div>
    `;
    node.addEventListener("click", () => showExpanded(agent));
    highwayEl.appendChild(node);

    const previous = lastCompletedCounts[agent.pubkey] ?? agent.completedCount;
    if (agent.completedCount > previous) {
      spawnPacket();
      node.classList.add("node-active");
      setTimeout(() => node.classList.remove("node-active"), 1800);
    }
    lastCompletedCounts[agent.pubkey] = agent.completedCount;
  });
}

function spawnPacket() {
  const packet = document.createElement("div");
  packet.className = "tx-packet";
  highwayEl.appendChild(packet);
  packet.addEventListener("animationend", () => packet.remove());
}

function solscanTxUrl(signature) {
  return `https://solscan.io/tx/${signature}?cluster=${SOLSCAN_CLUSTER}`;
}

function renderActivity(events) {
  if (!events || events.length === 0) {
    activityListEl.innerHTML = `<div class="activity-empty">No activity yet. Click "Run purchase" above to see it live.</div>`;
    return;
  }
  activityListEl.innerHTML = events
    .map((e) => {
      const color = STEP_COLORS[e.step] || "var(--text-secondary)";
      const link = e.signature
        ? `<a class="solscan-link" href="${solscanTxUrl(e.signature)}" target="_blank" rel="noopener">View &#8599;</a>`
        : "";
      return `
    <div class="activity-row">
      <span class="activity-time">${formatTime(e.timestamp)}</span>
      <span class="activity-dot" style="background:${color}"></span>
      <span class="activity-step" style="color:${color}">${e.step}</span>
      <span class="activity-message">${formatMessage(e.message)}</span>
      ${link}
    </div>
  `;
    })
    .join("");
}

function renderLeaderboard(agents) {
  leaderboardListEl.innerHTML = "";
  const sorted = [...agents].sort((a, b) => b.reputationScore - a.reputationScore);
  const medals = ["\u{1F947}", "\u{1F948}", "\u{1F949}"];

  sorted.forEach((agent, i) => {
    const tier = getTier(agent);
    const row = document.createElement("div");
    row.className = "lb-row";
    row.innerHTML = `
      <span class="lb-rank">${medals[i] || i + 1}</span>
      <div style="flex:1">
        <div class="lb-name">${displayName(agent.pubkey)} <span class="lb-tier" style="color:${tier.color}">${tier.label}</span></div>
        <div class="lb-sub">${agent.completedCount} completed &middot; ${formatUsdc(agent.totalVolume)} volume</div>
      </div>
      <div style="text-align:right">
        <div class="lb-score">${agent.reputationScore}</div>
        <div class="lb-score-label">reputation</div>
      </div>
    `;
    row.addEventListener("click", () => showExpanded(agent));
    leaderboardListEl.appendChild(row);
  });
}

function showExpanded(agent) {
  const tier = getTier(agent);
  expandedEl.hidden = false;
  expandedContentEl.innerHTML = `
    <div style="font-size:15px;font-weight:500">${displayName(agent.pubkey)} <span class="lb-tier" style="color:${tier.color}">${tier.label}</span></div>
    <div class="stat-grid">
      <div class="stat-card"><div class="label">Reputation</div><div class="value">${agent.reputationScore}</div></div>
      <div class="stat-card"><div class="label">Completed</div><div class="value">${agent.completedCount}</div></div>
      <div class="stat-card"><div class="label">Failed</div><div class="value">${agent.failedCount}</div></div>
      <div class="stat-card"><div class="label">Volume</div><div class="value">${formatUsdc(agent.totalVolume)}</div></div>
    </div>
    <div class="pipeline-label">Pipeline</div>
    <div class="pipeline">
      <div class="pipeline-step">Receive request</div>
      <div class="pipeline-step">402 challenge</div>
      <div class="pipeline-step">Verify payment</div>
      <div class="pipeline-step">Deliver result</div>
    </div>
    <a class="solscan-link" style="display:inline-block;margin-top:1rem" href="https://solscan.io/account/${agent.pubkey}?cluster=${SOLSCAN_CLUSTER}" target="_blank" rel="noopener">View this agent's on-chain account &#8599;</a>
  `;
}

closeExpandedBtn.addEventListener("click", () => {
  expandedEl.hidden = true;
});

runPurchaseBtn.addEventListener("click", async () => {
  runPurchaseBtn.disabled = true;
  runPurchaseBtn.textContent = "Purchasing...";
  runPurchaseBtn.classList.remove("state-success", "state-error");

  // 55s timeout — Render free-tier can take 50s+ to cold-start. Without this
  // the fetch hangs indefinitely and the button stays stuck on "Purchasing...".
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 55_000);

  const { ok, body, aborted } = await fetchJson(BUYER_SERVER_URL, "/demo-purchase", {
    method: "POST",
    signal: controller.signal,
  });
  clearTimeout(timeoutId);

  if (ok && body?.success) {
    runPurchaseBtn.textContent = "Purchase complete";
    runPurchaseBtn.classList.add("state-success");
  } else if (aborted) {
    runPurchaseBtn.textContent = "Backend waking up — try again in a moment";
    runPurchaseBtn.classList.add("state-error");
  } else {
    runPurchaseBtn.textContent = "Purchase failed";
    runPurchaseBtn.classList.add("state-error");
    console.error("Purchase failed:", body);
  }

  await tick();

  setTimeout(() => {
    runPurchaseBtn.disabled = false;
    runPurchaseBtn.textContent = "Run purchase";
    runPurchaseBtn.classList.remove("state-success", "state-error");
  }, 2500);
});

function initials(pubkey) {
  return pubkey.slice(0, 2).toUpperCase();
}

function shortAddr(pubkey) {
  return `${pubkey.slice(0, 4)}...${pubkey.slice(-4)}`;
}

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatUsdc(baseUnits) {
  return `${(baseUnits / 1_000_000).toFixed(2)} USDC`;
}

function formatMessage(message) {
  return message.replace(/(\d+) base units/, (_match, amount) => formatUsdc(Number(amount)));
}

async function tick() {
  const [agentsRes, eventsRes] = await Promise.all([
    fetchJson(SELLER_URL, "/agents"),
    fetchJson(SELLER_URL, "/events"),
  ]);
  if (agentsRes.ok && agentsRes.body) {
    const agents = agentsRes.body;
    renderHighway(agents);
    renderLeaderboard(agents);
  }
  if (eventsRes.ok && eventsRes.body) {
    renderActivity(eventsRes.body);
  }
}

tick();
setInterval(tick, POLL_INTERVAL_MS);

const menuToggle = document.getElementById("menu-toggle");
const menuDropdown = document.getElementById("menu-dropdown");
if (menuToggle && menuDropdown) {
  menuToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    menuDropdown.hidden = !menuDropdown.hidden;
  });
  document.addEventListener("click", (e) => {
    if (!menuDropdown.hidden && !menuDropdown.contains(e.target) && e.target !== menuToggle) {
      menuDropdown.hidden = true;
    }
  });
}
