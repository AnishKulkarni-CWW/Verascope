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
// Link Checker Pro — background subsystem
// Ported from the standalone "Link Checker Pro" extension's own
// background.js. It replaces the old, much heavier "Check My
// Links" clone that used to live here — that version depended on
// an entire injected iframe report UI (jQuery, Bootstrap,
// DataTables, JSZip, PDF fonts) whose icon assets never shipped
// with this repo, so every icon in its report broke with
// net::ERR_FILE_NOT_FOUND and the tool was effectively unusable.
// Link Checker Pro needs none of that: it checks link status from
// here (the service worker) and reports results straight back to
// the shell's own Crawler pane, the same pattern every other tool
// in this popup already uses.
//
// Runs a HEAD (falling back to GET) fetch per link and classifies
// the result. Cross-origin requests still tell us success/failure/
// timeout even though the response body isn't readable.
// ============================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'LCP_CHECK_LINK') {
    checkLink(msg.href, msg.timeout || 8000).then(sendResponse);
    return true; // keep the message channel open for async response
  }
});

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
