"use strict";

// ---------- inline SVG icon set (replaces emoji toolbar glyphs) ----------

const ICONS = {
  refresh: '<path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M3 21v-5h5"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.07 0l2.83-2.83a5 5 0 0 0-7.07-7.07L11.5 4.5"/><path d="M14 11a5 5 0 0 0-7.07 0L4.1 13.83a5 5 0 0 0 7.07 7.07L12.5 19.5"/>',
  bolt: '<path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
};

function icon(name) {
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
}

// ---------- theme (dark default, light optional, persisted) ----------

const themeToggleBtn = document.getElementById("theme-toggle");

function paintThemeToggle() {
  const light = document.documentElement.dataset.theme === "light";
  themeToggleBtn.innerHTML = icon(light ? "sun" : "moon");
}
paintThemeToggle();
themeToggleBtn.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("theme", next);
  paintThemeToggle();
});

// ---------- mode: compact popup vs full-screen dashboard tab ----------

const PARAMS = new URLSearchParams(location.search);
const FULL = PARAMS.get("mode") === "full";

if (FULL) {
  document.body.classList.add("full");
  document.getElementById("open-full").hidden = true;
  // "Current Tab" is meaningless inside a dedicated tab — the active tab is this dashboard.
  document.getElementById("tab-current").hidden = true;
}

// Sidebar-switched pages (Compare/History/Settings) only exist in full-dashboard
// mode. Declared here, at module scope, so code outside the FULL boot block
// (e.g. re-running a history entry) can jump back to the compare page without
// caring whether a sidebar exists at all — a no-op in compact-popup mode.
let dashPages = null;
function showDashPage(which) {
  if (!dashPages) return;
  for (const key of Object.keys(dashPages)) dashPages[key].hidden = key !== which;
  document.querySelectorAll(".side-link").forEach((b) => b.classList.toggle("active", b.dataset.page === which));
}

document.getElementById("open-full").addEventListener("click", async () => {
  let url = "";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && /^https?:/.test(tab.url || "")) url = tab.url;
  } catch (e) {}
  chrome.tabs.create({
    url: chrome.runtime.getURL(
      "popup.html?mode=full" + (url ? "&url=" + encodeURIComponent(url) : "")
    ),
  });
});

// ---------- tab switching ----------

const viewCurrent = document.getElementById("view-current");
const viewCompare = document.getElementById("view-compare");
const tabCurrent = document.getElementById("tab-current");
const tabCompare = document.getElementById("tab-compare");

tabCurrent.addEventListener("click", () => switchTab("current"));
tabCompare.addEventListener("click", () => switchTab("compare"));

function switchTab(which) {
  const cur = which === "current";
  viewCurrent.hidden = !cur;
  viewCompare.hidden = cur;
  tabCurrent.classList.toggle("active", cur);
  tabCompare.classList.toggle("active", !cur);
}

// ---------- robots.txt / sitemap (cached per origin) ----------

const robotsCache = new Map();

function checkRobots(url) {
  let origin;
  try {
    origin = new URL(url).origin;
  } catch (e) {
    return Promise.resolve(null);
  }
  if (robotsCache.has(origin)) return robotsCache.get(origin);

  const p = (async () => {
    const out = { exists: false, sitemap: false, sitemapVia: null, disallowAll: false };
    try {
      const r = await fetch(origin + "/robots.txt", { cache: "no-store", credentials: "omit" });
      const ct = r.headers.get("content-type") || "";
      if (r.ok && !/text\/html/i.test(ct)) {
        out.exists = true;
        const t = await r.text();
        if (/^\s*sitemap\s*:/im.test(t)) {
          out.sitemap = true;
          out.sitemapVia = "robots";
        }
        const group = t.match(/user-agent:\s*\*[\s\S]*?(?=user-agent:|$)/i);
        if (group && /^\s*disallow:\s*\/\s*$/im.test(group[0]) && !/^\s*allow:\s*\//im.test(group[0]))
          out.disallowAll = true;
      }
    } catch (e) {}
    if (!out.sitemap) {
      try {
        const s = await fetch(origin + "/sitemap.xml", { cache: "no-store", credentials: "omit" });
        const ct = s.headers.get("content-type") || "";
        if (s.ok && /xml|text\/plain/i.test(ct)) {
          out.sitemap = true;
          out.sitemapVia = "file";
        }
      } catch (e) {}
    }
    return out;
  })();
  robotsCache.set(origin, p);
  return p;
}

// ---------- per-URL audit history (progress tracking across sessions) ----------

const URL_HIST_KEY = "urlHistory";

function histKey(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname.replace(/\/$/, "") + u.search;
  } catch (e) {
    return url;
  }
}

// Stores a snapshot of this audit and returns the URL's full snapshot list
// (current audit last). Identical consecutive audits merge instead of stacking.
async function recordAudit(result) {
  try {
    const { urlHistory = {} } = await chrome.storage.local.get(URL_HIST_KEY);
    const key = histKey(result.url);
    const arr = urlHistory[key] || [];
    const checks = {};
    for (const c of result.categories) for (const ch of c.checks) checks[ch.label] = ch.status;
    const snap = { ts: Date.now(), overall: result.overall, checks };
    const last = arr[arr.length - 1];
    if (last && last.overall === snap.overall && JSON.stringify(last.checks) === JSON.stringify(snap.checks)) {
      last.ts = snap.ts;
    } else {
      arr.push(snap);
      if (arr.length > 20) arr.splice(0, arr.length - 20);
    }
    urlHistory[key] = arr;
    const keys = Object.keys(urlHistory);
    if (keys.length > 50) {
      keys.sort((x, y) => urlHistory[x][urlHistory[x].length - 1].ts - urlHistory[y][urlHistory[y].length - 1].ts);
      for (const k of keys.slice(0, keys.length - 50)) delete urlHistory[k];
    }
    await chrome.storage.local.set({ urlHistory });
    return arr;
  } catch (e) {
    return null; // storage unavailable — the trend line just won't render
  }
}

function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
}

// ---------- shared: fetch + analyze one URL ----------

async function fetchAndAnalyze(url, extra = {}) {
  const robotsP = checkRobots(url);
  const t0 = performance.now();
  const res = await fetch(url, { cache: "no-store", redirect: "follow", credentials: "omit" });
  const ttfb = performance.now() - t0; // headers received ≈ TTFB from the extension's vantage point
  const rawHtml = await res.text();

  const headers = {};
  res.headers.forEach((v, k) => (headers[k] = v));

  const doc = new DOMParser().parseFromString(rawHtml, "text/html");
  const result = analyzePage({
    url: res.url || url,
    rawHtml,
    doc,
    headers: extra.headers || headers,
    status: extra.status != null ? extra.status : res.status,
    timing: extra.timing || { ttfb },
    live: extra.live || null,
    apiCount: extra.apiCount != null ? extra.apiCount : null,
    robots: await robotsP,
    focusKeyword: extra.focusKeyword || null,
  });
  result.trend = await recordAudit(result);
  return result;
}

// ---------- current tab ----------

// Injected into the page's MAIN world so real page globals are visible.
async function collectPageData() {
  const nav = performance.getEntriesByType("navigation")[0];
  const paints = performance.getEntriesByType("paint");
  const fcpEntry = paints.find((p) => p.name === "first-contentful-paint");

  const lcp = await new Promise((resolve) => {
    try {
      const entries = [];
      const obs = new PerformanceObserver((l) => entries.push(...l.getEntries()));
      obs.observe({ type: "largest-contentful-paint", buffered: true });
      setTimeout(() => {
        obs.disconnect();
        resolve(entries.length ? entries[entries.length - 1].startTime : null);
      }, 80);
    } catch (e) {
      resolve(null);
    }
  });

  const has = (k) => {
    try { return typeof window[k] !== "undefined"; } catch (e) { return false; }
  };

  return {
    ttfb: nav ? nav.responseStart - nav.requestStart : null,
    fcp: fcpEntry ? fcpEntry.startTime : null,
    lcp,
    transferSize: nav ? nav.transferSize : null,
    domTextLength: document.body ? document.body.innerText.length : 0,
    globals: {
      next: has("__NEXT_DATA__") || !!document.getElementById("__NEXT_DATA__"),
      nuxt: has("__NUXT__"),
      gatsby: has("___gatsby"),
      remix: has("__remixContext"),
      angular: !!document.querySelector("[ng-version]"),
      initialState: has("__INITIAL_STATE__") || has("__APOLLO_STATE__") || has("__PRELOADED_STATE__"),
    },
  };
}

let currentResult = null;

// Full current-tab audit (live injection + SW headers + raw refetch).
// Shared by the initial popup render and the Re-audit & diff button.
async function gatherCurrentTabResult() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https?:/.test(tab.url || ""))
    throw new Error("this page can't be analyzed (only http/https pages)");

  const swInfo = await chrome.runtime
    .sendMessage({ type: "getTabInfo", tabId: tab.id })
    .catch(() => null);

  let live = null;
  try {
    const [inj] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: collectPageData,
    });
    live = inj && inj.result;
  } catch (e) {
    // restricted page (chrome web store, pdf viewer…) — proceed without live data
  }

  return fetchAndAnalyze(tab.url, {
    headers: swInfo && swInfo.headers ? swInfo.headers : undefined,
    status: swInfo ? swInfo.status : undefined,
    timing: live && live.ttfb != null ? { ttfb: live.ttfb } : undefined,
    live,
    apiCount: swInfo ? swInfo.apiCount : null,
  });
}

async function analyzeCurrentTab() {
  const statusEl = document.getElementById("current-status");
  const reportEl = document.getElementById("current-report");
  try {
    statusEl.textContent = "Fetching the raw HTML the way a crawler sees it…";
    const result = await gatherCurrentTabResult();

    currentResult = result;
    statusEl.hidden = true;
    document.getElementById("current-export").hidden = false;
    reportEl.innerHTML = "";
    reportEl.appendChild(siteCard(result, { open: true, current: true }));
  } catch (e) {
    statusEl.hidden = false;
    statusEl.className = "status error";
    statusEl.textContent = "Analysis failed: " + e.message;
  }
}

// ---------- compare mode ----------

let compareResults = [];

function makeUrlInput(value = "") {
  const input = document.createElement("input");
  input.type = "url";
  input.className = "url-input";
  input.placeholder = "https://another-site.com/page";
  input.value = value;
  return input;
}

document.getElementById("add-url").addEventListener("click", () => {
  document.getElementById("url-inputs").appendChild(makeUrlInput());
});

document.getElementById("use-current").addEventListener("click", async () => {
  let url = null;
  try {
    if (FULL) {
      // The active tab is this dashboard; take the most recently used http(s) tab instead.
      const tabs = await chrome.tabs.query({});
      const candidates = tabs
        .filter((t) => /^https?:/.test(t.url || "") && !t.url.startsWith(chrome.runtime.getURL("")))
        .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
      url = candidates[0] && candidates[0].url;
    } else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      url = tab && /^https?:/.test(tab.url || "") ? tab.url : null;
    }
  } catch (e) {}
  if (!url) return;
  const inputs = [...document.querySelectorAll(".url-input")];
  const empty = inputs.find((i) => !i.value.trim());
  if (empty) empty.value = url;
  else document.getElementById("url-inputs").appendChild(makeUrlInput(url));
});

document.getElementById("run-compare").addEventListener("click", runCompare);
document.getElementById("url-inputs").addEventListener("keydown", (e) => {
  if (e.key === "Enter") runCompare();
});

function normalizeUrl(v) {
  v = v.trim();
  if (!v) return null;
  if (!/^https?:\/\//i.test(v)) v = "https://" + v;
  try { new URL(v); return v; } catch (e) { return null; }
}

// Case-insensitive host, trailing-slash-insensitive path — two URLs that
// resolve to the same page shouldn't be scored as if comparing two sites.
function dedupeKey(u) {
  try {
    const x = new URL(u);
    return x.protocol + "//" + x.hostname.toLowerCase() + x.pathname.replace(/\/$/, "") + x.search;
  } catch (e) {
    return u;
  }
}

async function runCompare() {
  const statusEl = document.getElementById("compare-status");
  const reportEl = document.getElementById("compare-report");
  const btn = document.getElementById("run-compare");

  let urls = [...document.querySelectorAll(".url-input")]
    .map((i) => normalizeUrl(i.value))
    .filter(Boolean);

  const seenKeys = new Set();
  let duplicates = 0;
  urls = urls.filter((u) => {
    const key = dedupeKey(u);
    if (seenKeys.has(key)) { duplicates++; return false; }
    seenKeys.add(key);
    return true;
  });

  if (urls.length < 1) {
    statusEl.hidden = false;
    statusEl.className = "status error";
    statusEl.textContent = "Enter at least one valid URL (two or more for a batch audit).";
    return;
  }

  btn.disabled = true;
  statusEl.hidden = false;
  statusEl.className = "status";
  statusEl.textContent = `Fetching and scoring ${urls.length} page${urls.length > 1 ? "s" : ""}…`;
  reportEl.innerHTML = "";
  document.getElementById("compare-export").hidden = true;

  const focusKeyword = document.getElementById("focus-keyword").value.trim() || null;
  const settled = await Promise.allSettled(urls.map((u) => fetchAndAnalyze(u, { focusKeyword })));
  btn.disabled = false;

  const results = [];
  const errors = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") results.push(s.value);
    else errors.push({ url: urls[i], error: s.reason && s.reason.message });
  });

  compareResults = results;
  statusEl.hidden = true;

  if (duplicates) {
    const note = document.createElement("div");
    note.className = "status notice";
    note.textContent = `Removed ${duplicates} duplicate URL${duplicates > 1 ? "s" : ""} before auditing.`;
    reportEl.appendChild(note);
  }

  if (results.length >= 2) {
    reportEl.appendChild(winnerBanner(results));
    reportEl.appendChild(scoreTable(results));

    // Competitive AI prompt buttons
    const promptBar = document.createElement("div");
    promptBar.className = "compare-prompt-bar";
    promptBar.innerHTML = `
      <span class="cpb-label">AI fix prompts:</span>
      ${results
        .map(
          (r, i) =>
            `<button class="ghost mini cpb-btn" data-idx="${i}" title="Copy audit prompt for ${r.url}">Fix ${shortName(r.url)}</button>`
        )
        .join("")}`;
    promptBar.querySelectorAll(".cpb-btn").forEach((btn) =>
      btn.addEventListener("click", async (e) => {
        const idx = +btn.dataset.idx;
        const text = buildComparePrompt(results, results[idx].url);
        await navigator.clipboard.writeText(text);
        const old = btn.textContent;
        btn.textContent = "✓ Copied";
        setTimeout(() => (btn.textContent = old), 1600);
      })
    );
    reportEl.appendChild(promptBar);
  } else if (results.length === 1) {
    reportEl.appendChild(Object.assign(document.createElement("div"), {
      className: "status",
      textContent: "Single-page report (add a second URL for a comparison):",
    }));
  }

  const grid = document.createElement("div");
  grid.className = "cards-grid";
  for (const r of results) grid.appendChild(siteCard(r, { open: results.length === 1 }));
  reportEl.appendChild(grid);

  for (const e of errors) {
    const div = document.createElement("div");
    div.className = "err-card";
    div.textContent = `Could not analyze ${e.url}: ${e.error || "fetch failed"} (site may block cross-origin requests or be unreachable)`;
    reportEl.appendChild(div);
  }

  if (results.length) {
    document.getElementById("compare-export").hidden = false;
    if (FULL) document.getElementById("compare-again").hidden = false;
    saveHistory(results);
  }
}

// ---------- history ----------

async function saveHistory(results) {
  const item = {
    ts: Date.now(),
    sites: results.map((r) => ({ url: r.url, overall: r.overall, verdict: r.rendering.verdict })),
  };
  const { history = [] } = await chrome.storage.local.get("history");
  history.unshift(item);
  if (history.length > 20) history.length = 20;
  await chrome.storage.local.set({ history });
  renderHistory();
}

async function renderHistory() {
  const listEl = document.getElementById("history-list");
  const { history = [] } = await chrome.storage.local.get("history");
  listEl.innerHTML = "";
  if (!history.length) {
    listEl.innerHTML = '<div class="status">No comparisons yet.</div>';
    return;
  }
  for (const item of history) {
    const div = document.createElement("div");
    div.className = "history-item";
    div.tabIndex = 0;
    div.setAttribute("role", "button");
    const when = new Date(item.ts).toLocaleString([], {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
    div.innerHTML =
      `<span class="when">${when}</span>` +
      item.sites
        .map((s) => `<span class="hsite" title="${escapeHtml(s.url)}">${escapeHtml(shortName(s.url))} <b>${s.overall}</b></span>`)
        .join('<span class="vs">vs</span>');
    div.title = "Click to re-run this comparison";
    const rerun = () => {
      showDashPage("compare"); // no-op outside full-dashboard mode
      const box = document.getElementById("url-inputs");
      box.innerHTML = "";
      for (const s of item.sites) box.appendChild(makeUrlInput(s.url));
      while (box.children.length < 2) box.appendChild(makeUrlInput());
      runCompare();
      window.scrollTo({ top: 0, behavior: "smooth" });
    };
    div.addEventListener("click", rerun);
    div.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault(); // Space must not also scroll the page
        rerun();
      }
    });
    listEl.appendChild(div);
  }
}

document.getElementById("clear-history").addEventListener("click", async (e) => {
  e.preventDefault();
  e.stopPropagation();
  await chrome.storage.local.remove("history");
  renderHistory();
});

// ---------- export (Markdown / JSON) ----------

document.querySelectorAll("[data-export]").forEach((btn) =>
  btn.addEventListener("click", async () => {
    const scope = btn.dataset.scope;
    const results = scope === "current" ? (currentResult ? [currentResult] : []) : compareResults;
    if (!results.length) return;
    if (btn.dataset.export === "md") {
      await navigator.clipboard.writeText(toMarkdown(results));
      const old = btn.textContent;
      btn.textContent = "✓ Copied";
      setTimeout(() => (btn.textContent = old), 1400);
    } else {
      const blob = new Blob([JSON.stringify(results, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "seo-report-" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") + ".json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
  })
);

const MD_MARKS = { pass: "✅", warn: "⚠️", fail: "❌", info: "ℹ️" };

function toMarkdown(results) {
  const lines = [`# SEO Report — ${new Date().toLocaleString()}`, ""];

  if (results.length >= 2) {
    const sorted = [...results].sort((a, b) => b.overall - a.overall);
    lines.push(
      `**Winner: ${shortName(sorted[0].url)} (${sorted[0].overall}/100)**` +
        (sorted[0].overall !== sorted[1].overall
          ? ` — +${sorted[0].overall - sorted[1].overall} over ${shortName(sorted[1].url)}`
          : " (tie)"),
      ""
    );
    lines.push(`| Perspective | ${results.map((r) => shortName(r.url)).join(" | ")} |`);
    lines.push(`|---|${results.map(() => "---").join("|")}|`);
    lines.push(`| **Overall** | ${results.map((r) => `**${r.overall}**`).join(" | ")} |`);
    for (const cat of results[0].categories.map((c) => c.id)) {
      const cs = results.map((r) => r.categories.find((c) => c.id === cat));
      lines.push(`| ${cs[0].name} | ${cs.map((c) => c.score).join(" | ")} |`);
    }
    lines.push(`| Rendering | ${results.map((r) => r.rendering.verdict).join(" | ")} |`);
    lines.push(`| Framework | ${results.map((r) => r.rendering.framework).join(" | ")} |`, "");
  }

  for (const r of results) {
    lines.push(`## ${r.url}`, "");
    lines.push(
      `**${r.overall}/100 (${gradeFor(r.overall)})** · ${r.rendering.verdict} (${r.rendering.confidence} confidence) · ${r.rendering.framework}${r.rendering.hydration ? " · hydrates" : ""}`,
      ""
    );
    const plan = actionPlan(r);
    if (plan.length) {
      lines.push(`### Action plan (highest score impact first)`, "");
      plan.forEach((it, i) =>
        lines.push(
          `${i + 1}. ${MD_MARKS[it.status]} **${it.label}** (${it.category}, ${it.stage}-production, +${it.gain} pts) — ${it.detail}` +
            (it.fix ? `\n   Fix: ${it.fix}` : "")
        )
      );
      lines.push("");
    }
    for (const c of r.categories) {
      lines.push(`### ${c.name} — ${c.score}/100`, "");
      for (const ch of c.checks) {
        lines.push(`- ${MD_MARKS[ch.status]} **${ch.label}**${ch.max ? ` (${ch.points}/${ch.max})` : ""} — ${ch.detail}`);
        if (ch.fix) lines.push(`  - Fix: ${ch.fix}`);
      }
      lines.push("");
    }
    lines.push(`### Rendering signals`, "");
    for (const s of r.rendering.signals) lines.push(`- ${s}`);
    lines.push("");
  }
  return lines.join("\n");
}

// ---------- rendering helpers ----------

function shortName(url) {
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
    return u.hostname.replace(/^www\./, "") + (path.length > 22 ? path.slice(0, 20) + "…" : path);
  } catch (e) {
    return url;
  }
}

function pill(score) {
  const g = gradeFor(score);
  return `<span class="score-pill s-${g.toLowerCase()}">${score}</span>`;
}

function winnerBanner(results) {
  const sorted = [...results].sort((a, b) => b.overall - a.overall);
  const [win, runnerUp] = sorted;
  const div = document.createElement("div");
  div.className = "winner-banner";
  const tie = win.overall === runnerUp.overall;
  const nWay = sorted.length > 2;

  const headline = tie
    ? `<b>Tie</b> — ${shortName(win.url)} and ${shortName(runnerUp.url)} both score ${win.overall}/100${nWay ? ` (top of ${sorted.length} pages)` : ""}.`
    : `🏆 <b>${shortName(win.url)}</b> wins with <b>${win.overall}/100</b> (+${win.overall - runnerUp.overall} over ${nWay ? "2nd place" : shortName(runnerUp.url)}${nWay ? `, ${shortName(runnerUp.url)}` : ""})`;

  const sub = nWay
    ? `Ranked across ${sorted.length} pages — expand a card below to see every factor behind its score.`
    : `${win.rendering.verdict}-delivered vs ${runnerUp.rendering.verdict} — expand the cards below to see every factor behind each score.`;

  // Winner-vs-runner-up only tells the story for a 2-way compare; with 3+
  // pages, show the full ranking so "wins by X" doesn't read as the whole picture.
  const leaderboard = nWay
    ? `<ol class="rank-list">${sorted
        .map(
          (r, i) =>
            `<li><span class="rank-pos">${i + 1}</span><span class="rank-name">${escapeHtml(shortName(r.url))}</span><span class="rank-score">${r.overall}</span></li>`
        )
        .join("")}</ol>`
    : "";

  div.innerHTML = `${headline}<div class="sub">${sub}</div>${leaderboard}`;
  return div;
}

function scoreTable(results) {
  const best = (vals) => Math.max(...vals);
  const catIds = results[0].categories.map((c) => c.id);
  const table = document.createElement("table");
  table.className = "scores";

  let html = `<thead><tr><th>Perspective</th>${results
    .map((r) => `<th class="site" title="${r.url}">${shortName(r.url)}</th>`)
    .join("")}</tr></thead><tbody>`;

  const overallBest = best(results.map((r) => r.overall));
  html += `<tr class="overall"><td>Overall SEO score</td>${results
    .map((r) => `<td class="overall-row ${r.overall === overallBest ? "best" : ""}">${pill(r.overall)}${r.overall === overallBest ? '<span class="crown">◀</span>' : ""}</td>`)
    .join("")}</tr>`;

  for (const id of catIds) {
    const scores = results.map((r) => r.categories.find((c) => c.id === id));
    const b = best(scores.map((c) => c.score));
    html += `<tr><td>${scores[0].name} <small>(${Math.round(scores[0].weight * 100)}%)</small></td>${scores
      .map((c) => `<td class="${c.score === b ? "best" : ""}">${c.score}${c.score === b ? '<span class="crown">◀</span>' : ""}</td>`)
      .join("")}</tr>`;
  }

  html += `<tr><td>Rendering strategy</td>${results
    .map((r) => `<td><span class="badge ${r.rendering.verdict}">${r.rendering.verdict}</span></td>`)
    .join("")}</tr>`;
  html += `<tr><td>Framework</td>${results
    .map((r) => `<td>${r.rendering.framework}</td>`)
    .join("")}</tr></tbody>`;

  table.innerHTML = html;
  return table;
}

const MARKS = { pass: "✓", warn: "△", fail: "✗", info: "ℹ" };

function trendHtml(result) {
  const t = result.trend;
  if (!t || t.length < 2) return "";
  const prev = t[t.length - 2];
  const delta = result.overall - prev.overall;
  const cls = delta > 0 ? "pass" : delta < 0 ? "fail" : "flat";
  const deltaText = delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : "no change";
  const seq = t.slice(-6).map((s) => s.overall).join(" → ");
  return `<div class="trend-line">Progress: <b>${seq}</b>
    <span class="delta ${cls}">${deltaText}</span>
    <small>vs previous audit ${timeAgo(prev.ts)}</small></div>`;
}

// SVG ring gauge: colored by grade, center label shows the raw score.
function scoreGauge(score) {
  const g = gradeFor(score);
  const gradeLabel = { A: "Excellent", B: "Good", C: "Fair", D: "Weak", F: "Poor" }[g];
  const r = 34;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const color =
    score >= 90 ? "var(--pass)" : score >= 75 ? "var(--info)" : score >= 60 ? "var(--warn)" : "var(--fail)";
  return `
    <div class="gauge-wrap">
      <svg width="84" height="84" viewBox="0 0 84 84" class="gauge">
        <circle cx="42" cy="42" r="${r}" fill="none" stroke="var(--border)" stroke-width="8"/>
        <circle cx="42" cy="42" r="${r}" fill="none" stroke="${color}" stroke-width="8"
          stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - pct)).toFixed(1)}"
          transform="rotate(-90 42 42)"/>
        <text x="42" y="39" text-anchor="middle" class="gauge-num">${score}</text>
        <text x="42" y="54" text-anchor="middle" class="gauge-den">/100</text>
      </svg>
      <div class="gauge-label" style="color:${color}">${gradeLabel}</div>
    </div>`;
}

function statCard(label, score) {
  const color =
    score >= 90 ? "var(--pass)" : score >= 75 ? "var(--info)" : score >= 60 ? "var(--warn)" : "var(--fail)";
  return `
    <div class="stat-card">
      <div class="stat-label" title="${escapeHtml(label)}">${escapeHtml(label)}</div>
      <div class="stat-value">${score}<small>/100</small></div>
      <div class="stat-bar"><i style="width:${score}%;background:${color}"></i></div>
    </div>`;
}

// Priority tag for the Overview tab. Delegates to analyzer.js's classifySeverity
// (used for the Issues tab's severity badges) instead of re-deriving the same
// fail/warn + gain thresholds a second time — one severity rule, two views.
const SEVERITY_CLASS = { critical: "crit", high: "high", medium: "med", low: "low" };
function priorityTag(item) {
  const sev = classifySeverity(item);
  return { text: sev.label, cls: SEVERITY_CLASS[sev.level] };
}

function overviewTab(result) {
  const plan = actionPlan(result);
  const top = plan.slice(0, 5);
  const div = document.createElement("div");
  div.className = "overview-grid";

  const recCol = document.createElement("div");
  recCol.className = "overview-col";
  recCol.innerHTML =
    `<div class="overview-heading">Top Recommendations</div>` +
    (top.length
      ? `<div class="rec-list">${top
          .map((it) => {
            const pr = priorityTag(it);
            return `<div class="rec-item">
              <div class="rec-main">
                <div class="rec-label">${escapeHtml(it.label)}</div>
                <div class="rec-detail">${escapeHtml(it.fix || it.detail || "")}</div>
              </div>
              <span class="prio prio-${pr.cls}">${pr.text}</span>
            </div>`;
          })
          .join("")}</div>`
      : `<div class="plan-clean">✓ Every scored check passes. Ship it.</div>`);

  const issCol = document.createElement("div");
  issCol.className = "overview-col";
  issCol.innerHTML =
    `<div class="overview-heading">Issues Found <span class="pill-count">${plan.length}</span></div>` +
    (plan.length
      ? `<div class="iss-list">${plan
          .slice(0, 6)
          .map((it) => {
            const pr = priorityTag(it);
            return `<div class="iss-item">
              <span class="mark">${MARKS[it.status]}</span>
              <span class="iss-label">${escapeHtml(it.label)}</span>
              <span class="prio prio-${pr.cls}">${pr.text}</span>
            </div>`;
          })
          .join("")}</div>`
      : `<div class="plan-clean">✓ No open issues.</div>`);

  div.append(recCol, issCol);
  return div;
}

// One tab per real category + an Overview tab + an Issues tab (the old action
// plan). Replaces the old always-expanded stack of per-category accordions.
function categoryTabs(result) {
  const wrap = document.createElement("div");
  wrap.className = "tabs-block";

  const tabDefs = [
    { key: "issues", label: "Issues" },
    { key: "overview", label: "Overview" },
    ...result.categories.map((c) => ({ key: c.id, label: c.name })),
  ];

  const nav = document.createElement("div");
  nav.className = "tab-strip";
  nav.innerHTML = tabDefs
    .map((t, i) => `<button class="dash-tab${i === 0 ? " active" : ""}" data-tab="${t.key}">${escapeHtml(t.label)}</button>`)
    .join("");

  const panels = document.createElement("div");
  panels.className = "tab-panels";

  const issuesPanel = document.createElement("div");
  issuesPanel.className = "tab-panel";
  issuesPanel.dataset.tab = "issues";
  issuesPanel.appendChild(issuesTabContent(result));
  panels.appendChild(issuesPanel);

  const overviewPanel = document.createElement("div");
  overviewPanel.className = "tab-panel";
  overviewPanel.hidden = true;
  overviewPanel.dataset.tab = "overview";
  overviewPanel.appendChild(overviewTab(result));
  panels.appendChild(overviewPanel);

  for (const cat of result.categories) {
    const panel = document.createElement("div");
    panel.className = "tab-panel";
    panel.hidden = true;
    panel.dataset.tab = cat.id;
    const color = cat.score >= 75 ? "var(--pass)" : cat.score >= 50 ? "var(--warn)" : "var(--fail)";
    panel.innerHTML = `
      <div class="cat-panel-head">
        <span class="cat-name">${escapeHtml(cat.name)}<small>${Math.round(cat.weight * 100)}% of total</small></span>
        <span class="bar"><i style="width:${cat.score}%;background:${color}"></i></span>
        <span class="score-pill s-${gradeFor(cat.score).toLowerCase()}">${cat.score}</span>
      </div>
      <ul class="checks">
        ${cat.checks
          .map(
            (ch) => `<li class="${ch.status}">
              <span class="mark">${MARKS[ch.status]}</span>
              <span class="label">${escapeHtml(ch.label)}</span>
              <span class="detail">${escapeHtml(ch.detail || "")}</span>
              <span class="pts">${ch.max ? ch.points + "/" + ch.max : ""}</span>
              ${ch.fix ? `<div class="fixline">Fix: ${escapeHtml(ch.fix)}</div>` : ""}
            </li>`
          )
          .join("")}
      </ul>`;
    panels.appendChild(panel);
  }

  nav.querySelectorAll(".dash-tab").forEach((btn) =>
    btn.addEventListener("click", () => {
      nav.querySelectorAll(".dash-tab").forEach((b) => b.classList.toggle("active", b === btn));
      panels.querySelectorAll(".tab-panel").forEach((p) => (p.hidden = p.dataset.tab !== btn.dataset.tab));
    })
  );

  wrap.append(nav, panels);
  return wrap;
}

function siteCard(result, opts = {}) {
  const card = document.createElement("div");
  card.className = "site-card";

  card.innerHTML = `
    <div class="card-head">
      <div class="card-head-top">
        <div class="url" title="${result.url}">${result.url}</div>
        <button class="primary copy-fix-btn" style="padding: 6px 14px; font-size: 13px;" title="Copy AI fix prompt for this page">Copy fix prompt</button>
      </div>
      ${scoreGauge(result.overall)}
    </div>
    <div class="verdict-line">
      <span class="badge ${result.rendering.verdict}">${result.rendering.verdict}</span>
      <b>${escapeHtml(result.rendering.framework)}</b>
      · ${result.rendering.confidence} confidence
      ${result.rendering.hydration ? " · hydrates client-side" : ""}
    </div>
    ${trendHtml(result)}`;

  // Copy fix prompt button handler
  card.querySelector(".copy-fix-btn").addEventListener("click", async () => {
    const text = buildAiPrompt(result);
    await navigator.clipboard.writeText(text);
    const btn = card.querySelector(".copy-fix-btn");
    btn.textContent = "✓ Copied";
    setTimeout(() => (btn.textContent = "Copy fix prompt"), 1600);
  });

  const statRow = document.createElement("div");
  statRow.className = "stat-row";
  statRow.innerHTML = result.categories.map((c) => statCard(c.name, c.score)).join("");
  card.appendChild(statRow);

  card.appendChild(reAuditSection(result, opts));
  card.appendChild(categoryTabs(result));

  const advanced = document.createElement("details");
  advanced.className = "advanced";
  const advSummary = document.createElement("summary");
  advSummary.textContent = "Advanced: SERP preview, link audit, Lighthouse, signal chain";
  advanced.appendChild(advSummary);
  advanced.appendChild(previewSection(result));

  const sig = document.createElement("div");
  sig.className = "signals";
  sig.innerHTML =
    `<div class="sig-title">How the rendering verdict was reached</div><ul>` +
    result.rendering.signals.map((s) => `<li>${escapeHtml(s)}</li>`).join("") +
    `</ul>`;
  advanced.appendChild(sig);

  advanced.appendChild(toolsSection(result, opts));
  card.appendChild(advanced);
  return card;
}

// ---------- Issues tab: what's missing, how to fix it, AI fix prompt ----------

const SEV_BADGES = {
  critical: '<span class="sev-badge sev-critical">🔴 CRITICAL</span>',
  high: '<span class="sev-badge sev-high">🟠 HIGH</span>',
  medium: '<span class="sev-badge sev-medium">🟡 MEDIUM</span>',
  low: '<span class="sev-badge sev-low">🔵 LOW</span>',
};

function issuesTabContent(result) {
  const plan = actionPlan(result);
  const modules = buildAiPromptModules(result);
  const wrap = document.createElement("div");
  wrap.className = "issues-tab";

  const fails = plan.filter((p) => p.status === "fail").length;
  const warns = plan.length - fails;
  const totalGain = Math.round(plan.reduce((s, p) => s + p.gain, 0));

  const summaryText = plan.length
    ? `${fails} critical · ${warns} improvement${warns === 1 ? "" : "s"} · up to +${totalGain} pts recoverable`
    : "audit is clean — nothing to fix";

  const moduleHtml = (m) => {
    const idx = modules.indexOf(m);
    return `
    <details class="plan-module">
      <summary>
        <span class="pm-name">${escapeHtml(m.name)}</span>
        <span class="pm-meta">${m.count} issue${m.count === 1 ? "" : "s"} · <b class="gain">+${m.gain} pts</b></span>
        <button class="ghost mini pm-copy" data-copy="${idx}">Copy prompt</button>
      </summary>
      <ol class="plan-list">
        ${m.items
          .map(
            (it) => {
              const sev = classifySeverity(it);
              return `<li class="${it.status}">
              <div class="plan-head">
                ${SEV_BADGES[sev.level]}
                <span class="plan-label">${escapeHtml(it.label)}</span>
                <span class="gain">+${it.gain} pts</span>
              </div>
              <div class="plan-detail">${escapeHtml(it.detail || "")}</div>
              ${it.fix ? `<div class="fixline">Fix: ${escapeHtml(it.fix)}</div>` : ""}
            </li>`;
            }
          )
          .join("")}
      </ol>
      <details class="prompt-view">
        <summary>View this module's prompt</summary>
        <pre>${escapeHtml(m.prompt)}</pre>
      </details>
    </details>`;
  };

  const stageGroup = (stage, title, sub) => {
    const mods = modules.filter((m) => m.stage === stage);
    if (!mods.length) return "";
    const gain = +mods.reduce((s, m) => s + m.gain, 0).toFixed(1);
    const count = mods.reduce((s, m) => s + m.count, 0);
    return `
      <div class="stage-group">
        <div class="stage-title">${title}<small>${sub}</small>
          <span class="pm-meta">${count} issue${count === 1 ? "" : "s"} · <b class="gain">+${gain} pts</b></span>
        </div>
        ${mods.map(moduleHtml).join("")}
      </div>`;
  };

  wrap.innerHTML = `
    <div class="issues-summary">${summaryText}</div>
    ${
      plan.length
        ? `<div class="plan-actions">
            <div class="prompt-format-selector">
              <span class="pfs-label">Prompt format:</span>
              <button class="pfs-btn active" data-format="full">Full structured</button>
              <button class="pfs-btn" data-format="quick">Quick-fix list</button>
              <button class="pfs-btn" data-format="module">Module-by-module ↓</button>
            </div>
            <button class="ghost ai-prompt-btn" data-copy="full">Copy AI prompt (${plan.length} issues)</button>
            <span class="plan-hint">or expand a module below to copy its prompt individually</span>
          </div>` +
          stageGroup("pre", "Pre-production", "fix now in application code") +
          stageGroup("post", "Post-production", "server / CDN / deploy config")
        : `<div class="plan-clean">✓ Every scored check passes. Ship it.</div>`
    }`;

  // --- Prompt format selector logic ---
  let activeFormat = "full";
  const formatBtns = wrap.querySelectorAll(".pfs-btn");
  const mainCopyBtn = wrap.querySelector(".ai-prompt-btn");

  formatBtns.forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      formatBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      activeFormat = btn.dataset.format;
      if (mainCopyBtn) {
        if (activeFormat === "full") mainCopyBtn.textContent = `Copy AI prompt (${plan.length} issues)`;
        else if (activeFormat === "quick") mainCopyBtn.textContent = `Copy quick-fix list (${plan.length} items)`;
        else mainCopyBtn.textContent = `Copy all modules (${modules.length} prompts)`;
      }
    })
  );

  // --- Copy handlers ---
  wrap.querySelectorAll("[data-copy]").forEach((btn) =>
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const which = btn.dataset.copy;
      let text;
      if (which === "full") {
        if (activeFormat === "quick") text = buildQuickFixList(result);
        else if (activeFormat === "module") text = modules.map((m) => m.prompt).join("\n\n---\n\n");
        else text = buildAiPrompt(result);
      } else {
        text = modules[+which].prompt;
      }
      await navigator.clipboard.writeText(text);
      const old = btn.textContent;
      btn.textContent = "✓ Copied";
      setTimeout(() => (btn.textContent = old), 1600);
    })
  );

  return wrap;
}

// ---------- SERP + social preview ----------

function previewSection(result) {
  const s = result.snippet || {};
  const det = document.createElement("details");
  det.className = "cat";
  if (FULL) det.open = true;

  let crumb = result.url;
  try {
    const u = new URL(result.url);
    crumb = u.hostname + (u.pathname === "/" ? "" : " › " + u.pathname.split("/").filter(Boolean).join(" › "));
  } catch (e) {}

  const serpTitle = (s.title || "").slice(0, 60) + ((s.title || "").length > 60 ? "…" : "");
  const serpDesc = (s.desc || "").slice(0, 160) + ((s.desc || "").length > 160 ? "…" : "");
  const ogImg = s.ogImage
    ? `<img class="og-img" src="${escapeHtml(s.ogImage)}" alt="" loading="lazy" onerror="this.remove()">`
    : `<div class="og-img og-none">no og:image</div>`;

  det.innerHTML = `
    <summary><span class="cat-name">SERP &amp; social preview<small>how it looks when found or shared</small></span></summary>
    <div class="previews">
      <div class="serp">
        <div class="serp-crumb">${escapeHtml(crumb)}</div>
        <div class="serp-title">${escapeHtml(serpTitle) || "<i>(no title)</i>"}</div>
        <div class="serp-desc">${escapeHtml(serpDesc) || "<i>(no description — Google will improvise)</i>"}</div>
      </div>
      <div class="og-card">
        ${ogImg}
        <div class="og-meta">
          <div class="og-title">${escapeHtml(s.ogTitle || s.title || "(no title)")}</div>
          <div class="og-desc">${escapeHtml((s.ogDesc || s.desc || "").slice(0, 90))}</div>
          <div class="og-domain">${escapeHtml(s.siteName || crumb.split(" ›")[0])}</div>
        </div>
      </div>
    </div>`;
  return det;
}

// ---------- per-site deep tools: link audit + PageSpeed ----------

// Kept outside the collapsed "Advanced" section — re-audit & diff is the verify step
// of the audit -> AI-fix -> re-audit loop, not a niche tool.
function reAuditSection(result, opts) {
  const wrap = document.createElement("div");
  wrap.className = "card-tools reaudit";
  const out = document.createElement("div");
  out.className = "tool-out";

  const reBtn = document.createElement("button");
  reBtn.className = "ghost";
  reBtn.innerHTML = icon("refresh") + "Re-audit & diff";
  reBtn.addEventListener("click", async () => {
    reBtn.disabled = true;
    reBtn.textContent = "Re-auditing…";
    try {
      const fresh =
        opts.current && !FULL
          ? await gatherCurrentTabResult()
          : await fetchAndAnalyze(result.url, { focusKeyword: result.focusKeyword });
      const diff = diffResults(result, fresh);
      const newCard = siteCard(fresh, opts);
      const anchor = newCard.querySelector(".trend-line") || newCard.querySelector(".verdict-line");
      anchor.after(diffPanel(diff));
      reBtn.closest(".site-card").replaceWith(newCard);
      if (currentResult === result) currentResult = fresh;
      const i = compareResults.indexOf(result);
      if (i >= 0) compareResults[i] = fresh;
    } catch (e) {
      reBtn.disabled = false;
      reBtn.innerHTML = icon("refresh") + "Re-audit & diff";
      const div = document.createElement("div");
      div.className = "tool-title fail-t";
      div.textContent = "Re-audit failed: " + e.message;
      out.appendChild(div);
    }
  });

  const row = document.createElement("div");
  row.className = "card-actions";
  row.appendChild(reBtn);
  wrap.append(row, out);
  return wrap;
}

function toolsSection(result, opts = {}) {
  const wrap = document.createElement("div");
  wrap.className = "card-tools";
  const out = document.createElement("div");
  out.className = "tool-out";

  const linksBtn = document.createElement("button");
  linksBtn.className = "ghost";
  linksBtn.innerHTML = icon("link") + `Audit ${result.linkSample.length} internal links`;
  linksBtn.disabled = !result.linkSample.length;
  linksBtn.addEventListener("click", () => auditLinks(result, linksBtn, out));

  const psiBtn = document.createElement("button");
  psiBtn.className = "ghost";
  psiBtn.innerHTML = icon("bolt") + "Lighthouse (PageSpeed API)";
  psiBtn.addEventListener("click", () => runPSI(result.url, psiBtn, out));

  // Upfront signal, not just a failure after the fact: PSI's keyless quota is
  // shared across everyone using this extension, so warn before the call.
  const psiHint = document.createElement("span");
  psiHint.className = "psi-hint";
  psiHint.hidden = true;
  psiHint.textContent = "no API key — shared quota, may rate-limit";
  psiHint.title = "PageSpeed Insights has no key set, so this call shares Google's free keyless quota with every other unkeyed request. Add a free API key in Settings for reliable results.";
  chrome.storage.sync.get("psiKey").then(({ psiKey }) => {
    psiHint.hidden = !!psiKey;
  });

  const row = document.createElement("div");
  row.className = "card-actions";
  row.append(linksBtn, psiBtn, psiHint);
  wrap.append(row, out);
  return wrap;
}

// Rendered between the card header and the report after a re-audit:
// what changed since the previous run of the same page.
function diffPanel(d) {
  const div = document.createElement("div");
  div.className = "diff-panel";
  const cls = d.delta > 0 ? "pass" : d.delta < 0 ? "fail" : "flat";
  const deltaText = d.delta > 0 ? `+${d.delta}` : d.delta < 0 ? `${d.delta}` : "no change";
  const list = (title, items, className, fmt) =>
    items.length
      ? `<div class="diff-row ${className}"><b>${title} (${items.length}):</b> ${items.map(fmt).join(", ")}</div>`
      : "";
  const changed = d.fixed.length + d.improved.length + d.regressed.length + d.added.length;
  div.innerHTML =
    `<div class="diff-head">Re-audit: <b>${d.after}/100</b> <span class="delta ${cls}">${deltaText}</span> vs the previous audit (${d.before}/100)</div>` +
    (d.categories.length
      ? `<div class="diff-cats">${d.categories
          .map((c) => `${escapeHtml(c.name)} ${c.before}→${c.after} (${c.delta > 0 ? "+" : ""}${c.delta})`)
          .join(" · ")}</div>`
      : "") +
    list("Fixed", d.fixed, "pass-t", (i) => escapeHtml(i.label)) +
    list("Improved", d.improved, "pass-t", (i) => `${escapeHtml(i.label)} (${i.from}→${i.status})`) +
    list("Regressed", d.regressed, "fail-t", (i) => `${escapeHtml(i.label)} (${i.from}→${i.status})`) +
    list("New issues", d.added, "fail-t", (i) => escapeHtml(i.label)) +
    `<div class="diff-row muted">${d.stillOpen} issue${d.stillOpen === 1 ? "" : "s"} still open${changed ? "" : " — nothing changed since the last audit"}</div>`;
  return div;
}

async function auditLinks(result, btn, out) {
  btn.disabled = true;
  btn.textContent = "Checking…";
  const probe = async (href) => {
    try {
      let r = await fetch(href, { method: "HEAD", redirect: "follow", credentials: "omit" });
      if (r.status === 405 || r.status === 501)
        r = await fetch(href, { method: "GET", redirect: "follow", credentials: "omit" });
      return { href, status: r.status, ok: r.ok };
    } catch (e) {
      return { href, status: 0, ok: false };
    }
  };
  const checked = await Promise.all(result.linkSample.map(probe));
  const broken = checked.filter((c) => !c.ok);
  btn.innerHTML = icon("link") + `${checked.length} links checked`;

  const div = document.createElement("div");
  div.className = "link-audit";
  div.innerHTML = broken.length
    ? `<div class="tool-title fail-t">${broken.length}/${checked.length} sampled internal links are broken:</div>` +
      broken.map((b) => `<div class="broken-link">✗ ${b.status || "network error"} — ${escapeHtml(b.href)}</div>`).join("")
    : `<div class="tool-title pass-t">✓ All ${checked.length} sampled internal links respond OK.</div>`;
  out.appendChild(div);
}

async function runPSI(url, btn, out) {
  btn.disabled = true;
  btn.innerHTML = icon("bolt") + "Running (10–30s)…";
  try {
    const { psiKey } = await chrome.storage.sync.get("psiKey");
    const api =
      "https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=" + encodeURIComponent(url) +
      "&strategy=mobile&category=performance&category=seo&category=accessibility&category=best-practices" +
      (psiKey ? "&key=" + encodeURIComponent(psiKey) : "");
    const r = await fetch(api);
    if (!r.ok)
      throw new Error("HTTP " + r.status + (r.status === 429 ? " — rate limited; add a free API key in Settings" : ""));
    const j = await r.json();
    const cats = (j.lighthouseResult && j.lighthouseResult.categories) || {};
    const pct = (c) => (cats[c] ? Math.round(cats[c].score * 100) : null);
    const scores = [
      ["Performance", pct("performance")],
      ["SEO", pct("seo")],
      ["Best Practices", pct("best-practices")],
      ["Accessibility", pct("accessibility")],
    ];
    const fm = (j.loadingExperience && j.loadingExperience.metrics) || {};
    const field = [];
    if (fm.LARGEST_CONTENTFUL_PAINT_MS) field.push(`LCP ${(fm.LARGEST_CONTENTFUL_PAINT_MS.percentile / 1000).toFixed(1)}s`);
    if (fm.INTERACTION_TO_NEXT_PAINT) field.push(`INP ${fm.INTERACTION_TO_NEXT_PAINT.percentile}ms`);
    if (fm.CUMULATIVE_LAYOUT_SHIFT_SCORE) field.push(`CLS ${(fm.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile / 100).toFixed(2)}`);

    const div = document.createElement("div");
    div.className = "psi-out";
    div.innerHTML =
      `<div class="tool-title">Lighthouse (mobile, lab)</div>
       <div class="psi-grid">` +
      scores
        .map(([name, v]) =>
          v == null ? "" :
          `<div class="psi-cell"><span class="psi-score ${v >= 90 ? "s-a" : v >= 50 ? "s-c" : "s-f"}">${v}</span><span>${name}</span></div>`
        )
        .join("") +
      `</div>` +
      (field.length
        ? `<div class="psi-field">Field data (real Chrome users, 28d): ${field.join(" · ")} — overall ${j.loadingExperience.overall_category || ""}</div>`
        : `<div class="psi-field">No field (CrUX) data for this URL — not enough real-user traffic.</div>`);
    out.appendChild(div);
    btn.innerHTML = icon("bolt") + "Lighthouse done";
  } catch (e) {
    btn.disabled = false;
    btn.innerHTML = icon("bolt") + "Lighthouse (PageSpeed API)";
    const div = document.createElement("div");
    div.className = "tool-title fail-t";
    div.textContent = "PageSpeed failed: " + e.message;
    out.appendChild(div);
  }
}

// ---------- settings ----------

(async () => {
  const el = document.getElementById("psi-key");
  const { psiKey } = await chrome.storage.sync.get("psiKey");
  if (psiKey) el.value = psiKey;
  el.addEventListener("change", () => chrome.storage.sync.set({ psiKey: el.value.trim() }));
})();

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

// ---------- boot ----------

renderHistory();

if (FULL) {
  switchTab("compare");
  const prefill = PARAMS.get("url");
  if (prefill) {
    document.querySelector(".url-input").value = prefill;
    document.querySelectorAll(".url-input")[1].focus();
  }

  // Real sections only — no sidebar entries for tools this extension doesn't have.
  dashPages = {
    compare: document.getElementById("page-compare"),
    history: document.getElementById("history-box"),
    settings: document.getElementById("settings-box"),
  };
  // In full mode these two are sidebar-switched pages, not click-to-toggle
  // accordions — force them open and swallow the native <summary> toggle.
  dashPages.history.open = true;
  dashPages.settings.open = true;
  dashPages.history.querySelector(":scope > summary").addEventListener("click", (e) => e.preventDefault());
  dashPages.settings.querySelector(":scope > summary").addEventListener("click", (e) => e.preventDefault());

  document.querySelectorAll(".side-link").forEach((b) => b.addEventListener("click", () => showDashPage(b.dataset.page)));
  showDashPage("compare");

  // Export actions live in the top toolbar in full mode instead of inline below the form.
  document.getElementById("header-export-slot").appendChild(document.getElementById("compare-export"));

  document.getElementById("compare-again").addEventListener("click", () => {
    showDashPage("compare");
    document.getElementById("page-compare").scrollIntoView({ behavior: "smooth", block: "start" });
    document.querySelector(".url-input").focus();
  });
} else {
  analyzeCurrentTab();
}
