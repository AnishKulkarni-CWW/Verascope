// ============================================================
// Tool 6 (replaced): Broken Link Crawler — popup script.
// Ported from the standalone "Link Checker Pro" extension's own
// popup.js. IIFE-wrapped and pane-scoped like every other tool
// script sharing this document — all getElementById() calls from
// the original became pane.querySelector() so this tool's ids
// (many generic: "search-box", "table-body", "empty-state") can't
// collide with the other six tools' markup. window.LinkCheckerTool
// exposes init(), called by the shell's popup.js the first time
// this tab is opened, matching every other tool's pattern — the
// original's own top-level init() call at file end was removed in
// favor of that. Scan/check/export logic is otherwise unchanged.
// ============================================================
(function () {
  'use strict';

  const pane = document.querySelector('[data-tool-pane="link-checker"]');

  const CONCURRENCY = 6;
  const PAGE_SIZE = 12;

  // ── State ──────────────────────────────────────────────────────────────
  let pageInfo = { pageUrl: '', pageTitle: '' };
  let allResults = [];       // full result objects
  let filteredResults = [];  // after search + pill filter
  let currentFilter = 'all';
  let searchTerm = '';
  let currentPage = 1;
  let isScanning = false;
  let highlightOn = false;

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

  const tableWrap = $('lc-table-wrap');
  const tableBody = $('lc-table-body');
  const emptyState = $('lc-empty-state');

  const pagination = $('lc-pagination');
  const pagePrev = $('lc-page-prev');
  const pageNext = $('lc-page-next');
  const pageInfoEl = $('lc-page-info');

  const chkHighlight = $('lc-chk-highlight');
  const btnExport = $('lc-btn-export');

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
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs[0]) return resolve(null);
        chrome.tabs.sendMessage(tabs[0].id, message, (response) => {
          if (chrome.runtime.lastError) {
            resolve(null);
          } else {
            resolve(response);
          }
        });
      });
    });
  }

  function checkLinkStatus(href) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'LCP_CHECK_LINK', href }, (res) => {
        if (chrome.runtime.lastError || !res) {
          resolve({ status: 'unverified', httpStatus: null, ms: 0, reason: 'no response' });
        } else {
          resolve(res);
        }
      });
    });
  }

  // ── Scan flow ──────────────────────────────────────────────────────────
  async function onScan() {
    if (isScanning) return;
    isScanning = true;
    btnScan.disabled = true;
    btnScanLabel.textContent = 'Scanning…';
    scanStatus.textContent = 'Collecting links from the page…';
    progressTrack.style.display = 'block';
    progressFill.style.width = '0%';
    btnExport.disabled = true;

    allResults = [];
    filteredResults = [];
    currentPage = 1;
    currentFilter = 'all';
    searchTerm = '';
    searchBox.value = '';
    setActivePill('all');

    const collected = await sendToActiveTab({ type: 'LCP_COLLECT_LINKS' });

    if (!collected || !collected.links) {
      scanStatus.textContent = 'Could not read this page. Try reloading the tab and scanning again.';
      resetScanButton();
      return;
    }

    pageInfo = { pageUrl: collected.pageUrl, pageTitle: collected.pageTitle };
    pageUrlEl.textContent = collected.pageUrl;

    const links = collected.links;
    const total = links.length;

    if (total === 0) {
      scanStatus.textContent = 'No links found on this page.';
      resetScanButton();
      renderTable();
      return;
    }

    // Seed placeholder rows so the table + stats appear immediately.
    allResults = links.map((l, i) => ({
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
      ms: null
    }));

    statsBar.style.display = 'flex';
    filterRow.style.display = 'block';
    applyFiltersAndRender();

    let completed = 0;
    scanStatus.textContent = `Checking ${total} link${total === 1 ? '' : 's'}…`;

    // Throttled concurrent checks (skip anchor/mailto/tel — nothing to verify).
    let cursor = 0;
    async function worker() {
      while (cursor < allResults.length) {
        const idx = cursor++;
        const item = allResults[idx];

        if (item.scope === 'anchor' || item.scope === 'mailto' || item.scope === 'tel') {
          item.status = 'skipped';
        } else {
          const result = await checkLinkStatus(item.href);
          item.status = result.status;
          item.httpStatus = result.httpStatus;
          item.ms = result.ms;
          item.reason = result.reason || '';
        }

        completed++;
        const pct = Math.round((completed / total) * 100);
        progressFill.style.width = pct + '%';
        scanStatus.textContent = `Checked ${completed} of ${total} links…`;

        if (completed % 5 === 0 || completed === total) {
          applyFiltersAndRender();
        }
      }
    }

    const workers = Array.from({ length: Math.min(CONCURRENCY, total) }, () => worker());
    await Promise.all(workers);

    applyFiltersAndRender();
    scanStatus.textContent = `Done — ${total} link${total === 1 ? '' : 's'} checked.`;
    resetScanButton();
    btnExport.disabled = false;

    if (highlightOn) {
      pushHighlight();
    }
  }

  function resetScanButton() {
    isScanning = false;
    btnScan.disabled = false;
    btnScanLabel.textContent = 'Re-Analyze All Links on This Page';
    progressTrack.style.display = 'none';
  }

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
        ? 'Click "Analyze All Links" above to scan every link on this page — from the top navigation to the footer.'
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
            <a class="link-cell" data-href="${escapeHtml(r.href)}" title="${escapeHtml(r.href)}">${escapeHtml(shortenUrl(r.href, 42))}</a>
            <span class="link-text-sub" title="${escapeHtml(r.text)}">${escapeHtml(shortenUrl(r.text, 42))}</span>
          </td>
          <td><span class="loc-tag">${escapeHtml(r.location)}</span></td>
          <td>${codeText}</td>
          <td>${timeText}</td>
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

    pagination.style.display = totalPages > 1 ? 'flex' : 'none';
    pageInfoEl.textContent = `Page ${currentPage} of ${totalPages}`;
    pagePrev.disabled = currentPage <= 1;
    pageNext.disabled = currentPage >= totalPages;
  }

  // ── Event listeners ────────────────────────────────────────────────────
  btnScan.addEventListener('click', onScan);

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

  // ── Excel export ───────────────────────────────────────────────────────
  btnExport.addEventListener('click', exportToExcel);

  function statusLabelForExport(status) {
    const map = {
      ok: 'OK',
      broken: 'Broken',
      redirect: 'Redirect',
      slow: 'Slow',
      unverified: 'Unverified',
      timeout: 'Timeout',
      skipped: 'Skipped (non-HTTP)',
      pending: 'Not checked'
    };
    return map[status] || status;
  }

  function scopeLabel(scope) {
    const map = { internal: 'Internal', external: 'External', anchor: 'Anchor (#)', mailto: 'Mailto', tel: 'Tel' };
    return map[scope] || scope;
  }

  function exportToExcel() {
    if (!allResults.length) return;

    const rows = allResults.map((r) => ({
      '#': r.index,
      'Status': statusLabelForExport(r.status),
      'HTTP Code': r.httpStatus || '',
      'Response Time (ms)': (r.ms !== null && r.ms !== undefined) ? r.ms : '',
      'Link URL': r.href,
      'Anchor Text': r.text,
      'Location': r.location,
      'Link Type': scopeLabel(r.scope),
      'Rel Attribute': r.rel,
      'Nofollow': r.nofollow ? 'Yes' : 'No',
      'Target': r.target,
      'Occurrences': r.occurrences,
      'Notes': r.reason || ''
    }));

    const wb = XLSX.utils.book_new();

    // ── Summary sheet ──
    const counts = { ok: 0, broken: 0, redirect: 0, slow: 0, unverified: 0, skipped: 0 };
    allResults.forEach((r) => {
      if (r.status === 'timeout') counts.broken++;
      else if (counts.hasOwnProperty(r.status)) counts[r.status]++;
    });

    const summaryData = [
      ['Link Checker — Scan Report'],
      [],
      ['Page URL', pageInfo.pageUrl || ''],
      ['Page Title', pageInfo.pageTitle || ''],
      ['Scan Date', new Date().toLocaleString()],
      [],
      ['Metric', 'Count'],
      ['Total Links', allResults.length],
      ['OK', counts.ok],
      ['Broken', counts.broken],
      ['Redirects', counts.redirect],
      ['Slow (>3s)', counts.slow],
      ['Unverified', counts.unverified],
      ['Skipped (non-HTTP)', counts.skipped]
    ];
    const summaryWs = XLSX.utils.aoa_to_sheet(summaryData);
    summaryWs['!cols'] = [{ wch: 22 }, { wch: 60 }];
    summaryWs['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }];
    styleSummarySheet(summaryWs);
    XLSX.utils.book_append_sheet(wb, summaryWs, 'Summary');

    // ── Data sheet ──
    const dataWs = XLSX.utils.json_to_sheet(rows);
    dataWs['!cols'] = [
      { wch: 4 }, { wch: 12 }, { wch: 9 }, { wch: 10 }, { wch: 55 },
      { wch: 30 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 9 },
      { wch: 8 }, { wch: 11 }, { wch: 16 }
    ];
    dataWs['!autofilter'] = { ref: dataWs['!ref'] };
    styleDataSheet(dataWs, rows.length);
    XLSX.utils.book_append_sheet(wb, dataWs, 'Link Data');

    const safeName = (pageInfo.pageUrl || 'report')
      .replace(/^https?:\/\//, '')
      .split(/[?#]/)[0]
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'report';

    XLSX.writeFile(wb, `LinkChecker_${safeName}.xlsx`);
  }

  function styleSummarySheet(ws) {
    if (ws['A1']) {
      ws['A1'].s = { font: { bold: true, sz: 16, color: { rgb: '5B8DEF' } } };
    }
    ['A7', 'B7'].forEach((addr) => {
      if (ws[addr]) {
        ws[addr].s = {
          font: { bold: true, color: { rgb: 'FFFFFF' } },
          fill: { fgColor: { rgb: '5B8DEF' } }
        };
      }
    });
    ['A3', 'A4', 'A5'].forEach((addr) => {
      if (ws[addr]) ws[addr].s = { font: { bold: true } };
    });
  }

  function styleDataSheet(ws, rowCount) {
    const cols = 13;
    for (let c = 0; c < cols; c++) {
      const addr = XLSX.utils.encode_cell({ r: 0, c });
      if (ws[addr]) {
        ws[addr].s = {
          font: { bold: true, color: { rgb: 'FFFFFF' } },
          fill: { fgColor: { rgb: '5B8DEF' } },
          alignment: { vertical: 'center' }
        };
      }
    }
    for (let r = 1; r <= rowCount; r++) {
      const statusAddr = XLSX.utils.encode_cell({ r, c: 1 });
      const cell = ws[statusAddr];
      if (!cell) continue;
      const val = String(cell.v || '');
      let rgb = null;
      if (val === 'OK') rgb = 'DCFCE7';
      else if (val === 'Broken' || val === 'Timeout') rgb = 'FEE2E2';
      else if (val === 'Redirect' || val === 'Slow') rgb = 'FEF3C7';
      else if (val.startsWith('Unverified') || val.startsWith('Skipped')) rgb = 'F1F2F5';
      if (rgb) {
        cell.s = { fill: { fgColor: { rgb } }, font: { bold: true } };
      }
    }
  }

  window.LinkCheckerTool = {
    init() {
      // Refresh the header's current-page label every time this tab is
      // opened, matching Link Checker Pro's original on-load behavior.
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs[0];
        if (tab && tab.url) {
          pageUrlEl.textContent = tab.url;
          pageUrlEl.title = tab.url;
        }
      });
    }
  };
})();
