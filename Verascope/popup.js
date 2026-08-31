// ============================================================
// Shell: tab switching + one-time per-tool init().
// New code — none of the three original extensions had a
// multi-tab popup, so there was no existing controller to
// preserve here.
// ============================================================
(function () {
  const tabs = document.querySelectorAll('.shell-tab');
  const panes = document.querySelectorAll('.shell-pane');

  // Meta Inspector's tool script (meta-inspector.js) wires its own
  // button listeners immediately on load and needs no init() call —
  // it has no state to sync on tab-open, unlike the other two tools.
  // Glyphscope's own popup.js also calls its init() unconditionally
  // at the bottom of its own script (matching the original
  // extension's own on-load behavior exactly), so it's marked
  // initialized: true for the same reason Meta Inspector is —
  // otherwise the shell would call GlyphscopeTool.init() a second,
  // redundant time the moment the person first opens that tab.
  const initialized = { 'meta-inspector': true, 'alt-text': false, 'link-extractor': false, 'nocache': false, 'form-validator': false, 'link-checker': false, 'glyphscope': true };

  function activate(toolName) {
    tabs.forEach(tab => {
      const isMatch = tab.dataset.tool === toolName;
      tab.classList.toggle('active', isMatch);
      tab.setAttribute('aria-selected', isMatch ? 'true' : 'false');
    });
    panes.forEach(pane => {
      pane.classList.toggle('active', pane.dataset.toolPane === toolName);
    });

    if (!initialized[toolName]) {
      if (toolName === 'alt-text' && window.AltTextTool) {
        window.AltTextTool.init();
      } else if (toolName === 'link-extractor' && window.LinkExtractorTool) {
        window.LinkExtractorTool.init();
      } else if (toolName === 'nocache' && window.NoCacheTool) {
        window.NoCacheTool.init();
      } else if (toolName === 'form-validator' && window.FormValidatorTool) {
        window.FormValidatorTool.init();
      } else if (toolName === 'link-checker' && window.LinkCheckerTool) {
        window.LinkCheckerTool.init();
      } else if (toolName === 'glyphscope' && window.GlyphscopeTool) {
        window.GlyphscopeTool.init();
      }
      initialized[toolName] = true;
    }
  }

  tabs.forEach(tab => {
    tab.addEventListener('click', () => activate(tab.dataset.tool));
  });

  // Meta Inspector is the default active tab (matches the markup's
  // initial `active` classes), so nothing else needs to fire on load.
})();
