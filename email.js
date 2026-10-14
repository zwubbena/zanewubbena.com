// Build email links in the browser so the address is not in the page source.
document.querySelectorAll(".em").forEach(function (e) {
  var addr = e.getAttribute("data-u") + "@" + e.getAttribute("data-d");
  var a = document.createElement("a");
  a.href = "mailto:" + addr;
  a.textContent = addr;
  if (e.getAttribute("data-s")) a.setAttribute("style", e.getAttribute("data-s"));
  e.replaceWith(a);
});
