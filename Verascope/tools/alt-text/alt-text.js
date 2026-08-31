// ============================================================
// Alt Text Viewer (Extension 2)
// Wrapped in an IIFE for scope isolation from the other two
// tools' popup scripts. Exposes window.AltTextTool.init(), which
// the tab shell (popup.js) calls the first time this tab is
// opened, so its status-refresh call doesn't fire before the
// tab is visible. All messaging to background.js/content.js is
// unchanged from the original.
// ============================================================
(function () {
  // Scoped to this tool's own pane: #exportBtn and #status are reused
  // (with different meaning) by the other two tools' original markup,
  // so an unqualified getElementById() would risk grabbing the wrong
  // element depending on DOM order. toggleBtn/exportBtn/status.
  const pane = document.querySelector('[data-tool-pane="alt-text"]');
  const toggleBtn = pane.querySelector('#toggleBtn');
  const exportBtn = pane.querySelector('#exportBtn');
  const statusEl  = pane.querySelector('#status');

  function setStatus(msg) {
    statusEl.textContent = msg;
  }

  function getActiveTab() {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0]));
    });
  }

  function isRestrictedUrl(url) {
    if (!url) return true;
    return (
      url.startsWith('chrome://') ||
      url.startsWith('chrome-extension://') ||
      url.startsWith('edge://') ||
      url.startsWith('about:') ||
      url.startsWith('https://chrome.google.com/webstore') ||
      url.startsWith('https://chromewebstore.google.com')
    );
  }

  // Ping the tab first. If content.js is already running, do nothing —
  // re-injecting it would re-run its top-level `let`/`const` declarations
  // in the same JS world and throw "already declared" errors, which
  // silently breaks messaging. Only inject when there's truly no
  // listener yet (fresh tab, or one that pre-dates this extension load).
  function pingContentScript(tabId) {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { action: 'ping' }, () => {
        resolve(!chrome.runtime.lastError);
      });
    });
  }

  async function ensureContentScript(tabId) {
    const alreadyLoaded = await pingContentScript(tabId);
    if (alreadyLoaded) return true;

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['tools/alt-text/content.js']
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  function sendMessageWithRetry(tabId, message) {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ error: chrome.runtime.lastError.message });
        } else {
          resolve({ response });
        }
      });
    });
  }

  async function refreshToggleUI() {
    const tab = await getActiveTab();
    if (!tab) return;
    chrome.runtime.sendMessage({ action: 'getAltStateForTab', tabId: tab.id }, (response) => {
      const active = response && response.active;
      toggleBtn.classList.toggle('off', !active);
      toggleBtn.textContent = active ? 'Overlay: ON' : 'Overlay: OFF';
    });
  }

  toggleBtn.addEventListener('click', async () => {
    const tab = await getActiveTab();
    if (!tab) return;

    if (isRestrictedUrl(tab.url)) {
      setStatus('This page type cannot be modified by extensions.');
      return;
    }

    await ensureContentScript(tab.id);

    chrome.runtime.sendMessage({ action: 'toggleFromPopup', tabId: tab.id }, () => {
      refreshToggleUI();
    });
  });

  exportBtn.addEventListener('click', async () => {
    const tab = await getActiveTab();
    if (!tab) return;

    if (isRestrictedUrl(tab.url)) {
      setStatus('This page type cannot be scanned (browser-internal or store page). Try a regular website.');
      return;
    }

    exportBtn.disabled = true;
    setStatus('Preparing page…');

    await ensureContentScript(tab.id);

    setStatus('Collecting images…');

    const { response, error } = await sendMessageWithRetry(tab.id, { action: 'exportReport' });

    if (error) {
      exportBtn.disabled = false;
      setStatus('Error: could not reach the page. Try reloading the page itself (not just the extension), then try again.');
      return;
    }

    if (!response || !response.rows) {
      exportBtn.disabled = false;
      setStatus('No data returned.');
      return;
    }

    if (response.rows.length === 0) {
      exportBtn.disabled = false;
      setStatus('No images (10x10px or larger) found on this page.');
      return;
    }

    setStatus(`Building report for ${response.rows.length} image(s)…`);

    chrome.runtime.sendMessage(
      { action: 'buildExportFile', rows: response.rows },
      (buildResponse) => {
        exportBtn.disabled = false;
        if (buildResponse && buildResponse.ok) {
          setStatus('Report downloaded.');
        } else {
          setStatus('Failed to build report: ' + (buildResponse && buildResponse.error ? buildResponse.error : 'unknown error'));
        }
      }
    );
  });

  let initialized = false;
  window.AltTextTool = {
    init() {
      // Safe to call every time the tab is opened — refreshToggleUI()
      // is idempotent, and re-running it keeps ON/OFF state correct
      // if the user switched real browser tabs while on a different
      // popup tab.
      refreshToggleUI();
      initialized = true;
    }
  };
})();
