(function attachFieldTestCore(globalScope) {
  "use strict";

  const DEFAULT_TEXT = "Sample";
  const UNICODE_TEXT = "测试🙂";

  // ---------------------------------------------------------------------
  // Semantic field-type inference (QA Automation enhancement)
  // ---------------------------------------------------------------------
  // Real forms are not always marked up correctly (e.g. a text input named
  // "emailAddress" with type="text"). We infer a *semantic* type using
  // multiple weighted signals so downstream case generation can produce
  // realistic positive/negative values even when the HTML type is generic.
  const SEMANTIC_PATTERNS = [
    { semantic: "email", weight: 3, test: /mail/i },
    { semantic: "phone", weight: 3, test: /phone|mobile|tel(?:ephone)?|cell|contact.?number/i },
    { semantic: "url", weight: 3, test: /url|website|link|homepage/i },
    { semantic: "firstName", weight: 2, test: /first.?name|fname|given.?name/i },
    { semantic: "lastName", weight: 2, test: /last.?name|lname|surname|family.?name/i },
    { semantic: "fullName", weight: 2, test: /^name$|full.?name|your.?name/i },
    { semantic: "password", weight: 3, test: /pass.?word|pwd/i },
    { semantic: "zip", weight: 2, test: /zip|postal/i },
    { semantic: "date", weight: 2, test: /date|dob|birth/i },
    { semantic: "age", weight: 2, test: /^age$/i },
    { semantic: "creditCard", weight: 3, test: /card.?number|credit.?card|ccnum/i }
  ];

  function inferSemanticType(descriptor) {
    // HTML type wins for unambiguous native types.
    if (["email", "tel", "url", "password", "date", "number", "range"].includes(descriptor.type)) {
      return descriptor.type === "tel" ? "phone" : descriptor.type;
    }
    const haystack = [descriptor.label, descriptor.name, descriptor.id, descriptor.placeholder, descriptor.autocomplete]
      .filter(Boolean).join(" ");
    let best = null, bestWeight = 0;
    SEMANTIC_PATTERNS.forEach((pattern) => {
      if (pattern.test.test(haystack) && pattern.weight > bestWeight) {
        best = pattern.semantic;
        bestWeight = pattern.weight;
      }
    });
    return best || descriptor.type || "text";
  }

  function clampPrecision(value) {
    if (!Number.isFinite(value)) return value;
    return Number(value.toFixed(10));
  }

  function parseNumber(value) {
    if (value === "" || value === null || value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function numericStep(descriptor) {
    if (descriptor.step === "any") return null;
    const parsed = parseNumber(descriptor.step);
    return parsed && parsed > 0 ? parsed : 1;
  }

  // testType: high-level QA category shown in the report (Positive / Negative / Boundary /
  // Required / Format / Accessibility). severity: only meaningful for cases whose failure
  // (accepted-when-should-reject, or vice versa) indicates a real defect.
  function classifyTestType(category, expectedValid) {
    if (category === "empty") return "Required";
    if (category === "format") return "Negative";
    if (category === "unicode" || category === "typical") return "Positive";
    if (category === "boundary") return expectedValid === false ? "Negative" : "Boundary";
    if (category === "accessibility") return "Accessibility";
    return expectedValid === false ? "Negative" : "Positive";
  }

  function severityFor(category, expectedValid) {
    if (category === "empty") return "High";
    if (category === "format") return "High";
    if (category === "accessibility") return "Medium";
    if (category === "boundary") return "Medium";
    return "Low";
  }

  function addCase(cases, id, label, value, expectedValid, reason, category = "boundary") {
    if (cases.some((item) => item.id === id)) return;
    cases.push({
      id,
      label,
      value: String(value),
      expectedValid,
      reason,
      category,
      testType: classifyTestType(category, expectedValid),
      severity: severityFor(category, expectedValid)
    });
  }

  function repeatToLength(seed, length) {
    if (length <= 0) return "";
    return seed.repeat(Math.ceil(length / seed.length)).slice(0, length);
  }

  function compileHtmlPattern(pattern) {
    if (!pattern) return null;
    try {
      return new RegExp(`^(?:${pattern})$`, "v");
    } catch {
      try {
        return new RegExp(`^(?:${pattern})$`, "u");
      } catch {
        return undefined;
      }
    }
  }

  function textExpectation(value, descriptor) {
    if (value === "") return descriptor.required ? false : true;
    if (!evaluateLength(value, descriptor).valid) return false;
    if (descriptor.pattern) {
      const regex = compileHtmlPattern(descriptor.pattern);
      if (regex === undefined) return null;
      if (!regex.test(value)) return false;
    }
    return true;
  }

  function evaluateLength(value, descriptor = {}) {
    const text = String(value ?? "");
    const actualLength = text.length;
    const minLength = parseNumber(descriptor.minLength);
    const maxLength = parseNumber(descriptor.maxLength);
    if (actualLength > 0 && minLength !== null && actualLength < minLength) {
      return { valid: false, code: "tooShort", actualLength, limit: minLength };
    }
    if (maxLength !== null && actualLength > maxLength) {
      return { valid: false, code: "tooLong", actualLength, limit: maxLength };
    }
    return { valid: true, code: null, actualLength, limit: null };
  }

  function fitTypicalText(descriptor) {
    const minLength = Math.max(1, parseNumber(descriptor.minLength) || 0);
    const maxLength = parseNumber(descriptor.maxLength);
    const target = maxLength === null ? Math.max(DEFAULT_TEXT.length, minLength) : Math.min(maxLength, Math.max(DEFAULT_TEXT.length, minLength));
    if (target <= 0) return "";
    const candidates = [DEFAULT_TEXT, "abc123", "aaaaaa", "123456"]
      .map((seed) => repeatToLength(seed, target));
    const match = candidates.find((value) => textExpectation(value, descriptor) === true);
    return match || candidates[0];
  }

  function textCases(descriptor) {
    const cases = [];
    const minLength = parseNumber(descriptor.minLength);
    const maxLength = parseNumber(descriptor.maxLength);
    const typical = fitTypicalText(descriptor);

    addCase(cases, "typical-text", "Typical text", typical, textExpectation(typical, descriptor), "A representative text value.", "typical");

    if (descriptor.required) {
      addCase(cases, "required-empty", "Required field empty", "", false, "Required fields should reject an empty value.", "empty");
    }

    if (minLength !== null && minLength > 0) {
      const below = repeatToLength("a", Math.max(0, minLength - 1));
      const at = repeatToLength("a", minLength);
      addCase(cases, "below-minlength", `Below minlength (${minLength - 1})`, below, textExpectation(below, descriptor), "One character shorter than the declared minimum.");
      addCase(cases, "at-minlength", `At minlength (${minLength})`, at, textExpectation(at, descriptor), "Exactly the declared minimum length.");
    }

    if (maxLength !== null && maxLength >= 0) {
      const at = repeatToLength("b", maxLength);
      const above = repeatToLength("b", maxLength + 1);
      addCase(cases, "at-maxlength", `At maxlength (${maxLength})`, at, textExpectation(at, descriptor), "Exactly the declared maximum length.");
      addCase(cases, "above-maxlength", `Above maxlength (${maxLength + 1})`, above, textExpectation(above, descriptor), "One character longer than the declared maximum.");
    }

    addCase(cases, "unicode", "Unicode and emoji", UNICODE_TEXT, textExpectation(UNICODE_TEXT, descriptor), "Checks non-ASCII input handling.", "unicode");

    if (descriptor.pattern) {
      const regex = compileHtmlPattern(descriptor.pattern);
      if (regex === undefined) {
        addCase(cases, "pattern-unknown", "Pattern probe", "PatternProbe", null, "The declared pattern cannot be reliably evaluated by this extension.", "format");
      } else {
        const candidates = ["###invalid###", " ", "__", "abc", "123", "x@y"];
        const mismatch = candidates.find((value) => !regex.test(value) && textExpectation(value, { ...descriptor, pattern: "" }) !== false);
        if (mismatch !== undefined) {
          addCase(cases, "pattern-mismatch", "Pattern mismatch", mismatch, false, `Does not match the declared pattern: ${descriptor.pattern}`, "format");
        }
      }
    }

    return cases;
  }

  function emailCases(descriptor) {
    const cases = [];
    if (descriptor.required) addCase(cases, "required-empty", "Required field empty", "", false, "Required fields should reject an empty value.", "empty");
    const valid = "qa@example.com";
    const lengthExpectation = textExpectation(valid, { ...descriptor, pattern: descriptor.pattern || "" });
    addCase(cases, "valid-email", "Valid email", valid, lengthExpectation, "A typical valid email address.", "typical");
    addCase(cases, "missing-at", "Email missing @", "qa.example.com", false, "Should fail email format validation.", "format");
    addCase(cases, "missing-domain", "Email missing domain", "qa@", false, "Should fail email format validation.", "format");
    return cases;
  }

  function isStepAligned(value, base, step) {
    if (step === null) return true;
    const quotient = (value - base) / step;
    return Math.abs(quotient - Math.round(quotient)) < 1e-8;
  }

  function numberExpectation(value, descriptor) {
    if (value === "") return descriptor.required ? false : true;
    const number = Number(value);
    if (!Number.isFinite(number)) return false;
    const min = parseNumber(descriptor.min);
    const max = parseNumber(descriptor.max);
    const step = numericStep(descriptor);
    const base = min !== null ? min : 0;
    if (min !== null && number < min) return false;
    if (max !== null && number > max) return false;
    if (!isStepAligned(number, base, step)) return false;
    return true;
  }

  function alignedTypical(descriptor) {
    const min = parseNumber(descriptor.min);
    const max = parseNumber(descriptor.max);
    const step = numericStep(descriptor);
    const base = min !== null ? min : 0;
    if (step === null) {
      if (min !== null && max !== null) return clampPrecision((min + max) / 2);
      if (min !== null) return min;
      if (max !== null) return max;
      return 1;
    }
    if (min !== null) return min;
    if (max !== null && max < 0) return clampPrecision(Math.floor(max / step) * step);
    if (max !== null && 0 > max) return max;
    return base;
  }

  function numberCases(descriptor) {
    const cases = [];
    const min = parseNumber(descriptor.min);
    const max = parseNumber(descriptor.max);
    const step = numericStep(descriptor) || 1;

    if (descriptor.required) addCase(cases, "required-empty", "Required field empty", "", false, "Required fields should reject an empty value.", "empty");
    if (min !== null) {
      const below = clampPrecision(min - step);
      addCase(cases, "below-min", `Below min (${below})`, below, false, "One step below the declared minimum.");
      addCase(cases, "at-min", `At min (${min})`, min, numberExpectation(min, descriptor), "Exactly the declared minimum.");
    }
    if (max !== null) {
      addCase(cases, "at-max", `At max (${max})`, max, numberExpectation(max, descriptor), "Exactly the declared maximum.");
      const above = clampPrecision(max + step);
      addCase(cases, "above-max", `Above max (${above})`, above, false, "One step above the declared maximum.");
    }
    const typical = alignedTypical(descriptor);
    addCase(cases, "typical-number", `Typical number (${typical})`, typical, numberExpectation(typical, descriptor), "A step-aligned value inside the declared range.", "typical");
    return cases;
  }

  function shiftIsoDate(isoDate, days) {
    const date = new Date(`${isoDate}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) return isoDate;
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }

  function dateExpectation(value, descriptor) {
    if (value === "") return descriptor.required ? false : true;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    if (descriptor.min && value < descriptor.min) return false;
    if (descriptor.max && value > descriptor.max) return false;
    return true;
  }

  function dateCases(descriptor) {
    const cases = [];
    const today = new Date().toISOString().slice(0, 10);
    if (descriptor.required) addCase(cases, "required-empty", "Required field empty", "", false, "Required fields should reject an empty value.", "empty");
    if (descriptor.min) {
      const before = shiftIsoDate(descriptor.min, -1);
      addCase(cases, "below-min-date", `Before min (${before})`, before, false, "One day before the declared minimum.");
      addCase(cases, "at-min-date", `At min (${descriptor.min})`, descriptor.min, dateExpectation(descriptor.min, descriptor), "Exactly the declared minimum date.");
    }
    if (descriptor.max) {
      addCase(cases, "at-max-date", `At max (${descriptor.max})`, descriptor.max, dateExpectation(descriptor.max, descriptor), "Exactly the declared maximum date.");
      const after = shiftIsoDate(descriptor.max, 1);
      addCase(cases, "above-max-date", `After max (${after})`, after, false, "One day after the declared maximum date.");
    }
    addCase(cases, "today", `Today (${today})`, today, dateExpectation(today, descriptor), "Checks today's date against the declared range.", "typical");
    return cases;
  }

  // ---------------------------------------------------------------------
  // Semantic-aware generators: phone, URL, password, and named text fields.
  // These layer on top of textCases()'s boundary/length handling by adding
  // realistic positive values and targeted negative/format cases.
  // ---------------------------------------------------------------------
  function phoneCases(descriptor) {
    const cases = textCases(descriptor);
    const valid = "9876543210";
    addCase(cases, "phone-valid", "Valid phone number", valid, textExpectation(valid, descriptor), "A typical 10-digit phone number.", "typical");
    addCase(cases, "phone-too-short", "Phone number too short", "123", textExpectation("123", descriptor), "Implausibly short for a phone number; flagged if accepted without pattern/length rules.", "format");
    addCase(cases, "phone-letters", "Phone number with letters", "98765abc10", textExpectation("98765abc10", descriptor), "Contains non-numeric characters; flagged if the field has no format restriction.", "format");
    addCase(cases, "phone-too-long", "Excessively long phone number", "98765432101234567890", textExpectation("98765432101234567890", descriptor), "Unrealistically long input to probe for missing length limits.", "format");
    return cases;
  }

  function urlCases(descriptor) {
    const cases = [];
    if (descriptor.required) addCase(cases, "required-empty", "Required field empty", "", false, "Required fields should reject an empty value.", "empty");
    const valid = "https://example.com";
    addCase(cases, "url-valid", "Valid URL", valid, textExpectation(valid, descriptor), "A well-formed absolute URL.", "typical");
    addCase(cases, "url-no-protocol", "URL missing protocol", "example.com", null, "Browsers vary on whether a bare domain is accepted by type=url validation.", "format");
    addCase(cases, "url-malformed", "Malformed URL", "http:/example", false, "Structurally invalid URL that should fail type=url validation.", "format");
    addCase(cases, "url-spaces", "URL containing spaces", "https://exa mple.com", false, "URLs with embedded whitespace should be rejected.", "format");
    return cases;
  }

  function passwordCases(descriptor) {
    const cases = textCases(descriptor);
    const minLength = parseNumber(descriptor.minLength);
    const strong = "Test@12345";
    addCase(cases, "password-strong", "Strong password", strong, textExpectation(strong, descriptor), "A realistic strong password (upper/lower/digit/symbol).", "typical");
    const weak = "abc";
    const weakExpectation = minLength && minLength > weak.length ? false : textExpectation(weak, descriptor);
    addCase(cases, "password-weak-short", "Very short password", weak, weakExpectation, "Too short to be a secure password; only fails automatically if minlength/pattern enforce it.", "format");
    return cases;
  }

  function nameCases(descriptor) {
    const cases = textCases(descriptor);
    const valid = descriptor.semanticType === "firstName" ? "John" : descriptor.semanticType === "lastName" ? "Smith" : "John Smith";
    addCase(cases, "name-valid", "Realistic name", valid, textExpectation(valid, descriptor), "A realistic human name value.", "typical");
    addCase(cases, "name-numeric", "Name containing digits", "John123", textExpectation("John123", descriptor), "Names are not usually expected to contain digits; flagged if no pattern rejects it.", "format");
    addCase(cases, "name-special-chars", "Name with special characters", "John<>@Smith", textExpectation("John<>@Smith", descriptor), "Checks handling of special/markup characters in free-text name fields.", "format");
    return cases;
  }

  // ---------------------------------------------------------------------
  // Accessibility-related form validation cases.
  // These don't submit new values; the runner inspects static DOM/ARIA
  // attributes on the field itself (see content.js evaluateAccessibility).
  // We still emit a "case" so it appears uniformly in the test list/report.
  // ---------------------------------------------------------------------
  function accessibilityCase(descriptor) {
    return {
      id: "a11y-audit",
      label: "Accessibility audit",
      value: "(no value change)",
      expectedValid: null,
      reason: "Checks for an accessible name, label association, and aria-invalid/aria-describedby wiring on this field.",
      category: "accessibility",
      testType: "Accessibility",
      severity: "Medium",
      isStaticAudit: true
    };
  }

  function selectCases(descriptor) {
    const cases = [];
    const usable = (descriptor.options || []).filter((item) => !item.disabled && item.value !== "");
    if (descriptor.required) addCase(cases, "required-empty", "Required selection empty", "", false, "Required selects should reject an empty option.", "empty");
    if (usable.length > 0) addCase(cases, "first-option", `First option: ${usable[0].label}`, usable[0].value, true, "Selects the first enabled non-empty option.", "typical");
    if (usable.length > 1) {
      const last = usable[usable.length - 1];
      addCase(cases, "last-option", `Last option: ${last.label}`, last.value, true, "Selects the last enabled non-empty option.", "boundary");
    }
    return cases;
  }

  function generateCases(descriptor) {
    if (!descriptor || descriptor.disabled || descriptor.sensitive) return [];

    const semanticType = descriptor.semanticType || inferSemanticType(descriptor);
    let cases;

    if (descriptor.tagName === "select") {
      cases = selectCases(descriptor);
    } else {
      switch (descriptor.type) {
        case "number":
        case "range":
          cases = numberCases(descriptor);
          break;
        case "date":
          cases = dateCases(descriptor);
          break;
        case "email":
          cases = emailCases(descriptor);
          break;
        case "checkbox":
        case "radio": {
          // expectedValid for "left unchecked": true only if we have a real,
          // observable signal this is genuinely required (required attribute
          // or aria-required) -- see requirementUnknown in content.js's
          // describeField. When neither signal is present, this tool does
          // NOT assert "unchecked is valid" as a confident guess (a previous
          // version inferred required-ness from label text and got this
          // wrong on a real page: an "Interested in..." opt-in checkbox
          // isn't meant to be mandatory, but nothing about its wording could
          // reliably prove that either way). expectedValid: null here means
          // exactly what it means everywhere else in this codebase --
          // "cannot be predicted reliably" -- so running the case reports
          // WARNING with the real native/aria state shown, not a false PASS
          // or FAIL against an unverified assumption.
          const uncheckedExpectedValid = descriptor.requirementUnknown ? null : !descriptor.required;
          const uncheckedReason = descriptor.requirementUnknown
            ? "Required-ness for this checkbox can't be confirmed from the page's own markup (no required attribute or aria-required) -- this only reports what native validation actually does when left unchecked, without assuming intent."
            : descriptor.required ? "Required controls should reject an unchecked state." : "Checks the unchecked state.";
          cases = [
            addCaseObject("required-unchecked-or-unchecked", "unchecked", "Unchecked", "false", uncheckedExpectedValid, uncheckedReason, "empty"),
            addCaseObject("checked", "checked", "Checked", "true", true, "Checks the selected state.", "typical")
          ];
          break;
        }
        default:
          // Route generic text-like inputs through semantic-aware generators when
          // a strong semantic signal was detected, otherwise fall back to plain text rules.
          if (semanticType === "phone") cases = phoneCases(descriptor);
          else if (semanticType === "url") cases = urlCases(descriptor);
          else if (semanticType === "password") cases = passwordCases({ ...descriptor });
          else if (semanticType === "email") cases = emailCases(descriptor);
          else if (["firstName", "lastName", "fullName"].includes(semanticType)) cases = nameCases({ ...descriptor, semanticType });
          else cases = textCases(descriptor);
      }
    }

    if (!descriptor.disabled) cases = cases.concat([accessibilityCase(descriptor)]);
    return cases;
  }

  // Small helper so the checkbox/radio literal case objects also carry testType/severity,
  // consistent with cases produced via addCase().
  function addCaseObject(id, _unusedId, label, value, expectedValid, reason, category) {
    return {
      id,
      label,
      value: String(value),
      expectedValid,
      reason,
      category,
      testType: classifyTestType(category, expectedValid),
      severity: severityFor(category, expectedValid)
    };
  }

  const api = {
    generateCases, parseNumber, repeatToLength, shiftIsoDate, textExpectation, numberExpectation,
    dateExpectation, compileHtmlPattern, evaluateLength, inferSemanticType
  };
  globalScope.FieldTestCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
