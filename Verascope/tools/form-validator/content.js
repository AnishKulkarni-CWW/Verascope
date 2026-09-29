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
  let lastScanDiagnostics = null;

  // Heuristics for fields that behave as required in practice but don't carry the
  // HTML `required` attribute -- a very common real-world pattern where a site
  // enforces "must select/check this" purely through its own JS validation on
  // submit, not through HTML5 semantics. Confirmed against a real page (BMW's
  // test-drive form): two <select> elements with an empty "--Select--"
  // placeholder option and a "I accept the Terms & Conditions" checkbox are all
  // clearly mandatory in intent, but none of the three carry `required` in the
  // markup. Treating these as required (a) generates the missing negative test
  // case ("what happens if this is left empty/unchecked"), and (b) correctly
  // surfaces the existing accessibility check ("Required field is not exposed as
  // required to assistive technology") for a field that genuinely has that
  // problem -- a soft-required field with no ARIA/required wiring is exactly
  // what that audit exists to catch.

  // A <select> with a blank ("") value option is the standard, widely-used
  // placeholder pattern ("--Select--", "Choose one", etc.) -- its presence is a
  // strong, generic signal the field is meant to be filled in, independent of
  // any specific site's option text or field name. Confirmed working correctly
  // on a real page (BMW's test-drive form: outlet_key/salutation/outlet_city
  // all correctly detected and flagged required via this exact check).
  function selectHasEmptyPlaceholderOption(element) {
    if (!(element instanceof HTMLSelectElement)) return false;
    return Array.from(element.options).some((option) => option.value === "");
  }

  // REMOVED: a previous version of this file guessed a checkbox was required
  // by matching its label text against consent/Terms phrasing ("I accept",
  // "Terms & Conditions", etc.). Direct real-world feedback showed this was
  // genuinely unreliable: a real "Interested in BMW Financial Services' plans
  // and offers" opt-in checkbox (clearly NOT meant to be mandatory) had the
  // `required` HTML attribute set on the actual page -- for reasons that have
  // nothing to do with its label wording -- and no text-pattern check on
  // EITHER the label or the attribute could have told that apart from a
  // genuine Terms checkbox, because the distinction lives in the site's own
  // business logic, not in anything visible from outside. Label-text
  // pattern-matching for "is this mandatory" is the wrong category of signal
  // and has been removed rather than tuned further -- see
  // isCheckboxRequiredByObservableSignal below for what replaced it.

  // Terms & Conditions / Privacy Policy acceptance checkboxes are treated as
  // ALWAYS required, as a matter of policy -- independent of what any given
  // site's markup says. This is a deliberate, narrow reintroduction of
  // label-based inference for exactly ONE well-justified category, not a
  // return to the broad "guess required-ness from any nearby text" approach
  // removed two rounds ago. The distinction matters: requiring acceptance of
  // legal terms before allowing form submission is a near-universal
  // compliance pattern across production forms, not a guess about any one
  // site's specific intent -- unlike guessing whether "Interested in BMW
  // Financial Services' plans and offers" is mandatory, which genuinely
  // depends on business logic this tool can't observe, whether or not this
  // is a Terms/Privacy checkbox is a much more reliably answerable question
  // from the page's own structure.
  //
  // Two independent signals, either sufficient on its own:
  //   1. The label text itself uses legal-agreement phrasing ("I accept the
  //      terms", "I agree to the privacy policy", etc.) -- kept narrow and
  //      specific to acceptance-of-terms language, not generic "sounds
  //      important" wording.
  //   2. A real hyperlink inside the label whose visible text OR href
  //      references terms/conditions/privacy -- a structural signal (an
  //      actual link to a legal document) that's much harder to misfire on
  //      than prose alone. Confirmed against the real page this rule was
  //      built for: the actual Terms checkbox wraps a live
  //      <a href="/privacy-policy">Terms & Conditions.</a> link.
  const TERMS_ACCEPTANCE_PHRASES = /(i\s+accept|i\s+agree|accept\s+the\s+terms|agree\s+to\s+the\s+terms|terms\s*(?:&|and)\s*conditions|terms\s+of\s+(?:use|service)|privacy\s+policy)/i;
  const TERMS_LINK_HREF_OR_TEXT = /(terms|tos|privacy|conditions|legal|agreement)/i;
  function isTermsAcceptanceCheckbox(element) {
    if ((element.type || "").toLowerCase() !== "checkbox") return false;
    const wrappingLabel = element.closest("label");
    const labelText = wrappingLabel ? wrappingLabel.textContent : (element.labels && element.labels[0] ? element.labels[0].textContent : "");
    if (TERMS_ACCEPTANCE_PHRASES.test(labelText || "")) return true;
    if (!wrappingLabel) return false;
    const link = wrappingLabel.querySelector("a[href]");
    if (!link) return false;
    const linkSignal = `${link.textContent} ${link.getAttribute("href") || ""}`;
    return TERMS_LINK_HREF_OR_TEXT.test(linkSignal);
  }

  // Whether a checkbox/radio is required, using ONLY signals the page itself
  // states about the element -- never inferred from label wording. Checks
  // both `required` (the real HTML5 attribute, read via .required so it also
  // reflects it being set dynamically via JS) and `aria-required="true"` (a
  // distinct attribute some sites set independently, often precisely because
  // they enforce required-ness via their own JS rather than native HTML5
  // constraint validation -- so it can be true even when .required is false).
  // Neither is a guess: both are the page's own explicit, observable
  // statement about the field. If NEITHER is present, this function does not
  // guess "not required" either -- see generateCases in core.js, which treats
  // that case as genuinely unknown rather than asserting an unverified
  // negative. EXCEPTION: isTermsAcceptanceCheckbox above overrides this to
  // true for the one narrow, well-justified category described there.
  function isCheckboxRequiredByObservableSignal(element) {
    return Boolean(element.required) || element.getAttribute("aria-required") === "true" || isTermsAcceptanceCheckbox(element);
  }

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
    const genuinelyVisible = style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && rect.width > 0 && rect.height > 0;
    if (genuinelyVisible) return true;
    return isRealHiddenControl(element);
  }

  // A select/checkbox/radio that's CSS-hidden but still a real, functional field --
  // very commonly true for custom-styled dropdown/checkbox widgets (Select2, Chosen,
  // and similar libraries hide the native <select>; hand-rolled custom checkboxes
  // hide the native <input> behind a decorative sibling span/label). A field only
  // counts as "really hidden and probably dead/decorative" -- and stays filtered out
  // -- if it lacks a name, is disabled, or isn't actually attached to the document.
  function isRealHiddenControl(element) {
    const tagName = element.tagName.toLowerCase();
    const type = (element.type || "").toLowerCase();
    const isEligibleType = tagName === "select" || type === "checkbox" || type === "radio";
    if (!isEligibleType) return false;
    if (element.disabled) return false;
    if (!element.name) return false;
    if (!element.isConnected) return false;
    return true;
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
    const isCheckboxLike = type === "checkbox" || type === "radio";
    // For checkboxes/radios: required is true ONLY from an observable signal
    // (the real attribute or aria-required) -- never inferred from label text.
    // For selects: the real attribute, OR the empty-placeholder-option signal
    // (a real DOM fact, not a text guess -- confirmed working on a live page).
    // For checkboxes: the real attribute, aria-required, OR being recognized
    // as a Terms & Conditions / Privacy Policy acceptance checkbox (see
    // isTermsAcceptanceCheckbox above) -- the one deliberate, narrow
    // exception to "never infer from label text" for checkboxes.
    const hasRealRequiredAttr = Boolean(element.required);
    const hasAriaRequired = element.getAttribute("aria-required") === "true";
    const isTermsCheckbox = isCheckboxLike && isTermsAcceptanceCheckbox(element);
    const softRequiredReason = hasRealRequiredAttr ? null
      : isTermsCheckbox ? "recognized as a Terms & Conditions / Privacy Policy acceptance checkbox"
      : selectHasEmptyPlaceholderOption(element) ? "select has an empty placeholder option"
      : null;
    const required = isCheckboxLike
      ? isCheckboxRequiredByObservableSignal(element)
      : (hasRealRequiredAttr || Boolean(softRequiredReason));
    // True only for a checkbox/radio with NEITHER a real signal (attribute/
    // aria-required) NOR the Terms-acceptance override present -- this tool
    // genuinely cannot tell from outside whether the page's own JS enforces
    // it anyway (see the long comment on isCheckboxRequiredByObservableSignal
    // above). Surfaced to the person rather than silently defaulting to "not
    // required", which would just be a different unverified guess. A
    // recognized Terms checkbox is NOT genuinely unknown -- it's confidently,
    // deliberately required by policy -- so it's excluded here.
    const requirementUnknown = isCheckboxLike && !hasRealRequiredAttr && !hasAriaRequired && !isTermsCheckbox;
    // A form with novalidate disables the browser's AUTOMATIC validation on
    // a real submit event -- it does NOT disable direct, programmatic
    // checkValidity() calls on individual elements (verified directly: a
    // genuinely required-but-empty field still correctly reports invalid via
    // checkValidity() even on a novalidate form). Since this tool never
    // submits the form and only ever calls checkValidity() directly on one
    // element at a time (see runCase below), novalidate does NOT break this
    // tool's core validation mechanism for fields that DO carry a real
    // required/aria-required attribute. What it DOES explain is a real,
    // reported case: a real page had TWO checkboxes with identical (missing)
    // required/aria-required signals -- one a genuine Terms & Conditions
    // checkbox, one an unrelated marketing opt-in -- and no DOM-observable
    // fact distinguished them, because this form enforces "required"
    // entirely through its own custom JS. novalidate is a signal that a
    // form's real validation logic lives entirely off-page, in JS this tool
    // can't inspect -- it doesn't change what checkValidity() returns for
    // fields that already have a real signal, only explains why fields with
    // NO signal can't be resolved any other way on this specific form.
    const formNoValidate = Boolean(element.form && element.form.noValidate);
    const descriptor = {
      fieldId: `fb-${index}`,
      formLabel: formLabelFor(element),
      formDestructive: isFormPotentiallyDestructive(element.form),
      formNoValidate,
      locator: locatorFor(element, index),
      tagName,
      type,
      label,
      name: element.name || "",
      id: element.id || "",
      placeholder: element.getAttribute("placeholder") || "",
      autocomplete: element.getAttribute("autocomplete") || "",
      // required: true if a REAL, observable signal says so -- the HTML
      // required attribute, aria-required="true", or (selects only) an
      // empty placeholder option. softRequired marks the one case that's
      // still an inference (select placeholder) rather than a page-stated
      // fact, so it's traceable in the UI/report. requirementUnknown is true
      // only for a checkbox/radio with NEITHER real signal present -- the
      // tool does not guess required OR not-required for that case; see the
      // long comment on isCheckboxRequiredByObservableSignal above for why.
      required,
      softRequired: !hasRealRequiredAttr && !hasAriaRequired && Boolean(softRequiredReason),
      softRequiredReason,
      requirementUnknown,
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

  // Diagnostic snapshot of the current DOM state, returned alongside a normal
  // scan so a person (or developer) can see WHY a specific field wasn't picked
  // up, rather than just getting an empty/incomplete field list with no trace
  // of what happened. This does not change scanning behavior at all -- it's
  // read-only instrumentation layered on top.
  function buildScanDiagnostics(candidateElements, keptElements) {
    const filteredOut = candidateElements.length - keptElements.length;
    const reasons = { disabled: 0, readOnly: 0, notVisible: 0 };
    const filteredOutDetail = [];
    candidateElements.forEach((element) => {
      if (keptElements.includes(element)) return;
      const identity = element.name || element.id || `<${element.tagName.toLowerCase()} with no name/id>`;
      if (element.disabled) { reasons.disabled += 1; filteredOutDetail.push({ identity, reason: "disabled" }); }
      else if (element.readOnly) { reasons.readOnly += 1; filteredOutDetail.push({ identity, reason: "readOnly" }); }
      else if (!isVisible(element)) { reasons.notVisible += 1; filteredOutDetail.push({ identity, reason: "notVisible" }); }
    });
    return {
      totalCandidatesFound: candidateElements.length,
      totalKeptAfterFilters: keptElements.length,
      totalFilteredOut: filteredOut,
      filteredOutReasons: reasons,
      filteredOutDetail,
      documentReadyState: document.readyState,
      iframeCount: document.querySelectorAll("iframe").length,
      formCount: document.querySelectorAll("form").length,
      selectCount: document.querySelectorAll("select").length,
      checkboxCount: document.querySelectorAll('input[type="checkbox"]').length
    };
  }

  function scanFields() {
    fieldElements = new Map();
    const candidateElements = Array.from(document.querySelectorAll(SUPPORTED_SELECTOR));
    const keptElements = candidateElements.filter((element) => !element.disabled && !element.readOnly && isVisible(element));
    const fields = keptElements.map((element, index) => {
      const descriptor = describeField(element, index);
      fieldElements.set(descriptor.fieldId, element);
      return { ...descriptor, cases: window.FieldTestCore.generateCases(descriptor) };
    });
    lastScanSignature = fields.map((f) => f.fieldId + f.type + f.name).join("|");
    lastScanDiagnostics = buildScanDiagnostics(candidateElements, keptElements);
    return fields;
  }

  // Counts distinct <form> elements that contain at least one supported field, plus
  // (if any supported fields exist with no parent form) one bucket for "unassociated" fields.
  // Counts distinct <form> elements that contain at least one supported field. If
  // there are zero such forms but supported fields exist with no parent <form> at
  // all (a common pattern: a modal or widget whose fields are wired up via JS and
  // submitted without a real <form> tag), that counts as 1 form-like group so the
  // count isn't misleadingly 0 when fields genuinely were found and are testable.
  // Crucially, this bucket is NOT added on top of real forms that already have
  // fields -- a page with one real <form> plus a separate orphaned-field modal
  // (e.g. this page's "Request a Call Back" popup, whose inputs have no wrapping
  // <form>) correctly reports 1, not 2. The orphaned fields are still fully
  // scanned and testable either way; this only changes what the Forms metric
  // counts, not what gets tested.
  function countForms() {
    const elements = Array.from(document.querySelectorAll(SUPPORTED_SELECTOR));
    const forms = new Set();
    let hasUnassociated = false;
    elements.forEach((element) => { if (element.form) forms.add(element.form); else hasUnassociated = true; });
    if (forms.size > 0) return forms.size;
    return hasUnassociated ? 1 : 0;
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

  function evaluateSoftRequiredConstraint(element, actualValue) {
    const type = (element.type || "").toLowerCase();
    const isCheckboxLike = type === "checkbox" || type === "radio";
    const isSelect = element instanceof HTMLSelectElement;
    if (!isCheckboxLike && !isSelect) return { valid: true, issues: [] };
    if (element.required) return { valid: true, issues: [] }; // native checkValidity() already covers this correctly

    // Select: the empty-placeholder-option case is a real DOM fact (not a
    // text guess) needing a computed check, since native checkValidity() has
    // no opinion when .required is false. Confirmed working on a real page.
    if (isSelect) {
      if (!selectHasEmptyPlaceholderOption(element)) return { valid: true, issues: [] };
      if (actualValue !== "") return { valid: true, issues: [] };
      return { valid: false, issues: [{ code: "softRequiredEmpty", message: "This selection has an empty placeholder value chosen (detected by the blank option, not the required attribute)." }] };
    }

    // Checkbox/radio: a computed override applies when EITHER aria-required
    // is set (a real, page-stated signal distinct from .required) OR this is
    // a recognized Terms & Conditions / Privacy Policy acceptance checkbox
    // (the one deliberate policy exception -- see isTermsAcceptanceCheckbox
    // above). Without this, a detected Terms checkbox left unchecked would
    // silently report valid via native checkValidity(), which has no
    // opinion here since there's no real required attribute on the element
    // -- the same false-negative gap already found and fixed for the select
    // and aria-required cases. A checkbox with NONE of these three signals
    // gets no override: there's no genuine basis left to check it against.
    const hasAriaRequiredSignal = element.getAttribute("aria-required") === "true";
    const hasTermsSignal = isTermsAcceptanceCheckbox(element);
    if (!hasAriaRequiredSignal && !hasTermsSignal) return { valid: true, issues: [] };
    if (actualValue !== "false") return { valid: true, issues: [] };
    const message = hasTermsSignal
      ? "This is a Terms & Conditions / Privacy Policy acceptance checkbox left unchecked (treated as always required by policy, not by a required/aria-required attribute)."
      : "This checkbox has aria-required=\"true\" and was left unchecked (the plain required attribute is absent, so the browser's own validation doesn't catch this).";
    return { valid: false, issues: [{ code: "softRequiredEmpty", message }] };
  }

  // Per-element highlight bookkeeping. The page's own outline is captured once
  // (before our first highlight) and any pending reset timer is cancelled when a
  // new case starts, so back-to-back cases can't restore a previous case's
  // colour and leave it stuck on the field. A persisted highlight (the final
  // passing positive case of a run) stays until the field is tested again.
  const highlightState = new WeakMap();

  function applyHighlight(element, outline, persist) {
    let state = highlightState.get(element);
    if (!state) {
      state = { original: element.style.outline, timer: null };
      highlightState.set(element, state);
    }
    if (state.timer) {
      window.clearTimeout(state.timer);
      state.timer = null;
    }
    element.style.outline = outline;
    if (persist) return;
    state.timer = window.setTimeout(() => {
      element.style.outline = state.original;
      state.timer = null;
    }, 1800);
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
      const softRequiredConstraint = evaluateSoftRequiredConstraint(element, actualValue);
      const actualValid = nativeValid && computedConstraints.valid && softRequiredConstraint.valid;
      const normalized = actualValue !== requestedValue;
      let verdict = "unknown";
      if (!normalized && testCase.expectedValid !== null && testCase.expectedValid !== undefined) verdict = actualValid === Boolean(testCase.expectedValid) ? "matched" : "mismatch";

      // Cross-check ARIA error wiring: if the field is now invalid, well-built forms
      // typically reflect that via aria-invalid="true" for assistive technology.
      const ariaInvalidNow = element.getAttribute("aria-invalid");
      const ariaReflectsInvalid = actualValid ? true : ariaInvalidNow === "true";

      element.scrollIntoView({ behavior: "smooth", block: "center" });
      applyHighlight(element, verdict === "matched" ? "3px solid #1f9d55" : verdict === "mismatch" ? "3px solid #dc3545" : "3px solid #d97706", Boolean(testCase.persistHighlight) && verdict === "matched");

      const allIssues = [...computedConstraints.issues, ...softRequiredConstraint.issues];
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
        validationSource: (computedConstraints.valid && softRequiredConstraint.valid) ? "native" : "native+computed",
        constraintIssues: allIssues,
        validationMessage: [element.validationMessage, ...allIssues.map((issue) => issue.message)].filter(Boolean).join(" "),
        label: fieldLabel(element, 0)
      };
    } catch (error) {
      element.style.outline = originalOutline;
      return { ok: false, error: "EXECUTION_FAILED", detail: error instanceof Error ? error.message : String(error) };
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "FORM_BOUNDARY_SCAN") {
      const formsDetected = countForms();
      const fields = scanFields();
      sendResponse({ ok: true, url: location.href, title: document.title, formsDetected, fields, diagnostics: lastScanDiagnostics });
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
