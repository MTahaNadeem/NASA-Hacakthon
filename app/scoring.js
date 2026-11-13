/* Rotation Explorer scoring engine.
 * Rule-based and explainable: no machine learning. Every factor is scored 0-1
 * per rotation per historical year, then combined with slider weights:
 *   S[r,y] = sum_f w_f * s[f,r,y],  sum_f w_f = 1
 * Works in the browser (window.Scoring) and in Node (module.exports).
 */
(function (root) {
  "use strict";

  var FACTORS = [
    { id: "water", label: "Water demand vs. supply", slider: "water",
      data: "NASA POWER rainfall (+ SMAP root-zone moisture)",
      rule: "Effective rain (80% of rain in the crop's growing months, adjusted by SMAP moisture) is compared with the crop's water need. Score = 1 - unmet need / need." },
    { id: "heat", label: "Heat and frost exposure", slider: "income",
      data: "NASA POWER daily Tmax/Tmin",
      rule: "Heat days (Tmax >= 35 C) in the crop's heat-sensitive months and frost days (Tmin <= 0 C) in its frost-sensitive months, weighted by crop sensitivity. Score = 1 - exposure / 20." },
    { id: "bare", label: "Bare-field exposure", slider: "soil",
      data: "MODIS NDVI (month is 'bare' if long-term NDVI < threshold and no crop is growing)",
      rule: "Months with no crop growing and low NDVI count as bare. Score = 1 - bare months / 8." },
    { id: "fit", label: "Soil fit", slider: "soil",
      data: "SoilGrids pH and clay (5th/50th/95th percentile)",
      rule: "Score falls linearly as soil pH leaves the crop's pH range (zero at 1.5 units away) and as clay leaves its range (zero at 20 points away). Mean of the two." },
    { id: "soc", label: "Soil organic carbon effect", slider: "soil",
      data: "SoilGrids SOC + crop type (legume / cereal / oilseed)",
      rule: "Score = 0.5 + 0.35 x crop SOC effect x (1 + low-SOC boost). Legumes (+) help more, and cereals (-) hurt more, when soil carbon is already low." },
    { id: "rain", label: "Extreme-rain risk", slider: "income",
      data: "GPM IMERG daily rain >= 50 mm (POWER used if IMERG is missing)",
      rule: "Extreme-rain days in the crop's rain-sensitive months, weighted by crop sensitivity. Score = 1 - exposure / 4." }
  ];

  var SLIDERS = ["water", "income", "soil"];

  function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
  function mean(a) { return a.length ? a.reduce(function (s, v) { return s + v; }, 0) / a.length : NaN; }
  function pct(sorted, p) {
    if (!sorted.length) return NaN;
    var idx = (sorted.length - 1) * p, lo = Math.floor(idx), hi = Math.ceil(idx);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }

  // Months a crop is in the field, handling year wrap (e.g. sow 11, harvest 4).
  function growingMonths(c) {
    var out = [], m = c.sow;
    for (var i = 0; i < 12; i++) {
      out.push(m);
      if (m === c.harvest) break;
      m = m % 12 + 1;
    }
    return out;
  }

  // Sum a [year][12] monthly series over a list of 1-based months.
  function sumMonths(series, y, months) {
    return months.reduce(function (s, m) { return s + (series[y][m - 1] || 0); }, 0);
  }

  function distOutside(v, range) {
    if (v < range[0]) return range[0] - v;
    if (v > range[1]) return v - range[1];
    return 0;
  }

  function fitScore(crop, soil, phV, clayV) {
    var parts = [];
    if (phV != null) parts.push(1 - clamp(distOutside(phV, crop.ph) / 1.5, 0, 1));
    if (clayV != null) parts.push(1 - clamp(distOutside(clayV, crop.clay) / 20, 0, 1));
    return parts.length ? mean(parts) : null;
  }

  function socScore(crop, socGperKg) {
    if (socGperKg == null) return null;
    var lowBoost = Math.max(0, 1 - socGperKg / 15);
    return clamp(0.5 + 0.35 * crop.soc_effect * (1 + lowBoost), 0, 1);
  }

  // Rain the crop can actually use: 80% of rain in its growing months, nudged by SMAP root-zone moisture when available.
  function effectiveSupply(crop, data, y) {
    var months = growingMonths(crop), rain = sumMonths(data.climate.rain, y, months), smapAdj = 1;
    if (data.smap_clim) {
      var sm = mean(months.map(function (m) { return data.smap_clim[m - 1]; }).filter(function (v) { return v != null; }));
      if (!isNaN(sm)) smapAdj = clamp(1 + (sm - 0.25) * 0.6, 0.85, 1.15);
    }
    return rain * 0.8 * smapAdj;
  }

  // Typical water gap in mm per year: what rain does not cover (the irrigation need if irrigated).
  function irrigationNeed(rot, cfg, data) {
    var tot = 0, n = 0;
    for (var y = 0; y < data.years.length; y++) rot.cycle.forEach(function (plan) {
      var gap = 0; plan.forEach(function (cid) { var c = cfg.crops[cid]; gap += Math.max(0, c.water_mm - effectiveSupply(c, data, y)); });
      tot += gap; n++;
    });
    return n ? tot / n : NaN;
  }

  // Score one crop in one year (index y into data.years). Returns factor -> 0..1 or null if no data.
  // soilMode: "low" | "mid" | "high" -- low = worst-case soil values, high = best-case.
  function cropFactors(crop, data, y, soilMode) {
    var months = growingMonths(crop);
    var out = {};

    // water
    out.water = 1 - clamp((crop.water_mm - effectiveSupply(crop, data, y)) / crop.water_mm, 0, 1);

    // heat / frost
    var heat = sumMonths(data.climate.heat_days, y, crop.heat_months) * crop.heat_sens;
    var frost = sumMonths(data.climate.frost_days, y, crop.frost_months) * crop.frost_sens;
    out.heat = 1 - clamp((heat + frost) / 20, 0, 1);

    // extreme rain
    var ext = sumMonths(data.climate.extreme_days, y, crop.rain_months) * crop.rain_sens;
    out.rain = 1 - clamp(ext / 4, 0, 1);

    // soil: pessimistic = worst of the two percentile ends, optimistic = best.
    var soil = data.soil || {};
    if (soil.ph && soil.clay) {
      var ends = [[soil.ph.q05, soil.clay.q05], [soil.ph.q05, soil.clay.q95],
                  [soil.ph.q95, soil.clay.q05], [soil.ph.q95, soil.clay.q95]]
        .map(function (p) { return fitScore(crop, soil, p[0], p[1]); });
      if (soilMode === "mid") out.fit = fitScore(crop, soil, soil.ph.mean, soil.clay.mean);
      else out.fit = soilMode === "low" ? Math.min.apply(null, ends) : Math.max.apply(null, ends);
    } else out.fit = null;

    if (soil.soc) {
      var v = soilMode === "mid" ? soil.soc.mean : (soilMode === "low" ? soil.soc.q05 : soil.soc.q95);
      // Whether low or high carbon is "worse" depends on crop type; evaluate both ends.
      var a = socScore(crop, soil.soc.q05), b = socScore(crop, soil.soc.q95);
      out.soc = soilMode === "mid" ? socScore(crop, soil.soc.mean)
        : (soilMode === "low" ? Math.min(a, b) : Math.max(a, b));
    } else out.soc = null;

    return out;
  }

  // Bare-field score for one annual plan (list of crop ids).
  function bareScore(plan, crops, data, threshold) {
    var covered = {};
    plan.forEach(function (id) { growingMonths(crops[id]).forEach(function (m) { covered[m] = true; }); });
    if (!data.ndvi_clim) return null;
    var bare = 0;
    for (var m = 1; m <= 12; m++) {
      if (!covered[m] && data.ndvi_clim[m - 1] != null && data.ndvi_clim[m - 1] < threshold) bare++;
    }
    return 1 - clamp(bare / 8, 0, 1);
  }

  // Normalised weights per factor from the three sliders (each 0..1).
  // Rain-fed farms cannot trade water use for anything: a water gap there is yield risk, so it moves to the income slider.
  function sliderOf(f, irrigation) { return (f.id === "water" && irrigation === "rainfed") ? "income" : f.slider; }

  function weightsFromSliders(sl, availableFactorIds, irrigation) {
    var groups = { water: [], income: [], soil: [] };
    FACTORS.forEach(function (f) {
      if (!availableFactorIds || availableFactorIds.indexOf(f.id) >= 0) groups[sliderOf(f, irrigation)].push(f.id);
    });
    var w = {}, total = 0;
    SLIDERS.forEach(function (s) {
      var g = groups[s];
      g.forEach(function (id) { w[id] = (sl[s] || 0) / g.length; total += w[id]; });
    });
    if (total === 0) { // all sliders at zero: fall back to equal weights
      var ids = Object.keys(w);
      ids.forEach(function (id) { w[id] = 1 / ids.length; });
      return w;
    }
    Object.keys(w).forEach(function (id) { w[id] /= total; });
    return w;
  }

  // Per-year score S[r,y] for a rotation (average over every phase of the cycle in that year).
  function yearScores(rot, cfg, data, weights, soilMode) {
    var out = [];
    for (var y = 0; y < data.years.length; y++) {
      var phaseScores = [];
      rot.cycle.forEach(function (plan) {
        var perFactor = {};
        FACTORS.forEach(function (f) { perFactor[f.id] = []; });
        plan.forEach(function (cid) {
          var cf = cropFactors(cfg.crops[cid], data, y, soilMode);
          Object.keys(cf).forEach(function (k) { if (cf[k] != null) perFactor[k].push(cf[k]); });
        });
        var b = bareScore(plan, cfg.crops, data, cfg.bare_ndvi_threshold);
        if (b != null) perFactor.bare.push(b);
        var s = 0, wsum = 0;
        FACTORS.forEach(function (f) {
          if (perFactor[f.id].length && weights[f.id] != null) { s += weights[f.id] * mean(perFactor[f.id]); wsum += weights[f.id]; }
        });
        phaseScores.push(wsum ? s / wsum : NaN);
      });
      out.push(mean(phaseScores));
    }
    return out;
  }

  function availableFactors(data) {
    var ids = ["water", "heat", "rain"];
    if (data.ndvi_clim) ids.push("bare");
    if (data.soil && data.soil.ph && data.soil.clay) ids.push("fit");
    if (data.soil && data.soil.soc) ids.push("soc");
    return ids;
  }

  function rangesOverlap(a, b) {
    var lo = Math.max(a.low, b.low), hi = Math.min(a.high, b.high);
    if (hi <= lo) return 0;
    var narrow = Math.min(a.high - a.low, b.high - b.low);
    return narrow <= 0 ? 1 : (hi - lo) / narrow;
  }

  // Main entry. Returns rotations ranked by mean score, with ranges and "no clear winner" ties.
  function rankRotations(cfg, data, rotationIds, sliders, opts) {
    opts = opts || {};
    var avail = availableFactors(data);
    var weights = weightsFromSliders(sliders, avail, opts.irrigation);
    var results = rotationIds.map(function (id) {
      var rot = cfg.rotations[id];
      var mid = yearScores(rot, cfg, data, weights, "mid");
      var lo = yearScores(rot, cfg, data, weights, "low");
      var hi = yearScores(rot, cfg, data, weights, "high");
      var sm = mid.slice().sort(function (a, b) { return a - b; });
      var sl = lo.slice().sort(function (a, b) { return a - b; });
      var sh = hi.slice().sort(function (a, b) { return a - b; });
      return {
        id: id, label: rot.label,
        mean: mean(mid),
        low: pct(sl, 0.10),   // pessimistic soil, bad years
        high: pct(sh, 0.90),  // optimistic soil, good years
        yearScores: mid
      };
    });
    results.sort(function (a, b) { return b.mean - a.mean; });
    var top = results[0];
    results.forEach(function (r, i) {
      r.rank = i + 1;
      r.overlapWithTop = i === 0 ? 1 : rangesOverlap(top, r);
      r.noClearWinner = i > 0 && r.overlapWithTop >= (opts.overlapThreshold || 0.7);
    });
    top.noClearWinner = results.slice(1).some(function (r) { return r.noClearWinner; });
    return { weights: weights, availableFactors: avail, results: results };
  }

  // Per-rotation breakdown used by cards: mean score of each factor, plus which crops drive it.
  function factorBreakdown(rot, cfg, data) {
    var rows = {};
    FACTORS.forEach(function (f) { rows[f.id] = []; });
    for (var y = 0; y < data.years.length; y++) {
      rot.cycle.forEach(function (plan) {
        var per = {}; FACTORS.forEach(function (f) { per[f.id] = []; });
        plan.forEach(function (cid) {
          var cf = cropFactors(cfg.crops[cid], data, y, "mid");
          Object.keys(cf).forEach(function (k) { if (cf[k] != null) per[k].push(cf[k]); });
        });
        var b = bareScore(plan, cfg.crops, data, cfg.bare_ndvi_threshold);
        if (b != null) per.bare.push(b);
        FACTORS.forEach(function (f) { if (per[f.id].length) rows[f.id].push(mean(per[f.id])); });
      });
    }
    var out = {};
    FACTORS.forEach(function (f) { out[f.id] = rows[f.id].length ? mean(rows[f.id]) : null; });
    return out;
  }

  // Confidence is about how far to trust a ranking, not about the crops: close calls, wide year-to-year ranges,
  // missing soil data and few data sources all lower it. With only POWER + SoilGrids it can never be "high".
  function confidence(res, data) {
    var reasons = [], pts = 0;
    if (res.noClearWinner) reasons.push("conf.r.tie"); else pts++;
    if (res.high - res.low > 0.25) reasons.push("conf.r.wide"); else pts++;
    if (!(data.soil && data.soil.ph)) reasons.push("conf.r.nosoil"); else pts++;
    var nsrc = Object.keys(data.sources || {}).filter(function (k) { return data.sources[k] && data.sources[k] !== "synthetic"; }).length;
    if (nsrc < 3) reasons.push("conf.r.fewdata"); else pts++;
    return { level: pts >= 4 ? "high" : (pts >= 3 ? "medium" : "low"), reasons: reasons };
  }

  function hasTemperatureScenario(d) { return !!(d.climate && d.climate.heat_by_dt && d.climate.frost_by_dt); }

  // What-if on the historical record. Rain is scaled. Warming of dT degrees C re-counts heat days against a threshold lowered
  // by dT (Tmax >= 35-dT) and frost days against Tmin <= -dT, using counts the pipeline stored from the real daily data.
  // Evaporation (water demand) is NOT adjusted.
  function applyScenario(d, rainPct, dT) {
    var warm = dT > 0 && hasTemperatureScenario(d) && d.climate.heat_by_dt[String(dT)] && d.climate.frost_by_dt[String(dT)];
    if (!rainPct && !warm) return d;
    var c = JSON.parse(JSON.stringify(d));
    if (rainPct) { var k = 1 + rainPct / 100; c.climate.rain = c.climate.rain.map(function (r) { return r.map(function (v) { return v * k; }); }); }
    if (warm) { c.climate.heat_days = c.climate.heat_by_dt[String(dT)]; c.climate.frost_days = c.climate.frost_by_dt[String(dT)]; }
    return c;
  }

  var api = {
    FACTORS: FACTORS, SLIDERS: SLIDERS,
    growingMonths: growingMonths, cropFactors: cropFactors, bareScore: bareScore,
    weightsFromSliders: weightsFromSliders, availableFactors: availableFactors,
    yearScores: yearScores, rankRotations: rankRotations, factorBreakdown: factorBreakdown,
    rangesOverlap: rangesOverlap, pct: pct, mean: mean,
    effectiveSupply: effectiveSupply, irrigationNeed: irrigationNeed, confidence: confidence, applyScenario: applyScenario, hasTemperatureScenario: hasTemperatureScenario, sliderOf: sliderOf
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Scoring = api;
})(typeof window !== "undefined" ? window : globalThis);
