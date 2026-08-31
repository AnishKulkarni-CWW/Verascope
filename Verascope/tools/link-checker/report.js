// ============================================================
// Check My Links — report.js (was popup.js in the standalone
// extension; renamed to avoid colliding with the shell's own
// top-level popup.js). This is the script for the in-page
// report overlay (linkreport.html), NOT the QA ToolKit shell.
//
// PAYWALL/LOGIN REMOVED: every `allow ? doThing() : showLogin()`
// gate found in the original became an unconditional doThing() —
// there is no more login/subscription system, so every gated
// feature (move popup, export invalid, download invalid,
// invalid-checkbox) is now always available. The `allow` and
// `isLoggedIn` variables and every reference to
// .home-login-btn/.home-profile-btn were removed entirely.
//
// RATE-US / SHARE REMOVED: the entire attention-callout timer
// system (functions tracking cmlRateUsClicked/cmlShareTime/
// cmlInstallTime/cmlRatePopupTime, the pulsing "Rate Us" badge,
// and the WhatsApp/Twitter/LinkedIn/Facebook/Telegram share
// menu) is gone along with the HTML elements it targeted.
//
// BUG FIX: the original sendHeight() read
// document.getElementById("register_form").style.display and
// document.querySelector(".profile-tab").style.display — both
// elements were removed from linkreport.html along with the
// login/profile-tab UI, so those two lines would throw
// "Cannot read properties of null" the moment sendHeight() ran
// (which is immediately, on window load). Fixed by dropping
// those two now-dead height-override checks; the function now
// just reports the real scrollHeight, which is what it should
// do now that there's no hidden oversized login panel to
// account for.
//
// Everything else — the message listener for scan progress,
// the color pickers, checkboxes, move/position/exclude/export/
// download handlers, CSV export — is unchanged in behavior from
// the original.
// ============================================================

const urlParams = new URLSearchParams(window.location.search), tabId = urlParams.get("tabid");
var validUrls = [], invalidUrls = [], redirectUrls = [], warningUrls = [], targetTab = "";
let processStart = null;

$(function () {
  $('[data-toggle="tooltip"]').tooltip();

  // BUG FIX (pre-existing in the original extension, unrelated to this
  // pass's other changes): Bootstrap's default tooltip trigger is
  // "hover focus", which hides a tooltip when its trigger element loses
  // hover/focus -- but every checkbox this page uses (.checkbox-wrapper-
  // 28 through -31, i.e. the valid/invalid/warning/redirect toggles) has
  // its actual <input> visually hidden (clip: rect(0 0 0 0)) with the
  // tooltip attached to the wrapper div instead. Clicking through to a
  // sibling label doesn't reliably transfer hover/focus the way Bootstrap
  // expects, so the tooltip can be left rendered on top of the page after
  // a click -- confirmed directly: a leftover "Hide color" tooltip
  // physically blocked a real click on the next checkbox, since
  // document.elementFromPoint() at that screen position returned the
  // tooltip's own DOM node, not the control underneath it. This would
  // affect any real person clicking these checkboxes in quick succession,
  // not just an automated test. Fixed with the standard remedy for this
  // known Bootstrap behavior: explicitly hide any currently-visible
  // tooltip on every document click, rather than depend on Bootstrap's
  // own hover/focus-based hide logic to catch every case.
  $(document).on("click", function () {
    $('[data-toggle="tooltip"]').tooltip("hide");
  });

  chrome.storage.local.get(["batchProcessingEnabled"], b => {
    let f = false;
    if (typeof b.batchProcessingEnabled === "undefined" || b.batchProcessingEnabled === false) f = true;
    else if (b.batchProcessingEnabled === true) f = false;
    f ? $(".with-intervals").remove() : $(".no-intervals").remove();
  });
});

chrome.runtime.onMessage.addListener((b, f, g) => {
  if (tabId == b.tabId && b.action !== "starting") {
    if (b.action === "reset") {
      console.log(b);
      validUrls = []; invalidUrls = []; redirectUrls = []; warningUrls = [];
    } else if (b.action === "updatedlogs") {
      targetTab = b.targetTab;
      if (b.type == "valid") validUrls.push(b.urlObj);
      if (b.type == "invalid") invalidUrls.push(b.urlObj);
      if (b.type == "redirect") redirectUrls.push(b.urlObj);
      if (b.type == "warning") warningUrls.push(b.urlObj);
      $("#totalCount").html(b.totalPageLinks);
      document.querySelectorAll("#queuedCount").forEach(function (c) {
        c.textContent = Math.abs(parseInt(b.queued));
        let pct = (b.totalPageLinks - b.queued) / b.totalPageLinks * 100;
        pct = Math.floor(pct);
        if (pct <= 100) { $("#percentComplete").text(pct + "%"); $("#progressBar").css("width", pct + "%"); }
        if (pct == 100) {
          const now = Date.now();
          if (b.startTime) {
            const dur = formatDuration((now - b.startTime) / 1000 + 5);
            $(".counter-text-line").text("Completed in " + dur + ".");
          } else {
            $(".counter-text-line").text("Completed.");
          }
        }
      });
      document.querySelectorAll(".valid-links").forEach(function (c) { c.textContent = b.passed; });
      document.querySelectorAll(".redirecting-links").forEach(function (c) { c.textContent = b.redirected; });
      document.querySelectorAll(".warnings").forEach(function (c) { c.textContent = b.warning; });
      document.querySelectorAll(".invalid-links").forEach(function (c) { c.textContent = b.invalid; });
    } else if (b.action === "nextCounters") {
      $(".counter-text-line").removeClass("hide-text-1");
      if ($("#processTime").length == 0 || $("#processCount").length == 0) {
        $(".counter-text-line").html($(".counter-text-line").html().replace("Processing...", 'In <span id="processTime" class="orange-text" >0</span> sec, it will process <span id="processCount" class="orange-text" >0</span> links'));
      }
      let c = b.nextDelay;
      $("#processCount").html(b.nextBatchSize);
      $("#processTime").html(c);
      if (window.nextTimerInterval) clearInterval(window.nextTimerInterval);
      window.nextTimerInterval = setInterval(() => {
        c--;
        $("#processTime").html(c);
        if (c <= 0) clearInterval(window.nextTimerInterval);
      }, 1000);
    } else if (b.action === "EXCLUDE_MODE_DISABLED") {
      disableExcludeMode(b.domain);
    }
    if (b.action === "EXCLUDED_ELEMENT_SAVED") loadSavedElements();
  }
});

function formatDuration(b) {
  b = Math.floor(b);
  const f = Math.floor(b / 3600), g = Math.floor(b % 3600 / 60);
  b %= 60;
  return f > 0 ? `${f} hr ${g} min ${b} sec` : g > 0 ? `${g} min ${b} sec` : `${b} sec`;
}

// Moved to top-level scope (was previously declared inside the
// DOMContentLoaded closure below) since the Excel export functions
// further down in this file also need it, and they're intentionally
// top-level like formatDuration above rather than nested inside that
// closure.
function h() {
  var a = new Date;
  const d = String(a.getDate()).padStart(2, "0"), k = a.toLocaleString("en-US", { month: "short" }), e = String(a.getFullYear()).slice(-2), w = String(a.getHours()).padStart(2, "0");
  a = String(a.getMinutes()).padStart(2, "0");
  return `${d}${k}${e}_${w}_${a}`;
}

document.addEventListener("DOMContentLoaded", () => {
  const m = document.getElementById("valid-links"), l = document.getElementById("valid-links-1");
  chrome.storage.local.get(["validColor"], a => {
    if (a.validColor) { m.value = a.validColor; l.style.background = a.validColor; }
    else { m.value = validColorCode; l.style.background = validColorCode; chrome.storage.local.set({ validColor: validColorCode }); }
  });
  m.addEventListener("input", a => { a = a.target.value; l.style.background = a; chrome.storage.local.set({ validColor: a }); });

  const p = document.getElementById("invalid-links"), q = document.getElementById("invalid-links-1");
  chrome.storage.local.get(["invalidColor"], a => {
    if (a.invalidColor) { p.value = a.invalidColor; q.style.background = a.invalidColor; }
    else { p.value = invalidColorCode; q.style.background = invalidColorCode; chrome.storage.local.set({ invalidColor: invalidColorCode }); }
  });
  p.addEventListener("input", a => { a = a.target.value; q.style.background = a; chrome.storage.local.set({ invalidColor: a }); });

  const r = document.getElementById("redirect-links"), t = document.getElementById("redirect-links-1");
  chrome.storage.local.get(["redirectColor"], a => {
    if (a.redirectColor) { r.value = a.redirectColor; t.style.background = a.redirectColor; }
    else { r.value = redirectColorCode; t.style.background = redirectColorCode; chrome.storage.local.set({ redirectColor: redirectColorCode }); }
  });
  r.addEventListener("input", a => { a = a.target.value; t.style.background = a; chrome.storage.local.set({ redirectColor: a }); });

  const u = document.getElementById("warnings-links"), v = document.getElementById("warnings-links-1");
  chrome.storage.local.get(["warningColor"], a => {
    if (a.warningColor) { u.value = a.warningColor; v.style.background = a.warningColor; }
    else { u.value = warningColorCode; v.style.background = warningColorCode; chrome.storage.local.set({ warningColor: warningColorCode }); }
  });
  u.addEventListener("input", a => { a = a.target.value; v.style.background = a; chrome.storage.local.set({ warningColor: a }); });

  $(document).on("click", ".close-all", function () { chrome.tabs.sendMessage(parseInt(tabId), { action: "removeAllDom" }); });
  $(document).on("click", ".reload-tab", function () { chrome.runtime.sendMessage({ action: "reloadTab" }); });
  $(document).on("click", "#left-arrow", function () {
    chrome.storage.local.set({ cPosition: "right" });
    $("#left-arrow").hide(); $("#right-arrow").show();
    chrome.tabs.sendMessage(parseInt(tabId), { action: "changePos", cPosition: "right" });
  });
  $(document).on("click", "#right-arrow", function () {
    chrome.storage.local.set({ cPosition: "left" });
    $("#left-arrow").show(); $("#right-arrow").hide();
    chrome.tabs.sendMessage(parseInt(tabId), { action: "changePos", cPosition: "left" });
  });

  // Move popup — was: allow ? moveThing() : (isLoggedIn ? profile : login).
  // No more login system, so this is always available now.
  $(document).on("click", "#move-icon", function () {
    $(".move-icon").toggleClass("active");
    chrome.tabs.sendMessage(parseInt(tabId), { action: "startMove" });
  });

  $(".close-btn img").hover(
    function () { $(this).attr("src", "../img/close-red.png"); },
    function () { $(this).attr("src", "../img/close.png"); }
  );

  $(document).on("click", "#clear-storage", function () {
    chrome.storage.local.set({ invalidColor: invalidColorCode });
    chrome.storage.local.set({ validColor: validColorCode });
    chrome.storage.local.set({ warningColor: warningColorCode });
    chrome.storage.local.set({ redirectColor: redirectColorCode });
    chrome.storage.local.set({ vt: true });
    chrome.storage.local.set({ rt: true });
    chrome.storage.local.set({ wt: true });
    chrome.storage.local.set({ it: true });
    $(".valid-checkbox").prop("checked", true);
    $(".invalid-checkbox").prop("checked", true);
    $(".warning-checkbox").prop("checked", true);
    $(".redirect-checkbox").prop("checked", true);
    $("#invalid-links").val(invalidColorCode); $("#invalid-links-1").css("background", invalidColorCode);
    $("#valid-links").val(validColorCode); $("#valid-links-1").css("background", validColorCode);
    $("#redirect-links").val(redirectColorCode); $("#redirect-links-1").css("background", redirectColorCode);
    $("#warning-links").val(warningColorCode); $("#warning-links-1").css("background", warningColorCode);
    chrome.storage.local.set({
      defaultOptions: {
        blacklist: "doubleclick.net\nchromewebstore.google.com\nchrome.google.com\nappliedsemantics.com",
        checkType: "GET", cache: "false", noFollow: "false", parseDOM: "false", trailingHash: "false",
        emptyLink: "false", noHrefAttr: "false", autoCheck: "false",
        optionsURL: "chrome-extension://" + chrome.runtime.id + "/options.html"
      }
    });
  });

  // --- Master "auto-highlight" toggle ---
  // Drives all four category flags (vt/it/rt/wt) together. Layered on top
  // of the four existing per-category checkboxes rather than replacing
  // them: turning highlighting off here still checks and counts every
  // link normally (the classesToRemove/_t-suffix mechanism in
  // contentScript.js already supported per-category on/off — this just
  // adds one control for "all four at once" instead of requiring four
  // separate clicks). The four checkboxes and this master stay in sync
  // in both directions: changing any one of them updates the master's
  // own checked state to reflect whether all four are currently on.
  // Declared here, before anything below references it, rather than
  // relying on function-declaration hoisting.
  const $autoHighlightToggle = $("#autoHighlightToggle");

  function syncAutoHighlightToggle() {
    const allOn = $(".valid-checkbox").is(":checked")
      && $(".invalid-checkbox").is(":checked")
      && $(".warning-checkbox").is(":checked")
      && $(".redirect-checkbox").is(":checked");
    $autoHighlightToggle.prop("checked", allOn);
  }

  $autoHighlightToggle.on("change", function () {
    const on = $(this).is(":checked");
    chrome.storage.local.set({ vt: on, it: on, rt: on, wt: on });
    $(".valid-checkbox").prop("checked", on);
    $(".invalid-checkbox").prop("checked", on);
    $(".warning-checkbox").prop("checked", on);
    $(".redirect-checkbox").prop("checked", on);
  });

  $(document).on("click", "#settings", function () { chrome.tabs.create({ url: chrome.runtime.getURL("tools/link-checker/pages/settings.html") }); });
  $(document).on("click", "#editRangeBtn", function () { chrome.tabs.create({ url: chrome.runtime.getURL("tools/link-checker/pages/settings.html?highlight=true") }); });
  $(document).on("click", ".export-only-redirect", function () { redirectUrls.length && chrome.runtime.sendMessage({ action: "links", data: redirectUrls, targetTab }); });
  $(document).on("click", ".export-only-valid", function () { validUrls.length && chrome.runtime.sendMessage({ action: "links", data: validUrls, targetTab }); });
  // Export invalid — was gated behind `allow`. Always available now.
  $(document).on("click", ".export-only-invalid", function () { invalidUrls.length && chrome.runtime.sendMessage({ action: "links", data: invalidUrls, targetTab }); });
  $(document).on("click", ".export-only-warning", function () { warningUrls.length && chrome.runtime.sendMessage({ action: "links", data: warningUrls, targetTab }); });
  $(document).on("click", "#view-all", function () {
    let a = validUrls.concat(invalidUrls, redirectUrls, warningUrls);
    a.length && chrome.runtime.sendMessage({ action: "links", data: a, targetTab });
  });

  $(document).on("click", ".all-export", function () {
    exportAllToExcel();
  });
  $(document).on("click", ".valid-down", function () { exportCategoryToExcel(validUrls, "Valid", "valid", false); });
  // Download invalid — was gated behind `allow`. Always available now.
  $(document).on("click", ".invalid-down", function () { exportCategoryToExcel(invalidUrls, "Invalid", "invalid", false); });
  $(document).on("click", ".redirect-down", function () { exportCategoryToExcel(redirectUrls, "Redirect", "valid_redirect", true); });
  $(document).on("click", ".warning-down", function () { exportCategoryToExcel(warningUrls, "Warning", "warning", true); });

  chrome.storage.local.get(["vt", "it", "rt", "wt", "cPosition"], a => {
    $(".valid-checkbox").prop("checked", a.vt);
    $(".invalid-checkbox").prop("checked", a.it);
    $(".warning-checkbox").prop("checked", a.wt);
    $(".redirect-checkbox").prop("checked", a.rt);
    if (typeof a.cPosition === "undefined") {
      chrome.storage.local.set({ cPosition: "left" });
      $("#left-arrow").show(); $("#right-arrow").hide();
    } else if (a.cPosition == "left") {
      $("#left-arrow").show(); $("#right-arrow").hide();
    } else {
      $("#left-arrow").hide(); $("#right-arrow").show();
    }
  });

  $(".valid-checkbox").change(function () { chrome.storage.local.set({ vt: $(this).is(":checked") }); syncAutoHighlightToggle(); });
  // Invalid-checkbox — was gated to force-checked when !allow. Always a normal toggle now.
  $(".invalid-checkbox").change(function () { chrome.storage.local.set({ it: $(this).is(":checked") }); syncAutoHighlightToggle(); });
  $(".warning-checkbox").change(function () { chrome.storage.local.set({ wt: $(this).is(":checked") }); syncAutoHighlightToggle(); });
  $(".redirect-checkbox").change(function () { chrome.storage.local.set({ rt: $(this).is(":checked") }); syncAutoHighlightToggle(); });

  // Reflect current state once the four checkboxes' own initial values
  // have loaded (chrome.storage.local.get above is async, so this needs
  // to run after that callback, not inline with the rest of this block).
  chrome.storage.local.get(["vt", "it", "rt", "wt"], () => syncAutoHighlightToggle());
});

// Excel export (report overlay's own buttons: Export All + the four
// per-row download icons). These were previously downloadCsv() calls
// producing plain .csv files with a "Status code, Url, Label" header —
// the exact same problem already fixed for links.html's Excel button:
// "Label" here is just the link's own visible text truncated to 20
// characters (see contentScript.js's urlObj construction), frequently
// non-Latin and not a meaningful field on its own. Rebuilt on the same
// MiniXlsx library and theme as links.html's export.
//
// Export All now produces one workbook with FOUR sheets (Valid,
// Redirect, Warning, Invalid) rather than two — this page already
// tracks those four categories separately (validUrls/redirectUrls/
// warningUrls/invalidUrls, matching the four colored status rows and
// their own checkboxes), so splitting only into two would throw away
// a distinction this exact page already makes. The four individual
// per-row buttons (.valid-down etc.) already download one category
// alone, so each produces a single-sheet workbook — there is nothing
// to split when the data is already filtered to one category.
function urlEntryToRow(entry) {
  // entry: [url, statusCode, truncatedLabel, warningsJoined?] — see
  // contentScript.js's urlObj construction. Label is dropped; the
  // optional 4th element (redirect/warning free-text notes) is kept
  // when present, since unlike Label it's genuinely informative and
  // isn't just truncated page text.
  const [url, status, , warnings] = entry;
  const row = [typeof status === "number" ? status : (isNaN(status) ? String(status) : Number(status)), url];
  if (warnings !== undefined) row.push(warnings);
  return row;
}

function urlEntriesToSheetRows(entries, includeWarningsColumn) {
  const headers = includeWarningsColumn ? ["Status code", "Url", "Notes"] : ["Status code", "Url"];
  return [headers, ...entries.map(urlEntryToRow)];
}

function downloadXlsxWorkbook(sheets, filename) {
  const bytes = MiniXlsx.buildXlsxMultiSheet(sheets);
  const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function exportAllToExcel() {
  const sheets = [
    { name: "Valid", rows: urlEntriesToSheetRows(validUrls, false), headerRowCount: 1 },
    { name: "Redirect", rows: urlEntriesToSheetRows(redirectUrls, true), headerRowCount: 1 },
    { name: "Warning", rows: urlEntriesToSheetRows(warningUrls, true), headerRowCount: 1 },
    { name: "Invalid", rows: urlEntriesToSheetRows(invalidUrls, false), headerRowCount: 1 }
  ].filter((s) => s.rows.length > 1); // drop sheets with no data rows beyond the header
  if (!sheets.length) return;
  downloadXlsxWorkbook(sheets, `CheckMyLinks_${h()}.xlsx`);
}

function exportCategoryToExcel(entries, sheetName, filenamePrefix, includeWarningsColumn) {
  if (!entries.length) return;
  const sheets = [{ name: sheetName, rows: urlEntriesToSheetRows(entries, includeWarningsColumn), headerRowCount: 1 }];
  downloadXlsxWorkbook(sheets, `CheckMyLinks_${filenamePrefix}_${h()}.xlsx`);
}

// BUG FIX (see file header): the original read
// document.getElementById("register_form").style.display and
// document.querySelector(".profile-tab").style.display, both of
// which are now null since that markup was removed. This version
// just reports the real height.
function sendHeight() {
  let b = document.body.scrollHeight;
  window.parent.postMessage({ type: "iframeHeight", height: b }, "*");
}
window.addEventListener("load", sendHeight);
(new MutationObserver(sendHeight)).observe(document.body, { childList: true, subtree: true });
