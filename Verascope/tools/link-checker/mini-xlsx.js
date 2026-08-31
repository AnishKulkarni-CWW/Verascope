/**
 * mini-xlsx.js
 * Zero-dependency, in-browser .xlsx (OOXML) writer for Chrome extensions.
 * Supports: multiple sheets, cell styles (fonts/fills/borders/number formats/alignment),
 * merged cells, autofilter, frozen panes, column widths, and formulas — enough to
 * produce a professional-looking multi-sheet QA report with no external library.
 *
 * Keeps the original ZIP/CRC32 primitives (buildZip/crc32) and the original
 * MiniXlsx.buildXlsx(rows, sheetName, headerRowCount) single-sheet API unchanged
 * so existing callers keep working, and adds MiniXlsx.buildWorkbook(spec) for
 * multi-sheet, richly styled workbooks.
 */
(function attachMiniXlsx(globalScope) {
  "use strict";

  // ---------------------------------------------------------------------
  // CRC32 / ZIP primitives (unchanged behavior from the original file)
  // ---------------------------------------------------------------------
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function strToBytes(str) { return new TextEncoder().encode(str); }

  function dosDateTime(date) {
    const time = ((date.getHours() & 0x1F) << 11) | ((date.getMinutes() & 0x3F) << 5) | ((date.getSeconds() >> 1) & 0x1F);
    const day = (((date.getFullYear() - 1980) & 0x7F) << 9) | (((date.getMonth() + 1) & 0xF) << 5) | (date.getDate() & 0x1F);
    return { time, day };
  }

  function buildZip(files) {
    const now = new Date();
    const { time, day } = dosDateTime(now);
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    Object.keys(files).forEach((path) => {
      const contentBytes = strToBytes(files[path]);
      const nameBytes = strToBytes(path);
      const crc = crc32(contentBytes);
      const size = contentBytes.length;

      const localHeader = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(localHeader.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0, true);
      lv.setUint16(8, 0, true);
      lv.setUint16(10, time, true);
      lv.setUint16(12, day, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, size, true);
      lv.setUint32(22, size, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      localHeader.set(nameBytes, 30);

      localParts.push(localHeader, contentBytes);

      const centralHeader = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(centralHeader.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, time, true);
      cv.setUint16(14, day, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, size, true);
      cv.setUint32(24, size, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      centralHeader.set(nameBytes, 46);

      centralParts.push(centralHeader);
      offset += localHeader.length + contentBytes.length;
    });

    const centralStart = offset;
    let centralSize = 0;
    centralParts.forEach((part) => { centralSize += part.length; });

    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, centralParts.length, true);
    ev.setUint16(10, centralParts.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, centralStart, true);
    ev.setUint16(20, 0, true);

    const totalLength = offset + centralSize + end.length;
    const output = new Uint8Array(totalLength);
    let cursor = 0;
    localParts.forEach((part) => { output.set(part, cursor); cursor += part.length; });
    centralParts.forEach((part) => { output.set(part, cursor); cursor += part.length; });
    output.set(end, cursor);
    return output;
  }

  // ---------------------------------------------------------------------
  // XML helpers
  // ---------------------------------------------------------------------
  function xmlEscape(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  function columnLetter(index) {
    let n = index + 1, letters = "";
    while (n > 0) {
      const rem = (n - 1) % 26;
      letters = String.fromCharCode(65 + rem) + letters;
      n = Math.floor((n - 1) / 26);
    }
    return letters;
  }

  function cellRef(rowIndex1, colIndex0) { return `${columnLetter(colIndex0)}${rowIndex1}`; }

  // ---------------------------------------------------------------------
  // Legacy simple API (kept for backward compatibility)
  // ---------------------------------------------------------------------
  function buildSheetXmlLegacy(rows, headerRowCount = 1) {
    const rowXml = rows.map((row, rowIndex) => {
      const rowNumber = rowIndex + 1;
      const styleIndex = rowIndex < headerRowCount ? 1 : 0;
      const cells = row.map((value, colIndex) => {
        const ref = cellRef(rowNumber, colIndex);
        const isNumber = typeof value === "number" && Number.isFinite(value);
        if (isNumber) return `<c r="${ref}" s="${styleIndex}"><v>${value}</v></c>`;
        return `<c r="${ref}" t="inlineStr" s="${styleIndex}"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
      }).join("");
      return `<row r="${rowNumber}">${cells}</row>`;
    }).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml}</sheetData></worksheet>`;
  }

  function buildStylesXmlLegacy() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF102A43"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="2">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
  }

  function buildWorkbookXmlLegacy(sheetName) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="${xmlEscape(sheetName)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
  }

  function buildContentTypesXmlLegacy() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;
  }

  function buildRootRelsXmlLegacy() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
  }

  function buildWorkbookRelsXmlLegacy() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
  }

  function buildXlsx(rows, sheetName = "Sheet1", headerRowCount = 1) {
    const files = {
      "[Content_Types].xml": buildContentTypesXmlLegacy(),
      "_rels/.rels": buildRootRelsXmlLegacy(),
      "xl/workbook.xml": buildWorkbookXmlLegacy(sheetName),
      "xl/_rels/workbook.xml.rels": buildWorkbookRelsXmlLegacy(),
      "xl/styles.xml": buildStylesXmlLegacy(),
      "xl/worksheets/sheet1.xml": buildSheetXmlLegacy(rows, headerRowCount)
    };
    return buildZip(files);
  }

  // ---------------------------------------------------------------------
  // Rich multi-sheet workbook API
  // ---------------------------------------------------------------------
  const BUILTIN_STYLE_DEFS = {
    default: { font: { name: "Calibri", size: 10, color: "FF1A1A1A" } },
    title: { font: { name: "Calibri", size: 18, bold: true, color: "FFFFFFFF" }, fill: "FF102A43", align: { vertical: "center" } },
    subtitle: { font: { name: "Calibri", size: 11, color: "FFB9F3ED" }, fill: "FF102A43" },
    sectionHeader: { font: { name: "Calibri", size: 12, bold: true, color: "FFFFFFFF" }, fill: "FF1F6F78", border: true },
    tableHeader: { font: { name: "Calibri", size: 10, bold: true, color: "FFFFFFFF" }, fill: "FF102A43", border: true, align: { wrap: true, vertical: "center", horizontal: "center" } },
    label: { font: { name: "Calibri", size: 10, bold: true, color: "FF243B53" }, fill: "FFEDF2F5", border: true },
    metricLabel: { font: { name: "Calibri", size: 10, bold: true, color: "FF486581" }, border: true },
    metricValue: { font: { name: "Calibri", size: 14, bold: true, color: "FF102A43" }, border: true, align: { horizontal: "center" } },
    metricValuePass: { font: { name: "Calibri", size: 14, bold: true, color: "FF18794E" }, fill: "FFE7F8EF", border: true, align: { horizontal: "center" } },
    metricValueFail: { font: { name: "Calibri", size: 14, bold: true, color: "FFC92A2A" }, fill: "FFFFF0F0", border: true, align: { horizontal: "center" } },
    metricValueWarn: { font: { name: "Calibri", size: 14, bold: true, color: "FF8A5700" }, fill: "FFFFF7DF", border: true, align: { horizontal: "center" } },
    cell: { font: { name: "Calibri", size: 10, color: "FF243B53" }, border: true, align: { wrap: true, vertical: "top" } },
    cellCenter: { font: { name: "Calibri", size: 10, color: "FF243B53" }, border: true, align: { wrap: true, vertical: "top", horizontal: "center" } },
    cellMono: { font: { name: "Calibri", size: 9, color: "FF486581" }, border: true, align: { wrap: true, vertical: "top" } },
    pass: { font: { name: "Calibri", size: 10, bold: true, color: "FF18794E" }, fill: "FFE7F8EF", border: true, align: { horizontal: "center", vertical: "center" } },
    fail: { font: { name: "Calibri", size: 10, bold: true, color: "FFC92A2A" }, fill: "FFFFF0F0", border: true, align: { horizontal: "center", vertical: "center" } },
    warning: { font: { name: "Calibri", size: 10, bold: true, color: "FF8A5700" }, fill: "FFFFF7DF", border: true, align: { horizontal: "center", vertical: "center" } },
    severityHigh: { font: { name: "Calibri", size: 10, bold: true, color: "FFFFFFFF" }, fill: "FFC92A2A", border: true, align: { horizontal: "center" } },
    severityMedium: { font: { name: "Calibri", size: 10, bold: true, color: "FFFFFFFF" }, fill: "FFDD8E1A", border: true, align: { horizontal: "center" } },
    severityLow: { font: { name: "Calibri", size: 10, bold: true, color: "FFFFFFFF" }, fill: "FF5B7590", border: true, align: { horizontal: "center" } },
    percent: { font: { name: "Calibri", size: 10, color: "FF243B53" }, border: true, numFmt: "0.0%", align: { horizontal: "center" } },
    percentBold: { font: { name: "Calibri", size: 12, bold: true, color: "FF102A43" }, border: true, numFmt: "0.0%", align: { horizontal: "center" } },
    number: { font: { name: "Calibri", size: 10, color: "FF243B53" }, border: true, numFmt: "0", align: { horizontal: "center" } },
    note: { font: { name: "Calibri", size: 9, italic: true, color: "FF7B8794" } }
  };

  function styleKeyList(customStyles) { return Object.assign({}, BUILTIN_STYLE_DEFS, customStyles || {}); }

  function buildFontsXml(fonts) {
    const xml = fonts.map((font) => {
      const parts = [];
      if (font.bold) parts.push("<b/>");
      if (font.italic) parts.push("<i/>");
      parts.push(`<sz val="${font.size || 10}"/>`);
      parts.push(`<color rgb="${font.color || "FF1A1A1A"}"/>`);
      parts.push(`<name val="${xmlEscape(font.name || "Calibri")}"/>`);
      return `<font>${parts.join("")}</font>`;
    }).join("");
    return `<fonts count="${fonts.length}">${xml}</fonts>`;
  }

  function buildFillsXml(fills) {
    const base = [`<fill><patternFill patternType="none"/></fill>`, `<fill><patternFill patternType="gray125"/></fill>`];
    const custom = fills.map((color) => `<fill><patternFill patternType="solid"><fgColor rgb="${color}"/><bgColor indexed="64"/></patternFill></fill>`);
    const all = base.concat(custom);
    return `<fills count="${all.length}">${all.join("")}</fills>`;
  }

  function buildBordersXml() {
    const thin = `<color rgb="FFD7E0E7"/>`;
    return `<borders count="2">
      <border><left/><right/><top/><bottom/><diagonal/></border>
      <border><left style="thin">${thin}</left><right style="thin">${thin}</right><top style="thin">${thin}</top><bottom style="thin">${thin}</bottom><diagonal/></border>
    </borders>`;
  }

  function buildNumFmtsXml(numFmts) {
    if (!numFmts.length) return "";
    const xml = numFmts.map((fmt, index) => `<numFmt numFmtId="${164 + index}" formatCode="${xmlEscape(fmt)}"/>`).join("");
    return `<numFmts count="${numFmts.length}">${xml}</numFmts>`;
  }

  function compileStyles(customStyles) {
    const defs = styleKeyList(customStyles);
    const fontList = [];
    const fillList = [];
    const numFmtList = [];
    const fontIndex = new Map();
    const fillIndex = new Map();
    const numFmtIndex = new Map();

    function registerFont(font) {
      const key = JSON.stringify(font || {});
      if (fontIndex.has(key)) return fontIndex.get(key);
      const idx = fontList.length;
      fontList.push(font || {});
      fontIndex.set(key, idx);
      return idx;
    }
    function registerFill(color) {
      if (!color) return 0;
      if (fillIndex.has(color)) return fillIndex.get(color);
      const idx = fillList.length + 2;
      fillList.push(color);
      fillIndex.set(color, idx);
      return idx;
    }
    function registerNumFmt(fmt) {
      if (!fmt) return 0;
      if (numFmtIndex.has(fmt)) return numFmtIndex.get(fmt);
      const idx = 164 + numFmtList.length;
      numFmtList.push(fmt);
      numFmtIndex.set(fmt, idx);
      return idx;
    }

    registerFont({ name: "Calibri", size: 10, color: "FF1A1A1A" });

    const xfList = [{ fontId: 0, fillId: 0, borderId: 0, numFmtId: 0, align: null }];
    const xfIndex = new Map();

    Object.keys(defs).forEach((key) => {
      const style = defs[key];
      const fontId = registerFont(style.font);
      const fillId = registerFill(style.fill);
      const borderId = style.border ? 1 : 0;
      const numFmtId = registerNumFmt(style.numFmt);
      const align = style.align || null;
      const xf = { fontId, fillId, borderId, numFmtId, align };
      const xfKey = JSON.stringify(xf);
      let idx;
      if (xfIndex.has(xfKey)) idx = xfIndex.get(xfKey);
      else { idx = xfList.length; xfList.push(xf); xfIndex.set(xfKey, idx); }
      xfIndex.set(`name:${key}`, idx);
    });

    const cellXfsXml = xfList.map((xf) => {
      const alignXml = xf.align
        ? `<alignment${xf.align.horizontal ? ` horizontal="${xf.align.horizontal}"` : ""}${xf.align.vertical ? ` vertical="${xf.align.vertical}"` : ""}${xf.align.wrap ? ` wrapText="1"` : ""}/>`
        : "";
      const applies = [];
      if (xf.fontId) applies.push('applyFont="1"');
      if (xf.fillId) applies.push('applyFill="1"');
      if (xf.borderId) applies.push('applyBorder="1"');
      if (xf.numFmtId) applies.push('applyNumberFormat="1"');
      if (alignXml) applies.push('applyAlignment="1"');
      return `<xf numFmtId="${xf.numFmtId}" fontId="${xf.fontId}" fillId="${xf.fillId}" borderId="${xf.borderId}" xfId="0" ${applies.join(" ")}>${alignXml}</xf>`;
    }).join("");

    const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  ${buildNumFmtsXml(numFmtList)}
  ${buildFontsXml(fontList)}
  ${buildFillsXml(fillList)}
  ${buildBordersXml()}
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="${xfList.length}">${cellXfsXml}</cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
  <dxfs count="0"/>
  <tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>
</styleSheet>`;

    const styleKeyToXf = {};
    Object.keys(defs).forEach((key) => { styleKeyToXf[key] = xfIndex.get(`name:${key}`); });
    styleKeyToXf.__default = 0;

    return { stylesXml, styleKeyToXf };
  }

  // A cell definition can be: a primitive (string/number), or an object
  // with `value` and/or `formula` and/or `style`. An object with NEITHER
  // `value` nor `formula` (e.g. `{}` used to pad out a merged row, or
  // `{ style: "cell" }` for a styled-but-blank cell) is an intentionally
  // blank cell — it must normalize to an empty value while preserving
  // any `style` key, NOT fall through to `{ value: cellDef }`, which
  // would stringify the whole object as the cell's literal text
  // (producing "[object Object]" — this was a real bug: every report
  // this generated wrote that text into 6 padding cells on every QA
  // Summary sheet).
  function normalizeCell(cellDef) {
    if (cellDef && typeof cellDef === "object" && !Array.isArray(cellDef)) {
      if ("value" in cellDef || "formula" in cellDef) return cellDef;
      return { value: "", style: cellDef.style };
    }
    return { value: cellDef };
  }

  function buildSheetXml(sheet, styleKeyToXf) {
    const columns = sheet.columns || [];
    const colsXml = columns.length
      ? `<cols>${columns.map((col, i) => `<col min="${i + 1}" max="${i + 1}" width="${col.width || 14}" customWidth="1"/>`).join("")}</cols>`
      : "";

    const rowsXml = sheet.rows.map((row, rowIdx) => {
      const rowNumber = rowIdx + 1;
      const cellsXml = row.map((rawCell, colIdx) => {
        const cellDef = normalizeCell(rawCell);
        const ref = cellRef(rowNumber, colIdx);
        const styleKey = cellDef.style || "default";
        const s = styleKeyToXf[styleKey] !== undefined ? styleKeyToXf[styleKey] : styleKeyToXf.__default;
        if (cellDef.formula) return `<c r="${ref}" s="${s}"><f>${xmlEscape(cellDef.formula)}</f></c>`;
        const value = cellDef.value;
        if (typeof value === "number" && Number.isFinite(value)) return `<c r="${ref}" s="${s}"><v>${value}</v></c>`;
        if (value === undefined || value === null || value === "" || (typeof value === "object")) return `<c r="${ref}" s="${s}"/>`;
        return `<c r="${ref}" t="inlineStr" s="${s}"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
      }).join("");
      const heightAttr = sheet.rowHeights && sheet.rowHeights[rowIdx] ? ` ht="${sheet.rowHeights[rowIdx]}" customHeight="1"` : "";
      return `<row r="${rowNumber}"${heightAttr}>${cellsXml}</row>`;
    }).join("");

    const paneXml = sheet.freeze
      ? (() => {
          const { row = 0, col = 0 } = sheet.freeze;
          if (!row && !col) return "";
          const topLeft = cellRef(row + 1, col);
          const ySplit = row ? ` ySplit="${row}"` : "";
          const xSplit = col ? ` xSplit="${col}"` : "";
          const activePane = row && col ? "bottomRight" : row ? "bottomLeft" : "topRight";
          return `<pane${xSplit}${ySplit} topLeftCell="${topLeft}" activePane="${activePane}" state="frozen"/>`;
        })()
      : "";
    const sheetViewsXml = `<sheetViews><sheetView workbookViewId="0" showGridLines="1">${paneXml}</sheetView></sheetViews>`;

    const autofilterXml = sheet.autofilter ? `<autoFilter ref="${sheet.autofilter}"/>` : "";
    const mergesXml = sheet.merges && sheet.merges.length
      ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((range) => `<mergeCell ref="${range}"/>`).join("")}</mergeCells>`
      : "";

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
${sheetViewsXml}
${colsXml}
<sheetData>${rowsXml}</sheetData>
${autofilterXml}
${mergesXml}
</worksheet>`;
  }

  function buildWorkbookXml(sheets) {
    const sheetsXml = sheets.map((sheet, i) => `<sheet name="${xmlEscape(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <bookViews><workbookView activeTab="0"/></bookViews>
  <sheets>${sheetsXml}</sheets>
  <calcPr calcId="999" fullCalcOnLoad="1"/>
</workbook>`;
  }

  function buildWorkbookRelsXml(sheets) {
    const sheetRels = sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("");
    const stylesRelId = `rId${sheets.length + 1}`;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${sheetRels}
  <Relationship Id="${stylesRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
  }

  function buildContentTypesXml(sheets) {
    const overrides = sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  ${overrides}
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;
  }

  function buildRootRelsXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;
  }

  function buildCoreXml() {
    const now = new Date().toISOString();
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>Form QA Automation Report</dc:title>
  <dc:creator>Form Field Validator</dc:creator>
  <cp:lastModifiedBy>Form Field Validator</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
  }

  function buildAppXml(sheets) {
    const titles = sheets.map((sheet) => `<vt:lpstr>${xmlEscape(sheet.name)}</vt:lpstr>`).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Form QA Automation</Application>
  <TitlesOfParts><vt:vector size="${sheets.length}" baseType="lpstr">${titles}</vt:vector></TitlesOfParts>
</Properties>`;
  }

  function buildWorkbook(spec) {
    const { sheets, styles } = spec;
    const { stylesXml, styleKeyToXf } = compileStyles(styles);
    const files = {};
    files["[Content_Types].xml"] = buildContentTypesXml(sheets);
    files["_rels/.rels"] = buildRootRelsXml();
    files["docProps/core.xml"] = buildCoreXml();
    files["docProps/app.xml"] = buildAppXml(sheets);
    files["xl/workbook.xml"] = buildWorkbookXml(sheets);
    files["xl/_rels/workbook.xml.rels"] = buildWorkbookRelsXml(sheets);
    files["xl/styles.xml"] = stylesXml;
    sheets.forEach((sheet, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = buildSheetXml(sheet, styleKeyToXf); });
    return buildZip(files);
  }

  globalScope.MiniXlsx = { buildXlsx, buildWorkbook, columnLetter, cellRef };
})(typeof globalThis !== "undefined" ? globalThis : window);
