// ============================================================
// Tool 6: Check My Links — shell trigger.
// IIFE-wrapped and pane-scoped like every other tool script,
// even though this pane currently has no id collisions with
// the other five (cheap insurance against a future 7th tool).
//
// This does NOT reimplement any scanning logic. It only starts
// the scan the same way the original extension's
// chrome.action.onClicked used to — by calling the background
// worker's startLinkCheckScan(tab) — except reached via message
// instead of a click event, since QA ToolKit's shared popup
// means that click event can never fire (see the long comment
// in background.js for why). The actual scan, progress
// tracking, exclude picker, and all exports happen entirely on
// the scanned page via the injected linkreport.html iframe,
// which is why this pane has almost no UI of its own.
// ============================================================
(function () {
  const pane = document.querySelector('[data-tool-pane="link-checker"]');
  const scanBtn = pane.querySelector('#lcScanBtn');
  const statusEl = pane.querySelector('#lcStatus');

  const DEFAULT_STATUS = 'Opens a live report on the page — counts, exclude areas, and exports all happen there.';

  function setStatus(message, isError) {
    statusEl.textContent = message;
    statusEl.classList.toggle('error', Boolean(isError));
  }

  scanBtn.addEventListener('click', async () => {
    scanBtn.disabled = true;
    setStatus('Starting scan…');
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) {
        setStatus('No active tab is available.', true);
        scanBtn.disabled = false;
        return;
      }
      if (
        tab.url.indexOf('https://chromewebstore.google.com/') === 0 ||
        tab.url.indexOf('https://chrome.google.com') === 0 ||
        tab.url.indexOf('chrome://') === 0 ||
        tab.url.indexOf('chrome-extension://') === 0 ||
        tab.url.indexOf('edge://') === 0
      ) {
        setStatus('This page type cannot be scanned (Chrome/Edge internal or store pages).', true);
        scanBtn.disabled = false;
        return;
      }
      await chrome.runtime.sendMessage({ action: 'startLinkCheckScan' });
      setStatus('Scan started — check the page for the live report.');
      // Close the popup so the person immediately sees the on-page
      // overlay rather than staring at this trigger pane. A short
      // delay keeps the status message visible for a moment first.
      setTimeout(() => window.close(), 600);
    } catch (err) {
      setStatus('Could not start the scan: ' + (err && err.message ? err.message : String(err)), true);
      scanBtn.disabled = false;
    }
  });

  window.LinkCheckerTool = {
    init() {
      // No state to refresh on tab-open — this pane only acts on the
      // Scan button click, mirroring Link Extractor's no-op init().
      setStatus(DEFAULT_STATUS, false);
      scanBtn.disabled = false;
    }
  };
})();
