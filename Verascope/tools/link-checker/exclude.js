$(document).ready(function () {

    var wrap = document.getElementById("cmlExcludeWrap");
    var btn  = document.getElementById("cmlExcludeBtn");

    function setActive(on) {
      btn.classList.toggle("cml-active", on);
      wrap.classList.toggle("cml-on", on);
      btn.setAttribute("aria-pressed", String(on));
    }

    btn.addEventListener("click", function () {
      setActive(!btn.classList.contains("cml-active"));
      // Hook your selection-mode logic here
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && btn.classList.contains("cml-active")) setActive(false);
    });

   $(document).on("mouseenter", ".tag-chip", async function () {
        const $row = $(this).closest(".exclude-row");
        const xpath = $row.find(".delete-item").data("xpath");
        const domain = $row.find(".delete-item").data("domain");

        const [tab] = await chrome.tabs.query({
            active: true,
            currentWindow: true
        });

        chrome.tabs.sendMessage(tab.id, {
            action: "highlight-element",
            xpath,
            domain
        });
    });

    $(document).on("mouseleave", ".tag-chip", async function () {

        const [tab] = await chrome.tabs.query({
            active: true,
            currentWindow: true
        });

        chrome.tabs.sendMessage(tab.id, {
            action: "remove-highlight"
        });

    });

    const modal = new bootstrap.Modal(
        document.getElementById("excludedModal")
    );


     $("#view-hide").on("click", async function () {
        const [tab] = await chrome.tabs.query({
            active: true,
            currentWindow: true
        });

        chrome.tabs.sendMessage(tab.id, {
            action: "HIDE_CHECK_MY_LINK"
        });
    });

    $("#cmlExcludeBtn").on("click", async function () {
        const [tab] = await chrome.tabs.query({
            active: true,
            currentWindow: true
        });
        chrome.tabs.sendMessage(tab.id, {
            action: "START_EXCLUDE_MODE"
        });
    });

    $("#view-excluded").on("click", function () {
        loadSavedElements();
        modal.show();
        $('#feature-message').html("").slideUp();
    });
    
     $(".btn-close").on("click", function () {
        modal.hide();
    });


    const labelSaveTimers = {};

    $(document).on("input", ".element-label", function () {

        const domain = $(this).data("domain");
        const xpath = decodeURIComponent($(this).data("xpath"));
        const label = $(this).val();
        const key = domain + "|" + xpath;

        clearTimeout(labelSaveTimers[key]);

        labelSaveTimers[key] = setTimeout(() => {

            chrome.storage.local.get(["all-sections"], function (result) {

                const allSections = result["all-sections"] || {};

                if (!allSections[domain]) {
                    return;
                }

                const item = allSections[domain].find(
                    x => x.xpath === xpath
                );

                if (item) {
                    item.label = label;

                    chrome.storage.local.set({
                        "all-sections": allSections
                    });
                }

            });

        }, 300);

    });

    // ==================================
// Delete Element
// ==================================

$(document).on("click", ".delete-item", function () {

    const domain = $(this).data("domain");
    const index = Number($(this).data("index"));

    chrome.storage.local.get(
        ["all-sections"],
        function(result) {

            const allSections =
                result["all-sections"] || {};

            if (!Array.isArray(allSections[domain])) {
                return;
            }

            allSections[domain].splice(index, 1);

            if (allSections[domain].length === 0) {
                delete allSections[domain];
            }

            chrome.storage.local.set(
                {
                    "all-sections": allSections
                },
                function() {
                    loadSavedElements();
                }
            );

        }
    );

});

});

function loadSavedElements() {

    chrome.storage.local.get(
        ["all-sections"],
        function(result) {

            console.log(result);

            const allSections = result["all-sections"] || {};

            const $container = $("#savedElements");

            $container.empty();

            const domains = Object.keys(allSections);

            if (!domains.length) {

                $container.html(`
                    <div class="alert alert-secondary mb-0">
                        No excluded elements found
                    </div>
                `);

                return;
            }

            $.each(domains, function(_, domain) {
                console.log(domain);
                const items =
                    allSections[domain];

                let html = `
<div class="website-card">

    <div class="website-header">

        <span class="website-name">
            ${domain}
        </span>

        <span class="count-badge">
            ${items.length}
        </span>

    </div>

    <div class="website-body">
`;

               $.each(items, function (_, item) {

    const tagName = item.tag
        ? item.tag.toLowerCase()
        : "element";

    html += `
<div class="exclude-row">

    <input
        type="text"
        class="element-label"
        data-domain="${domain}"
        data-xpath="${encodeURIComponent(item.xpath)}"
        placeholder="Enter label"
        value="${item.label || ""}"
    >

    <span class="tag-chip">
        ${tagName}
    </span>

   

    <button
        class="delete-item"
        data-domain="${domain}"
        data-xpath="${encodeURIComponent(item.xpath)}"
        title="Delete">

        <img src="../img/delete_black.svg" alt="Delete" class="delete-icon">

    </button>

</div>
`;
});

               html += `
    </div>
</div>
`;

                $container.append(html);

            });

        }
    );

}


function  disableExcludeMode(domain) {
    var wrapOne = document.getElementById("cmlExcludeWrap");
    let btnext  = document.getElementById("cmlExcludeBtn");
    btnext.classList.toggle("cml-active", false);
    wrapOne.classList.toggle("cml-on", false);
    btnext.setAttribute("aria-pressed", String(false));
   // $('#exclude-messsage').text("This section has been added.").css('color','green').slideDown();


    setTimeout(()=>{
         $(".exclude-row.highlight-border").removeClass("highlight-border");

        let $input = $('.element-label[data-domain="' + domain + '"]').last();

        if ($input.length) {
            let $row = $input.closest(".exclude-row");

            $row.addClass("highlight-border");

            $input.focus();

            $("html, body").animate({
                scrollTop: $row.offset().top - 100
            }, 300);
        }
    },500)

    setTimeout(()=>{
       // $('#exclude-messsage').slideUp();
        $(".exclude-row.highlight-border").removeClass("highlight-border");
    },4000)
}