/* Interrupted Goode Homolosine (the projection ISRIC's SoilGrids tiles use), WGS84 sphere radius.
 * proj4js has no 'igh', so this is our own implementation: sinusoidal below 40.7366 degrees, Mollweide above, six lobes.
 * The lobe offsets and the Mollweide correction were fitted to PROJ's output and checked on 40,160 worldwide points
 * (median error 0 m, maximum 55 m, none over half a 250 m pixel): see tests/igh.test.js and tests/fixtures/igh_truth.json. */
(function (root) {
  "use strict";
  var R = 6378137, D = Math.PI / 180, PHI_LIM = 0.71093078197902358062, Y_COR = 0.0528035;
  var CM = [-100, 30, -160, -60, 20, 140];                               // central meridian of each lobe
  var XOFF = [-11131949.079, 3339584.724, -17811118.527, -6679169.448, 2226389.816, 15584728.711];
  function moll(lam, phi) {
    var k = Math.PI * Math.sin(phi), t = phi, i, d;
    for (i = 0; i < 50; i++) { d = (2 * t + Math.sin(2 * t) - k) / (2 + 2 * Math.cos(2 * t)); if (!isFinite(d)) break; t -= d; if (Math.abs(d) < 1e-14) break; }
    if (Math.abs(Math.abs(phi) - Math.PI / 2) < 1e-9) t = (phi > 0 ? 1 : -1) * Math.PI / 2;
    return [2 * Math.SQRT2 / Math.PI * lam * Math.cos(t), Math.SQRT2 * Math.sin(t)];
  }
  function zone(lon, lat) { if (lat >= 0) return lon < -40 ? 0 : 1; return lon < -100 ? 2 : lon < -20 ? 3 : lon < 80 ? 4 : 5; }
  function forward(lon, lat) {
    var z = zone(lon, lat), phi = lat * D, lam = (lon - CM[z]) * D, x, y, m;
    if (Math.abs(phi) <= PHI_LIM) { x = lam * Math.cos(phi); y = phi; }
    else { m = moll(lam, phi); x = m[0]; y = m[1] - (phi >= 0 ? Y_COR : -Y_COR); }
    return [R * x + XOFF[z], R * y];
  }
  var api = { forward: forward };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.IGH = api;
})(typeof window !== "undefined" ? window : globalThis);
