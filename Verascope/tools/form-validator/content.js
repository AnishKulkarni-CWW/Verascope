// ============================================================
// Tool 5: Form QA Automation — content script.
// Restored from the standalone "Form QA Automation" extension's
// own src/content.js (this file was entirely missing from the
// repo — see the note that used to live in this tool's popup.js
// placeholder). Injected on demand by popup.js via
// chrome.scripting.executeScript, the same pattern Alt Text uses
// for its own content script.
//
// REQUIRED/ARIA FIX: descriptor.required now also treats
// aria-required="true" as a real "this is required" signal (not
// just the native `required` attribute), and a new
// descriptor.requirementUnknown flag tells core.js's "left
// unchecked" checkbox/radio case whether required-ness could be
// confirmed at all from the page's own markup. This is what the
// newer core.js already shipped in this repo (see its "radio"
// case) expects from describeField() — the version of this file
// that used to ship alongside it never made it into this repo, so
// this rebuild adds exactly the fields that newer core.js reads.
// Every other line below is unchanged from the standalone
// extension's content.js.
// ============================================================
(function installFieldTestContent() {
  "use strict";

  if (window.__fieldTestInstalled) return;
  window.__fieldTestInstalled = true;

  const SUPPORTED_SELECTOR = [
    "input:not([type='hidden']):not([type='submit']):not([type='button']):not([type='reset']):not([type='image']):not([type='file']):not([type='password'])",
    "textarea",
    "select"
  ].join(",");
  const SENSITIVE = /(?:card|credit|cvv|cvc|ssn|social.?security|身份证|银行卡|信用卡|护照|passport)/i;
  const LENGTH_INPUT_TYPES = new Set(["text", "search", "tel", "url", "email"]);
  // Heuristics for flagging a form as potentially destructive/irreversible so the popup
  // can require an explicit confirmation before running any case against its fields
  // (Safe Test Mode). We never block scanning/inspection — only execution.
  const DESTRUCTIVE_HINTS = /(delete|remove|cancel|unsubscribe|purchase|buy.?now|checkout|payment|donate|transfer|wire|send.?money|close.?account|deactivate)/i;
  let fieldElements = new Map();
  let lastScanSignature = "";

  function isFormPotentiallyDestructive(form) {
    if (!form) return false;
    const haystack = [
      form.getAttribute("name"), form.getAttribute("id"), form.getAttribute("action"),
      form.textContent ? form.textContent.slice(0, 500) : ""
    ].filter(Boolean).join(" ");
    return DESTRUCTIVE_HINTS.test(haystack);
  }

  function isVisible(element) {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && rect.width > 0 && rect.height > 0;
  }

  function fieldLabel(element, index) {
    const labels = element.labels ? Array.from(element.labels).map((item) => item.textContent.trim()).filter(Boolean) : [];
    return labels.join(" / ") || element.getAttribute("aria-label") || element.getAttribute("placeholder") || element.getAttribute("name") || element.id || `Field ${index + 1}`;
  }

  function locatorFor(element, index) {
    if (element.id) return { strategy: "id", value: element.id };
    if (element.name) return { strategy: "name", value: element.name, tagName: element.tagName.toLowerCase(), type: element.type || "" };
    return { strategy: "index", value: index, tagName: element.tagName.toLowerCase(), type: element.type || "" };
  }

  function formLabelFor(element) {
    const form = element.form;
    if (!form) return "(no parent form)";
    return form.getAttribute("name") || form.getAttribute("id") || form.getAttribute("action") || "Unnamed form";
  }

  function describeField(element, index) {
    const tagName = element.tagName.toLowerCase();
    const type = tagName === "input" ? (element.type || "text").toLowerCase() : tagName;
    const label = fieldLabel(element, index);
    const sensitiveText = [label, element.name, element.id, element.autocomplete].filter(Boolean).join(" ");
    const ariaRequired = element.getAttribute("aria-required") === "true";
    const descriptor = {
      fieldId: `fb-${index}`,
      formLabel: formLabelFor(element),
      formDestructive: isFormPotentiallyDestructive(element.form),
      locator: locatorFor(element, index),
      tagName,
      type,
      label,
      name: element.name || "",
      id: element.id || "",
      placeholder: element.getAttribute("placeholder") || "",
      autocomplete: element.getAttribute("autocomplete") || "",
      // Treat aria-required="true" as an equally authoritative signal
      // alongside the native required attribute -- see file header.
      required: Boolean(element.required) || ariaRequired,
      requirementUnknown: !Boolean(element.required) && !ariaRequired,
      disabled: Boolean(element.disabled),
      readOnly: Boolean(element.readOnly),
      sensitive: SENSITIVE.test(sensitiveText),
      min: element.getAttribute("min") || "",
      max: element.getAttribute("max") || "",
      step: element.getAttribute("step") || "",
      minLength: element.getAttribute("minlength") || "",
      maxLength: element.getAttribute("maxlength") || "",
      pattern: element.getAttribute("pattern") || "",
      options: tagName === "select" ? Array.from(element.options).map((option) => ({ label: option.textContent.trim(), value: option.value, disabled: option.disabled })) : []
    };
    descriptor.semanticType = window.FieldTestCore.inferSemanticType(descriptor);
    descriptor.accessibility = auditAccessibility(element, descriptor);
    return descriptor;
  }

  // Static accessibility audit: does the field have an accessible name, is it
  // correctly associated with a <label>, and is ARIA error-wiring present?
  // This does not change any value — it inspects the DOM as authored.
  function auditAccessibility(element, descriptor) {
    const hasLabelElement = Boolean(element.labels && element.labels.length > 0);
    const hasAriaLabel = Boolean(element.getAttribute("aria-label"));
    const hasAriaLabelledby = Boolean(element.getAttribute("aria-labelledby"));
    const hasAccessibleName = hasLabelElement || hasAriaLabel || hasAriaLabelledby;
    const hasAriaDescribedby = Boolean(element.getAttribute("aria-describedby"));
    const ariaInvalidAttr = element.getAttribute("aria-invalid");
    const issues = [];
    if (!hasAccessibleName) issues.push("No accessible name: missing <label>, aria-label, or aria-labelledby.");
    if (descriptor.required && !element.getAttribute("aria-required") && !element.required) issues.push("Required field is not exposed as required to assistive technology.");
    if (element.placeholder && !hasAccessibleName) issues.push("Relies on placeholder text as the only label, which disappears on input and is not a substitute for a real label.");
    return {
      hasAccessibleName,
      hasLabelElement,
      hasAriaLabel,
      hasAriaLabelledby,
      hasAriaDescribedby,
      ariaInvalidAttr: ariaInvalidAttr || null,
      issues
    };
  }

  function scanFields() {
    fieldElements = new Map();
    const fields = Array.from(document.querySelectorAll(SUPPORTED_SELECTOR))
      .filter((element) => !element.disabled && !element.readOnly && isVisible(element))
      .map((element, index) => {
        const descriptor = describeField(element, index);
        fieldElements.set(descriptor.fieldId, element);
        return { ...descriptor, cases: window.FieldTestCore.generateCases(descriptor) };
      });
    lastScanSignature = fields.map((f) => f.fieldId + f.type + f.name).join("|");
    return fields;
  }

  // Counts distinct <form> elements that contain at least one supported field, plus
  // (if any supported fields exist with no parent form) one bucket for "unassociated" fields.
  function countForms() {
    const elements = Array.from(document.querySelectorAll(SUPPORTED_SELECTOR));
    const forms = new Set();
    let hasUnassociated = false;
    elements.forEach((element) => { if (element.form) forms.add(element.form); else hasUnassociated = true; });
    return forms.size + (hasUnassociated ? 1 : 0);
  }

  // Lightweight, on-demand check for whether the page's form structure changed since
  // the last scan (used by the popup to offer a "forms changed, rescan?" prompt for
  // dynamically loaded / SPA / modal forms rather than running a persistent observer,
  // which would need the extension to inject long-lived listeners on every page).
  function hasFormsChangedSinceLastScan() {
    const current = Array.from(document.querySelectorAll(SUPPORTED_SELECTOR))
      .filter((element) => !element.disabled && !element.readOnly && isVisible(element));
    const signature = current.map((element, index) => `fb-${index}${(element.tagName || "").toLowerCase()}${element.name || ""}`).join("|");
    return signature !== lastScanSignature;
  }

  function setNativeValue(element, value) {
    if (element instanceof HTMLInputElement) {
      if (element.type === "checkbox" || element.type === "radio") {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked").set.call(element, value === "true");
      } else {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(element, value);
      }
      return;
    }
    if (element instanceof HTMLTextAreaElement) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(element, value);
      return;
    }
    if (element instanceof HTMLSelectElement) Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(element, value);
  }

  function settle() {
    return new Promise((resolve) => window.setTimeout(() => window.setTimeout(resolve, 0), 0));
  }

  function evaluateProgrammaticConstraints(element, actualValue) {
    const type = (element.type || "").toLowerCase();
    const supportsLength = element instanceof HTMLTextAreaElement || (element instanceof HTMLInputElement && LENGTH_INPUT_TYPES.has(type));
    if (!supportsLength) return { valid: true, issues: [] };
    const length = window.FieldTestCore.evaluateLength(actualValue, {
      minLength: element.getAttribute("minlength") || "",
      maxLength: element.getAttribute("maxlength") || ""
    });
    if (length.valid) return { valid: true, issues: [] };
    const message = length.code === "tooShort"
      ? `Length ${length.actualLength} is below minlength ${length.limit}.`
      : `Length ${length.actualLength} exceeds maxlength ${length.limit}.`;
    return { valid: false, issues: [{ ...length, message }] };
  }

  // Accessibility cases are a static audit, not a value-changing interaction: running
  // one never touches the field's value, so it's always safe even in Safe Test Mode.
  function runAccessibilityCase(element) {
    const descriptor = describeField(element, 0);
    const audit = descriptor.accessibility;
    const actualValid = audit.issues.length === 0;
    const verdict = actualValid ? "matched" : "mismatch";
    return {
      ok: true,
      startedAt: new Date().toISOString(),
      actualValid,
      actualValue: "(no value change)",
      requestedValue: "(no value change)",
      expectedValid: true,
      matchedExpectation: actualValid,
      verdict,
      normalized: false,
      nativeValid: actualValid,
      validationSource: "static-audit",
      constraintIssues: [],
      validationMessage: audit.issues.join(" ") || "Accessible name, label association, and required/ARIA wiring look correct.",
      label: fieldLabel(element, 0)
    };
  }

  async function runCase(fieldId, testCase) {
    const element = fieldElements.get(fieldId);
    if (!element || !element.isConnected) return { ok: false, error: "FIELD_MISSING" };
    if (testCase.isStaticAudit) return runAccessibilityCase(element);

    const originalOutline = element.style.outline;
    const requestedValue = String(testCase.value);
    try {
      element.focus({ preventScroll: true });
      setNativeValue(element, requestedValue);
      element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      element.blur();
      await settle();

      const actualValue = element.type === "checkbox" || element.type === "radio" ? String(element.checked) : element.value;
      const nativeValid = element.checkValidity();
      const computedConstraints = evaluateProgrammaticConstraints(element, actualValue);
      const actualValid = nativeValid && computedConstraints.valid;
      const normalized = actualValue !== requestedValue;
      let verdict = "unknown";
      if (!normalized && testCase.expectedValid !== null && testCase.expectedValid !== undefined) verdict = actualValid === Boolean(testCase.expectedValid) ? "matched" : "mismatch";

      // Cross-check ARIA error wiring: if the field is now invalid, well-built forms
      // typically reflect that via aria-invalid="true" for assistive technology.
      const ariaInvalidNow = element.getAttribute("aria-invalid");
      const ariaReflectsInvalid = actualValid ? true : ariaInvalidNow === "true";

      element.scrollIntoView({ behavior: "smooth", block: "center" });
      element.style.outline = verdict === "matched" ? "3px solid #1f9d55" : verdict === "mismatch" ? "3px solid #dc3545" : "3px solid #d97706";
      window.setTimeout(() => { element.style.outline = originalOutline; }, 1800);

      return {
        ok: true,
        startedAt: new Date().toISOString(),
        actualValid,
        actualValue,
        requestedValue,
        expectedValid: testCase.expectedValid,
        matchedExpectation: verdict === "matched" ? true : verdict === "mismatch" ? false : null,
        verdict,
        normalized,
        nativeValid,
        ariaReflectsInvalid,
        validationSource: computedConstraints.valid ? "native" : "native+computed-length",
        constraintIssues: computedConstraints.issues,
        validationMessage: [element.validationMessage, ...computedConstraints.issues.map((issue) => issue.message)].filter(Boolean).join(" "),
        label: fieldLabel(element, 0)
      };
    } catch (error) {
      element.style.outline = originalOutline;
      return { ok: false, error: "EXECUTION_FAILED", detail: error instanceof Error ? error.message : String(error) };
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "FORM_BOUNDARY_SCAN") {
      sendResponse({ ok: true, url: location.href, title: document.title, formsDetected: countForms(), fields: scanFields() });
      return false;
    }
    if (message?.type === "FORM_BOUNDARY_RUN") {
      runCase(message.fieldId, message.testCase).then(sendResponse);
      return true;
    }
    if (message?.type === "FORM_BOUNDARY_CHECK_CHANGED") {
      sendResponse({ ok: true, changed: hasFormsChangedSinceLastScan() });
      return false;
    }
    return false;
  });
})();
