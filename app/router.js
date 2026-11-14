/* Page router: one HTML file, several "pages" (views) chosen by the address after #.
 *   #/  #/about  #/features  #/how  #/data  #/contact      the public website
 *   #/app  #/app/planner  #/app/explore  #/app/scoring      the tool (sidebar layout)
 * A link with ?lat= / ?loc= and no # (a shared result) opens the tool. Purely navigation: all the tool's logic lives in app.js. */
(function () {
  "use strict";
  var TITLES = { app: "app.overview", "app/planner": "app.planner", "app/explore": "app.explore", "app/scoring": "app.scoring" };
  var views = [].slice.call(document.querySelectorAll(".view")), known = {};
  views.forEach(function (v) { known[v.getAttribute("data-route")] = v; });
  var topright = document.getElementById("topright"), home = topright && topright.parentNode, slot = document.getElementById("topslot");

  function parse() {
    var h = (location.hash || "").replace(/^#\/?/, "").replace(/\/+$/, "");
    // a shared result link has place parameters and NO hash at all; an explicit "#/" always means the home page
    if (!location.hash && /[?&](loc|lat|lon)=/.test(location.search)) h = "app";
    if (!h) h = "home";
    return known[h] ? h : "home";
  }
  function show() {
    var r = parse(), isApp = r.indexOf("app") === 0;
    views.forEach(function (v) { v.hidden = v.getAttribute("data-route") !== r; });
    document.body.classList.toggle("mode-app", isApp); document.body.classList.toggle("mode-site", !isApp);
    document.getElementById("site").hidden = isApp; document.getElementById("appshell").hidden = !isApp;
    if (topright) (isApp ? slot : home).appendChild(topright);
    [].forEach.call(document.querySelectorAll("[data-route-link]"), function (a) {
      var on = a.getAttribute("data-route-link") === r; a.classList.toggle("active", on); if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    var title = document.getElementById("apptitle");
    if (title && TITLES[r]) { title.setAttribute("data-i18n", TITLES[r]); if (window.I18N) title.textContent = I18N.t(TITLES[r]); }
    window.scrollTo(0, 0);
    // the map was laid out while hidden or at another size; Leaflet must measure it again once it is visible
    setTimeout(function () { try { if (window.CropMap && CropMap.instance && CropMap.instance.map) CropMap.instance.map.invalidateSize(); } catch (e) {} }, 60);
    document.dispatchEvent(new CustomEvent("routechange", { detail: { route: r } }));
  }
  window.Router = { current: parse, go: function (r) { location.hash = "#/" + (r === "home" ? "" : r); } };
  window.addEventListener("hashchange", show);
  show();
})();
