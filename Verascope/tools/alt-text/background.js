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
// Check My Links — background subsystem
// Merged from the standalone extension's own background.js.
// Manifest V3 only allows one service worker file, so this
// lives here as a second, independent section rather than a
// separate file — its chrome.runtime.onMessage/tabs.onUpdated
// listeners are registered alongside (not instead of) Alt
// Text's own listeners above; Chrome supports multiple
// listeners per event with no conflict, confirmed empirically
// after this merge.
//
// PAYWALL/LOGIN/MARKETING REMOVED: the install/update listener
// that opened a marketing page and set an uninstall-survey URL
// was dropped entirely (confirmed to have zero effect on any
// link-checking feature — nothing else reads state it sets).
//
// TRIGGER MECHANISM CHANGED: the original used
// chrome.action.onClicked to start a scan when the toolbar icon
// was clicked. QA ToolKit's manifest sets a default_popup,
// which means action.onClicked NEVER fires (this is documented
// Chrome behavior, not a bug) — the shared popup swallows the
// click instead. startLinkCheckScan() below is the same
// injection logic, callable directly by the shell's popup.js
// via chrome.runtime.sendMessage instead of waiting for a click
// event that will never come.
//
// PATH FIXES: every injected file path and chrome.runtime.getURL
// call was updated from the standalone extension's flat
// pages/js/css/lib layout to this tool's nested
// tools/link-checker/ location, since these paths resolve
// against the EXTENSION ROOT, not the caller's own folder.
// ============================================================

let hiddenWindowId = null, originalTabId = null;

var indexedDBHelper = (function () {
  var db = null, counter = 0;
  return {
    init: function () { indexedDBHelper.open(); },
    open: function () {
      return new Promise(function (resolve, reject) {
        var req = indexedDB.open("CheckLinks", 1);
        req.onupgradeneeded = function (e) {
          db = e.target.result;
          e.target.transaction.onerror = indexedDB.onerror;
          if (db.objectStoreNames.contains("links")) db.deleteObjectStore("links");
          db.createObjectStore("links", { keyPath: "id" }).createIndex("by_link", "link");
        };
        req.onsuccess = function (e) { db = e.target.result; resolve(); };
        req.onerror = function () { reject("Couldn't open DB"); };
      });
    },
    addLink: function (link, status) {
      var store = db.transaction(["links"], "readwrite").objectStore("links");
      counter++;
      return new Promise(function (resolve, reject) {
        var req = store.put({ id: counter, link: link, timeStamp: (new Date).getTime(), status: status });
        req.onsuccess = function () { resolve(); };
        req.onerror = function () { reject("Couldn't add the passed item"); };
      });
    },
    getLink: function (link) {
      var store = db.transaction(["links"], "readonly").objectStore("links");
      return new Promise(function (resolve, reject) {
        var req = store.index("by_link").get(link);
        req.onsuccess = function (e) { resolve(e.target.result); };
        req.onerror = function () { reject("Couldn't fetch items from the DB"); };
      });
    },
    getAllLinks: function () {
      var results = [], store = db.transaction(["links"], "readonly").objectStore("links");
      return new Promise(function (resolve, reject) {
        var range = IDBKeyRange.lowerBound(0);
        var cursorReq = store.openCursor(range);
        cursorReq.onsuccess = function (e) {
          var cursor = e.target.result;
          if (cursor === null || cursor === undefined) { resolve(results); }
          else {
            results.push(cursor.value);
            if (cursor.value.id > counter) counter = cursor.value.id;
            cursor.continue();
          }
        };
        cursorReq.onerror = function () { reject("Couldn't fetch items from the DB"); };
      });
    },
    deleteLink: function (id) {
      return new Promise(function (resolve, reject) {
        var req = db.transaction(["links"], "readwrite").objectStore("links").delete(id);
        req.onsuccess = function () { resolve(); };
        req.onerror = function () { reject("Couldn't delete the item"); };
      });
    },
    deleteObjectStore: function () {
      return indexedDBHelper.open().then(function () {
        return new Promise(function (resolve, reject) {
          var req = db.transaction(["links"], "readwrite").objectStore("links").clear();
          req.onsuccess = function () { resolve(); };
          req.onerror = function () { reject("Couldn't delete the item"); };
        });
      }, function () {});
    }
  };
})();
indexedDBHelper.init();

var cmlDefaultOptions = {
  blacklist: "doubleclick.net\nchromewebstore.google.com\nchrome.google.com\nappliedsemantics.com",
  checkType: "GET", cache: "false", noFollow: "false", parseDOM: "false", trailingHash: "false",
  emptyLink: "false", emptyLinkExclude: "false", noHrefAttr: "false", autoCheck: "false",
  optionsURL: "chrome-extension://" + chrome.runtime.id + "/options.html"
};

chrome.storage.local.get("defaultOptions", function (result) {
  if (chrome.runtime.lastError) {
    console.error("Error retrieving options:", chrome.runtime.lastError);
  } else if (result.defaultOptions) {
    console.log("Default options already exist:", result.defaultOptions);
  } else {
    chrome.storage.local.set({ vt: true });
    chrome.storage.local.set({ rt: true });
    chrome.storage.local.set({ wt: true });
    chrome.storage.local.set({ it: true });
    chrome.storage.local.set({ defaultOptions: cmlDefaultOptions }, function () {
      if (chrome.runtime.lastError) console.error("Error setting default options:", chrome.runtime.lastError);
      else console.log("Default options saved successfully.");
    });
  }
});

let cmlIsExecuting = false;
let cmlLastTabId = 0;

// Called by the shell's popup.js (tab: "Broken Links") in place
// of the dead chrome.action.onClicked listener. Same injection
// sequence as the original extension, just reachable by message
// instead of by toolbar click.
async function startLinkCheckScan(tab) {
  if (cmlIsExecuting) return;
  if (
    tab.url.indexOf("https://chromewebstore.google.com/") === 0 ||
    tab.url.indexOf("https://chrome.google.com") === 0 ||
    tab.url.indexOf("chrome://") === 0 ||
    tab.url.indexOf("chrome-extension://") === 0 ||
    tab.url.indexOf("edge://extensions/") === 0 ||
    tab.url.indexOf("edge://") === 0
  ) {
    return;
  }
  cmlIsExecuting = true;
  try {
    const [activeTab] = await chrome.tabs.query({ currentWindow: true, active: true });
    const [injectionCheck] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => !!window.__myContentScriptInjected
    });
    if (injectionCheck.result) {
      chrome.storage.local.get("defaultOptions", function (d) {
        chrome.tabs.sendMessage(activeTab.id, { action: "start", tabid: activeTab.id, options: d.defaultOptions });
      });
      console.log("start from withour exe");
      cmlIsExecuting = false;
      return true;
    }
    try {
      await chrome.scripting.executeScript({ target: { tabId: activeTab.id, allFrames: false }, files: ["tools/link-checker/lib/jquery.min.js"] });
      await chrome.scripting.executeScript({ target: { tabId: activeTab.id, allFrames: false }, files: ["tools/link-checker/contentScript.js"] });
      await chrome.scripting.executeScript({ target: { tabId: activeTab.id, allFrames: false }, files: ["tools/link-checker/helperfxn.js"] });
      await chrome.scripting.executeScript({ target: { tabId: activeTab.id, allFrames: false }, files: ["tools/link-checker/con-exclude.js"] });
      await chrome.scripting.insertCSS({ target: { tabId: activeTab.id, allFrames: false }, files: ["tools/link-checker/css/contentStyle.css"] });
      console.log("start from exe");
      chrome.storage.local.get("defaultOptions", function (d) {
        chrome.tabs.sendMessage(activeTab.id, { action: "start", tabid: activeTab.id, options: d.defaultOptions });
        cmlLastTabId = activeTab.id;
      });
    } catch (err) {
      console.error("Error executing scripts:", err);
    } finally {
      cmlIsExecuting = false;
    }
  } catch (err) {
    console.error("Error in startLinkCheckScan:", err);
    cmlIsExecuting = false;
  }
}

// Auto-check on navigation, when enabled in settings. Unlike the
// original, this always registers (the original's
// storeExtensionId/edgeStoreExtensionId guard existed to skip
// this on the published Chrome/Edge store builds specifically;
// that distinction is meaningless once this is part of QA
// ToolKit, which is neither of those listings).
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url && tab.active && tab.id == cmlLastTabId) {
    setTimeout(() => {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        startLinkCheckScan(tabs[0]);
      });
    }, 5000);
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "startLinkCheckScan") {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      startLinkCheckScan(tabs[0]);
    });
    sendResponse({ ok: true });
    return true;
  }

  if (request.action === "hided") {
    originalTabId = sender.tab.id;
    const minimizeUrl = chrome.runtime.getURL("tools/link-checker/pages/minimize-checkmylink.html?id=" + originalTabId);
    chrome.tabs.query({ url: minimizeUrl }, existing => {
      if (!existing.length) {
        chrome.windows.create({ url: minimizeUrl, type: "popup", width: 400, height: 600, left: 400, top: 150 }, win => {
          hiddenWindowId = win.id;
          chrome.windows.update(hiddenWindowId, { state: "minimized" });
        });
      }
    });
  }

  if (request.action === "reloadTab") {
    chrome.tabs.query({ currentWindow: true, active: true }, function (tabs) {
      chrome.storage.local.get("defaultOptions", function (d) {
        chrome.tabs.sendMessage(tabs[0].id, { action: "start", actions: "starts", tabid: tabs[0].id, options: d.defaultOptions });
      });
    });
  } else if (request.action === "check") {
    if (request.url) {
      chrome.storage.local.get("defaultOptions", function (result) {
        const options = result.defaultOptions;
        let fallback = { status: null, document: null };
        if (cmlXhrIsNecessary(options, request.url) === true) {
          cmlCheck(request.url, options.checkType).then(function (res) {
            if (options.cache == "true" && res.status >= 200 && res.status < 400) indexedDBHelper.addLink(request.url, res.status);
            return new Promise(function (resolve) { resolve(res); });
          }).then(function (res) {
            sendResponse(res);
            return true;
          });
        } else {
          indexedDBHelper.getLink(request.url).then(function (cached) {
            let res;
            if (typeof cached !== "undefined" && cached.status >= 200 && cached.status < 400) {
              cmlLog("found");
              cmlLog(cached);
              fallback.status = cached.status;
              res = fallback;
            } else {
              res = cmlCheck(request.url, options.checkType);
            }
            return new Promise(function (resolve) { resolve(res); });
          }).then(function (res) {
            if (res.source == "xhr" && res.status >= 200 && res.status < 400) indexedDBHelper.addLink(request.url, res.status);
            return new Promise(function (resolve) { resolve(res); });
          }).then(function (res) {
            sendResponse(res);
            return true;
          });
        }
      });
    }
  } else if (request.action === "links") {
    chrome.tabs.create({ url: chrome.runtime.getURL("tools/link-checker/pages/links.html") }, tab => {
      chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
        if (tabId === tab.id && info.status === "complete") {
          chrome.tabs.sendMessage(tabId, { action: "displayreport", data: request.data, targetTab: request.targetTab });
        }
      });
    });
  } else if (request.action === "getstatus") {
    getActualHttpStatus(request.url, sender.tab.id);
  } else if (request.action === "getstatusMulti") {
    setTimeout(() => { getActualHttpStatus(request.url, sender.tab.id); }, 2000);
  }
  return true;
});

const cmlTimeout = 30000;
function cmlCheck(url, method) {
  let result = { status: null, document: null };
  return new Promise((resolve) => {
    const timer = setTimeout(() => { resolve({ status: 408, document: null }); }, cmlTimeout);
    fetch(url, { method: method, redirect: "follow" }).then(res => {
      clearTimeout(timer);
      result.status = (res.url === url.split("#")[0]) ? res.status : 300;
      return res.text();
    }).then(text => {
      result.document = text;
      result.source = "fetch";
      resolve(result);
    }).catch(err => {
      console.error(err);
      result.status = 0;
      resolve(result);
    });
  });
}
function cmlXhrIsNecessary(options, url) { return cmlShouldDomBeParsed(url, options.parseDOM, options.checkType) === true || options.cache == "false" ? true : false; }
function cmlShouldDomBeParsed(url, parseDOM, method) {
  return parseDOM === "true" && method == "GET" && url.lastIndexOf("#") > url.lastIndexOf("/") && url.lastIndexOf("#") < url.length - 1;
}
function cmlLog(msg) { /* mirrors original's `log()`, gated on a `logging` flag that defaults false in contentScript.js */ if (typeof logging !== "undefined" && logging) console.log(msg); }

var trackingWindowId = null, currentUrl = null, initiatorTabId = null;
function getActualHttpStatus(url, tabId) {
  currentUrl = url;
  initiatorTabId = tabId;
  if (trackingWindowId !== null) {
    chrome.tabs.get(trackingWindowId, existingTab => {
      if (chrome.runtime.lastError || !existingTab) openNewTrackingWindow(url);
      else chrome.tabs.update(trackingWindowId, { url: url }, updated => { console.log("Tab URL updated:", updated.url); });
    });
  } else {
    openNewTrackingWindow(url);
  }
}
function openNewTrackingWindow(url) {
  chrome.windows.create({ url: url, type: "popup", height: 630, width: 600, top: 20, left: 20 }, win => {
    trackingWindowId = win.tabs[0].id;
  });
}
chrome.webRequest.onCompleted.addListener(function (details) {
  if (details.tabId === trackingWindowId && details.type === "main_frame") {
    chrome.tabs.sendMessage(initiatorTabId, { action: "backHttp", currentUrl, status: details.statusCode, trackingWindowId });
  }
}, { urls: ["<all_urls>"] });
chrome.webRequest.onErrorOccurred.addListener(function (details) {
  if (details.tabId === trackingWindowId && details.type === "main_frame" && details.error === "net::ERR_CONNECTION_REFUSED") {
    chrome.tabs.sendMessage(initiatorTabId, { action: "backHttp", currentUrl, status: 0, trackingWindowId });
  }
}, { urls: ["<all_urls>"] });

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === hiddenWindowId && originalTabId !== null) {
    const win = await chrome.windows.get(windowId);
    if (win.state === "normal") {
      chrome.tabs.sendMessage(originalTabId, { action: "SHOW_CHECK_MY_LINK" });
      await chrome.windows.remove(hiddenWindowId);
      originalTabId = hiddenWindowId = null;
    }
  }
});
