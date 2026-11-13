/* Tiny i18n engine. Dictionaries live in i18n/<code>.js and call I18N.add(code, {...}).
 * English is bundled; other languages load on demand. Missing keys fall back to English. */
(function (root) {
  "use strict";
  var LANGS = [
    { code: "en", name: "English", dir: "ltr" }, { code: "ur", name: "اردو", dir: "rtl" },
    { code: "hi", name: "हिन्दी", dir: "ltr" }, { code: "ar", name: "العربية", dir: "rtl" },
    { code: "bn", name: "বাংলা", dir: "ltr" }, { code: "es", name: "Español", dir: "ltr" },
    { code: "fr", name: "Français", dir: "ltr" }, { code: "pt", name: "Português", dir: "ltr" },
    { code: "sw", name: "Kiswahili", dir: "ltr" }, { code: "zh", name: "中文", dir: "ltr" }
  ];
  var dicts = {}, cur = "en";
  // Extra web fonts for scripts that system fonts may render poorly; loaded only when that language is chosen.
  var FONTS = { ur: "Noto+Naskh+Arabic:wght@400;600;700", ar: "Noto+Sans+Arabic:wght@400;600;700", hi: "Noto+Sans+Devanagari:wght@400;600;700",
    bn: "Noto+Sans+Bengali:wght@400;600;700", zh: "Noto+Sans+SC:wght@400;500;700" };

  function add(code, d) { dicts[code] = d; }
  function t(key, p) {
    var s = dicts[cur] && dicts[cur][key];
    if (s == null) s = dicts.en && dicts.en[key];
    if (s == null) return key;
    return p ? s.replace(/\{(\w+)\}/g, function (m, k) { return p[k] != null ? p[k] : m; }) : s;
  }
  function info(code) { return LANGS.filter(function (l) { return l.code === code; })[0]; }
  function load(code) {
    if (dicts[code]) return Promise.resolve();
    return new Promise(function (res, rej) {
      var s = document.createElement("script"); s.src = "i18n/" + code + ".js";
      s.onload = res; s.onerror = function () { rej(new Error("Could not load language " + code)); };
      document.head.appendChild(s);
    });
  }
  function font(code) {
    if (!FONTS[code] || document.getElementById("font-" + code)) return;
    var l = document.createElement("link"); l.id = "font-" + code; l.rel = "stylesheet";
    l.href = "https://fonts.googleapis.com/css2?family=" + FONTS[code] + "&display=swap"; document.head.appendChild(l);
  }
  function set(code) {
    return load(code).then(function () { cur = code; font(code); }).catch(function () { cur = "en"; });
  }
  function detect() {
    try { var q = new URLSearchParams(location.search).get("lang"); if (q && info(q)) return q; } catch (e) {}
    try { var s = localStorage.getItem("rx_lang"); if (s && info(s)) return s; } catch (e) {}
    var nav = (navigator.languages || [navigator.language || "en"]);
    for (var i = 0; i < nav.length; i++) { var c = String(nav[i]).slice(0, 2).toLowerCase(); if (info(c)) return c; }
    return "en";
  }
  function remember(code) { try { localStorage.setItem("rx_lang", code); } catch (e) {} }

  var api = { LANGS: LANGS, add: add, t: t, set: set, detect: detect, remember: remember, info: info,
    lang: function () { return cur; }, dir: function () { return (info(cur) || {}).dir || "ltr"; }, _dicts: dicts };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.I18N = api;
})(typeof window !== "undefined" ? window : globalThis);
