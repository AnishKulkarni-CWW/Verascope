// ===============================
// CONTENT.JS
// ===============================

let excludeMode = false;
let highlightedElement = null;
let excludedElements = [];

// ===============================
// Listen for popup messages
// ===============================

chrome.runtime.onMessage.addListener((message) => {

    if (message.action === "START_EXCLUDE_MODE") {
        enableExcludeMode();
    }

});

// ===============================
// Enable Exclude Mode
// ===============================

function enableExcludeMode() {

    if (excludeMode) return;

    excludeMode = true;

    document.addEventListener("mouseover", handleMouseOver, true);
    document.addEventListener("mouseout", handleMouseOut, true);
    document.addEventListener("click", handleElementClick, true);

    console.log("Exclude mode enabled");
}

// ===============================
// Disable Exclude Mode
// ===============================

function disableExcludeMode() {

    excludeMode = false;

    document.removeEventListener("mouseover", handleMouseOver, true);
    document.removeEventListener("mouseout", handleMouseOut, true);
    document.removeEventListener("click", handleElementClick, true);

    if (highlightedElement) {
        highlightedElement.style.outline = "";
    }

    highlightedElement = null;

    console.log("Exclude mode disabled");
}

// ===============================
// Hover Element
// ===============================

function handleMouseOver(e) {

    if (!excludeMode) return;

    if (highlightedElement) {
        highlightedElement.style.outline = "";
    }

    highlightedElement = e.target;

    highlightedElement.style.outline = "2px solid red";
}

// ===============================
// Mouse Out
// ===============================

function handleMouseOut(e) {

    if (!excludeMode) return;

    if (
        e.target &&
        !e.target.hasAttribute("data-extension-excluded")
    ) {
        e.target.style.outline = "";
    }
}

// ===============================
// Select Element
// ===============================

function handleElementClick(e) {

    if (!excludeMode) return;

    e.preventDefault();
    e.stopPropagation();

    const element = e.target;

    saveExcludedElement(element);

    applyExcludedStyle(element);

    disableExcludeMode();

    chrome.runtime.sendMessage({
        action: "EXCLUDE_MODE_DISABLED", tabId:tabId, domain:location.hostname
    });
}

// ===============================
// Save Element
// ===============================
function saveExcludedElement(element) {

    const domain = location.hostname;

    const elementData = {
        id: element.id || "",
        xpath: getXPath(element),
        tag: element.tagName
    };

    chrome.storage.local.get(["all-sections"], function(result) {

        const allSections = result["all-sections"] || {};

        if (!allSections[domain]) {
            allSections[domain] = [];
        }

        const exists = allSections[domain].some(
                item => item.xpath === elementData.xpath
            );

        if (!exists) {
            allSections[domain].push(elementData);
            chrome.storage.local.set({
                "all-sections": allSections
            }, function() {
                chrome.runtime.sendMessage({
                    action: "EXCLUDED_ELEMENT_SAVED"
                });
            });
        }

    });

}

// ===============================
// Generate XPath
// ===============================

function getXPath(element) {

    if (element.id) {
        return `//*[@id="${element.id}"]`;
    }

    const parts = [];

    while ( element && element.nodeType === Node.ELEMENT_NODE) {

        let index = 1;

        let sibling = element.previousElementSibling;

        while (sibling) {

            if (
                sibling.tagName === element.tagName
            ) {
                index++;
            }

            sibling = sibling.previousElementSibling;
        }

        parts.unshift(
            `${element.tagName.toLowerCase()}[${index}]`
        );

        element = element.parentElement;
    }

    return "/" + parts.join("/");
}

// ===============================
// XPath Lookup
// ===============================

function getElementByXPath(xpath) {

    try {

        return document.evaluate(
            xpath,
            document,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null
        ).singleNodeValue;

    } catch (error) {

        return null;
    }
}

// ===============================
// Apply Border
// ===============================

function applyExcludedStyle(element) {

    if (!element) return;
    element.setAttribute(
        "data-extension-excluded",
        "true"
    );

    element.classList.add("ext_excluded");
    // element.style.outline = "3px solid blue";
}

// ===============================
// Restore Elements
// ===============================

async function restoreExcludedElements() {
    console.log("Restoring excluded elements...");
    console.log("Current excluded elements:", excludedElements);
    for (const item of excludedElements) {
        let element = null;

        // First try ID

        if (item.id) {
            element = document.getElementById(item.id);
        }

        // Then XPath

        if (!element && item.xpath) {
            element = getElementByXPath(item.xpath);
        }

        applyExcludedStyle(element);
    }
    return true;
}

// ===============================
// Load From Storage
// ===============================

async function loadExcludedElements() {
    const domain = location.hostname;
    const result = await new Promise((resolve) => {
        chrome.storage.local.get(["all-sections"], resolve);
    });
    const allSections = result["all-sections"] || {};
    excludedElements = allSections[domain] || [];
    await restoreExcludedElements();
  
}