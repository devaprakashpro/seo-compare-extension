// Service worker: captures main-document response headers and counts
// API-style requests (xhr/fetch) per tab, so the popup can analyze
// caching/CDN behavior of the page the user is actually looking at.

const tabData = {}; // tabId -> { url, status, headers, apiCount, ts }
const persistTimers = {}; // tabId -> debounce timer, so a chatty page's XHRs don't write to storage on every single request

function headersToObject(headerList) {
  const out = {};
  for (const h of headerList || []) {
    const k = h.name.toLowerCase();
    // keep first occurrence; concat duplicates (e.g. set-cookie is filtered anyway)
    out[k] = k in out ? out[k] + ", " + h.value : h.value;
  }
  return out;
}

async function persist(tabId) {
  try {
    await chrome.storage.session.set({ ["tab_" + tabId]: tabData[tabId] });
  } catch (e) {
    // storage.session may be unavailable in very old Chrome; in-memory copy still works
  }
}

// Coalesces bursts of apiCount increments (a chatty SPA can fire dozens of
// XHRs per load) into one write instead of one storage.session.set per request.
function debouncedPersist(tabId) {
  clearTimeout(persistTimers[tabId]);
  persistTimers[tabId] = setTimeout(() => persist(tabId), 300);
}

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (details.type === "main_frame") {
      tabData[details.tabId] = {
        url: details.url,
        status: details.statusCode,
        headers: headersToObject(details.responseHeaders),
        apiCount: 0,
        ts: Date.now(),
      };
      persist(details.tabId);
    }
  },
  { urls: ["<all_urls>"], types: ["main_frame"] },
  ["responseHeaders"]
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const t = tabData[details.tabId];
    if (t && details.type === "xmlhttprequest") {
      t.apiCount++;
      debouncedPersist(details.tabId);
    }
  },
  { urls: ["<all_urls>"], types: ["xmlhttprequest"] }
);

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTimeout(persistTimers[tabId]);
  delete persistTimers[tabId];
  delete tabData[tabId];
  chrome.storage.session.remove("tab_" + tabId).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "getTabInfo") {
    const inMem = tabData[msg.tabId];
    if (inMem) {
      sendResponse(inMem);
    } else {
      // SW may have been restarted since navigation; fall back to session storage
      chrome.storage.session
        .get("tab_" + msg.tabId)
        .then((r) => sendResponse(r["tab_" + msg.tabId] || null))
        .catch(() => sendResponse(null));
      return true; // async response
    }
  }
});
