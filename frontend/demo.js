"use strict";
(function () {
  var SELLER_URL = window.SELLER_URL, BUYER_URL = window.BUYER_SERVER_URL;
  var SIG = /^[1-9A-HJ-NP-Za-km-z]{60,100}$/;
  var CONF_RANK = { High: 4, Medium: 3, Low: 2, Unknown: 1, Unrated: 0 };
  var agents = [];
  function $(s) { return document.querySelector(s); }
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k]; if (v == null || v === false) return;
      if (k === "class") el.className = v; else if (k === "text") el.textContent = v;
      else if (k.indexOf("on") === 0) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? "" : v);
    });
    for (var i = 2; i < arguments.length; i++) { var c = arguments[i]; if (c == null || c === false) continue; (Array.isArray(c) ? c : [c]).forEach(function (x) { el.append(x.nodeType ? x : document.createTextNode(String(x))); }); }
    return el;
  }
  function shortKey(k) { return k.slice(0, 4) + "..." + k.slice(-4); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function tier(a) { return a.completedCount >= 15 && a.reputationScore >= 90 ? "Elite" : a.completedCount >= 5 && a.reputationScore >= 70 ? "Trusted" : "New"; }

  function fetchJson(base, path, opts, ms) {
    var c = new AbortController(), t = setTimeout(function () { c.abort(); }, ms || 30000);
    return fetch(base + path, Object.assign({}, opts || {}, { signal: c.signal })).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (b) { return { ok: r.ok, status: r.status, body: b, aborted: false }; });
    }).catch(function (e) { return { ok: false, status: 0, body: null, aborted: !!(e && e.name === "AbortError") }; })
      .then(function (r) { clearTimeout(t); return r; });
  }

  function loadAgents() {
    $("#load-msg").textContent = "Loading live agents...";
    fetchJson(SELLER_URL, "/agents", null, 45000).then(function (r) {
      if (!(r.ok && Array.isArray(r.body) && r.body.length)) {
        $("#load-msg").textContent = "Could not load agents (the backend may be waking up). Retrying...";
        return setTimeout(loadAgents, 5000);
      }
      agents = r.body.slice().sort(function (a, b) { return b.reputationScore - a.reputationScore; });
      var sel = $("#agent-sel"); sel.textContent = "";
      agents.forEach(function (a) { sel.append(h("option", { value: a.pubkey, text: shortKey(a.pubkey) + " (reputation " + a.reputationScore + ", " + a.completedCount + " payments)" })); });
      $("#load-msg").textContent = agents.length + " live agents loaded from the Routex402 seller API.";
      $("#run").disabled = false;
    });
  }

  function step(title, tagText, tagCls) {
    var li = h("li", { "class": "step running" },
      h("span", { "class": "ic", "aria-hidden": "true", text: "…" }),
      h("h3", null, title, h("span", { "class": "tag " + tagCls, text: tagText })));
    $("#steps").append(li); return li;
  }
  function finish(li, state, icon, body) {
    li.className = "step " + state; li.querySelector(".ic").textContent = icon;
    (Array.isArray(body) ? body : [body]).forEach(function (b) { if (b) li.append(b.nodeType ? b : h("p", { text: b })); });
  }

  function evaluate(a, policy, checks, conf) {
    if (policy === "off") return [{ ok: true, text: "Policy is off, so no trust check was applied." }];
    var bi = checks.filter(function (c) { return c.id === "buyer-independence"; })[0];
    var rules = [
      { ok: a.reputationScore >= 80, text: "Reputation " + a.reputationScore + " (needs 80 or more)" },
      { ok: bi.status !== "fail", text: "Buyer independence: " + bi.detail }
    ];
    if (policy === "strict") rules.push({ ok: CONF_RANK[conf] >= CONF_RANK.Medium, text: "Confidence " + conf + " (needs Medium or higher)" });
    return rules;
  }

  async function run() {
    var btn = $("#run"); btn.disabled = true; $("#steps").textContent = "";
    var a = agents.filter(function (x) { return x.pubkey === $("#agent-sel").value; })[0];
    var policy = $("#policy-sel").value;
    try {
      var s1 = step("Agent states its intent", "Agent", "mock");
      await sleep(400);
      finish(s1, "done", "✓", "\"Pay seller " + shortKey(a.pubkey) + " " + (a.price / 1e6) + " USDC for a task.\"");

      var s2 = step("Look up the seller's reputation", "Live Routex402 data", "live");
      await sleep(500);
      var checks = runVettingChecks(a), conf = getConfidence(a);
      var out = { tool: "check_agent_reputation", input: { pubkey: a.pubkey },
        output: { reputationScore: a.reputationScore, tier: tier(a), confidence: conf,
          completed: a.completedCount, failed: a.failedCount, distinctBuyers: (a.distinctBuyers === 0 && a.completedCount > 0) ? "not recorded" : a.distinctBuyers,
          vetting: checks.map(function (c) { return { check: c.id, status: c.status }; }),
          note: "Informational only. Proposed tool shape, not a published API." } };
      finish(s2, "done", "✓", [h("p", { text: "The agent calls a Routex402 tool. This is the data it gets back:" }), h("pre", { "class": "code", text: JSON.stringify(out, null, 2) })]);

      var s3 = step("Policy decides whether to continue", "Live data, local rules", "live");
      await sleep(500);
      var rules = evaluate(a, policy, checks, conf);
      var failed = rules.filter(function (r) { return !r.ok; });
      var ul = h("ul", { "class": "rules" }, rules.map(function (r) { return h("li", null, h("span", { "class": "badge " + (r.ok ? "b-pass" : "b-fail"), text: r.ok ? "✓ Pass" : "✕ Fail" }), r.text); }));
      if (failed.length) {
        finish(s3, "blocked", "✕", [h("p", { text: "Blocked. No transaction was built and no money moved." }), ul]);
        ["Simulate the transaction", "Approve and sign", "Record buyer-signed reputation"].forEach(function (t) { var sk = step(t, "Skipped", "mock"); finish(sk, "skipped", "-", "Skipped because the policy blocked this payment."); });
        $("#steps").append(h("li", { "class": "result err", text: "Try another seller, or set the policy to Off, to see the full flow." }));
        return;
      }
      finish(s3, "done", "✓", [h("p", { text: "Allowed." }), ul]);

      var s4 = step("Simulate the transaction", "Mocked", "mock");
      await sleep(900);
      finish(s4, "done", "✓", "Illustrative only. A real execution layer would rehearse this on forked chain state before anything is signed. Nothing was simulated here.");

      var s5 = step("Approve and sign", "Real devnet payment", "real");
      s5.className = "step running";
      var go = h("button", { "class": "btn btn-primary", type: "button" }, "Approve and sign");
      var msg = h("p", { "class": "muted", text: "This runs the live demo payment on Solana devnet. It always pays the demo seller, whichever seller you picked above." });
      s5.append(msg, go);
      await new Promise(function (resolve) { go.addEventListener("click", resolve, { once: true }); });
      go.disabled = true; go.textContent = "Signing...";
      msg.textContent = "Waiting for the backend. On the free tier the first request after idle can take up to about 90 seconds. Please keep this tab open.";
      var started = Date.now();
      var tick = setInterval(function () { go.textContent = "Signing... " + Math.floor((Date.now() - started) / 1000) + "s"; }, 1000);
      var res = await fetchJson(BUYER_URL, "/demo-purchase", { method: "POST" }, 120000);
      clearInterval(tick);
      go.remove();
      if (res.ok && res.body && res.body.success) {
        var sig = SIG.test(res.body.signature || "") ? res.body.signature : "";
        finish(s5, "done", "✓", [sig ? h("a", { href: "https://solscan.io/tx/" + sig + "?cluster=devnet", target: "_blank", rel: "noopener", text: "View payment on Solscan" }) : "Payment settled."]);
        var s6 = step("Record buyer-signed reputation", "Real devnet transaction", "real");
        var rs = res.body.reputationTxSignature;
        finish(s6, "done", "✓", [h("p", { text: "The buyer's own wallet signed the reputation update. This is the step a seller cannot do for itself." }),
          SIG.test(rs || "") ? h("a", { href: "https://solscan.io/tx/" + rs + "?cluster=devnet", target: "_blank", rel: "noopener", text: "View reputation update on Solscan" }) : null]);
        $("#steps").append(h("li", { "class": "result ok", text: "Done. The seller's score now reflects a payment the buyer signed for." }));
      } else {
        var why = res.aborted ? "The backend is waking up. Try again in a moment." : res.status === 429 ? "Too many demo payments. Try again in a minute." : "The backend could not be reached or rejected the request.";
        finish(s5, "blocked", "✕", why);
      }
    } catch (e) {
      $("#steps").append(h("li", { "class": "result err", text: "Something went wrong. Reload and try again." }));
    } finally { btn.disabled = false; }
  }

  $("#run").addEventListener("click", run);
  loadAgents();
  // Wake the buyer in the background so the first real payment is faster. no-cors: we only need the request to land.
  try { fetch(BUYER_URL + "/", { mode: "no-cors" }).catch(function () {}); } catch (e) {}
})();
