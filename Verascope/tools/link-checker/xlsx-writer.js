// xlsx-writer.js
//
// A minimal, dependency-free writer that produces a real .xlsx file
// (Office Open XML SpreadsheetML) with:
//   - actual embedded pictures (not linked/base64-in-HTML)
//   - real cell background fill colors
//   - a normal .xlsx extension that matches its true format, so Excel
//     opens it with no "format doesn't match" warning.
//
// No external libraries — everything here (CRC32 + a STORED-method
// ZIP writer + the OOXML parts) is hand-rolled so it works under the
// extension's default CSP with no network access.

// ---------- CRC32 ----------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
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

// ---------- Minimal ZIP (STORED = no compression) ----------
class SimpleZip {
  constructor() {
    this.files = []; // { name, data: Uint8Array }
  }

  addFile(name, data) {
    // data may be a string or Uint8Array
    const bytes = (typeof data === 'string')
      ? new TextEncoder().encode(data)
      : data;
    this.files.push({ name, data: bytes });
  }

  // Builds the final zip as a Uint8Array.
  build() {
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    const dosTime = 0;
    const dosDate = 0x21; // Jan 1 1980-ish placeholder, fine for our purposes

    for (const file of this.files) {
      const nameBytes = new TextEncoder().encode(file.name);
      const crc = crc32(file.data);
      const size = file.data.length;

      // Local file header
      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);   // local file header signature
      lv.setUint16(4, 20, true);           // version needed
      lv.setUint16(6, 0, true);            // flags
      lv.setUint16(8, 0, true);            // compression = 0 (stored)
      lv.setUint16(10, dosTime, true);
      lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, size, true);        // compressed size
      lv.setUint32(22, size, true);        // uncompressed size
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);           // extra field length
      local.set(nameBytes, 30);

      localParts.push(local, file.data);

      // Central directory header
      const central = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true);   // central dir signature
      cv.setUint16(4, 20, true);           // version made by
      cv.setUint16(6, 20, true);           // version needed
      cv.setUint16(8, 0, true);            // flags
      cv.setUint16(10, 0, true);           // compression
      cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, size, true);
      cv.setUint32(24, size, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);           // extra field length
      cv.setUint16(32, 0, true);           // comment length
      cv.setUint16(34, 0, true);           // disk number start
      cv.setUint16(36, 0, true);           // internal attrs
      cv.setUint32(38, 0, true);           // external attrs
      cv.setUint32(42, offset, true);      // offset of local header
      central.set(nameBytes, 46);

      centralParts.push(central);

      offset += local.length + file.data.length;
    }

    const centralStart = offset;
    let centralSize = 0;
    for (const c of centralParts) centralSize += c.length;

    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);      // end of central dir signature
    ev.setUint16(4, 0, true);               // disk number
    ev.setUint16(6, 0, true);               // disk with central dir
    ev.setUint16(8, this.files.length, true);
    ev.setUint16(10, this.files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, centralStart, true);
    ev.setUint16(20, 0, true);              // comment length

    const totalSize = offset + centralSize + end.length;
    const result = new Uint8Array(totalSize);
    let pos = 0;
    for (const part of localParts) { result.set(part, pos); pos += part.length; }
    for (const part of centralParts) { result.set(part, pos); pos += part.length; }
    result.set(end, pos);

    return result;
  }
}

// ---------- Helpers ----------
function xmlEscape(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function colLetter(n) {
  // 0-indexed column number -> Excel column letter
  let s = '';
  n = n + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function cellRef(col, row) {
  return `${colLetter(col)}${row + 1}`;
}

function dataUrlToBytes(dataUrl) {
  const base64 = dataUrl.split(',')[1] || '';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// EMU conversion: 914400 EMUs per inch, 96 px per inch (screen) assumption
const EMU_PER_PX = 9525;

// ---------- Main builder ----------
// rows: [{ src, dataUrl, alt, status, color, textColor, pageUrl, pageTitle }]
function buildXlsx(rows) {
  const zip = new SimpleZip();

  const headers = ['#', 'Image', 'Image Source URL', 'Alt Text', 'Status', 'Element Type', 'Page Title', 'Page URL'];
  const colWidths = [4, 18, 40, 30, 12, 32, 30, 40];
  const rowHeight = 90; // points, tall enough for a thumbnail

  // Collect images (only rows that actually have an embeddable dataUrl)
  const images = []; // { rowIndex, bytes, ext, width, height }
  rows.forEach((row, i) => {
    if (row.dataUrl) {
      try {
        const bytes = dataUrlToBytes(row.dataUrl);
        images.push({ rowIndex: i, bytes, colIndex: 1 });
      } catch (e) {
        // skip unparseable data URL
      }
    }
  });

  // ---- Styles: two fills (green/red) + header fill ----
  // Fill indices: 0=none,1=none(builtin) then custom fills start at 2
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="3">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FFFF0000"/><name val="Calibri"/></font>
  </fonts>
  <fills count="4">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF333333"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF00FF7F"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="1">
    <border><left/><right/><top/><bottom/><diagonal/></border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="5">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
    <xf numFmtId="0" fontId="2" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"><alignment wrapText="1" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf>
  </cellXfs>
</styleSheet>`;
  // style ids: 0=default, 1=header, 2=greenRow(alt+status present), 3=redRow(status missing, white bold text on red - reuse fillId 3 won't work since fill for red isn't defined above)
  // NOTE: simplified below by using dynamic per-row fill definitions instead. See buildXlsxDynamic.

  return buildXlsxDynamic(rows, headers, colWidths, rowHeight, images);
}

// Builds styles dynamically since each row may need a distinct fill color
// (green for "present", red for "missing" — matches the on-page overlay).
function buildXlsxDynamic(rows, headers, colWidths, rowHeight, images) {
  const zip = new SimpleZip();

  // Build unique fills for red/green (only 2 needed) + header + none
  const fillDefs = [
    '<fill><patternFill patternType="none"/></fill>',                                                              // 0
    '<fill><patternFill patternType="gray125"/></fill>',                                                            // 1 (required placeholder)
    '<fill><patternFill patternType="solid"><fgColor rgb="FF333333"/><bgColor indexed="64"/></patternFill></fill>', // 2 header
    '<fill><patternFill patternType="solid"><fgColor rgb="FF00FF7F"/><bgColor indexed="64"/></patternFill></fill>', // 3 green
    '<fill><patternFill patternType="solid"><fgColor rgb="FFFF0000"/><bgColor indexed="64"/></patternFill></fill>'  // 4 red
  ];

  const fontDefs = [
    '<font><sz val="11"/><name val="Calibri"/></font>',                                   // 0 normal
    '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>',         // 1 header (white bold)
    '<font><b/><sz val="11"/><color rgb="FFFF0000"/><name val="Calibri"/></font>',         // 2 red text bold (for green bg rows)
    '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>'          // 3 white text bold (for red bg rows)
  ];

  // cellXfs: 0 default, 1 header, 2 green-fill+red-text, 3 red-fill+white-text, 4 wraptext-plain
  const cellXfs = [
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>',
    '<xf numFmtId="0" fontId="2" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>',
    '<xf numFmtId="0" fontId="3" fillId="4" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>',
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>'
  ];

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="${fontDefs.length}">${fontDefs.join('')}</fonts>
  <fills count="${fillDefs.length}">${fillDefs.join('')}</fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="${cellXfs.length}">${cellXfs.join('')}</cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  const STYLE_DEFAULT = 0, STYLE_HEADER = 1, STYLE_GREEN = 2, STYLE_RED = 3, STYLE_WRAP = 4;

  // ---- Shared strings ----
  const sharedStrings = [];
  const sstIndex = (str) => {
    const s = str == null ? '' : String(str);
    let idx = sharedStrings.indexOf(s);
    if (idx === -1) {
      sharedStrings.push(s);
      idx = sharedStrings.length - 1;
    }
    return idx;
  };

  // ---- Build sheet rows ----
  const HEADER_ROW = 0;
  const sheetRowsXml = [];

  // Header row
  {
    const cellsXml = headers.map((h, c) => {
      const ref = cellRef(c, HEADER_ROW);
      const s = sstIndex(h);
      return `<c r="${ref}" t="s" s="${STYLE_HEADER}"><v>${s}</v></c>`;
    }).join('');
    sheetRowsXml.push(`<row r="${HEADER_ROW + 1}" ht="20" customHeight="1">${cellsXml}</row>`);
  }

  rows.forEach((row, i) => {
    const r = i + 1; // data row index (0-based, after header)
    const altStyle = row.status === 'Present' ? STYLE_GREEN : STYLE_RED;

    const values = [
      String(i + 1),
      row.dataUrl ? '' : (row.src ? '(no preview available)' : '(no source)'),
      row.src || '',
      row.alt || '',
      row.status || '',
      row.elementType || 'img',
      row.pageTitle || '',
      row.pageUrl || ''
    ];

    const cells = values.map((val, c) => {
      const ref = cellRef(c, r);
      let style = STYLE_WRAP;
      if (c === 3 || c === 4) style = altStyle; // Alt Text + Status columns get the color
      const s = sstIndex(val);
      return `<c r="${ref}" t="s" s="${style}"><v>${s}</v></c>`;
    }).join('');

    sheetRowsXml.push(`<row r="${r + 1}" ht="${rowHeight}" customHeight="1">${cells}</row>`);
  });

  const colsXml = colWidths.map((w, i) =>
    `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`
  ).join('');

  // ---- Drawing (embedded images) ----
  let drawingRelsXml = '';
  let drawingXml = '';
  let sheetHasDrawing = images.length > 0;

  if (sheetHasDrawing) {
    const anchors = images.map((img, idx) => {
      const rId = `rId${idx + 1}`;
      const rowIdx = img.rowIndex + 1; // +1 for header row, this is the 0-based row in the sheet
      const colIdx = img.colIndex; // "Image" column
      // Simple one-cell anchor sized to fit inside the row.
      const widthEmu = 110 * EMU_PER_PX;
      const heightEmu = 110 * EMU_PER_PX;
      return `
      <xdr:twoCellAnchor editAs="oneCell">
        <xdr:from><xdr:col>${colIdx}</xdr:col><xdr:colOff>19050</xdr:colOff><xdr:row>${rowIdx}</xdr:row><xdr:rowOff>19050</xdr:rowOff></xdr:from>
        <xdr:to><xdr:col>${colIdx + 1}</xdr:col><xdr:colOff>${widthEmu > 800000 ? 0 : 0}</xdr:colOff><xdr:row>${rowIdx + 1}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
        <xdr:pic>
          <xdr:nvPicPr>
            <xdr:cNvPr id="${idx + 2}" name="Image${idx + 1}"/>
            <xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr>
          </xdr:nvPicPr>
          <xdr:blipFill>
            <a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="${rId}"/>
            <a:stretch><a:fillRect/></a:stretch>
          </xdr:blipFill>
          <xdr:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="${widthEmu}" cy="${heightEmu}"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          </xdr:spPr>
        </xdr:pic>
        <xdr:clientData/>
      </xdr:twoCellAnchor>`;
    }).join('');

    drawingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
${anchors}
</xdr:wsDr>`;

    drawingRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${images.map((img, idx) => `<Relationship Id="rId${idx + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${idx + 1}.png"/>`).join('\n')}
</Relationships>`;
  }

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <cols>${colsXml}</cols>
  <sheetData>${sheetRowsXml.join('')}</sheetData>
  ${sheetHasDrawing ? '<drawing r:id="rIdDrawing1"/>' : ''}
</worksheet>`;

  const sheetRelsXml = sheetHasDrawing ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdDrawing1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>` : null;

  // ---- Shared strings XML ----
  const sstXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">
${sharedStrings.map(s => `<si><t xml:space="preserve">${xmlEscape(s)}</t></si>`).join('')}
</sst>`;

  // ---- Workbook + rels + content types ----
  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Alt Text Report" sheetId="1" r:id="rId1"/></sheets>
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
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
  ${sheetHasDrawing ? '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' : ''}
</Types>`;

  const coreXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:title>Alt Text Validation Report</dc:title>
</cp:coreProperties>`;

  // ---- Assemble zip ----
  zip.addFile('[Content_Types].xml', contentTypesXml);
  zip.addFile('_rels/.rels', rootRelsXml);
  zip.addFile('docProps/core.xml', coreXml);
  zip.addFile('xl/workbook.xml', workbookXml);
  zip.addFile('xl/_rels/workbook.xml.rels', workbookRelsXml);
  zip.addFile('xl/styles.xml', stylesXml);
  zip.addFile('xl/sharedStrings.xml', sstXml);
  zip.addFile('xl/worksheets/sheet1.xml', sheetXml);

  if (sheetHasDrawing) {
    zip.addFile('xl/worksheets/_rels/sheet1.xml.rels', sheetRelsXml);
    zip.addFile('xl/drawings/drawing1.xml', drawingXml);
    zip.addFile('xl/drawings/_rels/drawing1.xml.rels', drawingRelsXml);
    images.forEach((img, idx) => {
      zip.addFile(`xl/media/image${idx + 1}.png`, img.bytes);
    });
  }

  return zip.build();
}
