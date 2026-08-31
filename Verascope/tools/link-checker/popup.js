// ============================================================
// Tool 6: Broken Link Crawler — popup script (Link Checker Pro v1.1).
// Ported from the standalone "Link Checker Pro" extension's own
// popup.js. IIFE-wrapped and pane-scoped like every other tool
// script sharing this document — all getElementById() calls from
// the original became pane.querySelector(). ExcelJS is loaded once
// for the whole shell (libs/exceljs_bundle.js, already used by Meta
// Inspector's export elsewhere) rather than bundling this tool's
// own second copy, unlike the standalone extension's own
// exceljs.min.js — same library, one fewer 900KB file in the repo.
//
// The popup no longer owns scan state or performs the link checks
// itself. All of that lives in background.js, keyed by tabId and
// persisted to chrome.storage.local. This popup just:
//   1. Tells background.js to start a scan for the current tab.
//   2. Polls background.js for the latest state and renders it.
//   3. Reads whatever state already exists for this tab when
//      opened, so results reappear even if the page tab was closed
//      and reopened, or the popup itself was closed mid-scan.
// window.LinkCheckerTool.init() re-runs the same init() the
// original ran unconditionally at load, since re-entering this tab
// should re-sync from whatever the background scan is doing now.
// ============================================================
(function () {
  'use strict';

  const pane = document.querySelector('[data-tool-pane="link-checker"]');

  const PAGE_SIZE = 12;
  const POLL_MS = 500;

  // ── State (mirrors background.js's per-tab state) ─────────────────────
  let currentTabId = null;
  let pageInfo = { pageUrl: '', pageTitle: '' };
  let allResults = [];
  let filteredResults = [];
  let currentFilter = 'all';
  let searchTerm = '';
  let currentPage = 1;
  let scanStatusValue = 'idle'; // idle | collecting | checking | done
  let highlightOn = false;
  let pollTimer = null;

  // ── DOM refs ───────────────────────────────────────────────────────────
  const $ = (id) => pane.querySelector('#' + id);
  const pageUrlEl = $('lc-page-url');
  const btnScan = $('lc-btn-scan');
  const btnScanLabel = $('lc-btn-scan-label');
  const scanStatus = $('lc-scan-status');
  const progressTrack = $('lc-progress-track');
  const progressFill = $('lc-progress-fill');

  const statsBar = $('lc-stats-bar');
  const statTotal = $('lc-stat-total');
  const statOk = $('lc-stat-ok');
  const statBroken = $('lc-stat-broken');
  const statRedirect = $('lc-stat-redirect');
  const statSlow = $('lc-stat-slow');
  const statUnverified = $('lc-stat-unverified');

  const filterRow = $('lc-filter-row');
  const filterPills = $('lc-filter-pills');
  const searchBox = $('lc-search-box');
  const btnCopyAll = $('lc-btn-copy-all');

  const tableWrap = $('lc-table-wrap');
  const tableBody = $('lc-table-body');
  const emptyState = $('lc-empty-state');

  const pagination = $('lc-pagination');
  const pagePrev = $('lc-page-prev');
  const pageNext = $('lc-page-next');
  const pageInfoEl = $('lc-page-info');

  const chkHighlight = $('lc-chk-highlight');
  const btnExport = $('lc-btn-export');

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(() => refreshFromBackground(false), POLL_MS);
  }

  // ── Pull latest state from background and re-render ────────────────────
  async function refreshFromBackground(isInitialLoad) {
    if (currentTabId === null) return;
    chrome.runtime.sendMessage({ type: 'LCP_GET_STATE', tabId: currentTabId }, (data) => {
      if (chrome.runtime.lastError) return;
      if (!data) {
        // No scan has ever run for this tab — leave the empty state as-is.
        return;
      }
      applyState(data, isInitialLoad);
    });
  }

  function applyState(data, isInitialLoad) {
    pageInfo = { pageUrl: data.pageUrl, pageTitle: data.pageTitle };
    if (data.pageUrl) {
      pageUrlEl.textContent = data.pageUrl;
      pageUrlEl.title = data.pageUrl;
    }
    allResults = data.results || [];
    scanStatusValue = data.status || 'idle';

    if (scanStatusValue === 'collecting') {
      btnScan.disabled = true;
      btnScanLabel.textContent = 'Scanning…';
      scanStatus.textContent = 'Collecting links from the page (including frames)…';
      progressTrack.style.display = 'block';
      progressFill.style.width = '5%';
    } else if (scanStatusValue === 'checking') {
      btnScan.disabled = true;
      btnScanLabel.textContent = 'Scanning…';
      const total = data.total || allResults.length || 1;
      const completed = data.completed || 0;
      const pct = Math.round((completed / total) * 100);
      scanStatus.textContent = `Checked ${completed} of ${total} links…`;
      progressTrack.style.display = 'block';
      progressFill.style.width = pct + '%';
    } else if (scanStatusValue === 'done') {
      btnScan.disabled = false;
      btnScanLabel.textContent = 'Re-Analyze All Links on This Page';
      scanStatus.textContent = allResults.length
        ? `Done — ${allResults.length} link${allResults.length === 1 ? '' : 's'} checked.`
        : 'No links found on this page.';
      progressTrack.style.display = 'none';
      btnExport.disabled = allResults.length === 0;
    } else {
      btnScan.disabled = false;
      btnScanLabel.textContent = 'Analyze All Links on This Page';
      progressTrack.style.display = 'none';
    }

    if (allResults.length > 0) {
      statsBar.style.display = 'flex';
      filterRow.style.display = 'block';
    }

    applyFiltersAndRender();

    if (isInitialLoad && highlightOn) {
      pushHighlight();
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(str ?? ''));
    return div.innerHTML;
  }

  function shortenUrl(url, max) {
    if (!url) return '';
    return url.length > max ? url.slice(0, max - 1) + '…' : url;
  }

  function sendToActiveTab(message) {
    return new Promise((resolve) => {
      if (currentTabId === null) return resolve(null);
      chrome.tabs.sendMessage(currentTabId, message, (response) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(response);
      });
    });
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      // Fallback for contexts where clipboard API is blocked.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        document.body.removeChild(ta);
        return true;
      } catch (e2) {
        document.body.removeChild(ta);
        return false;
      }
    }
  }

  // ── Scan trigger ───────────────────────────────────────────────────────
  btnScan.addEventListener('click', () => {
    if (currentTabId === null) return;
    btnScan.disabled = true;
    btnScanLabel.textContent = 'Scanning…';
    scanStatus.textContent = 'Starting scan…';
    currentPage = 1;
    currentFilter = 'all';
    searchTerm = '';
    searchBox.value = '';
    setActivePill('all');
    chrome.runtime.sendMessage({ type: 'LCP_START_SCAN', tabId: currentTabId });
  });

  // ── Filtering + rendering ─────────────────────────────────────────────
  function setActivePill(filter) {
    filterPills.querySelectorAll('.pill').forEach((p) => {
      p.classList.toggle('active', p.dataset.filter === filter);
    });
  }

  function applyFiltersAndRender() {
    let list = allResults;

    if (currentFilter === 'broken') list = list.filter((r) => r.status === 'broken' || r.status === 'timeout');
    else if (currentFilter === 'redirect') list = list.filter((r) => r.status === 'redirect');
    else if (currentFilter === 'slow') list = list.filter((r) => r.status === 'slow');
    else if (currentFilter === 'ok') list = list.filter((r) => r.status === 'ok');
    else if (currentFilter === 'internal') list = list.filter((r) => r.scope === 'internal');
    else if (currentFilter === 'external') list = list.filter((r) => r.scope === 'external');

    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      list = list.filter((r) => r.href.toLowerCase().includes(term) || (r.text || '').toLowerCase().includes(term));
    }

    filteredResults = list;
    updateStats();
    renderTable();
  }

  function updateStats() {
    // Only terminal (non-pending) states are counted, so numbers don't
    // jump around while a scan is still in progress — a pending link
    // that hasn't been checked yet is never counted as OK or Broken.
    const counts = { ok: 0, broken: 0, redirect: 0, slow: 0, unverified: 0 };
    allResults.forEach((r) => {
      if (r.status === 'ok') counts.ok++;
      else if (r.status === 'broken' || r.status === 'timeout') counts.broken++;
      else if (r.status === 'redirect') counts.redirect++;
      else if (r.status === 'slow') counts.slow++;
      else if (r.status === 'unverified' || r.status === 'skipped') counts.unverified++;
    });
    statTotal.textContent = allResults.length;
    statOk.textContent = counts.ok;
    statBroken.textContent = counts.broken;
    statRedirect.textContent = counts.redirect;
    statSlow.textContent = counts.slow;
    statUnverified.textContent = counts.unverified;
  }

  function statusBadge(status) {
    const map = {
      ok: ['OK', 'badge-ok'],
      broken: ['Broken', 'badge-broken'],
      redirect: ['Redirect', 'badge-redirect'],
      slow: ['Slow', 'badge-slow'],
      unverified: ['Unverified', 'badge-unverified'],
      timeout: ['Timeout', 'badge-timeout'],
      skipped: ['Skipped', 'badge-skipped'],
      pending: ['Checking…', 'badge-pending']
    };
    const [label, cls] = map[status] || ['—', 'badge-unverified'];
    return `<span class="badge ${cls}">${label}</span>`;
  }

  function renderTable() {
    const total = filteredResults.length;

    if (total === 0) {
      tableWrap.style.display = 'none';
      pagination.style.display = 'none';
      emptyState.style.display = 'block';
      emptyState.querySelector('p').textContent = allResults.length === 0
        ? 'Click "Analyze All Links" above to scan every link on this page — from the top navigation to the footer, including menus and embedded frames.'
        : 'No links match this filter.';
      return;
    }

    emptyState.style.display = 'none';
    tableWrap.style.display = 'block';

    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (currentPage > totalPages) currentPage = totalPages;
    const start = (currentPage - 1) * PAGE_SIZE;
    const pageItems = filteredResults.slice(start, start + PAGE_SIZE);

    tableBody.innerHTML = pageItems.map((r) => {
      const codeText = r.httpStatus ? r.httpStatus : '—';
      const timeText = (r.ms !== null && r.ms !== undefined && r.status !== 'pending' && r.status !== 'skipped') ? `${r.ms}ms` : '—';
      return `
        <tr>
          <td>${r.index}</td>
          <td>${statusBadge(r.status)}</td>
          <td>
            <a class="link-cell" data-href="${escapeHtml(r.href)}" title="${escapeHtml(r.href)}">${escapeHtml(shortenUrl(r.href, 34))}</a>
            <span class="link-text-sub" title="${escapeHtml(r.text)}">${escapeHtml(shortenUrl(r.text, 34))}</span>
          </td>
          <td><span class="loc-tag">${escapeHtml(r.location)}</span></td>
          <td>${codeText}</td>
          <td>${timeText}</td>
          <td>
            <button class="copy-btn" data-href="${escapeHtml(r.href)}" title="Copy this URL" type="button">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
            </button>
          </td>
        </tr>
      `;
    }).join('');

    tableBody.querySelectorAll('.link-cell').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        const url = el.dataset.href;
        sendToActiveTab({ type: 'LCP_OPEN_URL', url });
      });
    });

    tableBody.querySelectorAll('.copy-btn').forEach((el) => {
      el.addEventListener('click', async (e) => {
        e.preventDefault();
        const url = el.dataset.href;
        const ok = await copyText(url);
        if (ok) {
          el.classList.add('copied');
          setTimeout(() => el.classList.remove('copied'), 1200);
        }
      });
    });

    pagination.style.display = totalPages > 1 ? 'flex' : 'none';
    pageInfoEl.textContent = `Page ${currentPage} of ${totalPages}`;
    pagePrev.disabled = currentPage <= 1;
    pageNext.disabled = currentPage >= totalPages;
  }

  // ── Copy all (visible/filtered) URLs at once ───────────────────────────
  btnCopyAll.addEventListener('click', async () => {
    if (!filteredResults.length) return;
    const text = filteredResults.map((r) => r.href).join('\n');
    const ok = await copyText(text);
    if (ok) {
      btnCopyAll.textContent = `Copied ${filteredResults.length}!`;
      btnCopyAll.classList.add('copied');
      setTimeout(() => {
        btnCopyAll.textContent = 'Copy All';
        btnCopyAll.classList.remove('copied');
      }, 1400);
    }
  });

  // ── Event listeners ────────────────────────────────────────────────────
  filterPills.addEventListener('click', (e) => {
    const btn = e.target.closest('.pill');
    if (!btn) return;
    currentFilter = btn.dataset.filter;
    currentPage = 1;
    setActivePill(currentFilter);
    applyFiltersAndRender();
  });

  let searchDebounce;
  searchBox.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      searchTerm = searchBox.value.trim();
      currentPage = 1;
      applyFiltersAndRender();
    }, 150);
  });

  pagePrev.addEventListener('click', () => {
    if (currentPage > 1) { currentPage--; renderTable(); }
  });
  pageNext.addEventListener('click', () => {
    const totalPages = Math.max(1, Math.ceil(filteredResults.length / PAGE_SIZE));
    if (currentPage < totalPages) { currentPage++; renderTable(); }
  });

  chkHighlight.addEventListener('change', () => {
    highlightOn = chkHighlight.checked;
    pushHighlight();
  });

  function pushHighlight() {
    if (highlightOn) {
      const brokenHrefs = allResults.filter((r) => r.status === 'broken' || r.status === 'timeout').map((r) => r.href);
      sendToActiveTab({ type: 'LCP_HIGHLIGHT_BROKEN', hrefs: brokenHrefs });
      sendToActiveTab({ type: 'LCP_HIGHLIGHT_ALL', enabled: true });
    } else {
      sendToActiveTab({ type: 'LCP_HIGHLIGHT_ALL', enabled: false });
      sendToActiveTab({ type: 'LCP_HIGHLIGHT_BROKEN', hrefs: [] });
    }
  }

  // ── Excel export — polished, professional formatting (ExcelJS) ────────
  btnExport.addEventListener('click', () => {
    exportToExcel().catch((err) => {
      console.error('Export failed', err);
      scanStatus.textContent = 'Export failed — see console for details.';
    });
  });

  function statusLabelForExport(status) {
    const map = {
      ok: 'OK', broken: 'Broken', redirect: 'Redirect', slow: 'Slow',
      unverified: 'Unverified', timeout: 'Timeout', skipped: 'Skipped (non-HTTP)', pending: 'Not checked'
    };
    return map[status] || status;
  }

  function scopeLabel(scope) {
    const map = { internal: 'Internal', external: 'External', anchor: 'Anchor (#)', mailto: 'Mailto', tel: 'Tel' };
    return map[scope] || scope;
  }

  const NAVY = 'FF1F3B73';
  const WHITE = 'FFFFFFFF';
  const BAND = 'FFF3F6FC';
  const BORDER = 'FFD9DEE8';
  const GREEN_BG = 'FFDCFCE7';
  const GREEN_TEXT = 'FF166534';
  const RED_BG = 'FFFEE2E2';
  const RED_TEXT = 'FF991B1B';
  const AMBER_BG = 'FFFEF3C7';
  const AMBER_TEXT = 'FF92400E';
  const GRAY_BG = 'FFF1F2F5';
  const GRAY_TEXT = 'FF4B5563';

  function thinBorder() {
    return {
      top: { style: 'thin', color: { argb: BORDER } },
      left: { style: 'thin', color: { argb: BORDER } },
      bottom: { style: 'thin', color: { argb: BORDER } },
      right: { style: 'thin', color: { argb: BORDER } }
    };
  }

  async function exportToExcel() {
    if (!allResults.length) return;

    const originalLabel = btnExport.innerHTML;
    btnExport.disabled = true;

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Verascope — Broken Link Crawler';
    wb.created = new Date();

    // ── Summary sheet ──────────────────────────────────────────────────
    const counts = { ok: 0, broken: 0, redirect: 0, slow: 0, unverified: 0, skipped: 0 };
    allResults.forEach((r) => {
      if (r.status === 'timeout') counts.broken++;
      else if (counts.hasOwnProperty(r.status)) counts[r.status]++;
    });

    const summary = wb.addWorksheet('Summary', {
      views: [{ showGridLines: false }]
    });
    summary.columns = [{ width: 26 }, { width: 64 }];

    summary.mergeCells('A1:B1');
    const titleCell = summary.getCell('A1');
    titleCell.value = 'Broken Link Crawler — Scan Report';
    titleCell.font = { bold: true, size: 18, color: { argb: NAVY } };
    summary.getRow(1).height = 28;

    const metaRows = [
      ['Page URL', pageInfo.pageUrl || ''],
      ['Page Title', pageInfo.pageTitle || ''],
      ['Scan Date', new Date().toLocaleString()]
    ];
    metaRows.forEach(([label, value], i) => {
      const rowNum = i + 3;
      const labelCell = summary.getCell(`A${rowNum}`);
      const valueCell = summary.getCell(`B${rowNum}`);
      labelCell.value = label;
      labelCell.font = { bold: true, color: { argb: GRAY_TEXT } };
      valueCell.value = value;
    });

    const headerRowNum = 7;
    const headerRow = summary.getRow(headerRowNum);
    headerRow.getCell(1).value = 'Metric';
    headerRow.getCell(2).value = 'Count';
    [1, 2].forEach((c) => {
      const cell = headerRow.getCell(c);
      cell.font = { bold: true, color: { argb: WHITE } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
      cell.border = thinBorder();
      cell.alignment = { vertical: 'middle' };
    });

    const metrics = [
      ['Total Links', allResults.length, null],
      ['OK', counts.ok, GREEN_TEXT],
      ['Broken', counts.broken, RED_TEXT],
      ['Redirects', counts.redirect, AMBER_TEXT],
      ['Slow (>3s)', counts.slow, AMBER_TEXT],
      ['Unverified', counts.unverified, GRAY_TEXT],
      ['Skipped (non-HTTP)', counts.skipped, GRAY_TEXT]
    ];
    metrics.forEach(([label, value, color], i) => {
      const rowNum = headerRowNum + 1 + i;
      const row = summary.getRow(rowNum);
      row.getCell(1).value = label;
      row.getCell(2).value = value;
      const isBand = (i % 2 === 1);
      [1, 2].forEach((c) => {
        const cell = row.getCell(c);
        cell.border = thinBorder();
        if (isBand) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND } };
      });
      row.getCell(2).font = { bold: true, color: { argb: color || 'FF1F2430' } };
    });

    // ── Data sheet ────────────────────────────────────────────────────
    const data = wb.addWorksheet('Link Data', {
      views: [{ state: 'frozen', ySplit: 1 }]
    });

    const columns = [
      { header: '#', key: 'index', width: 6 },
      { header: 'Status', key: 'status', width: 14 },
      { header: 'HTTP Code', key: 'httpCode', width: 11 },
      { header: 'Response Time (ms)', key: 'ms', width: 16 },
      { header: 'Link URL', key: 'url', width: 60 },
      { header: 'Anchor Text', key: 'text', width: 32 },
      { header: 'Location', key: 'location', width: 14 },
      { header: 'Link Type', key: 'linkType', width: 12 },
      { header: 'Rel Attribute', key: 'rel', width: 14 },
      { header: 'Nofollow', key: 'nofollow', width: 10 },
      { header: 'Target', key: 'target', width: 9 },
      { header: 'Occurrences', key: 'occurrences', width: 12 },
      { header: 'Notes', key: 'notes', width: 22 }
    ];
    data.columns = columns;

    const headerRowData = data.getRow(1);
    headerRowData.height = 22;
    headerRowData.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: WHITE }, size: 11 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.border = thinBorder();
    });

    allResults.forEach((r, i) => {
      const row = data.addRow({
        index: r.index,
        status: statusLabelForExport(r.status),
        httpCode: r.httpStatus || '',
        ms: (r.ms !== null && r.ms !== undefined) ? r.ms : '',
        url: r.href,
        text: r.text,
        location: r.location,
        linkType: scopeLabel(r.scope),
        rel: r.rel,
        nofollow: r.nofollow ? 'Yes' : 'No',
        target: r.target,
        occurrences: r.occurrences,
        notes: r.reason || ''
      });

      // Make the URL a clickable hyperlink.
      const urlCell = row.getCell('url');
      if (/^https?:\/\//i.test(r.href)) {
        urlCell.value = { text: r.href, hyperlink: r.href };
        urlCell.font = { color: { argb: 'FF3D63D9' }, underline: true, size: 10.5 };
      }

      const isBand = (i % 2 === 1);
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cell.border = thinBorder();
        if (isBand) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND } };
        cell.alignment = { vertical: 'middle', horizontal: colNumber === 1 ? 'center' : 'left' };
        if (!cell.font) cell.font = { size: 10.5 };
      });

      const statusCell = row.getCell('status');
      const val = statusCell.value;
      let bg = null, fg = 'FF1F2430';
      if (val === 'OK') { bg = GREEN_BG; fg = GREEN_TEXT; }
      else if (val === 'Broken' || val === 'Timeout') { bg = RED_BG; fg = RED_TEXT; }
      else if (val === 'Redirect' || val === 'Slow') { bg = AMBER_BG; fg = AMBER_TEXT; }
      else if (typeof val === 'string' && (val.startsWith('Unverified') || val.startsWith('Skipped'))) { bg = GRAY_BG; fg = GRAY_TEXT; }
      if (bg) {
        statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
        statusCell.font = { bold: true, color: { argb: fg }, size: 10.5 };
        statusCell.alignment = { vertical: 'middle', horizontal: 'center' };
      }
    });

    data.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };

    const safeName = (pageInfo.pageUrl || 'report')
      .replace(/^https?:\/\//, '')
      .split(/[?#]/)[0]
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'report';

    const buffer = await wb.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `LinkChecker_${safeName}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 30000);

    btnExport.disabled = false;
    btnExport.innerHTML = originalLabel;
  }

  window.LinkCheckerTool = {
    async init() {
      const tabs = await new Promise((resolve) => chrome.tabs.query({ active: true, currentWindow: true }, resolve));
      const tab = tabs[0];
      if (!tab) return;
      currentTabId = tab.id;
      pageUrlEl.textContent = tab.url || 'Ready to scan';
      pageUrlEl.title = tab.url || '';

      await refreshFromBackground(true);
      startPolling();
    }
  };
})();
