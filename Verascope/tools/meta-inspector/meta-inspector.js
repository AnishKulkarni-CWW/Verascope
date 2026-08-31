// ============================================================
// Meta Inspector — Title & Description Checker (Extension 1)
// Wrapped in an IIFE so its top-level declarations (compare,
// normalize, crc32, buildZip, etc.) can never collide with the
// other two tools' scripts, which now share this same popup
// document as separate tabs.
// ============================================================
(function () {
  // Scoped to this tool's own pane: #exportBtn is reused (with
  // different meaning — CSV vs the Excel export button in Alt Text
  // Viewer) by another tool's original markup, so an unqualified
  // getElementById() would risk grabbing the wrong element. Every
  // other id below is unique to this tool, but querying from `pane`
  // throughout keeps the pattern consistent and safe against any
  // future id additions to the other two tools.
  const pane = document.querySelector('[data-tool-pane="meta-inspector"]');
  const getMetaBtn = pane.querySelector('#getMetaBtn');
  const compareBtn = pane.querySelector('#compareBtn');
  const exportBtn = pane.querySelector('#exportBtn');

  const metaSummary = pane.querySelector('#metaSummary');
  const compareSection = pane.querySelector('#compareSection');
  const emptyState = pane.querySelector('#emptyState');

  const metaTitleValue = pane.querySelector('#metaTitleValue');
  const metaDescValue = pane.querySelector('#metaDescValue');
  const actualTitleCell = pane.querySelector('#actualTitleCell');
  const actualDescCell = pane.querySelector('#actualDescCell');

  const targetTitleInput = pane.querySelector('#targetTitleInput');
  const targetDescInput = pane.querySelector('#targetDescInput');

  const titleResult = pane.querySelector('#titleResult');
  const descResult = pane.querySelector('#descResult');

  const charCounts = pane.querySelector('#charCounts');

  let currentMeta = { title: '', description: '' };
  let currentPageUrl = '';

  // Function injected into the page to read meta title/description
  function extractMetaFromPage() {
    const titleMetaTag = document.querySelector('meta[name="title"]');
    const docTitle = document.title ? document.title.trim() : '';
    const metaTitle = titleMetaTag ? (titleMetaTag.getAttribute('content') || '').trim() : '';

    const descTag = document.querySelector('meta[name="description"]');
    const metaDescription = descTag ? (descTag.getAttribute('content') || '').trim() : '';

    // Prefer explicit <meta name="title"> like the screenshots show,
    // fall back to <title> if a dedicated meta title tag isn't present.
    const resolvedTitle = metaTitle || docTitle || '';

    return {
      title: resolvedTitle,
      description: metaDescription
    };
  }

  function setText(el, value, fallback) {
    if (value && value.length > 0) {
      el.textContent = value;
      el.classList.remove('missing');
    } else {
      el.textContent = fallback;
      el.classList.add('missing');
    }
  }

  async function getMeta() {
    getMetaBtn.disabled = true;
    getMetaBtn.querySelector('span').textContent = 'Fetching…';

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab || !tab.id || !/^https?:/i.test(tab.url || '')) {
        throw new Error('This page cannot be inspected (not a standard web page).');
      }

      const [injectionResult] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: extractMetaFromPage
      });

      const result = injectionResult.result;
      currentMeta = result;
      currentPageUrl = tab.url || '';

      setText(metaTitleValue, result.title, 'No meta title found');
      setText(metaDescValue, result.description, 'No meta description found');

      setText(actualTitleCell, result.title, 'No meta title found');
      setText(actualDescCell, result.description, 'No meta description found');

      metaSummary.classList.remove('hidden');
      compareSection.classList.remove('hidden');
      emptyState.classList.add('hidden');

      // Reset comparison state
      titleResult.textContent = '—';
      titleResult.className = 'result-pill result-pending';
      descResult.textContent = '—';
      descResult.className = 'result-pill result-pending';
      charCounts.textContent = '';
      exportBtn.disabled = false;

    } catch (err) {
      metaTitleValue.textContent = 'Error: ' + err.message;
      metaTitleValue.classList.add('missing');
      metaDescValue.textContent = '';
      metaSummary.classList.remove('hidden');
      compareSection.classList.add('hidden');
      emptyState.classList.add('hidden');
      exportBtn.disabled = true;
    } finally {
      getMetaBtn.disabled = false;
      getMetaBtn.querySelector('span').textContent = 'Get Meta';
    }
  }

  function normalize(str) {
    return (str || '').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  function classifyMatch(actual, target) {
    const a = normalize(actual);
    const t = normalize(target);

    if (!t) {
      return { label: 'Enter target', cls: 'result-pending' };
    }
    if (!a) {
      return { label: 'No actual meta', cls: 'result-mismatch' };
    }
    if (a === t) {
      return { label: 'Exact Match', cls: 'result-match' };
    }
    if (a.includes(t) || t.includes(a)) {
      return { label: 'Partial Match', cls: 'result-partial' };
    }
    return { label: 'Mismatch', cls: 'result-mismatch' };
  }

  function applyResult(el, classification) {
    el.textContent = classification.label;
    el.className = 'result-pill ' + classification.cls;
  }

  function compare() {
    const targetTitle = targetTitleInput.value;
    const targetDesc = targetDescInput.value;

    const titleClassification = classifyMatch(currentMeta.title, targetTitle);
    const descClassification = classifyMatch(currentMeta.description, targetDesc);

    applyResult(titleResult, titleClassification);
    applyResult(descResult, descClassification);

    const titleLen = (currentMeta.title || '').length;
    const descLen = (currentMeta.description || '').length;
    charCounts.textContent = `Title: ${titleLen} chars · Description: ${descLen} chars`;

    exportBtn.disabled = false;
  }

  function formatTimestamp(date) {
    const pad = n => String(n).padStart(2, '0');
    return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()} `
      + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  /* ---------- Minimal XLSX (OOXML) writer — no external libraries ---------- */
  /* Chrome extension CSP blocks CDN scripts, so the workbook (a ZIP of XML
     parts) is assembled here and compressed with the browser's native
     CompressionStream (deflate-raw). */

  function xmlEscape(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  async function deflateRaw(bytes) {
    const cs = new CompressionStream('deflate-raw');
    const writer = cs.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const chunks = [];
    const reader = cs.readable.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) { out.set(c, offset); offset += c.length; }
    return out;
  }

  function writeUInt32LE(view, offset, val) { view.setUint32(offset, val, true); }
  function writeUInt16LE(view, offset, val) { view.setUint16(offset, val, true); }

  async function buildZip(files) {
    // files: [{ name: string, data: Uint8Array }]
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const file of files) {
      const nameBytes = new TextEncoder().encode(file.name);
      const rawData = file.data;
      const compData = await deflateRaw(rawData);
      const crc = crc32(rawData);
      const method = 8; // deflate

      const localHeader = new ArrayBuffer(30);
      const lv = new DataView(localHeader);
      writeUInt32LE(lv, 0, 0x04034b50);
      writeUInt16LE(lv, 4, 20);
      writeUInt16LE(lv, 6, 0);
      writeUInt16LE(lv, 8, method);
      writeUInt16LE(lv, 10, 0);
      writeUInt16LE(lv, 12, 0);
      writeUInt32LE(lv, 14, crc);
      writeUInt32LE(lv, 18, compData.length);
      writeUInt32LE(lv, 22, rawData.length);
      writeUInt16LE(lv, 26, nameBytes.length);
      writeUInt16LE(lv, 28, 0);

      const localPart = new Uint8Array(30 + nameBytes.length + compData.length);
      localPart.set(new Uint8Array(localHeader), 0);
      localPart.set(nameBytes, 30);
      localPart.set(compData, 30 + nameBytes.length);
      localParts.push(localPart);

      const centralHeader = new ArrayBuffer(46);
      const cv = new DataView(centralHeader);
      writeUInt32LE(cv, 0, 0x02014b50);
      writeUInt16LE(cv, 4, 20);
      writeUInt16LE(cv, 6, 20);
      writeUInt16LE(cv, 8, 0);
      writeUInt16LE(cv, 10, method);
      writeUInt16LE(cv, 12, 0);
      writeUInt16LE(cv, 14, 0);
      writeUInt32LE(cv, 16, crc);
      writeUInt32LE(cv, 20, compData.length);
      writeUInt32LE(cv, 24, rawData.length);
      writeUInt16LE(cv, 28, nameBytes.length);
      writeUInt16LE(cv, 30, 0);
      writeUInt16LE(cv, 32, 0);
      writeUInt16LE(cv, 34, 0);
      writeUInt16LE(cv, 36, 0);
      writeUInt32LE(cv, 38, 0);
      writeUInt32LE(cv, 42, offset);

      const centralPart = new Uint8Array(46 + nameBytes.length);
      centralPart.set(new Uint8Array(centralHeader), 0);
      centralPart.set(nameBytes, 46);
      centralParts.push(centralPart);

      offset += localPart.length;
    }

    const centralDirOffset = offset;
    const centralDirTotal = centralParts.reduce((n, p) => n + p.length, 0);

    const eocd = new ArrayBuffer(22);
    const ev = new DataView(eocd);
    writeUInt32LE(ev, 0, 0x06054b50);
    writeUInt16LE(ev, 4, 0);
    writeUInt16LE(ev, 6, 0);
    writeUInt16LE(ev, 8, files.length);
    writeUInt16LE(ev, 10, files.length);
    writeUInt32LE(ev, 12, centralDirTotal);
    writeUInt32LE(ev, 16, centralDirOffset);
    writeUInt16LE(ev, 20, 0);

    const totalSize = localParts.reduce((n, p) => n + p.length, 0) + centralDirTotal + 22;
    const zipBytes = new Uint8Array(totalSize);
    let pos = 0;
    for (const p of localParts) { zipBytes.set(p, pos); pos += p.length; }
    for (const p of centralParts) { zipBytes.set(p, pos); pos += p.length; }
    zipBytes.set(new Uint8Array(eocd), pos);

    return zipBytes;
  }

  /* ---------- Workbook content (mirrors the manually-formatted layout) ---------- */

  async function buildXlsxReport() {
    const now = new Date();
    const titleLen = (currentMeta.title || '').length;
    const descLen = (currentMeta.description || '').length;

    const targetTitle = targetTitleInput ? targetTitleInput.value.trim() : '';
    const targetDesc = targetDescInput ? targetDescInput.value.trim() : '';

    const titleClassification = classifyMatch(currentMeta.title, targetTitle);
    const descClassification = classifyMatch(currentMeta.description, targetDesc);

    const titleLabel = targetTitle ? titleClassification.label : 'Not Compared';
    const descLabel = targetDesc ? descClassification.label : 'Not Compared';

    // Shared strings table
    const sharedStrings = [];
    const sstIndex = new Map();
    function sstRef(str) {
      if (sstIndex.has(str)) return sstIndex.get(str);
      const idx = sharedStrings.length;
      sharedStrings.push(str);
      sstIndex.set(str, idx);
      return idx;
    }

    // Style indices (defined in styles.xml below):
    // 1 = title bar (bold white, blue fill, centered)
    // 2 = label cell, orange fill (Page URL / Generated On / Meta Title / Meta Description)
    // 3 = value cell, plain, wrap text
    // 4 = header row cell, green fill, bold, centered
    // 5 = result/count cell, centered

    const rows = [
      [{ c: 'A', v: 'Meta Inspector — Validation Report', s: 1 }],
      [{ c: 'A', v: 'Page URL', s: 2 }, { c: 'B', v: currentPageUrl || 'N/A', s: 3 }],
      [{ c: 'A', v: 'Generated On', s: 2 }, { c: 'B', v: formatTimestamp(now), s: 3 }],
      [],
      [
        { c: 'A', v: 'Field', s: 4 },
        { c: 'B', v: 'Actual Value', s: 4 },
        { c: 'C', v: 'Target Value', s: 4 },
        { c: 'D', v: 'Result', s: 4 },
        { c: 'E', v: 'Character Count', s: 4 }
      ],
      [
        { c: 'A', v: 'Meta Title', s: 2 },
        { c: 'B', v: currentMeta.title || 'No meta title found', s: 3 },
        { c: 'C', v: targetTitle || 'N/A', s: 3 },
        { c: 'D', v: titleLabel, s: 5 },
        { c: 'E', v: titleLen, s: 5, t: 'n' }
      ],
      [
        { c: 'A', v: 'Meta Description', s: 2 },
        { c: 'B', v: currentMeta.description || 'No meta description found', s: 3 },
        { c: 'C', v: targetDesc || 'N/A', s: 3 },
        { c: 'D', v: descLabel, s: 5 },
        { c: 'E', v: descLen, s: 5, t: 'n' }
      ]
    ];

    let sheetRowsXml = '';
    rows.forEach((row, i) => {
      const rowNum = i + 1;
      if (row.length === 0) {
        sheetRowsXml += `<row r="${rowNum}"/>`;
        return;
      }
      let cellsXml = '';
      row.forEach(cell => {
        const ref = `${cell.c}${rowNum}`;
        if (cell.t === 'n') {
          cellsXml += `<c r="${ref}" s="${cell.s}"><v>${cell.v}</v></c>`;
        } else {
          const idx = sstRef(String(cell.v));
          cellsXml += `<c r="${ref}" t="s" s="${cell.s}"><v>${idx}</v></c>`;
        }
      });
      sheetRowsXml += `<row r="${rowNum}">${cellsXml}</row>`;
    });

    const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<cols>
<col min="1" max="1" width="18" customWidth="1"/>
<col min="2" max="2" width="60" customWidth="1"/>
<col min="3" max="3" width="20" customWidth="1"/>
<col min="4" max="4" width="16" customWidth="1"/>
<col min="5" max="5" width="16" customWidth="1"/>
</cols>
<sheetData>${sheetRowsXml}</sheetData>
<mergeCells count="1"><mergeCell ref="A1:E1"/></mergeCells>
</worksheet>`;

    const sstXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">
${sharedStrings.map(s => `<si><t xml:space="preserve">${xmlEscape(s)}</t></si>`).join('')}
</sst>`;

    const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="4">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="14"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><name val="Calibri"/></font>
<font><sz val="11"/><name val="Calibri"/></font>
</fonts>
<fills count="5">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF4472C4"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF8CBAD"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFC6E0B4"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color indexed="64"/></left><right style="thin"><color indexed="64"/></right><top style="thin"><color indexed="64"/></top><bottom style="thin"><color indexed="64"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

    const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Meta Report" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

    const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`;

    const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

    const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`;

    const enc = new TextEncoder();
    const files = [
      { name: '[Content_Types].xml', data: enc.encode(contentTypesXml) },
      { name: '_rels/.rels', data: enc.encode(rootRelsXml) },
      { name: 'xl/workbook.xml', data: enc.encode(workbookXml) },
      { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(workbookRelsXml) },
      { name: 'xl/styles.xml', data: enc.encode(stylesXml) },
      { name: 'xl/sharedStrings.xml', data: enc.encode(sstXml) },
      { name: 'xl/worksheets/sheet1.xml', data: enc.encode(sheetXml) }
    ];

    return buildZip(files);
  }

  async function exportReport() {
    exportBtn.disabled = true;
    const originalLabel = exportBtn.textContent;
    exportBtn.textContent = 'Generating…';

    try {
      const zipBytes = await buildXlsxReport();
      const blob = new Blob([zipBytes], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      });
      const url = URL.createObjectURL(blob);

      const pad = n => String(n).padStart(2, '0');
      const now = new Date();
      const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const filename = `meta-inspector-report-${stamp}.xlsx`;

      chrome.downloads.download({
        url,
        filename,
        saveAs: true
      }, () => {
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      });
    } catch (err) {
      console.error('Export failed:', err);
    } finally {
      exportBtn.disabled = false;
      exportBtn.textContent = originalLabel;
    }
  }

  getMetaBtn.addEventListener('click', getMeta);
  compareBtn.addEventListener('click', compare);
  exportBtn.addEventListener('click', exportReport);
})();
