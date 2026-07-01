const SELLER_URL = window.SELLER_URL || "http://localhost:4021";
const BUYER_SERVER_URL = window.BUYER_SERVER_URL || "http://localhost:4022";
const POLL_INTERVAL_MS = 3000;

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
    console.error(`Failed to fetch ${path}:`, err);
    return { ok: false, status: 0, body: null };
  }
}

function renderHighway(agents) {
  highwayEl.innerHTML = "";
  const spacing = 100 / (agents.length + 1);

  agents.forEach((agent, i) => {
    const node = document.createElement("div");
    node.className = "agent-node";
    node.style.left = `${spacing * (i + 1)}%`;
    node.innerHTML = `
      <div class="badge">${initials(agent.pubkey)}</div>
      <div class="name">${shortAddr(agent.pubkey)}</div>
    `;
    node.addEventListener("click", () => showExpanded(agent));
    highwayEl.appendChild(node);

    const previous = lastCompletedCounts[agent.pubkey] ?? agent.completedCount;
    if (agent.completedCount > previous) {
      spawnPacket();
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

function renderActivity(events) {
  if (!events || events.length === 0) {
    activityListEl.innerHTML = `<div class="activity-empty">No activity yet — click "Run purchase" above to see it live.</div>`;
    return;
  }
  activityListEl.innerHTML = events
    .map((e) => {
      const color = STEP_COLORS[e.step] || "var(--text-secondary)";
      return `
    <div class="activity-row">
      <span class="activity-time">${formatTime(e.timestamp)}</span>
      <span class="activity-dot" style="background:${color}"></span>
      <span class="activity-step" style="color:${color}">${e.step}</span>
      <span class="activity-message">${formatMessage(e.message)}</span>
    </div>
  `;
    })
    .join("");
}

function renderLeaderboard(agents) {
  leaderboardListEl.innerHTML = "";
  const sorted = [...agents].sort((a, b) => b.reputationScore - a.reputationScore);

  sorted.forEach((agent, i) => {
    const row = document.createElement("div");
    row.className = "lb-row";
    row.innerHTML = `
      <span class="lb-rank">${i + 1}</span>
      <div style="flex:1">
        <div class="lb-name">${shortAddr(agent.pubkey)}</div>
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
  expandedEl.hidden = false;
  expandedContentEl.innerHTML = `
    <div style="font-size:15px;font-weight:500">${shortAddr(agent.pubkey)}</div>
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
  `;
}

closeExpandedBtn.addEventListener("click", () => {
  expandedEl.hidden = true;
});

runPurchaseBtn.addEventListener("click", async () => {
  runPurchaseBtn.disabled = true;
  runPurchaseBtn.textContent = "Purchasing...";
  runPurchaseBtn.classList.remove("state-success", "state-error");

  const { ok, body } = await fetchJson(BUYER_SERVER_URL, "/purchase", { method: "POST" });

  if (ok && body?.success) {
    runPurchaseBtn.textContent = "Purchase complete";
    runPurchaseBtn.classList.add("state-success");
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

// Rewrites raw "base units" mentions in log messages to human-readable USDC.
function formatMessage(message) {
  return message.replace(/(\d+) base units/, (_match, amount) => formatUsdc(Number(amount)));
}

async function tick() {
  const [agentsRes, eventsRes] = await Promise.all([
    fetchJson(SELLER_URL, "/agents"),
    fetchJson(SELLER_URL, "/events"),
  ]);
  if (agentsRes.ok && agentsRes.body) {
    renderHighway(agentsRes.body);
    renderLeaderboard(agentsRes.body);
  }
  if (eventsRes.ok && eventsRes.body) {
    renderActivity(eventsRes.body);
  }
}

tick();
setInterval(tick, POLL_INTERVAL_MS);