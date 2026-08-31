var allUrlsArray=[],validStatusList=[200,300,301,307,404,201],AutoRunning=!1,automationArray=[],automationIndex=0,dublicateCounter=0;$(document).ready(function(){0==AutoRunning&&($(".state-btns").hide(),$("#startBtn").show());$(document).on("click","#stopBtn",function(){console.log("Stop button clicked");AutoRunning=!1;$(".state-btns").hide();$("#startBtn").show()})});
chrome.runtime.onMessage.addListener((c,d,a)=>{"backHttp"===c.action?(d=allUrlsArray.map((b,e)=>b[0]===c.currentUrl?e:-1).filter(b=>-1!==b),d.length&&(allUrlsArray[d[0]][1]==c.status?setTimeout(()=>{AutoRunning?automationArray[automationIndex][0]==c.currentUrl&&(automationIndex+=1,automationIndex>=automationArray.length?($(".state-btns").hide(),closeTab(c.trackingWindowId),AutoRunning=!1):(document.getElementById("modalText").innerHTML=`Total unique invalid urls: ${automationArray.length}<br>Processed urls: ${automationIndex+
1}`,AutoRunning&&chrome.runtime.sendMessage({action:"getstatusMulti",url:automationArray[automationIndex][0]}))):closeTab(c.trackingWindowId)},1E3):AutoRunning?automationArray[automationIndex][0]==c.currentUrl&&(automationIndex+=1,automationIndex>=automationArray.length?($(".state-btns").hide(),closeTab(c.trackingWindowId),AutoRunning=!1):(document.getElementById("modalText").innerHTML=`Total unique invalid urls: ${automationArray.length}<br>Processed urls: ${automationIndex+1}`,AutoRunning&&chrome.runtime.sendMessage({action:"getstatusMulti",
url:automationArray[automationIndex][0]}))):closeTab(c.trackingWindowId),d.forEach(b=>{allUrlsArray[b][1]=c.status}),updateTable())):"displayreport"===c.action&&(allUrlsArray=c.data,$("#target-tab").html(c.targetTab),updateTable())});function closeTab(c){chrome.tabs.remove(c,function(){console.log("Tab closed successfully")})}
$(document).on("click",".get-http-status",function(){$(this).prop("disabled",!0).text("Fetching Http Code");const c=$(this).attr("data-href");chrome.runtime.sendMessage({action:"getstatus",url:c})});function updateTable(){if(0==allUrlsArray.length)return!1;rendertable(allUrlsArray);$(".total-urls").text("Total Urls: "+allUrlsArray.length)}
// Excel export: originally DataTables Buttons' own built-in extend:"excel"
// button, which produced one flat sheet, included a "Label" column (just
// truncated, frequently non-Latin anchor text — not a meaningful field),
// and mangled non-Latin characters in that column on export. Replaced
// with a custom button built on the same MiniXlsx library the rest of
// QA ToolKit's Excel exports use, so this file gets the same navy-header
// theme and genuinely correct UTF-8 handling (MiniXlsx writes inline
// strings directly as UTF-8 XML text, with no intermediate encoding
// step that could corrupt non-Latin characters the way DataTables'
// own Excel button did).
//
// Split rule matches the table's own existing visual classification
// exactly (see the getstatus-btn/view-btn styling in rendertable()
// below): a row is "valid" if its status is a finite number in
// [200, 400); anything else (0/unchecked, >=400, or non-numeric) is
// "invalid". Rows with an empty status are excluded from both sheets,
// matching the table's own filter for entries with `""!=e[0]`... no —
// actually every row here always has a real url, so nothing is
// dropped; the split only concerns which of the two sheets a row lands
// in, not whether it's included at all.
function isRowValid(status) {
  return !isNaN(status) && status !== "" && Number(status) >= 200 && Number(status) < 400;
}

function exportToExcel() {
  if (!allUrlsArray.length) return;
  const headers = ["Status code", "Url"];
  const validRows = [headers];
  const invalidRows = [headers];
  allUrlsArray.forEach((entry) => {
    const url = entry[0], status = entry[1];
    const row = [typeof status === "number" ? status : (isNaN(status) ? String(status) : Number(status)), url];
    (isRowValid(status) ? validRows : invalidRows).push(row);
  });

  const sheets = [
    { name: "Valid Links", rows: validRows, headerRowCount: 1 },
    { name: "Invalid Links", rows: invalidRows, headerRowCount: 1 }
  ];
  const bytes = MiniXlsx.buildXlsxMultiSheet(sheets);
  const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `CheckMyLinks_${Date.now()}.xlsx`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function rendertable(c){var d=$("#example").DataTable();d.destroy();d=$("#example").DataTable({pageLength:25,data:c,dom:"Bfrtip",buttons:[{extend:"csv",exportOptions:{columns:[1,0,2],format:{body:function(a,b,e,f){return 0===e?$(a).data("href")||a:a}}}},{extend:"copy",exportOptions:{columns:[1,0,2],format:{body:function(a,b,e,f){return 0===e?$(a).data("href")||a:a}}}},{text:"Excel",action:function(){exportToExcel();}},"print"],createdRow:function(a,
b,e){$(a).addClass("table-items")},columns:[{title:"URL",render:function(a,b,e,f){b=a;50<a.length&&(b=a.substring(0,50)+"...");return'<span title="Click to copy" class="url-text" data-href="'+a+'">'+b+"</span>"}},{title:"Status Code"},{title:"Label",render:function(a,b,e,f){b=a;50<a.length&&(b=a.substring(0,50)+"...");return b}},{title:"Action",render:function(a,b,e,f){a=e[1];if(""!=e[0])return 0===$('#status-filter option[value="'+a+'"]').length&&$("#status-filter").append('<option value="'+a+'">'+
a+"</option>"),a="",b=e[1],f="btn-outline-success",0==b?(a='<button  data-href="'+e[0]+'" class="ml-2 getstatus-btn get-http-status btn btn-outline-warning">Recheck Http Status Code</button>',f="btn-outline-danger"):!isNaN(b)&&200<=b&&300>b||!isNaN(b)&&300<=b&&400>b||!isNaN(b)&&200<=b&&400>b||(a='<button  data-href="'+e[0]+'" class="ml-2 getstatus-btn get-http-status btn btn-outline-warning">Recheck Http Status Code</button>',f="btn-outline-danger"),'<button class="btn btn-outline-info click-to-copy">Copy Url</button><a target="_blank"  href="'+
e[0]+'"><button class="view-btn btn '+f+'">View</button></a>'+a}}],autoWidth:!1,columnDefs:[{width:"50%",targets:0},{width:"10%",targets:1},{width:"10%",targets:2},{width:"30%",targets:3}]});$("#status-filter").on("change",function(){var a=$(this).val();a?d.column(1).search("^"+a+"$",!0,!1).draw():d.column(1).search("").draw()});$(document).on("click",".click-to-copy",function(){const a=$(this).closest("tr").find(".url-text").data("href"),b=$("<textarea>");$("body").append(b);b.val(a).select();document.execCommand("copy");
b.remove();$(this).text("Copied");setTimeout(()=>{$(this).text("Copy Url")},2E3)})}
document.getElementById("startBtn").addEventListener("click",function(){console.log("Start button clicked");dublicateCounter=0;automationArray=[];allUrlsArray.forEach(function(c){let d=c[1],a=[];!isNaN(d)&&200<=d&&300>d&&0===a.length||!isNaN(d)&&300<=d&&400>d&&0===a.length||!isNaN(d)&&200<=d&&400>d||(automationArray.some(b=>b[0]===c[0])?dublicateCounter+=1:automationArray.push(c))});automationIndex=0;document.getElementById("modalText").innerHTML=`Total unique invalid urls: ${automationArray.length}<br>Processed urls: ${0}`;
$("#dublicate-urls").text("Duplicate urls: "+dublicateCounter);AutoRunning=!0;chrome.runtime.sendMessage({action:"getstatus",url:automationArray[automationIndex][0]});$(".state-btns").show();$("#startBtn").hide()});
// resumeBtn/pauseBtn addEventListener calls removed here: those two buttons
// are commented out in links.html (the pause/resume feature was never
// wired up beyond a console.log), so attaching listeners to them threw
// "Cannot read properties of null" on every load of this page — a
// pre-existing bug in the original extension, not something this merge
// introduced. Fixed by removing the dead calls rather than null-guarding
// references to UI that doesn't exist.
