// ============================================================
// Tool 7: Glyphscope — font intelligence for the web.
//
// SCOPING: the original used flat document.getElementById calls.
// Rebound to query within this pane only (pane.querySelector),
// matching every other tool in this shell — confirmed two real
// id collisions before making this change, not just applying it
// defensively: #exportBtn already exists in Meta Inspector's and
// Alt Text's panes, and #status already exists in Alt Text's,
// Link Extractor's, and Form Validator's panes.
//
// PATH FIX: chrome.scripting.executeScript's files array was
// ["content.js"], resolving relative to the standalone
// extension's own root. Corrected to
// ["tools/glyphscope/content.js"], since that array resolves
// relative to the EXTENSION ROOT, not the caller's own
// location — the same class of fix needed for every prior tool
// folded into this shell.
//
// NOT PORTED: this tool has no image/KV-banner detection to
// port in the first place — the uploaded content.js is
// deliberately, explicitly text-only (its own comments and the
// popup's own hint text both say so), despite README.md
// describing an image-detection feature and an "Image Regions"
// export sheet that doesn't exist in the actual code. Built
// against the real code, not the stale docs.
//
// ADDED: window.GlyphscopeTool.init() at the bottom, the same
// interface every other tool exposes so the shell's own tab-
// switcher can call it the first time this tab is opened. Unlike
// several other tools' no-op init(), this one's real init()
// logic (checking storage + tab status on load) was already a
// named async function in the original — it now runs both on
// first script load AND is re-callable via init() so re-opening
// this tab reflects current state, matching the original's own
// on-load behavior exactly.
//
// Everything else — the analyze/export/toggle flow, the Excel
// report's two-sheet ExcelJS-based structure and styling — is
// unchanged from the uploaded file.
// ============================================================
(function () {
  "use strict";

  const pane = document.querySelector('[data-tool-pane="glyphscope"]');
  const $ = (id) => pane.querySelector(`#${id}`);

  const analyzeBtn = $("analyzeBtn");
  const exportBtn = $("exportBtn");
  const statusDot = $("statusDot");
  const statusText = $("statusText");
  const statsBox = $("stats");
  const statElements = $("statElements");
  const statFonts = $("statFonts");
  const masterToggle = $("masterToggle");
  const wrapEl = pane.querySelector(".wrap");

  let activeTabId = null;

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  function setStatus(state, text) {
    statusDot.className = "dot" + (state ? ` ${state}` : "");
    statusText.textContent = text;
  }

  function updateStats(count, uniqueFonts) {
    statElements.textContent = count;
    statFonts.textContent = uniqueFonts;
    statsBox.hidden = false;
  }

  async function sendMessageSafe(tabId, message) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (e) {
      return null;
    }
  }

  function applyEnabledUI(enabled) {
    masterToggle.checked = enabled;
    wrapEl.classList.toggle("app-off", !enabled);
  }

  masterToggle.addEventListener("change", async () => {
    const enabled = masterToggle.checked;
    applyEnabledUI(enabled);
    await chrome.storage.local.set({ glyphscopeEnabled: enabled });
    if (activeTabId) {
      await sendMessageSafe(activeTabId, { action: "setEnabled", value: enabled });
    }
    if (!enabled) {
      setStatus(null, "Glyphscope is off");
    } else {
      setStatus(null, "Not analyzed yet");
      // Re-check whether this tab was already analyzed before being toggled off.
      const status = await sendMessageSafe(activeTabId, { action: "getStatus" });
      if (status && status.analyzed) {
        setStatus("active", "Analyzed — hover to inspect");
        updateStats(status.count, status.uniqueFonts);
        exportBtn.disabled = false;
      }
    }
  });

  async function init() {
    const stored = await chrome.storage.local.get(["glyphscopeEnabled"]);
    const enabled = stored.glyphscopeEnabled !== false; // default true
    applyEnabledUI(enabled);

    const tab = await getActiveTab();
    if (!tab || !tab.id || /^chrome:\/\//.test(tab.url || "")) {
      setStatus(null, "Unsupported page");
      analyzeBtn.disabled = true;
      return;
    }
    activeTabId = tab.id;

    if (!enabled) {
      setStatus(null, "Glyphscope is off");
      return;
    }

    const status = await sendMessageSafe(tab.id, { action: "getStatus" });
    if (status && status.analyzed) {
      setStatus("active", "Analyzed — hover to inspect");
      updateStats(status.count, status.uniqueFonts);
      exportBtn.disabled = false;
    } else {
      setStatus(null, "Not analyzed yet");
    }
  }

  analyzeBtn.addEventListener("click", async () => {
    if (!activeTabId) return;
    setStatus("working", "Analyzing page…");
    analyzeBtn.disabled = true;

    try {
      await chrome.scripting.executeScript({
        target: { tabId: activeTabId },
        files: ["tools/glyphscope/content.js"],
      });

      const result = await sendMessageSafe(activeTabId, { action: "analyze" });
      if (result && result.ok) {
        setStatus("active", "Analyzed — hover to inspect");
        updateStats(result.count, result.uniqueFonts);
        exportBtn.disabled = false;
      } else {
        setStatus(null, "Could not analyze this page");
      }
    } catch (err) {
      setStatus(null, "Injection blocked on this page");
    } finally {
      analyzeBtn.disabled = false;
    }
  });

  exportBtn.addEventListener("click", async () => {
    if (!activeTabId) return;
    const originalLabel = exportBtn.innerHTML;
    exportBtn.disabled = true;
    exportBtn.innerHTML = `<svg class="icn" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9" stroke-dasharray="42" stroke-dashoffset="14"></circle></svg> Building report…`;

    try {
      const response = await sendMessageSafe(activeTabId, { action: "export" });
      if (!response || !response.ok) {
        throw new Error(response?.error || "Export failed");
      }
      await buildExcelReport(response.rows, response.pageTitle, response.pageUrl);
    } catch (err) {
      console.error(err);
      setStatus(null, "Export failed — try re-analyzing");
    } finally {
      exportBtn.disabled = false;
      exportBtn.innerHTML = originalLabel;
    }
  });

  async function buildExcelReport(rows, pageTitle, pageUrl) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Glyphscope";
    workbook.created = new Date();

    // ---------- Summary sheet ----------
    const summary = workbook.addWorksheet("Summary", {
      properties: { tabColor: { argb: "FF6A5CFF" } },
    });
    summary.mergeCells("A1:D1");
    summary.getCell("A1").value = "Font Audit Report";
    summary.getCell("A1").font = { size: 20, bold: true, color: { argb: "FF6A5CFF" } };
    summary.getCell("A1").alignment = { vertical: "middle" };
    summary.getRow(1).height = 34;

    summary.mergeCells("A2:D2");
    summary.getCell("A2").value = pageTitle || "Untitled page";
    summary.getCell("A2").font = { size: 12, italic: true, color: { argb: "FF4A4E63" } };

    summary.mergeCells("A3:D3");
    summary.getCell("A3").value = pageUrl || "";
    summary.getCell("A3").font = { size: 10, color: { argb: "FF6B7089" }, underline: true };

    summary.getCell("A5").value = "Generated";
    summary.getCell("B5").value = new Date().toLocaleString();
    summary.getCell("A6").value = "Total text elements";
    summary.getCell("B6").value = rows.length;

    const fontCounts = {};
    rows.forEach((r) => {
      fontCounts[r.resolvedFont] = (fontCounts[r.resolvedFont] || 0) + 1;
    });
    const uniqueFonts = Object.keys(fontCounts);
    summary.getCell("A7").value = "Unique fonts detected";
    summary.getCell("B7").value = uniqueFonts.length;

    ["A5", "A6", "A7"].forEach((c) => (summary.getCell(c).font = { bold: true, color: { argb: "FF4A4E63" } }));

    summary.addRow([]);
    const headerRowIdx = 9;
    summary.getRow(headerRowIdx).values = ["Font Family", "Usage Count", "% of Elements", ""];
    styleHeaderRow(summary.getRow(headerRowIdx), 3);

    const sortedFonts = Object.entries(fontCounts).sort((a, b) => b[1] - a[1]);
    sortedFonts.forEach(([font, count], i) => {
      const row = summary.getRow(headerRowIdx + 1 + i);
      row.values = [font, count, `${((count / rows.length) * 100).toFixed(1)}%`];
      styleBodyRow(row, 3, i);
    });

    summary.columns = [{ width: 32 }, { width: 16 }, { width: 16 }, { width: 10 }];

    // ---------- Details sheet ----------
    const details = workbook.addWorksheet("Font Details", {
      properties: { tabColor: { argb: "FF8A5CFF" } },
    });

    const headers = [
      "Text Content",
      "Tag",
      "CSS Selector",
      "Font Family (declared)",
      "Resolved Font",
      "Font Size",
      "Font Weight",
      "Font Style",
      "Line Height",
      "Letter Spacing",
      "Color (RGB)",
      "Color (Hex)",
    ];
    details.addRow(headers);
    styleHeaderRow(details.getRow(1), headers.length);
    details.autoFilter = { from: "A1", to: `${colLetter(headers.length)}1` };
    details.views = [{ state: "frozen", ySplit: 1 }];

    rows.forEach((r, i) => {
      const row = details.addRow([
        r.text,
        r.tag,
        r.selector,
        r.fontFamily,
        r.resolvedFont,
        r.fontSize,
        r.fontWeight,
        r.fontStyle,
        r.lineHeight,
        r.letterSpacing,
        r.color,
        r.hexColor || "",
      ]);
      styleBodyRow(row, headers.length, i);

      // Color-swatch the "Color" column using its actual CSS color when possible.
      const colorCell = row.getCell(headers.length);
      const argb = cssColorToArgb(r.color);
      if (argb) {
        colorCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb } };
        colorCell.font = { color: { argb: contrastColor(argb) }, size: 10 };
      }
    });

    details.columns = [
      { width: 42 }, // text
      { width: 10 }, // tag
      { width: 26 }, // selector
      { width: 26 }, // declared font
      { width: 20 }, // resolved font
      { width: 10 }, // size
      { width: 12 }, // weight
      { width: 10 }, // style
      { width: 12 }, // line height
      { width: 14 }, // letter spacing
      { width: 16 }, // color rgb
      { width: 12 }, // color hex
    ];

    details.eachRow((row) => {
      row.eachCell((cell) => {
        cell.alignment = { vertical: "middle", wrapText: cell.col === 1 };
      });
    });

    // ---------- Download ----------
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const filename = `font-report-${sanitize(pageTitle) || "page"}.xlsx`;

    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function styleHeaderRow(row, colCount) {
    row.height = 22;
    for (let i = 1; i <= colCount; i++) {
      const cell = row.getCell(i);
      cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF6A5CFF" } };
      cell.alignment = { vertical: "middle", horizontal: "left" };
      cell.border = { bottom: { style: "thin", color: { argb: "FF4A3FCC" } } };
    }
  }

  function styleBodyRow(row, colCount, index) {
    const isAlt = index % 2 === 1;
    for (let i = 1; i <= colCount; i++) {
      const cell = row.getCell(i);
      cell.font = { size: 10.5, color: { argb: "FF1F2333" } };
      if (isAlt) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F1FF" } };
      }
      cell.border = { bottom: { style: "hair", color: { argb: "FFE4E6F2" } } };
    }
  }

  function colLetter(n) {
    let s = "";
    while (n > 0) {
      const m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - m) / 26);
    }
    return s;
  }

  function sanitize(str) {
    return (str || "").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  }

  // Converts an rgb()/rgba() computed-style string to ARGB hex for Excel fills.
  function cssColorToArgb(cssColor) {
    const m = cssColor.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (!m) return null;
    const [, r, g, b] = m;
    return (
      "FF" +
      [r, g, b]
        .map((v) => parseInt(v, 10).toString(16).padStart(2, "0").toUpperCase())
        .join("")
    );
  }

  // Picks black or white text for legibility against a fill color.
  function contrastColor(argb) {
    const r = parseInt(argb.slice(2, 4), 16);
    const g = parseInt(argb.slice(4, 6), 16);
    const b = parseInt(argb.slice(6, 8), 16);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.6 ? "FF000000" : "FFFFFFFF";
  }

  init();

  window.GlyphscopeTool = {
    init() {
      // Re-run the same on-load logic every time this tab is opened,
      // so re-opening it reflects current storage/tab state (matches
      // the original's own single init() call on script load — here
      // it's just made re-callable through the shell's tab-switcher).
      init();
    }
  };
})();
