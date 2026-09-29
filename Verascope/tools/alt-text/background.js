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

// ── Link checking ─────────────────────────────────────────────────────────
// Many sites (Akamai / Cloudflare style bot protection) answer a bare,
// cookie-less HEAD/GET from an extension with 403/405/429/5xx even though the
// page opens fine for a real visitor. So a failing status is escalated before
// a link is ever called "Broken":
//   1. HEAD (no cookies)            — fast path, same as before
//   2. GET  (no cookies)            — for servers that reject/mishandle HEAD
//   3. GET  (with browser cookies)  — for pages gated on a session/bot cookie
//   4. Real browser navigation in a background (minimized) window, with the
//      true document status read via chrome.webRequest — the same thing a
//      person clicking the link would get.
// 404/410 are treated as definitive and never escalated past step 2.
// Logout / sign-out / unsubscribe style URLs are never requested with cookies
// or opened, so a scan can't sign the user out of anything.
const LCP_DEFINITIVE_MISSING = new Set([404, 410]);
const LCP_BLOCKING_CODES = new Set([401, 403, 405, 406, 429]);
const LCP_SENSITIVE_URL = /log[-_]?out|sign[-_]?out|log[-_]?off|sign[-_]?off|unsubscribe/i;

function lcpClassifyStatus(status, ms, extra) {
  const base = { httpStatus: status, ms, ...extra };
  if (status >= 200 && status < 300) return { status: ms > 3000 ? 'slow' : 'ok', ...base };
  if (status >= 300 && status < 400) return { status: 'redirect', ...base };
  if (status === 404) return { status: 'broken', ...base, reason: 'Not Found' };
  if (status >= 400 && status < 500) return { status: 'broken', ...base, reason: 'Client error' };
  if (status >= 500) return { status: 'broken', ...base, reason: 'Server error' };
  return { status: 'unverified', ...base };
}

// Runs the fetch escalation above per link and classifies the result.
// Cross-origin requests still tell us success/failure/timeout even though the
// response body isn't readable.
async function checkLink(href, timeoutMs) {
  const start = Date.now();

  if (!/^https?:\/\//i.test(href)) {
    return { status: 'skipped', httpStatus: null, ms: 0, reason: 'non-http scheme' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const sensitive = LCP_SENSITIVE_URL.test(href);

  async function attempt(method, credentials) {
    const t0 = Date.now();
    try {
      const res = await fetch(href, {
        method,
        redirect: 'follow',
        signal: controller.signal,
        credentials,
        cache: 'no-store'
      });
      // We only need the status line — don't download GET bodies.
      if (method === 'GET' && res.body) res.body.cancel().catch(() => {});
      return { res, ms: Date.now() - t0 };
    } catch (err) {
      return { err, ms: Date.now() - t0 };
    }
  }
  const good = (a) => a.res && (a.res.type === 'opaque' || a.res.status < 400);
  // Keep an HTTP status we already have over a later thrown error/timeout.
  const better = (prev, next) => (next.res || !prev.res ? next : prev);

  let last = await attempt('HEAD', 'omit');
  if (!good(last) && !controller.signal.aborted) {
    last = better(last, await attempt('GET', 'omit'));
  }
  if (!good(last) && !sensitive && !controller.signal.aborted &&
      !(last.res && LCP_DEFINITIVE_MISSING.has(last.res.status))) {
    last = better(last, await attempt('GET', 'include'));
  }
  clearTimeout(timer);

  let result;
  if (last.res) {
    const res = last.res;
    if (res.type === 'opaque') {
      // Opaque response (no-cors fallback) — we cannot read the status.
      return { status: 'unverified', httpStatus: null, ms: last.ms, redirected: res.redirected, reason: 'opaque response' };
    }
    result = lcpClassifyStatus(res.status, last.ms, { redirected: res.redirected, finalUrl: res.url });
  } else if (last.err && last.err.name === 'AbortError') {
    return { status: 'timeout', httpStatus: null, ms: Date.now() - start, reason: 'Timed out' };
  } else {
    result = { status: 'broken', httpStatus: null, ms: Date.now() - start, reason: (last.err && last.err.message) || 'Network error' };
  }

  if (result.status !== 'broken' || LCP_DEFINITIVE_MISSING.has(result.httpStatus)) return result;

  const blockedCode = result.httpStatus;
  if (!sensitive) {
    const nav = await lcpVerifyInBrowser(href, 15000);
    const what = blockedCode ? `HTTP ${blockedCode}` : (result.reason || 'a network error');
    if (nav.status === 'ok') {
      return lcpClassifyStatus(nav.httpStatus, nav.ms, {
        redirected: nav.redirected, finalUrl: nav.finalUrl,
        reason: `Verified in browser (automated request got ${what})`
      });
    }
    if (nav.status === 'http') {
      const confirmed = lcpClassifyStatus(nav.httpStatus, nav.ms, { finalUrl: nav.finalUrl });
      if (confirmed.status === 'broken') confirmed.reason = `${confirmed.reason} (confirmed in browser)`;
      return confirmed;
    }
    if (nav.status === 'neterror') {
      return { status: 'broken', httpStatus: null, ms: nav.ms, reason: `${nav.error} (confirmed in browser)` };
    }
  }

  // Couldn't confirm in a real browser. A 401/403/405/429 is what bot
  // protection / access control sends, not proof the page is gone.
  if (LCP_BLOCKING_CODES.has(blockedCode)) {
    return {
      ...result,
      status: 'unverified',
      reason: `Automated check blocked (HTTP ${blockedCode}) — open manually to confirm`
    };
  }
  return result;
}

// ── Real-browser verification ─────────────────────────────────────────────
// Opens the link in a tab of a dedicated, minimized, unfocused window and
// reads the main document's real status from chrome.webRequest. At most
// LCP_VERIFY_CONCURRENCY tabs at once; the window closes itself when idle.
const LCP_VERIFY_CONCURRENCY = 2;
const LCP_VERIFY_WINDOW_KEY = 'lcp_verify_window';
const lcpVerify = {
  windowId: null,
  windowPromise: null,
  active: 0,
  queue: [],
  pending: new Map(), // tabId -> entry
  recentUrls: new Map(), // url -> expiry time, for downloads that surface after a check settles
  closeTimer: null
};

// A service-worker restart mid-scan could orphan the verification window —
// close it on startup.
chrome.storage.session.get(LCP_VERIFY_WINDOW_KEY).then((stored) => {
  const id = stored && stored[LCP_VERIFY_WINDOW_KEY];
  if (typeof id === 'number' && lcpVerify.windowId === null) {
    chrome.windows.remove(id).catch(() => {});
    chrome.storage.session.remove(LCP_VERIFY_WINDOW_KEY).catch(() => {});
  }
}).catch(() => {});

function lcpVerifyInBrowser(url, timeoutMs) {
  return new Promise((resolve) => {
    lcpVerify.queue.push({ url, timeoutMs, resolve });
    lcpVerifyPump();
  });
}

function lcpVerifyPump() {
  while (lcpVerify.active < LCP_VERIFY_CONCURRENCY && lcpVerify.queue.length) {
    const job = lcpVerify.queue.shift();
    lcpVerify.active++;
    clearTimeout(lcpVerify.closeTimer);
    lcpVerify.closeTimer = null;
    lcpVerifyRun(job)
      .catch(() => ({ status: 'unavailable' }))
      .then((result) => {
        lcpVerify.active--;
        job.resolve(result);
        lcpVerifyPump();
        lcpVerifyScheduleClose();
      });
  }
}

function lcpVerifyScheduleClose() {
  if (lcpVerify.active > 0 || lcpVerify.queue.length || lcpVerify.closeTimer) return;
  lcpVerify.closeTimer = setTimeout(() => {
    lcpVerify.closeTimer = null;
    if (lcpVerify.active > 0 || lcpVerify.queue.length || lcpVerify.windowId === null) return;
    const id = lcpVerify.windowId;
    lcpVerify.windowId = null;
    chrome.windows.remove(id).catch(() => {});
    chrome.storage.session.remove(LCP_VERIFY_WINDOW_KEY).catch(() => {});
  }, 2000);
}

async function lcpVerifyEnsureWindow() {
  if (lcpVerify.windowId !== null) {
    try {
      await chrome.windows.get(lcpVerify.windowId);
      return lcpVerify.windowId;
    } catch (e) {
      lcpVerify.windowId = null;
    }
  }
  if (!lcpVerify.windowPromise) {
    lcpVerify.windowPromise = chrome.windows
      .create({ url: 'about:blank', focused: false, state: 'minimized', type: 'normal' })
      .then((win) => {
        lcpVerify.windowId = win.id;
        chrome.storage.session.set({ [LCP_VERIFY_WINDOW_KEY]: win.id }).catch(() => {});
        return win.id;
      })
      .finally(() => { lcpVerify.windowPromise = null; });
  }
  return lcpVerify.windowPromise;
}

async function lcpVerifyRun({ url, timeoutMs }) {
  if (!chrome.webRequest || !chrome.windows) return { status: 'unavailable' };
  const windowId = await lcpVerifyEnsureWindow();
  const tab = await chrome.tabs.create({ windowId, url: 'about:blank', active: false });
  chrome.tabs.update(tab.id, { muted: true }).catch(() => {});

  return new Promise((resolve) => {
    const entry = {
      tabId: tab.id,
      url,
      start: Date.now(),
      done: false,
      headerStatus: null,
      errorStatus: null,
      redirected: false,
      finalUrl: url,
      graceTimer: null,
      timeout: null
    };
    entry.finish = (result) => {
      if (entry.done) return;
      entry.done = true;
      clearTimeout(entry.timeout);
      clearTimeout(entry.graceTimer);
      lcpVerify.pending.delete(tab.id);
      const expires = Date.now() + 15000;
      lcpVerify.recentUrls.set(entry.url, expires);
      lcpVerify.recentUrls.set(entry.finalUrl, expires);
      chrome.tabs.remove(tab.id).catch(() => {});
      resolve({ ms: Date.now() - entry.start, redirected: entry.redirected, finalUrl: entry.finalUrl, ...result });
    };
    entry.timeout = setTimeout(() => {
      entry.finish(entry.errorStatus
        ? { status: 'http', httpStatus: entry.errorStatus }
        : { status: 'unavailable' });
    }, timeoutMs);
    lcpVerify.pending.set(tab.id, entry);
    // Navigate only after the entry is registered so no webRequest event is missed.
    chrome.tabs.update(tab.id, { url }).catch(() => entry.finish({ status: 'unavailable' }));
  });
}

if (chrome.webRequest) {
  const lcpVerifyFilter = { urls: ['<all_urls>'], types: ['main_frame'] };

  chrome.webRequest.onBeforeRedirect.addListener((d) => {
    const entry = lcpVerify.pending.get(d.tabId);
    if (!entry) return;
    entry.redirected = true;
    entry.finalUrl = d.redirectUrl;
  }, lcpVerifyFilter);

  chrome.webRequest.onHeadersReceived.addListener((d) => {
    const entry = lcpVerify.pending.get(d.tabId);
    if (entry) entry.headerStatus = d.statusCode;
  }, lcpVerifyFilter);

  chrome.webRequest.onCompleted.addListener((d) => {
    const entry = lcpVerify.pending.get(d.tabId);
    if (!entry) return;
    const ms = Date.now() - entry.start;
    entry.finalUrl = d.url;
    if (d.statusCode < 400) {
      entry.finish({ status: 'ok', httpStatus: d.statusCode, ms });
      return;
    }
    if (LCP_DEFINITIVE_MISSING.has(d.statusCode)) {
      entry.finish({ status: 'http', httpStatus: d.statusCode, ms });
      return;
    }
    // Bot-protection interstitials often run a JS challenge and reload the
    // page with a 200 — give that a few seconds before accepting the error.
    entry.errorStatus = d.statusCode;
    clearTimeout(entry.graceTimer);
    entry.graceTimer = setTimeout(() => {
      entry.finish({ status: 'http', httpStatus: entry.errorStatus, ms });
    }, 4000);
  }, lcpVerifyFilter);

  chrome.webRequest.onErrorOccurred.addListener((d) => {
    const entry = lcpVerify.pending.get(d.tabId);
    if (!entry) return;
    // Response headers arrived fine but the navigation didn't commit (e.g.
    // the URL is a file download) — the server answered, so use that status.
    if (entry.headerStatus !== null && entry.headerStatus < 400) {
      entry.finish({ status: 'ok', httpStatus: entry.headerStatus, ms: Date.now() - entry.start });
      return;
    }
    if (entry.errorStatus !== null) return; // grace timer will settle it
    if (d.error === 'net::ERR_ABORTED') {
      entry.finish({ status: 'unavailable' });
      return;
    }
    entry.finish({ status: 'neterror', error: d.error, ms: Date.now() - entry.start });
  }, lcpVerifyFilter);
}

// A verification navigation that turns out to be a file download must not
// leave a file behind in the user's Downloads folder.
chrome.downloads.onCreated.addListener((item) => {
  const urls = [item.url, item.finalUrl];
  const discard = () => {
    chrome.downloads.cancel(item.id)
      .catch(() => {})
      .then(() => chrome.downloads.removeFile(item.id).catch(() => {}))
      .then(() => chrome.downloads.erase({ id: item.id }).catch(() => {}));
  };
  for (const entry of lcpVerify.pending.values()) {
    if (urls.includes(entry.url) || urls.includes(entry.finalUrl)) {
      discard();
      entry.finish({ status: 'ok', httpStatus: entry.headerStatus && entry.headerStatus < 400 ? entry.headerStatus : 200, ms: Date.now() - entry.start });
      return;
    }
  }
  const now = Date.now();
  for (const [url, expires] of lcpVerify.recentUrls) {
    if (expires < now) lcpVerify.recentUrls.delete(url);
  }
  if (urls.some((u) => lcpVerify.recentUrls.has(u))) discard();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const entry = lcpVerify.pending.get(tabId);
  if (entry) entry.finish({ status: 'unavailable' });
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === lcpVerify.windowId) {
    lcpVerify.windowId = null;
    chrome.storage.session.remove(LCP_VERIFY_WINDOW_KEY).catch(() => {});
  }
});
