/* Page shell: highlights the sidebar link of the section being read. Purely visual; the page works without it. */
(function () {
  "use strict";
  var links = [].slice.call(document.querySelectorAll(".nav .links a[data-nav]")); if (!links.length || !("IntersectionObserver" in window)) return;
  var byId = {}; links.forEach(function (a) { byId[a.getAttribute("data-nav")] = a; });
  var seen = {};
  function mark() {
    var best = null; Object.keys(seen).forEach(function (id) { if (seen[id] > 0 && (!best || seen[id] > seen[best])) best = id; });
    links.forEach(function (a) { var on = best && byId[best] === a; a.classList.toggle("active", !!on); if (on) a.setAttribute("aria-current", "true"); else a.removeAttribute("aria-current"); });
  }
  var io = new IntersectionObserver(function (es) { es.forEach(function (e) { seen[e.target.id] = e.isIntersecting ? e.intersectionRatio : 0; }); mark(); }, { threshold: [0, .1, .25, .5, .75] });
  Object.keys(byId).forEach(function (id) { var s = document.getElementById(id); if (s) io.observe(s); });
})();
