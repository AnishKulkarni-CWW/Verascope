// ============================================================
// Link & Text Extractor (Extension 3)
// Wrapped in an IIFE for scope isolation from the other two
// tools' popup scripts sharing this document. This tool has no
// state to refresh on tab-open (it's a single "click to extract"
// action), so init() is a no-op — kept only so the tab shell can
// call every tool's init() uniformly without special-casing.
// ============================================================
(function () {
  // Scoped to this tool's own pane: #status is reused (with different
  // meaning) by Alt Text Viewer's original markup, so an unqualified
  // getElementById() would risk grabbing the wrong element.
  const pane     = document.querySelector('[data-tool-pane="link-extractor"]');
  const btn      = pane.querySelector('#extractBtn');
  const statusEl = pane.querySelector('#status');

  function showStatus(type, msg) {
    statusEl.className = 'status ' + type;
    statusEl.innerHTML = msg;
  }

  // ─── Main click handler ────────────────────────────────────────────────────
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    showStatus('loading', '<span class="spinner"></span> Scanning page…');

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    let results;
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: extractData
      });
    } catch {
      showStatus('error', '❌ Cannot access this page.<br>Try a regular website.');
      btn.disabled = false;
      return;
    }

    const { textLinks, imageLinks } = results[0].result;

    if (!textLinks.length && !imageLinks.length) {
      showStatus('error', '⚠️ No links found on this page.');
      btn.disabled = false;
      return;
    }

    showStatus('loading', `<span class="spinner"></span> Fetching ${imageLinks.length} image(s)…`);

    const imagesWithData = imageLinks.length ? await fetchImages(imageLinks) : [];

    showStatus('loading', '<span class="spinner"></span> Building Excel…');

    const ExcelJS  = window.ExcelJS;
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Link Extractor Extension';
    workbook.created = new Date();

    await buildTextSheet(workbook, textLinks);

    if (imagesWithData.length > 0) {
      await buildImageSheet(workbook, imagesWithData);
    }

    const buffer = await workbook.xlsx.writeBuffer();
    const blob   = new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });

    const now  = new Date();
    const ts   = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
    const host = tab.url ? new URL(tab.url).hostname.replace('www.', '') : 'page';
    const filename = `links_${host}_${ts}.xlsx`;

    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    const imgNote = imagesWithData.length
      ? ` · <strong>${imagesWithData.length}</strong> image-link(s)`
      : '';
    showStatus('success',
      `✅ <strong>${textLinks.length}</strong> text-link(s)${imgNote} extracted.<br>` +
      `<span style="font-size:11px;opacity:0.8">${filename}</span>`);
    btn.disabled = false;
  });

  function pad(n) { return String(n).padStart(2, '0'); }

  // ── Style helpers ─────────────────────────────────────────────────────────
  function applyHeaderStyle(cell, bgArgb) {
    cell.font      = { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Arial', size: 11 };
    cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgArgb } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };
    cell.border    = { bottom: { style: 'medium', color: { argb: 'FF888888' } } };
  }
  function applyDataStyle(cell) {
    cell.font      = { name: 'Arial', size: 10 };
    cell.alignment = { vertical: 'middle', wrapText: false };
  }
  function applyLinkStyle(cell, href) {
    cell.value     = { text: href, hyperlink: href, tooltip: href };
    cell.font      = { name: 'Arial', size: 10, color: { argb: 'FF1155CC' }, underline: true };
    cell.alignment = { vertical: 'middle', wrapText: false };
  }

  // ── Sheet 1: TEXT-LINKS  (header: light maroon #8B2020) ──────────────────
  async function buildTextSheet(workbook, textLinks) {
    const ws = workbook.addWorksheet('TEXT-LINKS');
    ws.columns = [
      { key: 'text',  width: 55 },
      { key: 'links', width: 90 }
    ];

    ws.getRow(1).height = 24;
    ws.getCell('A1').value = 'TEXTS';
    ws.getCell('B1').value = 'LINKS';
    // Light maroon
    applyHeaderStyle(ws.getCell('A1'), 'FF8B2020');
    applyHeaderStyle(ws.getCell('B1'), 'FF8B2020');

    textLinks.forEach(([text, href], i) => {
      const rowNum = i + 2;
      ws.getRow(rowNum).height = 18;
      const tCell = ws.getCell(`A${rowNum}`);
      tCell.value = text;
      applyDataStyle(tCell);
      applyLinkStyle(ws.getCell(`B${rowNum}`), href);
    });

    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }

  // ── Natural pixel dimensions of a base64 image ────────────────────────────
  function getImageDimensions(b64, mime) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload  = () => resolve({
        w: img.naturalWidth  > 0 ? img.naturalWidth  : 200,
        h: img.naturalHeight > 0 ? img.naturalHeight : 200
      });
      img.onerror = () => resolve({ w: 200, h: 200 });
      img.src = `data:${mime};base64,${b64}`;
    });
  }

  // ── Sheet 2: IMAGE-LINKS  (header: dark navy blue #1A3A6B) ───────────────
  async function buildImageSheet(workbook, imageRows) {
    const ws = workbook.addWorksheet('IMAGE-LINKS');

    const IMG_COL_CHARS = 24;
    const IMG_COL_PX    = Math.round(IMG_COL_CHARS * 7); // ≈ 168 px
    const MAX_IMG_H_PX  = 200;
    const MIN_ROW_PT    = 50;

    ws.columns = [
      { key: 'image',  width: IMG_COL_CHARS },
      { key: 'name',   width: 32 },
      { key: 'alt',    width: 40 },
      { key: 'links',  width: 90 }
    ];

    ws.getRow(1).height = 24;
    ws.getCell('A1').value = 'IMAGES';
    ws.getCell('B1').value = 'IMAGE NAMES';
    ws.getCell('C1').value = 'ALT TEXTS';
    ws.getCell('D1').value = 'LINKS';
    // Dark navy blue (same shade as TEXT-LINKS was before)
    ['A1','B1','C1','D1'].forEach(addr => applyHeaderStyle(ws.getCell(addr), 'FF1A3A6B'));

    for (let i = 0; i < imageRows.length; i++) {
      const { name, alt, href, b64, mime } = imageRows[i];
      const rowNum = i + 2;

      ws.getCell(`A${rowNum}`).value = '';

      const nCell = ws.getCell(`B${rowNum}`);
      nCell.value = name; applyDataStyle(nCell);

      const aCell = ws.getCell(`C${rowNum}`);
      aCell.value = alt || ''; applyDataStyle(aCell);

      applyLinkStyle(ws.getCell(`D${rowNum}`), href);

      if (b64) {
        // All images arrive here as PNG (converted) or native GIF/JPEG
        const extType = mime.includes('jpeg') || mime.includes('jpg') ? 'jpeg'
                      : mime.includes('gif')  ? 'gif'
                      : 'png';

        const { w: natW, h: natH } = await getImageDimensions(b64, mime);

        const targetW = IMG_COL_PX - 4;
        let imgW = targetW;
        let imgH = natW > 0 ? Math.round(targetW * natH / natW) : targetW;

        if (imgH > MAX_IMG_H_PX) {
          imgH = MAX_IMG_H_PX;
          imgW = natH > 0 ? Math.round(MAX_IMG_H_PX * natW / natH) : MAX_IMG_H_PX;
        }

        const rowPt = Math.max(MIN_ROW_PT, Math.ceil(imgH * 0.75) + 4);
        ws.getRow(rowNum).height = rowPt;

        try {
          const imageId = workbook.addImage({ base64: b64, extension: extType });
          ws.addImage(imageId, {
            tl:  { col: 0, row: rowNum - 1 },
            ext: { width: imgW, height: imgH }
          });
        } catch {
          ws.getCell(`A${rowNum}`).value = '[embed error]';
          applyDataStyle(ws.getCell(`A${rowNum}`));
          ws.getRow(rowNum).height = MIN_ROW_PT;
        }
      } else {
        ws.getCell(`A${rowNum}`).value = '(unavailable)';
        applyDataStyle(ws.getCell(`A${rowNum}`));
        ws.getRow(rowNum).height = MIN_ROW_PT;
      }
    }

    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }

  // ── Convert ANY browser-renderable image to PNG via Canvas ────────────────
  // Handles: SVG, WebP, AVIF, BMP, ICO, TIFF — anything Chrome can render
  function convertImageToPng(blob) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();

      img.onload = () => {
        const MAX_DIM = 800; // cap extremely large images
        let w = img.naturalWidth  > 0 ? img.naturalWidth  : 300;
        let h = img.naturalHeight > 0 ? img.naturalHeight : 300;

        if (w > MAX_DIM || h > MAX_DIM) {
          const scale = MAX_DIM / Math.max(w, h);
          w = Math.round(w * scale);
          h = Math.round(h * scale);
        }

        const canvas = document.createElement('canvas');
        canvas.width  = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff'; // white bg (SVGs are often transparent)
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);

        try {
          const dataUrl = canvas.toDataURL('image/png');
          resolve({ base64: dataUrl.split(',')[1], mime: 'image/png' });
        } catch {
          resolve(null);
        }
      };

      img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };

      // Required for cross-origin SVGs loaded via blob URL
      img.crossOrigin = 'anonymous';
      img.src = url;
    });
  }

  // ── Fetch all images — converting non-Excel formats (SVG/WebP/etc.) to PNG ─
  async function fetchImages(imageLinks) {
    // Excel natively supports only these three formats via addImage()
    const NATIVE_OK = new Set(['image/png', 'image/jpeg', 'image/gif']);

    const results = [];

    for (const item of imageLinks) {
      let b64  = null;
      let mime = 'image/png';

      try {
        const resp = await fetch(item.src, { mode: 'cors', credentials: 'omit' });

        if (resp.ok) {
          const rawMime = (resp.headers.get('content-type') || '')
            .split(';')[0].trim().toLowerCase();
          const blob = await resp.blob();

          // Detect formats Excel can't display natively
          const srcLower = item.src.toLowerCase();
          const needsConversion =
            !NATIVE_OK.has(rawMime)              ||
            rawMime.includes('svg')              ||
            rawMime.includes('webp')             ||
            rawMime.includes('avif')             ||
            rawMime.includes('bmp')              ||
            rawMime.includes('tiff')             ||
            srcLower.endsWith('.svg')            ||
            srcLower.includes('.svg?')           ||
            srcLower.endsWith('.webp')           ||
            srcLower.endsWith('.avif')           ||
            srcLower.endsWith('.bmp')            ||
            srcLower.endsWith('.ico')            ||
            srcLower.endsWith('.tiff');

          if (needsConversion) {
            // Rasterise via Canvas → clean PNG
            const converted = await convertImageToPng(blob);
            if (converted) {
              b64  = converted.base64;
              mime = 'image/png';
            }
          } else {
            // PNG / JPEG / GIF — encode raw bytes directly
            mime = rawMime || 'image/png';
            const arr    = new Uint8Array(await blob.arrayBuffer());
            let   binary = '';
            const CHUNK  = 8192;
            for (let i = 0; i < arr.length; i += CHUNK) {
              binary += String.fromCharCode(...arr.subarray(i, i + CHUNK));
            }
            b64 = btoa(binary);
          }
        }
      } catch {
        // CORS block or network error — cell will show "(unavailable)"
      }

      results.push({ ...item, b64, mime });
    }

    return results;
  }

  // ── Injected into the active tab ──────────────────────────────────────────
  function extractData() {
    const textLinks  = [];
    const imageLinks = [];
    const seenText   = new Set();
    const seenImg    = new Set();

    document.querySelectorAll('a[href]').forEach(a => {
      const href = a.href;
      if (!href || href.startsWith('javascript:') || href === '#') return;

      const imgs = a.querySelectorAll('img');

      if (imgs.length > 0) {
        imgs.forEach(img => {
          const src = img.src || '';
          if (!src) return;

          let name = '';
          try {
            const p = new URL(src).pathname;
            name = decodeURIComponent(p.split('/').pop()) || 'image';
          } catch { name = 'image'; }

          const alt = (img.alt || '').trim();
          const key = src + '|||' + href;
          if (seenImg.has(key)) return;
          seenImg.add(key);

          imageLinks.push({ src, name, alt, href });
        });
      } else {
        let text = a.innerText.replace(/\s+/g, ' ').trim();
        if (!text) text = a.title || href;
        if (!text) return;

        const key = text + '|||' + href;
        if (seenText.has(key)) return;
        seenText.add(key);

        textLinks.push([text, href]);
      }
    });

    return { textLinks, imageLinks };
  }

  window.LinkExtractorTool = {
    init() {
      // No state to refresh — this tool only acts on button click.
    }
  };
})();
