// ============================================================
// Tool 4: NoCache URL Opener
// Wrapped in an IIFE for scope isolation from the other three
// tools' popup scripts sharing this document (same pattern as
// meta-inspector.js / alt-text.js / link-extractor.js). All
// getElementById() calls from the original standalone script
// are scoped to this tool's own pane via pane.querySelector(),
// even though none of this tool's ids currently collide with
// the other three tools — cheap insurance against a future
// 5th tool reusing a generic id like "result" or "status".
// Core logic (generateRandomString, isValidUrl, addNoCache) is
// unchanged from the original extension.
// ============================================================
(function () {
  const pane = document.querySelector('[data-tool-pane="nocache"]');

  const nocacheCountInput = pane.querySelector('#nocacheCount');
  const urlCountEl        = pane.querySelector('#urlCount');
  const urlsTextarea      = pane.querySelector('#urls');
  const warningEl         = pane.querySelector('#warning');
  const openBtn           = pane.querySelector('#openBtn');
  const resultEl          = pane.querySelector('#result');

  function generateRandomString() {

      const chars =
          "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

      const length =
          Math.floor(Math.random() * 5) + 6;

      let result = "";

      for (let i = 0; i < length; i++) {

          result += chars.charAt(
              Math.floor(Math.random() * chars.length)
          );
      }

      return result;
  }

  function isValidUrl(url) {

      // Must start with https:// and have .html right before
      // an optional query string / end of string.
      return /^https:\/\/.+\.html(\?.*)?$/i.test(url);
  }

  function addNoCache(url, count) {

      // count === 0 -> return the URL completely unchanged
      if (count === 0) {

          return url;
      }

      const nocachePart =
          ".nocache".repeat(count);

      if (/\.html(\?|$)/i.test(url)) {

          url = url.replace(
              /\.html/i,
              `${nocachePart}.html`
          );
      }

      const randomString =
          generateRandomString();

      if (url.includes("?")) {

          url += "&" + randomString;
      }
      else {

          url += "?" + randomString;
      }

      return url;
  }

  function updateUrlCount() {

      const urls =
          urlsTextarea
          .value
          .split("\n")
          .filter(
              x => x.trim()
          );

      urlCountEl
          .innerText =
          urls.length;

      if (urls.length > 20) {

          warningEl.style.display =
              "block";

          warningEl.innerHTML =
              `⚠ You are about to open ${urls.length} tabs.`;
      }
      else {

          warningEl.style.display =
              "none";
      }
  }

  function showValidationError(invalidUrls) {

      warningEl.style.display =
          "block";

      warningEl.innerHTML =
          `<span style="color:#ef4444; font-weight:700;">` +
          `URL Incorrect` +
          `</span>` +
          `<br>` +
          `Please insert URL in this format: ` +
          `<b>https://example.com/page.html</b>`;
  }

  urlsTextarea
      .addEventListener(
          "input",
          updateUrlCount
      );

  openBtn
      .addEventListener(
          "click",
          () => {

              const count =
                  parseInt(
                      nocacheCountInput.value
                  );

              const safeCount =
                  isNaN(count) || count < 0
                      ? 1
                      : count;

              const urls =
                  urlsTextarea
                  .value
                  .split("\n")
                  .map(
                      u => u.trim()
                  )
                  .filter(
                      u => u
                  );

              if (!urls.length) {

                  alert(
                      "Please enter at least one URL."
                  );

                  return;
              }

              const invalidUrls =
                  urls.filter(
                      u => !isValidUrl(u)
                  );

              if (invalidUrls.length) {

                  showValidationError(
                      invalidUrls
                  );

                  resultEl
                      .innerText =
                      "";

                  return;
              }

              // All URLs valid — clear any previous warning
              warningEl.style.display =
                  "none";

              urls.forEach(url => {

                  chrome.tabs.create({
                      url:
                          addNoCache(
                              url,
                              safeCount
                          )
                  });

              });

              resultEl
                  .innerText =
                  `✓ Opened ${urls.length} URL(s) successfully`;
          }
      );

  window.NoCacheTool = {
    init() {
      // Refresh the URL count / warning banner every time this tab is
      // opened, in case the user pasted text via another route or the
      // textarea content changed while a different popup tab was active.
      updateUrlCount();
    }
  };
})();
