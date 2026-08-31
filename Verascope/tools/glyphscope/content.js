// Glyphscope — content script
// Guard against duplicate injection when popup re-runs executeScript.
if (!window.__glyphscopeInjected) {
  window.__glyphscopeInjected = true;

  (function () {
    "use strict";

    const STATE = {
      analyzed: false,
      elements: [], // real text elements with resolved font data
      uniqueFonts: new Set(),
    };

    let ENABLED = true;
    try {
      chrome.storage.local.get(["glyphscopeEnabled"], (res) => {
        if (typeof res.glyphscopeEnabled === "boolean") ENABLED = res.glyphscopeEnabled;
        if (!ENABLED && tooltipEl) tooltipEl.style.display = "none";
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && "glyphscopeEnabled" in changes) {
          ENABLED = !!changes.glyphscopeEnabled.newValue;
          if (!ENABLED && tooltipEl) tooltipEl.style.display = "none";
        }
      });
    } catch (e) {
      /* storage unavailable in this context, default stays enabled */
    }

    const IGNORED_TAGS = new Set([
      "SCRIPT", "STYLE", "NOSCRIPT", "META", "LINK", "HEAD", "TITLE",
      "IFRAME", "TEMPLATE", "BR", "HR",
    ]);

    // ---------- Tooltip ----------
    let tooltipEl = null;

    function ensureTooltip() {
      if (tooltipEl) return tooltipEl;
      tooltipEl = document.createElement("div");
      tooltipEl.id = "__glyphscope_tooltip__";
      Object.assign(tooltipEl.style, {
        position: "fixed",
        zIndex: "2147483647",
        pointerEvents: "none",
        background: "#15151f",
        color: "#fff",
        padding: "14px 18px",
        borderRadius: "14px",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        boxShadow: "0 10px 30px rgba(0,0,0,0.45)",
        maxWidth: "360px",
        display: "none",
        border: "1px solid rgba(255,255,255,0.08)",
      });
      document.documentElement.appendChild(tooltipEl);
      return tooltipEl;
    }

    function escapeHtml(str) {
      const d = document.createElement("div");
      d.textContent = str;
      return d.innerHTML;
    }

    // Font-detail card: name up top, a row of icon+value stats, then
    // secondary weight/style/stack info. No emoji, geometric SVG icons only.
    function formatFontTooltip(styles) {
      const nameLine = `
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">
          <span style="
            display:flex;align-items:center;justify-content:center;
            width:26px;height:26px;border-radius:7px;
            border:1.5px solid rgba(255,255,255,0.35);
            font-weight:700;font-size:13px;flex-shrink:0;
          ">Aa</span>
          <span style="font-size:18px;font-weight:700;line-height:1.25;">
            ${escapeHtml(styles.resolvedFont)}
          </span>
        </div>`;

      const chip = (iconSvg, value) => `
        <div style="display:flex;align-items:center;gap:6px;">
          ${iconSvg}
          <span style="font-size:13.5px;font-weight:500;color:#e7e7ee;">${escapeHtml(value)}</span>
        </div>`;

      const iconSize = `
        <span style="display:flex;align-items:center;font-size:10px;color:#9a9aa5;font-weight:700;letter-spacing:-1px;">
          <span style="font-size:8px;">A</span><span style="font-size:12px;">A</span>
        </span>`;

      const iconLineHeight = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#9a9aa5" stroke-width="2.4" stroke-linecap="round">
          <line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/>
        </svg>`;

      const iconLetterSpacing = `<span style="font-size:10px;color:#9a9aa5;font-weight:700;">|A|</span>`;

      const colorDot = `
        <span style="
          display:inline-block;width:13px;height:13px;border-radius:50%;
          background:${escapeHtml(styles.color)};
          border:1.5px solid rgba(255,255,255,0.5);flex-shrink:0;
        "></span>`;

      const statsRow = `
        <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;">
          ${chip(iconSize, styles.fontSize)}
          ${chip(iconLineHeight, styles.lineHeight === "normal" ? styles.fontSize : styles.lineHeight)}
          ${chip(iconLetterSpacing, styles.letterSpacing === "normal" ? "0px" : styles.letterSpacing)}
          ${chip(colorDot, styles.hexColor)}
        </div>`;

      const metaRow = `
        <div style="margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.12);
                    display:flex;justify-content:space-between;gap:14px;font-size:11px;color:#9a9aa5;">
          <span>Weight <b style="color:#e7e7ee;">${escapeHtml(String(styles.fontWeight))}</b></span>
          <span>Style <b style="color:#e7e7ee;">${escapeHtml(styles.fontStyle)}</b></span>
        </div>`;

      const stackRow = `
        <div style="margin-top:6px;font-size:10.5px;color:#75758a;word-break:break-word;">
          Stack: ${escapeHtml(styles.fontFamily)}
        </div>`;

      return nameLine + statsRow + metaRow + stackRow;
    }

    function getComputedFontInfo(el) {
      const cs = window.getComputedStyle(el);
      const fontFamily = cs.fontFamily;
      return {
        fontFamily,
        resolvedFont: resolveActualFont(fontFamily, cs.fontWeight, cs.fontStyle),
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        fontStyle: cs.fontStyle,
        lineHeight: cs.lineHeight,
        letterSpacing: cs.letterSpacing,
        color: cs.color,
        hexColor: rgbToHex(cs.color),
      };
    }

    function rgbToHex(rgbStr) {
      const m = rgbStr.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
      if (!m) return rgbStr;
      const [, r, g, b] = m;
      return (
        "#" +
        [r, g, b].map((v) => parseInt(v, 10).toString(16).padStart(2, "0")).join("").toUpperCase()
      );
    }

    // Checks the font stack against the *actual* weight/style being used,
    // so a bold heading isn't misreported as a font that only has a
    // regular weight available. Falls back through the stack in order.
    function resolveActualFont(fontFamilyStack, weight, style) {
      const candidates = fontFamilyStack
        .split(",")
        .map((f) => f.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      if (document.fonts && document.fonts.check) {
        for (const font of candidates) {
          try {
            const spec = `${style === "italic" ? "italic " : ""}${weight || "400"} 16px "${font}"`;
            if (document.fonts.check(spec)) return font;
          } catch (e) {
            /* invalid font name in stack, skip */
          }
        }
      }
      return candidates[0] || "unknown";
    }

    // True only if this specific element owns a direct, visible text node
    // (not just inherited computed style with nothing actually rendered
    // here) — prevents false tooltips over padding/whitespace/wrappers.
    function hasOwnText(el) {
      if (!el || !el.childNodes) return false;
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) return true;
      }
      return false;
    }

    // Many CMS/AEM-style page builders (BMW's site included) wrap real
    // text several layers deep in single-purpose, single-child divs/spans
    // (e.g. <h2><span><span>iX3</span></span></h2>) purely for styling or
    // component-boundary reasons. hasOwnText() alone only sees a *direct*
    // text child, so it misses text on the outer wrapper the mouse
    // actually hits and on elementsFromPoint's stack. This walks down
    // through a chain of single-element-child wrappers to find the
    // innermost element that actually owns the visible text, so its font
    // size/weight/etc. are read from where the text is truly rendered
    // (matching what the browser paints) instead of being missed or
    // read from the wrong ancestor.
    function findTextOwner(el, depth = 0) {
      if (!el || depth > 6) return null;
      if (hasOwnText(el)) return el;

      const children = Array.from(el.children || []).filter((c) => {
        if (IGNORED_TAGS.has(c.tagName)) return false;
        const cs = window.getComputedStyle(c);
        if (cs.display === "none" || cs.visibility === "hidden") return false;
        return true;
      });

      // Only descend through unambiguous single-element wrapper chains —
      // if there are multiple visible children we don't know which one
      // the hovered point actually corresponds to, so stop rather than
      // guessing (avoids attributing text from a sibling element).
      if (children.length === 1) {
        return findTextOwner(children[0], depth + 1);
      }
      return null;
    }

    // Reads the *entire* element stack at a pixel — not just the topmost
    // hit-test target — because many sites (MINI's hero banners included)
    // place an invisible full-size <a> or overlay on top of real text for
    // click-catching purposes. elementsFromPoint sees through that stack
    // so we can find the actual text underneath, exactly like a browser's
    // own inspector does. Purely visual content (images, background
    // images, canvases) is intentionally ignored — Glyphscope only ever
    // reports pure text font data, never image metadata.
    function getHoverHit(x, y) {
      const direct = getHoverHitAtPoint(x, y);
      if (direct) return direct;

      // Direct pixel hit found no text. This happens when the cursor is
      // inside a large heading's layout box but not over actual glyph
      // ink — a hollow letter, a wide kerning gap, or simply because the
      // text sits stretched/letter-spaced far apart (common in hero
      // headlines like "iX3" spanning hundreds of pixels). Two fallbacks,
      // tried in order, both still requiring a genuine text-owning
      // element — neither ever reports on an image or invents data:
      //
      // 1. caretRangeFromPoint/caretPositionFromPoint: the browser's own
      //    API for "what text is nearest this point", independent of
      //    which element paints that exact pixel. This is the correct
      //    tool for exactly this gap-in-glyph problem.
      const caretOwner = getTextOwnerViaCaret(x, y);
      if (caretOwner) return { type: "text", el: caretOwner };

      // 2. A small expanding ring probe as a last resort, for cases
      //    where caret APIs return nothing (some browsers/edge cases).
      const radii = [10, 24, 48];
      const angles = [0, 45, 90, 135, 180, 225, 270, 315];
      for (const radius of radii) {
        for (const deg of angles) {
          const rad = (deg * Math.PI) / 180;
          const px = x + Math.round(Math.cos(rad) * radius);
          const py = y + Math.round(Math.sin(rad) * radius);
          const probe = getHoverHitAtPoint(px, py);
          if (probe && probe.type === "text") return probe;
        }
      }
      return null;
    }

    // Uses the browser's native "nearest text position to a point" API
    // to find the actual text-owning element even when the exact pixel
    // has no glyph ink. Falls back gracefully across browser API name
    // differences (Chrome vs Firefox) and returns null on any failure —
    // never guesses an element that doesn't genuinely own text.
    function getTextOwnerViaCaret(x, y) {
      try {
        let node = null;
        if (document.caretPositionFromPoint) {
          const pos = document.caretPositionFromPoint(x, y);
          node = pos && pos.offsetNode;
        } else if (document.caretRangeFromPoint) {
          const range = document.caretRangeFromPoint(x, y);
          node = range && range.startContainer;
        }
        if (!node) return null;
        const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
        if (!el) return null;
        if (hasOwnText(el)) return el;
        return findTextOwner(el);
      } catch (e) {
        return null;
      }
    }

    function getHoverHitAtPoint(x, y) {
      let stack = [];
      try {
        stack = document.elementsFromPoint(x, y) || [];
      } catch (e) {
        const single = document.elementFromPoint(x, y);
        if (single) stack = [single];
      }

      const usable = stack.filter(
        (el) =>
          el instanceof Element &&
          el.tagName !== "HTML" &&
          el.tagName !== "BODY" &&
          el.id !== "__glyphscope_tooltip__" &&
          !el.closest?.("#__glyphscope_tooltip__") &&
          !IGNORED_TAGS.has(el.tagName)
      );

      for (const el of usable) {
        if (hasOwnText(el)) return { type: "text", el };
        const owner = findTextOwner(el);
        if (owner) return { type: "text", el: owner };
      }
      return null;
    }

    let rafPending = false;

    function onMouseOver(e) {
      if (!ENABLED || !STATE.analyzed) return;
      updateTooltipAt(e.clientX, e.clientY);
    }

    // Only ever shows a tooltip when the hover point resolves to real,
    // pure text. Non-text content (images, background images, empty
    // layout elements) simply hides the tooltip — Glyphscope never
    // reports on anything but actual text.
    function updateTooltipAt(x, y) {
      const tip = ensureTooltip();
      const hit = getHoverHit(x, y);

      if (!hit || hit.type !== "text") {
        tip.style.display = "none";
        return;
      }

      tip.innerHTML = formatFontTooltip(getComputedFontInfo(hit.el));
      tip.style.display = "block";
      positionTooltip(x, y);
    }

    function onMouseMove(e) {
      if (!ENABLED || !STATE.analyzed) return;
      const x = e.clientX;
      const y = e.clientY;
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        updateTooltipAt(x, y);
      });
    }

    function positionTooltip(x, y) {
      const offset = 16;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const rect = tooltipEl.getBoundingClientRect();
      let left = x + offset;
      let top = y + offset;
      if (left + rect.width > vw) left = x - rect.width - offset;
      if (top + rect.height > vh) top = y - rect.height - offset;
      tooltipEl.style.left = `${Math.max(4, left)}px`;
      tooltipEl.style.top = `${Math.max(4, top)}px`;
    }

    function onMouseOut(e) {
      if (tooltipEl && !e.relatedTarget) {
        tooltipEl.style.display = "none";
      }
    }

    document.addEventListener("mouseover", onMouseOver, true);
    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("mouseout", onMouseOut, true);

    // ---------- Analysis ----------
    // Distinguishes truly non-existent-on-page elements (display:none,
    // detached, zero-size layout) from elements merely transitioning
    // (opacity animating in, fade-in on scroll/load — very common on
    // BMW's title/hero components) or briefly outside the viewport.
    // Only the former should be excluded from the scan: excluding
    // opacity:0-mid-transition elements caused real on-page headings
    // (e.g. "iX3") to be silently skipped if Analyze Page ran before
    // their fade-in finished. display:none and detached/zero-layout
    // elements are never going to render text, so those stay excluded.
    function isVisible(el) {
      const style = window.getComputedStyle(el);
      if (style.display === "none") return false;
      if (!el.isConnected) return false;
      const rect = el.getBoundingClientRect();
      // offsetParent is null for display:none or fixed-position-detached
      // elements, but also for <body> itself and position:fixed items —
      // so only treat a truly zero-area, no-rect element as invisible
      // when it also has no offsetParent, avoiding false negatives on
      // elements that are on-page but mid-fade or briefly zero-height
      // during a CSS transition.
      if (rect.width === 0 && rect.height === 0 && el.offsetParent === null && style.position !== "fixed") {
        return false;
      }
      return true;
    }

    // Pure text scan only. No image, background-image, or canvas
    // detection at all — Glyphscope reports exclusively on real,
    // paintable text elements and their computed font data.
    function collectAll() {
      const textResults = [];
      const seenText = new Set();

      const all = document.body.querySelectorAll("*");
      for (const el of all) {
        if (IGNORED_TAGS.has(el.tagName)) continue;
        if (el.closest("#__glyphscope_tooltip__")) continue;
        if (!isVisible(el)) continue;

        // Text-owning elements. Skip pure single-child wrapper elements
        // here (they have no own text and exactly one visible child) —
        // findTextOwner would just resolve them to that same descendant,
        // which querySelectorAll will visit on its own iteration, so
        // recording the wrapper too would create a duplicate row with
        // identical text but the wrapper's (often less accurate,
        // inherited) computed style instead of the actual text node's.
        if (!hasOwnText(el)) continue;
        if (!seenText.has(el)) {
          seenText.add(el);
          const text = el.textContent.trim().replace(/\s+/g, " ");
          if (!text) continue;
          const styles = getComputedFontInfo(el);
          textResults.push({
            text: text.length > 300 ? text.slice(0, 300) + "…" : text,
            tag: el.tagName.toLowerCase(),
            selector: buildSelector(el),
            ...styles,
          });
        }
      }
      return { textResults };
    }

    // Native `title` attributes on images/media fire the browser's own
    // plain tooltip, which is easy to mistake for Glyphscope's own card
    // (as seen when hovering BMW's hero image under overlaid heading
    // text). Suppressing them during analysis means a hover miss is
    // silent instead of surfacing a confusing, differently-styled native
    // tooltip that has nothing to do with font data.
    const SUPPRESSED_TITLES = new Map();

    function suppressMediaTitles() {
      const media = document.querySelectorAll("img[title], picture[title], svg[title], video[title], canvas[title]");
      media.forEach((el) => {
        if (!SUPPRESSED_TITLES.has(el)) {
          SUPPRESSED_TITLES.set(el, el.getAttribute("title"));
          el.removeAttribute("title");
        }
      });
    }

    function restoreMediaTitles() {
      SUPPRESSED_TITLES.forEach((title, el) => {
        el.setAttribute("title", title);
      });
      SUPPRESSED_TITLES.clear();
    }

    function buildSelector(el) {
      if (el.id) return `#${el.id}`;
      let path = el.tagName.toLowerCase();
      if (el.className && typeof el.className === "string" && el.className.trim()) {
        path += "." + el.className.trim().split(/\s+/).slice(0, 2).join(".");
      }
      return path;
    }

    function analyze() {
      const { textResults } = collectAll();
      STATE.elements = textResults;
      STATE.uniqueFonts = new Set(textResults.map((e) => e.resolvedFont));
      STATE.analyzed = true;
      suppressMediaTitles();
      return {
        ok: true,
        count: STATE.elements.length,
        uniqueFonts: STATE.uniqueFonts.size,
      };
    }

    // ---------- Messaging ----------
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.action === "analyze") {
        sendResponse(analyze());
      } else if (msg.action === "getStatus") {
        sendResponse({
          analyzed: STATE.analyzed,
          count: STATE.elements.length,
          uniqueFonts: STATE.uniqueFonts.size,
          enabled: ENABLED,
        });
      } else if (msg.action === "setEnabled") {
        ENABLED = !!msg.value;
        if (!ENABLED) {
          if (tooltipEl) tooltipEl.style.display = "none";
          restoreMediaTitles();
        } else if (STATE.analyzed) {
          suppressMediaTitles();
        }
        sendResponse({ ok: true, enabled: ENABLED });
      } else if (msg.action === "export") {
        if (!STATE.analyzed) {
          sendResponse({ ok: false, error: "Not analyzed yet" });
        } else {
          sendResponse({
            ok: true,
            rows: STATE.elements,
            pageUrl: location.href,
            pageTitle: document.title,
          });
        }
      }
      return true;
    });
  })();
}
