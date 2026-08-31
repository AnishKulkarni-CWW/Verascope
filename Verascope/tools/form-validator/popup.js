// ============================================================
// Tool 5: Form QA Automation — popup controller.
// Restored from the standalone "Form QA Automation" extension's
// own src/popup.js (this was a placeholder stub before — see the
// note it used to carry). IIFE-wrapped and pane-scoped like every
// other tool script sharing this document: every
// document.getElementById() from the original became
// pane.querySelector(), and the two injected-file paths in
// ensureContentScript() were updated from the standalone
// extension's flat src/ layout to this tool's nested
// tools/form-validator/ location (paths resolve against the
// EXTENSION ROOT, not this file's own folder). Everything else —
// scan/generate/run/export logic — is unchanged. window.
// FormValidatorTool.init() is a no-op: unlike Alt Text or NoCache,
// this tool has no persisted state to refresh when the tab is
// reopened, so all wiring below happens once at file load like
// the original.
// ============================================================
(function startPopup() {
  "use strict";

  const pane = document.querySelector('[data-tool-pane="form-validator"]');
  const $ = (id) => pane.querySelector('#' + id);
  const detectButton = $("detectButton"), statusElement = $("status");
  const dashboard = $("dashboard");
  const metricForms = $("metricForms"), metricFields = $("metricFields"), metricTests = $("metricTests"),
    metricExecuted = $("metricExecuted"), metricPassed = $("metricPassed"), metricFailed = $("metricFailed"),
    metricWarnings = $("metricWarnings");
  const categoryToggles = $("categoryToggles");
  const generateButton = $("generateButton"), runAllButton = $("runAllButton"), exportButton = $("exportButton"), clearButton = $("clearButton");
  const progress = $("progress"), progressText = $("progressText"), progressCount = $("progressCount"), progressBar = $("progressBar"), stopButton = $("stopButton");
  const fieldsElement = $("fields"), fieldTemplate = $("fieldTemplate");
  const resultsSection = $("resultsSection"), resultsBody = $("resultsBody");
  const searchInput = $("searchInput"), filterCategory = $("filterCategory"), filterResult = $("filterResult");
  const detailPanel = $("detailPanel"), detailBody = $("detailBody"), closeDetail = $("closeDetail");
  const modeBadge = $("modeBadge");

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------
  let activeTabId = null;
  let scanData = null;             // raw scan response { url, title, formsDetected, fields }
  let allFields = [];              // fields with .cases (each case tagged testType/severity)
  let enabledCategories = new Set(["Positive", "Negative", "Boundary", "Required", "Accessibility"]);
  let results = [];                // executed test result rows (see buildResultRow)
  let testCounter = 0;
  let stopRequested = false;
  let sortState = { key: "testId", dir: 1 };

  function setStatus(message, isError = false) {
    statusElement.textContent = message;
    statusElement.classList.toggle("error", isError);
  }

  function nextTestId() {
    testCounter += 1;
    return `TC-${String(testCounter).padStart(3, "0")}`;
  }

  function ruleLabels(field) {
    const labels = [`type: ${field.type}`, `semantic: ${field.semanticType || field.type}`];
    if (field.required) labels.push("required");
    if (field.min) labels.push(`min: ${field.min}`);
    if (field.max) labels.push(`max: ${field.max}`);
    if (field.step) labels.push(`step: ${field.step}`);
    if (field.minLength) labels.push(`minlength: ${field.minLength}`);
    if (field.maxLength) labels.push(`maxlength: ${field.maxLength}`);
    if (field.pattern) labels.push(`pattern: ${field.pattern}`);
    if (field.sensitive) labels.push("sensitive: skipped");
    if (field.formDestructive) labels.push("form: potentially destructive");
    return labels;
  }

  // ---------------------------------------------------------------------
  // Messaging helpers
  // ---------------------------------------------------------------------
  async function ensureContentScript(tabId) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["tools/form-validator/core.js", "tools/form-validator/content.js"] });
  }
  function sendMessage(tabId, message, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("TIMED_OUT"));
      }, timeoutMs);
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(response);
      });
    });
  }

  // ---------------------------------------------------------------------
  // Scan
  // ---------------------------------------------------------------------
  async function detectAndValidate() {
    detectButton.disabled = true;
    fieldsElement.replaceChildren();
    dashboard.hidden = true;
    resultsSection.hidden = true;
    detailPanel.hidden = true;
    progress.hidden = true;
    results = [];
    testCounter = 0;
    setStatus("Scanning the page for forms and fields…");
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error("No active tab is available.");
      if (!/^https?:|^file:/.test(tab.url || "")) throw new Error("Chrome internal pages cannot be scanned.");
      activeTabId = tab.id;
      await ensureContentScript(tab.id);
      const response = await sendMessage(tab.id, { type: "FORM_BOUNDARY_SCAN" });
      if (!response?.ok) throw new Error(response?.error || "The page could not be scanned.");
      scanData = response;
      allFields = response.fields;

      const totalCases = allFields.reduce((sum, field) => sum + field.cases.length, 0);
      setStatus(allFields.length ? "Scan complete. Review fields below, then Generate Tests." : "No supported visible form fields were found on this page.");
      dashboard.hidden = false;
      updateDashboard();
      metricTests.textContent = String(totalCases);

      if (allFields.length <= 200 || window.confirm(`This page has ${allFields.length} supported fields. Rendering them may be slow. Continue?`)) {
        renderFields(allFields);
      }
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      detectButton.disabled = false;
    }
  }

  function updateDashboard() {
    const totalCases = allFields.reduce((sum, field) => sum + field.cases.length, 0);
    metricForms.textContent = String(scanData?.formsDetected ?? "—");
    metricFields.textContent = String(allFields.length);
    metricTests.textContent = String(totalCases);
    metricExecuted.textContent = String(results.length);
    metricPassed.textContent = String(results.filter((r) => r.result === "PASS").length);
    metricFailed.textContent = String(results.filter((r) => r.result === "FAIL").length);
    metricWarnings.textContent = String(results.filter((r) => r.result === "WARNING").length);
  }

  // ---------------------------------------------------------------------
  // Field / case rendering
  // ---------------------------------------------------------------------
  function casePassesCategoryFilter(testCase) {
    return enabledCategories.has(testCase.testType);
  }

  function renderFields(fields) {
    fieldsElement.replaceChildren();
    fields.forEach((field) => {
      const fragment = fieldTemplate.content.cloneNode(true);
      fragment.querySelector(".field-label").textContent = field.label;
      fragment.querySelector(".field-meta").textContent = `${field.tagName} · ${field.name || "unnamed"} · form: ${field.formLabel}`;
      const visibleCases = field.cases.filter(casePassesCategoryFilter);
      fragment.querySelector(".case-count").textContent = `${visibleCases.length} cases`;
      const rulesElement = fragment.querySelector(".rules");
      ruleLabels(field).forEach((label) => { const tag = document.createElement("span"); tag.className = "rule"; tag.textContent = label; rulesElement.append(tag); });

      const runField = fragment.querySelector(".run-field");
      runField.disabled = visibleCases.length === 0;
      runField.addEventListener("click", () => runBatch([{ field, cases: visibleCases }]));

      const casesElement = fragment.querySelector(".cases");
      if (visibleCases.length === 0) {
        const empty = document.createElement("p"); empty.className = "field-meta";
        empty.textContent = field.sensitive ? "Sensitive field skipped." : "No cases match the enabled categories.";
        casesElement.append(empty);
      }
      visibleCases.forEach((testCase) => {
        const button = document.createElement("button");
        button.type = "button"; button.className = "case-button"; button.title = testCase.reason;
        const text = document.createElement("span"), label = document.createElement("span"), value = document.createElement("span"), typeTag = document.createElement("span");
        label.className = "case-label"; label.textContent = testCase.label;
        value.className = "case-value"; value.textContent = testCase.value === "" ? "(empty)" : testCase.value;
        text.append(label, value);
        typeTag.className = `expectation type-${testCase.testType.toLowerCase()}`;
        typeTag.textContent = testCase.testType;
        button.append(text, typeTag);
        button.addEventListener("click", async () => {
          button.disabled = true;
          try { await runBatch([{ field, cases: [testCase] }]); } finally { button.disabled = false; }
        });
        casesElement.append(button);
      });
      fieldsElement.append(fragment);
    });
  }

  // ---------------------------------------------------------------------
  // Result classification (PASS / FAIL / WARNING)
  // ---------------------------------------------------------------------
  // Rule: a test PASSES when the actual outcome matches what the test category expects.
  // Negative tests pass when invalid input is rejected; positive tests pass when valid
  // input is accepted; ambiguous/uncheckable outcomes are WARNING, never a silent PASS.
  function classifyResult(testCase, response) {
    if (!response?.ok) return { result: "WARNING", reason: response?.error || "Could not be executed." };
    if (testCase.isStaticAudit) return { result: response.actualValid ? "PASS" : "FAIL", reason: response.validationMessage };
    if (response.normalized) return { result: "WARNING", reason: "The framework normalized/rewrote the input before validation ran, so the result is not directly comparable to the requested value." };
    if (testCase.expectedValid === null || testCase.expectedValid === undefined) return { result: "WARNING", reason: "Expected outcome cannot be predicted reliably (e.g. an unparseable pattern)." };
    const matched = response.actualValid === Boolean(testCase.expectedValid);
    return { result: matched ? "PASS" : "FAIL", reason: response.validationMessage || "" };
  }

  function buildResultRow(testId, field, testCase, response) {
    const { result, reason } = classifyResult(testCase, response);
    return {
      testId,
      form: field.formLabel,
      field: field.label,
      fieldType: field.type,
      category: testCase.testType,
      description: testCase.label,
      input: testCase.value === "" ? "(empty)" : testCase.value,
      expected: testCase.expectedValid === true ? "valid" : testCase.expectedValid === false ? "invalid" : "unknown",
      actual: response?.ok ? (response.actualValid ? "valid" : "invalid") : "—",
      result,
      severity: result === "FAIL" ? testCase.severity : result === "WARNING" ? "Low" : "—",
      validationMessage: reason || "",
      elementInfo: `${field.tagName}${field.name ? `[name="${field.name}"]` : ""}${field.id ? `#${field.id}` : ""}`,
      url: scanData?.url || "",
      timestamp: new Date().toISOString()
    };
  }

  // ---------------------------------------------------------------------
  // Execution
  // ---------------------------------------------------------------------
  async function runBatch(groups) {
    if (!activeTabId) { setStatus("Scan a page first.", true); return; }
    const queue = groups.flatMap((group) => group.cases.map((testCase) => ({ field: group.field, testCase })));
    if (!queue.length) { setStatus("There are no cases to run for the selected categories.", true); return; }

    const anyValueChanging = queue.some((item) => !item.testCase.isStaticAudit);
    const anyDestructiveForm = queue.some((item) => item.field.formDestructive);
    if (anyValueChanging) {
      const warning = anyDestructiveForm
        ? "This form looks like it may perform a destructive or irreversible action (e.g. delete, purchase, unsubscribe). Safe Test Mode will still only change field values and dispatch input/change events — it will NOT click submit. Continue?"
        : "This will change values on the current page and trigger input/change events. The form will not be submitted. Continue?";
      if (!window.confirm(warning)) return;
    }

    stopRequested = false;
    setStatus("Running tests…");
    progress.hidden = false;
    progressBar.max = Math.max(queue.length, 1);
    progressBar.value = 0;
    stopButton.disabled = false;

    for (let index = 0; index < queue.length; index += 1) {
      if (stopRequested) break;
      const { field, testCase } = queue[index];
      progressText.textContent = `Testing: ${field.label} — ${testCase.testType}: ${testCase.label}`;
      progressCount.textContent = `${index + 1}/${queue.length}`;
      const testId = nextTestId();
      try {
        const response = await sendMessage(activeTabId, { type: "FORM_BOUNDARY_RUN", fieldId: field.fieldId, testCase });
        results.push(buildResultRow(testId, field, testCase, response));
      } catch (error) {
        const timedOut = error.message === "TIMED_OUT";
        results.push(buildResultRow(testId, field, testCase, { ok: false, error: timedOut ? "No response from the page (timed out)." : error.message }));
        if (!timedOut) {
          stopRequested = true;
          setStatus("The page changed or disconnected, so the run was stopped.", true);
          break;
        }
      }
      progressBar.value = index + 1;
      updateDashboard();
      renderResultsTable();
    }

    stopButton.disabled = true;
    progress.hidden = true;
    resultsSection.hidden = false;
    if (!statusElement.classList.contains("error")) {
      const failed = results.filter((r) => r.result === "FAIL").length;
      const warned = results.filter((r) => r.result === "WARNING").length;
      setStatus(stopRequested
        ? "Run stopped."
        : `${results.length} tests completed — ${results.length - failed - warned} passed, ${failed} failed, ${warned} warnings.`);
    }
  }

  function runAllEnabled() {
    if (!allFields.length) return;
    const groups = allFields
      .map((field) => ({ field, cases: field.cases.filter(casePassesCategoryFilter) }))
      .filter((group) => group.cases.length > 0);
    runBatch(groups);
  }

  // ---------------------------------------------------------------------
  // Results table: search / filter / sort / detail panel
  // ---------------------------------------------------------------------
  function filteredResults() {
    const query = searchInput.value.trim().toLowerCase();
    const category = filterCategory.value;
    const resultFilter = filterResult.value;
    return results.filter((row) => {
      if (category && row.category !== category) return false;
      if (resultFilter && row.result !== resultFilter) return false;
      if (query) {
        const haystack = `${row.field} ${row.input} ${row.validationMessage} ${row.testId}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
  }

  function sortRows(rows) {
    const { key, dir } = sortState;
    return [...rows].sort((a, b) => {
      const av = String(a[key] ?? ""), bv = String(b[key] ?? "");
      return av.localeCompare(bv) * dir;
    });
  }

  function renderResultsTable() {
    const rows = sortRows(filteredResults());
    resultsBody.replaceChildren();
    rows.forEach((row) => {
      const tr = document.createElement("tr");
      tr.className = `row-${row.result.toLowerCase()}`;
      tr.innerHTML = `
        <td>${row.testId}</td>
        <td>${escapeHtml(row.field)}</td>
        <td>${escapeHtml(row.category)}</td>
        <td class="mono">${escapeHtml(row.input)}</td>
        <td><span class="badge badge-${row.result.toLowerCase()}">${row.result}</span></td>
        <td>${row.severity !== "—" ? `<span class="sev sev-${row.severity.toLowerCase()}">${row.severity}</span>` : "—"}</td>
      `;
      tr.addEventListener("click", () => showDetail(row));
      resultsBody.append(tr);
    });
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }

  function showDetail(row) {
    detailPanel.hidden = false;
    detailBody.replaceChildren();
    const entries = [
      ["Test ID", row.testId],
      ["Field", row.field],
      ["Element", row.elementInfo],
      ["Category", row.category],
      ["Description", row.description],
      ["Input used", row.input],
      ["Expected", row.expected],
      ["Actual", row.actual],
      ["Result", row.result],
      ["Severity", row.severity],
      ["Validation message", row.validationMessage || "(none)"],
      ["Page URL", row.url],
      ["Timestamp", row.timestamp]
    ];
    entries.forEach(([term, value]) => {
      const dt = document.createElement("dt"); dt.textContent = term;
      const dd = document.createElement("dd"); dd.textContent = value;
      detailBody.append(dt, dd);
    });
    detailPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  closeDetail.addEventListener("click", () => { detailPanel.hidden = true; });
  searchInput.addEventListener("input", renderResultsTable);
  filterCategory.addEventListener("change", renderResultsTable);
  filterResult.addEventListener("change", renderResultsTable);
  pane.querySelectorAll("#resultsTable th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      sortState = sortState.key === key ? { key, dir: -sortState.dir } : { key, dir: 1 };
      renderResultsTable();
    });
  });

  // ---------------------------------------------------------------------
  // Category toggles
  // ---------------------------------------------------------------------
  categoryToggles.addEventListener("change", (event) => {
    const input = event.target.closest("input[data-category]");
    if (!input) return;
    if (input.checked) enabledCategories.add(input.dataset.category);
    else enabledCategories.delete(input.dataset.category);
    if (allFields.length) renderFields(allFields);
  });

  function regenerateTests() {
    if (!allFields.length) { setStatus("Scan a page first.", true); return; }
    renderFields(allFields);
    const totalCases = allFields.reduce((sum, field) => sum + field.cases.filter(casePassesCategoryFilter).length, 0);
    metricTests.textContent = String(totalCases);
    setStatus(`Generated ${totalCases} test cases across ${enabledCategories.size} enabled categories.`);
  }

  function clearResults() {
    results = [];
    testCounter = 0;
    resultsBody.replaceChildren();
    resultsSection.hidden = true;
    detailPanel.hidden = true;
    updateDashboard();
    setStatus("Results cleared.");
  }

  // ---------------------------------------------------------------------
  // Excel export ("Extract Report")
  // ---------------------------------------------------------------------
  function pad2(n) { return String(n).padStart(2, "0"); }

  function buildReportWorkbook() {
    const total = results.length;
    const passed = results.filter((r) => r.result === "PASS").length;
    const failed = results.filter((r) => r.result === "FAIL").length;
    const warnings = results.filter((r) => r.result === "WARNING").length;
    const now = new Date();

    const categories = ["Positive", "Negative", "Boundary", "Required", "Accessibility"];
    const categoryStats = categories.map((cat) => {
      const rows = results.filter((r) => r.category === cat);
      const p = rows.filter((r) => r.result === "PASS").length;
      const f = rows.filter((r) => r.result === "FAIL").length;
      const w = rows.filter((r) => r.result === "WARNING").length;
      return { cat, total: rows.length, p, f, w };
    });

    // ---- Sheet 1: QA Summary ----
    const summaryRows = [];
    summaryRows.push([{ value: "Form QA Automation Report", style: "title" }, { style: "title" }, { style: "title" }, { style: "title" }]);
    summaryRows.push([{ value: `Generated by Form QA Automation · ${now.toISOString()}`, style: "subtitle" }, { style: "subtitle" }, { style: "subtitle" }, { style: "subtitle" }]);
    summaryRows.push([]);
    summaryRows.push([{ value: "Website URL", style: "metricLabel" }, { value: scanData?.url || "", style: "cell" }, {}, {}]);
    summaryRows.push([{ value: "Page Title", style: "metricLabel" }, { value: scanData?.title || "", style: "cell" }, {}, {}]);
    summaryRows.push([{ value: "Test Date", style: "metricLabel" }, { value: now.toLocaleString(), style: "cell" }, {}, {}]);
    summaryRows.push([{ value: "Total Forms", style: "metricLabel" }, { value: scanData?.formsDetected ?? 0, style: "number" }, {}, {}]);
    summaryRows.push([{ value: "Total Fields", style: "metricLabel" }, { value: allFields.length, style: "number" }, {}, {}]);
    summaryRows.push([]);
    const summaryHeaderRow = summaryRows.length + 1;
    summaryRows.push([{ value: "METRIC", style: "tableHeader" }, { value: "VALUE", style: "tableHeader" }, {}, {}]);
    const totalRow = summaryRows.length + 1;
    summaryRows.push([{ value: "Total Tests", style: "label" }, { value: total, style: "metricValue" }]);
    const passedRow = summaryRows.length + 1;
    summaryRows.push([{ value: "Passed", style: "label" }, { value: passed, style: "metricValuePass" }]);
    const failedRow = summaryRows.length + 1;
    summaryRows.push([{ value: "Failed", style: "label" }, { value: failed, style: "metricValueFail" }]);
    const warnRow = summaryRows.length + 1;
    summaryRows.push([{ value: "Warnings", style: "label" }, { value: warnings, style: "metricValueWarn" }]);
    summaryRows.push([{ value: "Pass Rate", style: "label" }, { formula: `IF(B${totalRow}=0,0,B${passedRow}/B${totalRow})`, style: "percentBold" }]);
    summaryRows.push([]);
    summaryRows.push([{ value: "Category Summary", style: "sectionHeader" }, { style: "sectionHeader" }, { style: "sectionHeader" }, { style: "sectionHeader" }, { style: "sectionHeader" }]);
    summaryRows.push([{ value: "Category", style: "tableHeader" }, { value: "Total", style: "tableHeader" }, { value: "Passed", style: "tableHeader" }, { value: "Failed", style: "tableHeader" }, { value: "Pass Rate", style: "tableHeader" }]);
    categoryStats.forEach((stat) => {
      const rowNum = summaryRows.length + 1;
      summaryRows.push([
        { value: stat.cat, style: "cell" },
        { value: stat.total, style: "number" },
        { value: stat.p, style: "number" },
        { value: stat.f, style: "number" },
        { formula: `IF(B${rowNum}=0,0,C${rowNum}/B${rowNum})`, style: "percent" }
      ]);
    });

    // ---- Sheet 2: Test Results ----
    const resultHeaders = ["Test ID", "Form", "Field", "Field Type", "Category", "Description", "Input", "Expected Result", "Actual Result", "Result", "Severity", "Validation Message", "URL", "Timestamp"];
    const resultRows = [resultHeaders.map((h) => ({ value: h, style: "tableHeader" }))];
    results.forEach((row) => {
      const resultStyle = row.result === "PASS" ? "pass" : row.result === "FAIL" ? "fail" : "warning";
      const severityStyle = row.severity === "High" ? "severityHigh" : row.severity === "Medium" ? "severityMedium" : row.severity === "Low" ? "severityLow" : "cellCenter";
      resultRows.push([
        { value: row.testId, style: "cellCenter" },
        { value: row.form, style: "cell" },
        { value: row.field, style: "cell" },
        { value: row.fieldType, style: "cellCenter" },
        { value: row.category, style: "cellCenter" },
        { value: row.description, style: "cell" },
        { value: row.input, style: "cellMono" },
        { value: row.expected, style: "cellCenter" },
        { value: row.actual, style: "cellCenter" },
        { value: row.result, style: resultStyle },
        { value: row.severity, style: severityStyle },
        { value: row.validationMessage, style: "cell" },
        { value: row.url, style: "cellMono" },
        { value: row.timestamp, style: "cellMono" }
      ]);
    });

    // ---- Sheet 3: Failed Tests ----
    const failedHeaders = ["Test ID", "Field", "Category", "Input", "Expected", "Actual", "Severity", "Validation Message", "URL", "Timestamp"];
    const failedRows = [failedHeaders.map((h) => ({ value: h, style: "tableHeader" }))];
    results.filter((r) => r.result === "FAIL").forEach((row) => {
      const severityStyle = row.severity === "High" ? "severityHigh" : row.severity === "Medium" ? "severityMedium" : "severityLow";
      failedRows.push([
        { value: row.testId, style: "cellCenter" },
        { value: row.field, style: "cell" },
        { value: row.category, style: "cellCenter" },
        { value: row.input, style: "cellMono" },
        { value: row.expected, style: "cellCenter" },
        { value: row.actual, style: "cellCenter" },
        { value: row.severity, style: severityStyle },
        { value: row.validationMessage, style: "cell" },
        { value: row.url, style: "cellMono" },
        { value: row.timestamp, style: "cellMono" }
      ]);
    });
    if (failedRows.length === 1) failedRows.push([{ value: "No failed tests recorded.", style: "note" }]);

    // ---- Sheet 4: Field Inventory ----
    const inventoryHeaders = ["Form", "Field", "Type", "Name", "ID", "Required", "Min Length", "Max Length", "Min", "Max", "Pattern", "Placeholder", "Autocomplete", "ARIA Info"];
    const inventoryRows = [inventoryHeaders.map((h) => ({ value: h, style: "tableHeader" }))];
    allFields.forEach((field) => {
      const aria = field.accessibility
        ? `name:${field.accessibility.hasAccessibleName ? "yes" : "no"}; aria-invalid:${field.accessibility.ariaInvalidAttr || "none"}; describedby:${field.accessibility.hasAriaDescribedby ? "yes" : "no"}`
        : "";
      inventoryRows.push([
        { value: field.formLabel, style: "cell" },
        { value: field.label, style: "cell" },
        { value: field.type, style: "cellCenter" },
        { value: field.name, style: "cellMono" },
        { value: field.id, style: "cellMono" },
        { value: field.required ? "Yes" : "No", style: "cellCenter" },
        { value: field.minLength, style: "cellCenter" },
        { value: field.maxLength, style: "cellCenter" },
        { value: field.min, style: "cellCenter" },
        { value: field.max, style: "cellCenter" },
        { value: field.pattern, style: "cellMono" },
        { value: field.placeholder, style: "cell" },
        { value: field.autocomplete, style: "cellMono" },
        { value: aria, style: "cell" }
      ]);
    });

    // ---- Sheet 5: Test Coverage ----
    const coverageHeaders = ["Field Type", "Positive", "Negative", "Boundary", "Required", "Accessibility", "Total"];
    const coverageRows = [coverageHeaders.map((h) => ({ value: h, style: "tableHeader" }))];
    const byType = new Map();
    results.forEach((row) => {
      const key = row.fieldType || "unknown";
      if (!byType.has(key)) byType.set(key, { Positive: 0, Negative: 0, Boundary: 0, Required: 0, Accessibility: 0 });
      const bucket = byType.get(key);
      if (bucket[row.category] !== undefined) bucket[row.category] += 1;
    });
    Array.from(byType.entries()).sort((a, b) => a[0].localeCompare(b[0])).forEach(([type, bucket]) => {
      const rowNum = coverageRows.length + 1;
      coverageRows.push([
        { value: type, style: "cellCenter" },
        { value: bucket.Positive, style: "number" },
        { value: bucket.Negative, style: "number" },
        { value: bucket.Boundary, style: "number" },
        { value: bucket.Required, style: "number" },
        { value: bucket.Accessibility, style: "number" },
        { formula: `SUM(B${rowNum}:F${rowNum})`, style: "number" }
      ]);
    });
    if (coverageRows.length === 1) coverageRows.push([{ value: "No tests executed yet.", style: "note" }]);

    const sheets = [
      { name: "QA Summary", columns: [{ width: 22 }, { width: 26 }, { width: 14 }, { width: 14 }, { width: 14 }], freeze: { row: summaryHeaderRow, col: 0 }, merges: ["A1:D1", "A2:D2"], rows: summaryRows },
      { name: "Test Results", columns: [{ width: 10 }, { width: 16 }, { width: 18 }, { width: 12 }, { width: 13 }, { width: 26 }, { width: 18 }, { width: 12 }, { width: 12 }, { width: 10 }, { width: 10 }, { width: 30 }, { width: 26 }, { width: 20 }], freeze: { row: 1, col: 0 }, autofilter: `A1:N${resultRows.length}`, rows: resultRows },
      { name: "Failed Tests", columns: [{ width: 10 }, { width: 18 }, { width: 13 }, { width: 18 }, { width: 12 }, { width: 12 }, { width: 10 }, { width: 30 }, { width: 26 }, { width: 20 }], freeze: { row: 1, col: 0 }, autofilter: `A1:J${failedRows.length}`, rows: failedRows },
      { name: "Field Inventory", columns: [{ width: 16 }, { width: 18 }, { width: 10 }, { width: 16 }, { width: 14 }, { width: 10 }, { width: 10 }, { width: 10 }, { width: 8 }, { width: 8 }, { width: 16 }, { width: 18 }, { width: 14 }, { width: 34 }], freeze: { row: 1, col: 0 }, autofilter: `A1:N${inventoryRows.length}`, rows: inventoryRows },
      { name: "Test Coverage", columns: [{ width: 14 }, { width: 10 }, { width: 10 }, { width: 10 }, { width: 10 }, { width: 13 }, { width: 10 }], freeze: { row: 1, col: 0 }, autofilter: `A1:G${coverageRows.length}`, rows: coverageRows }
    ];

    return MiniXlsx.buildWorkbook({ sheets });
  }

  function extractReport() {
    if (!results.length) { setStatus("Run at least one test before extracting a report.", true); return; }
    try {
      const bytes = buildReportWorkbook();
      const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const now = new Date();
      const stamp = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}_${pad2(now.getHours())}-${pad2(now.getMinutes())}`;
      a.href = url;
      a.download = `Form_QA_Report_${stamp}.xlsx`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      setStatus("Report exported to Excel.");
    } catch (error) {
      setStatus(`Could not build the report: ${error.message}`, true);
    }
  }

  // ---------------------------------------------------------------------
  // Wire up
  // ---------------------------------------------------------------------
  detectButton.addEventListener("click", detectAndValidate);
  generateButton.addEventListener("click", regenerateTests);
  runAllButton.addEventListener("click", runAllEnabled);
  exportButton.addEventListener("click", extractReport);
  clearButton.addEventListener("click", clearResults);
  stopButton.addEventListener("click", () => { stopRequested = true; });

  // Safe Test Mode is always on: the badge simply communicates this. Value-changing
  // batch runs always show a confirmation dialog (see runBatch) before touching the page.
  modeBadge.textContent = "Safe Mode";

  window.FormValidatorTool = {
    init() {
      // No persisted state to refresh on tab-open — everything above is
      // wired once at load, matching the standalone extension's own
      // behavior (it had no multi-tab popup to reopen into).
    }
  };
})();
