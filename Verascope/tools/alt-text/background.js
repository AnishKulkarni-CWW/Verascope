// background.js
importScripts('xlsx-writer.js'); // provides buildXlsx(rows) -> Uint8Array

function setTabState(tabId, newActive) {
  chrome.storage.local.set({ [`alt_active_${tabId}`]: newActive }, () => {
    if (newActive) {
      chrome.action.setBadgeText({ text: 'ON', tabId });
      chrome.action.setBadgeBackgroundColor({ color: '#00FF7F', tabId });
      chrome.action.setBadgeTextColor({ color: '#000000', tabId });
    } else {
      chrome.action.setBadgeText({ text: '', tabId });
    }
    chrome.tabs.sendMessage(tabId, { action: 'toggleAltDisplay', active: newActive });
  });
}

function toggleTab(tabId, callback) {
  chrome.storage.local.get(`alt_active_${tabId}`, (result) => {
    const current   = result[`alt_active_${tabId}`] || false;
    const newActive = !current;
    setTabState(tabId, newActive);
    if (callback) callback(newActive);
  });
}

// Uint8Array -> base64 without blowing the call stack on large files
function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getAltState') {
    const tabId = sender.tab.id;
    chrome.storage.local.get(`alt_active_${tabId}`, (result) => {
      const active = result[`alt_active_${tabId}`] || false;
      sendResponse({ active });
    });
    return true;
  }

  if (request.action === 'getAltStateForTab') {
    chrome.storage.local.get(`alt_active_${request.tabId}`, (result) => {
      const active = result[`alt_active_${request.tabId}`] || false;
      sendResponse({ active });
    });
    return true;
  }

  if (request.action === 'toggleFromPopup') {
    toggleTab(request.tabId, (newActive) => {
      sendResponse({ active: newActive });
    });
    return true;
  }

  if (request.action === 'fetchImageAsDataUrl') {
    (async () => {
      try {
        const resp = await fetch(request.url, { credentials: 'omit' });
        if (!resp.ok) {
          sendResponse({ dataUrl: null });
          return;
        }
        const blob = await resp.blob();
        const contentType = blob.type || 'image/png';
        const buffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(buffer);

        // Skip SVGs and non-raster types the xlsx writer can't embed
        // as a picture; let the caller fall back to a link instead.
        if (contentType.includes('svg')) {
          sendResponse({ dataUrl: null });
          return;
        }

        const base64 = bytesToBase64(bytes);
        sendResponse({ dataUrl: `data:${contentType};base64,${base64}` });
      } catch (e) {
        sendResponse({ dataUrl: null });
      }
    })();
    return true;
  }

  if (request.action === 'buildExportFile') {
    try {
      const xlsxBytes = buildXlsx(request.rows);
      const base64 = bytesToBase64(xlsxBytes);
      const dataUrl =
        'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,' + base64;

      const filename = `alt-text-report-${Date.now()}.xlsx`;

      chrome.downloads.download({
        url: dataUrl,
        filename: filename,
        saveAs: true
      }, () => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ ok: true });
        }
      });
    } catch (e) {
      sendResponse({ ok: false, error: e.message + (e.stack ? ('\n' + e.stack) : '') });
    }
    return true;
  }
});

// Reset badge when navigating to a new page
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    chrome.storage.local.remove(`alt_active_${tabId}`);
    chrome.action.setBadgeText({ text: '', tabId });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.remove(`alt_active_${tabId}`);
});


// ============================================================
// Link Checker Pro (v1.1) — background subsystem
// Ported from the standalone "Link Checker Pro" extension's own
// background.js. It replaces the old, much heavier "Check My
// Links" clone that used to live here — that version depended on
// an entire injected iframe report UI (jQuery, Bootstrap,
// DataTables, JSZip, PDF fonts) whose icon assets never shipped
// with this repo, so every icon in its report broke with
// net::ERR_FILE_NOT_FOUND and the tool was effectively unusable.
//
// v1.1 moved scan orchestration here entirely (out of the popup):
// scan state now lives in chrome.storage.local, keyed by tab id, so
// results survive the popup closing and even the source tab
// closing. Every scan gets a monotonically increasing runId; any
// in-flight status checks from a superseded run are ignored, which
// is what fixed the OK/Broken counts changing randomly between
// runs on the v1 popup-driven implementation (two scans' results
// could race and get merged). Link collection now also queries
// every frame on the tab (content.js is registered with
// all_frames: true and walks open shadow DOM too), merged here via
// chrome.webNavigation.getAllFrames.
// ============================================================

const lcpState = {
  // tabId -> { runId, pageUrl, pageTitle, results: [...], status: 'collecting'|'checking'|'done' }
};

function lcpStorageKey(tabId) {
  return `lcp_scan_${tabId}`;
}

async function lcpSaveState(tabId) {
  const data = lcpState[tabId];
  if (!data) return;
  await chrome.storage.local.set({ [lcpStorageKey(tabId)]: data });
}

async function lcpLoadState(tabId) {
  const key = lcpStorageKey(tabId);
  const stored = await chrome.storage.local.get(key);
  return stored[key] || null;
}

// ── Collect links from every frame in the tab ─────────────────────────────
async function lcpCollectAllFrameLinks(tabId) {
  let frames = [];
  try {
    frames = await chrome.webNavigation.getAllFrames({ tabId });
  } catch (e) {
    frames = [{ frameId: 0 }];
  }

  const merged = new Map();
  let pageUrl = '';
  let pageTitle = '';

  for (const frame of frames || [{ frameId: 0 }]) {
    try {
      const response = await chrome.tabs.sendMessage(
        tabId,
        { type: 'LCP_COLLECT_LINKS' },
        { frameId: frame.frameId }
      );
      if (!response) continue;
      if (frame.frameId === 0) {
        pageUrl = response.pageUrl;
        pageTitle = response.pageTitle;
      }
      (response.links || []).forEach((l) => {
        if (merged.has(l.href)) {
          merged.get(l.href).occurrences += l.occurrences;
        } else {
          merged.set(l.href, { ...l });
        }
      });
    } catch (e) {
      // Frame may not have a content script (cross-origin, chrome://, etc.) — skip it.
    }
  }

  return {
    pageUrl,
    pageTitle,
    links: Array.from(merged.values())
  };
}

// ── Run a full scan for a tab, guarded by runId so stale runs can't corrupt state ──
async function lcpRunScan(tabId) {
  const runId = Date.now() + Math.random();
  lcpState[tabId] = {
    runId,
    pageUrl: '',
    pageTitle: '',
    results: [],
    status: 'collecting',
    completed: 0,
    total: 0
  };
  await lcpSaveState(tabId);
  lcpBroadcast(tabId, { type: 'LCP_SCAN_UPDATE', tabId });

  const collected = await lcpCollectAllFrameLinks(tabId);

  // Bail out if a newer scan has started while we were collecting.
  if (!lcpState[tabId] || lcpState[tabId].runId !== runId) return;

  const links = collected.links || [];
  const results = links.map((l, i) => ({
    index: i + 1,
    href: l.href,
    text: l.text,
    scope: l.scope,
    rel: l.rel,
    nofollow: l.nofollow,
    target: l.target,
    location: l.location,
    occurrences: l.occurrences,
    status: 'pending',
    httpStatus: null,
    ms: null,
    reason: ''
  }));

  lcpState[tabId] = {
    runId,
    pageUrl: collected.pageUrl,
    pageTitle: collected.pageTitle,
    results,
    status: 'checking',
    completed: 0,
    total: results.length
  };
  await lcpSaveState(tabId);
  lcpBroadcast(tabId, { type: 'LCP_SCAN_UPDATE', tabId });

  if (results.length === 0) {
    lcpState[tabId].status = 'done';
    await lcpSaveState(tabId);
    lcpBroadcast(tabId, { type: 'LCP_SCAN_UPDATE', tabId });
    return;
  }

  const LCP_CONCURRENCY = 6;
  let cursor = 0;

  async function worker() {
    while (true) {
      // Stop immediately if this run has been superseded.
      if (!lcpState[tabId] || lcpState[tabId].runId !== runId) return;

      const idx = cursor++;
      if (idx >= results.length) return;

      const item = results[idx];
      if (item.scope === 'anchor' || item.scope === 'mailto' || item.scope === 'tel') {
        item.status = 'skipped';
      } else {
        const result = await checkLink(item.href, 8000);
        // Re-check staleness AFTER the await — this is the critical guard
        // that prevents a slow response from a previous run overwriting
        // the current run's data with mismatched counts.
        if (!lcpState[tabId] || lcpState[tabId].runId !== runId) return;
        item.status = result.status;
        item.httpStatus = result.httpStatus;
        item.ms = result.ms;
        item.reason = result.reason || '';
      }

      lcpState[tabId].completed++;
      if (lcpState[tabId].completed % 4 === 0 || lcpState[tabId].completed === results.length) {
        await lcpSaveState(tabId);
        lcpBroadcast(tabId, { type: 'LCP_SCAN_UPDATE', tabId });
      }
    }
  }

  const workers = Array.from({ length: Math.min(LCP_CONCURRENCY, results.length) }, () => worker());
  await Promise.all(workers);

  if (lcpState[tabId] && lcpState[tabId].runId === runId) {
    lcpState[tabId].status = 'done';
    await lcpSaveState(tabId);
    lcpBroadcast(tabId, { type: 'LCP_SCAN_UPDATE', tabId });
  }
}

function lcpBroadcast(tabId, message) {
  chrome.runtime.sendMessage({ ...message }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'LCP_START_SCAN') {
    lcpRunScan(msg.tabId);
    sendResponse({ ok: true });
    return true;
  }
  if (msg && msg.type === 'LCP_GET_STATE') {
    (async () => {
      const live = lcpState[msg.tabId];
      if (live) {
        sendResponse(live);
      } else {
        const stored = await lcpLoadState(msg.tabId);
        sendResponse(stored);
      }
    })();
    return true;
  }
  if (msg && msg.type === 'LCP_CLEAR_STATE') {
    delete lcpState[msg.tabId];
    chrome.storage.local.remove(lcpStorageKey(msg.tabId));
    sendResponse({ ok: true });
    return true;
  }
});

// Clean up in-memory state when a tab is closed. Intentionally NOT deleting
// chrome.storage.local here — that's what lets results survive after the
// source tab is closed, per this tool's persistence design.
chrome.tabs.onRemoved.addListener((tabId) => {
  delete lcpState[tabId];
});

// Runs a HEAD (falling back to GET) fetch per link and classifies the
// result. Cross-origin requests still tell us success/failure/timeout even
// though the response body isn't readable.
async function checkLink(href, timeoutMs) {
  const start = Date.now();

  if (!/^https?:\/\//i.test(href)) {
    return { status: 'skipped', httpStatus: null, ms: 0, reason: 'non-http scheme' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let res;
    try {
      res = await fetch(href, {
        method: 'HEAD',
        redirect: 'follow',
        signal: controller.signal,
        credentials: 'omit',
        cache: 'no-store'
      });
    } catch (headErr) {
      // Some servers reject HEAD; retry with GET before giving up.
      res = await fetch(href, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        credentials: 'omit',
        cache: 'no-store'
      });
    }

    clearTimeout(timer);
    const ms = Date.now() - start;
    const redirected = res.redirected;

    if (res.type === 'opaque') {
      // Opaque response (no-cors fallback) — we cannot read the status.
      return { status: 'unverified', httpStatus: null, ms, redirected, reason: 'opaque response' };
    }

    if (res.status >= 200 && res.status < 300) {
      return {
        status: ms > 3000 ? 'slow' : 'ok',
        httpStatus: res.status,
        ms,
        redirected,
        finalUrl: res.url
      };
    }
    if (res.status >= 300 && res.status < 400) {
      return { status: 'redirect', httpStatus: res.status, ms, redirected, finalUrl: res.url };
    }
    if (res.status === 404) {
      return { status: 'broken', httpStatus: res.status, ms, redirected, reason: 'Not Found' };
    }
    if (res.status >= 400 && res.status < 500) {
      return { status: 'broken', httpStatus: res.status, ms, redirected, reason: 'Client error' };
    }
    if (res.status >= 500) {
      return { status: 'broken', httpStatus: res.status, ms, redirected, reason: 'Server error' };
    }
    return { status: 'unverified', httpStatus: res.status, ms, redirected };
  } catch (err) {
    clearTimeout(timer);
    const ms = Date.now() - start;
    if (err.name === 'AbortError') {
      return { status: 'timeout', httpStatus: null, ms, reason: 'Timed out' };
    }
    return { status: 'broken', httpStatus: null, ms, reason: err.message || 'Network error' };
  }
}
