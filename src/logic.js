/* ===== ABG logic: pure functions, no DOM. ===== */
var ABG = (function () {
  /* ---------- O2 requirement: mirrors the source sheet ("Shortcut version", steps 1–6 + O2 req) ---------- */
  var P_DRY = 713;          // 760 − 47 mmHg: sea-level barometric pressure minus water vapour at 37 °C
  var RQ = 0.8;             // respiratory quotient
  var NC_BASE = 20, NC_STEP = 4, NC_MAX_LPM = 6;   // nasal cannula: FiO2 % ≈ 20 + 4 × L/min, 1–6 L/min
  var NC_MAX_PCT = NC_BASE + NC_STEP * NC_MAX_LPM;  // 44 %
  var VENTURI_MAX = 60;
  var RA = 21;

  function ncToFio2(lpm) { return NC_BASE + NC_STEP * lpm; }       // percent
  function fio2ToNc(pct) { return (pct - NC_BASE) / NC_STEP; }     // L/min
  function ageTarget(age) { return 104 - 0.4 * age; }
  function expectedAa(age) { return age / 4 + 4; }

  // Accepts 21, 28.5 (percent) or 0.21, 0.285 (fraction). Returns percent, or null.
  function parseFio2(raw) {
    if (raw == null || raw === "") return null;
    var v = typeof raw === "number" ? raw : parseFloat(String(raw).replace(",", "."));
    if (!isFinite(v)) return null;
    return v <= 1 ? v * 100 : v;
  }

  function describeFio2(pct) {
    if (Math.abs(pct - RA) < 0.05) return { short: "room air", long: "room air (21%)" };
    var n = fio2ToNc(pct);
    if (n >= 1 && n <= NC_MAX_LPM && Math.abs(n - Math.round(n)) < 0.01) {
      return { short: "NC " + Math.round(n) + " L/min", long: "NC " + Math.round(n) + " L/min (" + fmt(pct, 0) + "%)" };
    }
    return { short: "FiO2 " + fmt(pct, 1) + "%", long: "FiO2 " + fmt(pct, 1) + "%" };
  }

  function fmt(n, d) {
    if (n == null || !isFinite(n)) return "—";
    var s = n.toFixed(d);
    if (d > 0 && /\.0+$/.test(s)) s = s.replace(/\.0+$/, "");
    return s === "-0" ? "0" : s;
  }

  /*
   * Shared validation (v16.2). One accepted range and one status per measurement, used by every module, so a value
   * rejected in one place can never enter a calculation somewhere else. Status: "valid", "invalid" (entered but outside
   * the accepted range: shown with a warning, never used) or "missing" (not entered: never treated as normal).
   */
  var LIM = { ph: [6.30, 8.00], paco2: [5, 200], pao2: [10, 700], fio2Pct: [21, 100], spo2: [50.5, 100], mv: [0.5, 59.99], mawp: [1, 60] };
  function vStat(key, v) {
    if (v == null || v === "" || typeof v === "number" && !isFinite(v)) return "missing";
    if (!isFinite(v)) return "invalid";
    var L = LIM[key];
    return L && (v < L[0] || v > L[1]) ? "invalid" : "valid";
  }
  function vOK(key, v) { return vStat(key, v) === "valid" ? +v : null; }
  // A pO2 above the alveolar pO2 (alveolar gas equation at sea level) is impossible: the same a/A > 1 rule calc() applies,
  // now shared by every module. Returns the alveolar pO2 when the pO2 is above it, otherwise null.
  function pao2AboveAlv(pao2, paco2, fio2Pct) {
    var p = vOK("pao2", pao2), c = vOK("paco2", paco2), f = vOK("fio2Pct", fio2Pct);
    if (p == null || c == null || f == null) return null;
    var A = P_DRY * f / 100 - c / RQ;
    return A > 0 && p / A > 1 ? A : null;
  }

  /*
   * inp: { pao2, paco2, fio2Pct, age, target }   (mmHg, mmHg, %, years, mmHg or null for age-based)
   * Returns null when inputs are incomplete; otherwise an object with every intermediate.
   */
  function calc(inp) {
    var pao2 = inp.pao2, paco2 = inp.paco2, fio2Pct = inp.fio2Pct, age = inp.age;
    var custom = inp.target != null;
    if ([pao2, paco2, fio2Pct].some(function (v) { return v == null || !isFinite(v); })) return null;
    if (!custom && (age == null || !isFinite(age))) return null;

    var r = { errors: [], warnings: [], custom: custom };
    if (pao2 < 10 || pao2 > 700) r.errors.push("pO₂ of " + fmt(pao2, 0) + " mmHg is outside 10–700. Check the entry.");
    if (paco2 < 5 || paco2 > 200) r.errors.push("pCO₂ of " + fmt(paco2, 0) + " mmHg is outside 5–200. Check the entry.");
    if (fio2Pct < 21 || fio2Pct > 100) r.errors.push("FiO₂ must be 21–100% (or 0.21–1.0).");
    if (age != null && isFinite(age) && (age < 0 || age > 120)) r.errors.push("Age must be 0–120 years.");
    if (custom && (inp.target < 30 || inp.target > 500)) r.errors.push("Custom target pO₂ must be 30–500 mmHg.");
    if (r.errors.length) return r;

    var fio2 = fio2Pct / 100;
    r.fio2Pct = fio2Pct;
    r.current = describeFio2(fio2Pct);
    r.paco2Term = paco2 / RQ;                            // step 1  (B7)
    r.PAO2 = P_DRY * fio2 - r.paco2Term;                 // step 2  (B8)  alveolar gas equation
    if (r.PAO2 <= 0) {
      r.errors.push("Alveolar PO₂ comes out at " + fmt(r.PAO2, 0) + " mmHg (713 × FiO₂ − pCO₂/0.8). Check pCO₂ and FiO₂.");
      return r;
    }
    r.aA = pao2 / r.PAO2;                                // step 3  (B9)
    if (r.aA > 1) {
      r.aboveAlv = true;   // shown as a note, not an error (v16.3); no a/A-based FiO2 estimate can be made
      r.errors.push("pO₂ " + fmt(pao2, 0) + " is above what FiO₂ " + fmt(fio2Pct, 0) + "% can give (alveolar ≈ " + fmt(r.PAO2, 0) + "), so the FiO₂ estimate cannot be calculated. The patient is probably on more oxygen than entered, or the sample has air: set the oxygen support to get it.");
      return r;
    }
    r.target = custom ? inp.target : ageTarget(age);     // step 4  (B10)
    if (r.target <= 0) { r.errors.push("Target pO₂ is not above 0. Check age."); return r; }
    r.step5 = r.target / r.aA + r.paco2Term;             // step 5  (B11)  = 713 × FiO2 needed
    r.fio2Req = r.step5 / P_DRY * 100;                   // step 6  (B12)  %
    r.lpm = fio2ToNc(r.fio2Req);                         // O2 req  (B13)  L/min by nasal cannula

    r.AaGrad = r.PAO2 - pao2;
    r.AaExpected = age != null && isFinite(age) ? expectedAa(age) : null;
    r.pf = pao2 / fio2;

    if (r.fio2Req <= RA) r.level = "ra";
    else if (r.fio2Req <= NC_MAX_PCT) r.level = "nc";
    else if (r.fio2Req <= 100) r.level = "high";
    else r.level = "over";

    var diff = (r.level === "ra" ? RA : r.fio2Req) - fio2Pct;
    r.change = Math.abs(diff) < 1 ? "same" : diff > 0 ? "up" : "down";

    if (age != null && isFinite(age) && age < 18 && !custom) r.warnings.push("The age-based target (104 − 0.4 × age) is an adult formula. Use a custom target for children.");
    if (paco2 > 45 && !custom) r.warnings.push("pCO₂ is " + fmt(paco2, 0) + ". If the patient is at risk of CO₂ retention (e.g. COPD), tick the CO₂-retention box: the aim becomes SpO₂ 88–92% (pO₂ about 60).");
    return r;
  }

  /* ---------- Acid–base: pH, PaCO2, HCO3 only (no Na, K, Cl) ---------- */
  var NORM = { phLo: 7.35, phHi: 7.45, co2Lo: 35, co2Hi: 45, hco3Lo: 22, hco3Hi: 26, ph: 7.40, co2: 40, hco3: 24 };
  var NAME = { "resp-acid": "respiratory acidosis", "resp-alk": "respiratory alkalosis", "met-acid": "metabolic acidosis", "met-alk": "metabolic alkalosis" };

  // Kassirer–Bleich form of Henderson–Hasselbalch: [H+] (nmol/L) = 24 × PaCO2 / HCO3
  function hco3FromPh(ph, paco2) { return 24 * paco2 / Math.pow(10, 9 - ph); }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  // Expected compensation for a single primary disorder. Returns { lines, verdict, extra, tone }.
  function compensation(primary, paco2, hco3) {
    var c = { primary: primary, hco3: hco3, paco2: paco2 };
    if (primary === "met-acid") {
      var e = 1.5 * hco3 + 8;                                   // Winter's formula ± 2
      c.kind = "Winter's formula"; c.formula = "Expected pCO₂ = 1.5 × HCO₃ + 8 ± 2";
      c.calc = "1.5 × " + fmt(hco3, 1) + " + 8 = " + fmt(e, 1) + " (" + fmt(e - 2, 1) + "–" + fmt(e + 2, 1) + ")";
      c.center = e; c.pm = 2; c.lo = e - 2; c.hi = e + 2; c.actual = "pCO₂ " + fmt(paco2, 1);
      if (paco2 > c.hi) { c.verdict = "pCO₂ is higher than expected: concurrent respiratory acidosis (inadequate respiratory compensation)."; c.extra = "resp-acid"; }
      else if (paco2 < c.lo) { c.verdict = "pCO₂ is lower than expected: concurrent respiratory alkalosis."; c.extra = "resp-alk"; }
      else c.verdict = "pCO₂ is in the expected range: appropriate respiratory compensation.";
    } else if (primary === "met-alk") {
      var m = 0.7 * hco3 + 20;                                  // ± 5
      c.kind = "Metabolic alkalosis rule"; c.formula = "Expected pCO₂ = 0.7 × HCO₃ + 20 ± 5";
      c.calc = "0.7 × " + fmt(hco3, 1) + " + 20 = " + fmt(m, 1) + " (" + fmt(m - 5, 1) + "–" + fmt(m + 5, 1) + ")";
      c.center = m; c.pm = 5; c.lo = m - 5; c.hi = m + 5; c.actual = "pCO₂ " + fmt(paco2, 1);
      if (paco2 > c.hi) { c.verdict = "pCO₂ is higher than expected: concurrent respiratory acidosis." + (paco2 > 55 ? " Compensation alone rarely takes pCO₂ above 55." : ""); c.extra = "resp-acid"; }
      else if (paco2 < c.lo) { c.verdict = "pCO₂ is lower than expected: concurrent respiratory alkalosis."; c.extra = "resp-alk"; }
      else c.verdict = "pCO₂ is in the expected range: appropriate respiratory compensation.";
    } else if (primary === "resp-acid") {
      var d = paco2 - NORM.co2, a = NORM.hco3 + 0.1 * d, ch = NORM.hco3 + 0.35 * d;
      c.kind = "Respiratory acidosis rule"; c.formula = "HCO₃ rises 1 per 10 mmHg pCO₂ (acute), 3.5 per 10 (chronic)";
      c.calc = "Expected HCO₃: acute " + fmt(a, 1) + " · chronic " + fmt(ch, 1) + " (± 2)";
      c.hco3 = hco3; c.paco2 = paco2; c.acute = a; c.chronic = ch; c.actual = "HCO₃ " + fmt(hco3, 1);
      if (hco3 < a - 2) { c.verdict = "HCO₃ is below the acute range: concurrent metabolic acidosis."; c.extra = "met-acid"; }
      else if (hco3 > ch + 2) { c.verdict = "HCO₃ is above the chronic range: concurrent metabolic alkalosis."; c.extra = "met-alk"; }
      else if (Math.abs(hco3 - a) <= 2 && Math.abs(hco3 - a) <= Math.abs(hco3 - ch)) { c.verdict = "Fits acute respiratory acidosis."; c.timing = "acute"; }
      else if (Math.abs(hco3 - ch) <= 2) { c.verdict = "Fits chronic respiratory acidosis."; c.timing = "chronic"; }
      else { c.verdict = "Between acute and chronic: acute-on-chronic, or renal compensation still under way (takes days)."; c.timing = "between"; }
    } else if (primary === "resp-alk") {
      var d2 = NORM.co2 - paco2, a2 = NORM.hco3 - 0.2 * d2, ch2 = NORM.hco3 - 0.4 * d2;
      c.kind = "Respiratory alkalosis rule"; c.formula = "HCO₃ falls 2 per 10 mmHg pCO₂ (acute), 4 per 10 (chronic)";
      c.calc = "Expected HCO₃: acute " + fmt(a2, 1) + " · chronic " + fmt(ch2, 1) + " (± 2)";
      c.hco3 = hco3; c.paco2 = paco2; c.acute = a2; c.chronic = ch2; c.actual = "HCO₃ " + fmt(hco3, 1);
      if (hco3 > a2 + 2) { c.verdict = "HCO₃ is above the acute range: concurrent metabolic alkalosis."; c.extra = "met-alk"; }
      else if (hco3 < ch2 - 2) { c.verdict = "HCO₃ is below the chronic range: concurrent metabolic acidosis."; c.extra = "met-acid"; }
      else if (Math.abs(hco3 - a2) <= 2 && Math.abs(hco3 - a2) <= Math.abs(hco3 - ch2)) { c.verdict = "Fits acute respiratory alkalosis."; c.timing = "acute"; }
      else if (Math.abs(hco3 - ch2) <= 2) { c.verdict = "Fits chronic respiratory alkalosis."; c.timing = "chronic"; }
      else { c.verdict = "Between acute and chronic: acute-on-chronic, or renal compensation still under way (takes days)."; c.timing = "between"; }
    } else return null;
    c.tone = c.extra ? "warn" : "ok";
    return c;
  }

  /* inp: { ph, paco2, hco3 (optional) } */
  function acidBase(inp) {
    var ph = inp.ph, paco2 = inp.paco2;
    if (ph == null || paco2 == null || !isFinite(ph) || !isFinite(paco2)) return null;
    var r = { errors: [], notes: [] };
    if (ph < 6.3 || ph > 8.0) r.errors.push("pH of " + fmt(ph, 2) + " is outside 6.30–8.00. Check the entry.");
    if (paco2 < 5 || paco2 > 200) r.errors.push("pCO₂ of " + fmt(paco2, 0) + " mmHg is outside 5–200. Check the entry.");
    if (inp.hco3 != null && (inp.hco3 < 2 || inp.hco3 > 60)) r.errors.push("HCO₃ of " + fmt(inp.hco3, 1) + " is outside 2–60. Check the entry.");
    if (r.errors.length) return r;
    if (ph < 6.8 || ph > 7.8) r.extreme = "pH " + fmt(ph, 2) + " is extreme: confirm the analyzer result (sample, air bubbles, calibration); it is interpreted as entered.";
    else if (paco2 < 10 || paco2 > 150) r.extreme = "pCO₂ " + fmt(paco2, 0) + " is extreme: confirm the analyzer result; it is interpreted as entered.";

    r.ph = ph; r.paco2 = paco2;
    r.hco3Calc = hco3FromPh(ph, paco2);
    r.hco3Entered = inp.hco3 != null;
    var hco3 = r.hco3 = r.hco3Entered ? inp.hco3 : r.hco3Calc;
    // An analyzer calculates HCO₃ from pH and pCO₂ (Henderson–Hasselbalch), so values from one gas agree within rounding.
    // v16.3 (user decision): a larger gap (often a chemistry bicarbonate) no longer pauses the reading. The gas is interpreted
    // with the values as entered, and the difference is shown as a quiet note with the calculated value.
    var dH = Math.abs(hco3 - r.hco3Calc);
    if (r.hco3Entered && (dH > 2 || (dH > 1 && dH / r.hco3Calc > 0.15))) {
      r.hco3Diff = { entered: hco3, calc: r.hco3Calc };
      r.notes.push({ tone: "", key: "hco3", text: "HCO₃ " + fmt(hco3, 1) + " as entered; pH and pCO₂ give " + fmt(r.hco3Calc, 1) + ". Interpreted with the entered value." });
    }

    var rA = paco2 > NORM.co2Hi, rB = paco2 < NORM.co2Lo, mA = hco3 < NORM.hco3Lo, mB = hco3 > NORM.hco3Hi;
    r.flags = { co2: rA ? "high" : rB ? "low" : "normal", hco3: mA ? "low" : mB ? "high" : "normal" };
    r.phStatus = ph < NORM.phLo ? "acidemia" : ph > NORM.phHi ? "alkalemia" : "normal";
    r.severe = ph < 7.20 || ph > 7.60;

    var primary = null, comp = null;
    if (r.phStatus === "acidemia") {
      if (rA && mA) primary = "mixed-acid";
      else if (rA) { primary = "resp-acid"; comp = mB ? "partial" : "un"; }
      else if (mA) { primary = "met-acid"; comp = rB ? "partial" : "un"; }
      else {
        r.borderline = true;
        var up = paco2 > NORM.co2, dn = hco3 < NORM.hco3;
        primary = up && dn ? "mixed-acid" : up ? "resp-acid" : dn ? "met-acid" : "inconsistent";
        if (primary === "resp-acid" || primary === "met-acid") comp = "un";
      }
    } else if (r.phStatus === "alkalemia") {
      if (rB && mB) primary = "mixed-alk";
      else if (rB) { primary = "resp-alk"; comp = mA ? "partial" : "un"; }
      else if (mB) { primary = "met-alk"; comp = rA ? "partial" : "un"; }
      else {
        r.borderline = true;
        var lo = paco2 < NORM.co2, hi = hco3 > NORM.hco3;
        primary = lo && hi ? "mixed-alk" : lo ? "resp-alk" : hi ? "met-alk" : "inconsistent";
        if (primary === "resp-alk" || primary === "met-alk") comp = "un";
      }
    } else {
      if (!rA && !rB && !mA && !mB) primary = "normal";
      else if (rA && mB) { primary = ph < NORM.ph ? "resp-acid" : ph > NORM.ph ? "met-alk" : "ambig-ra-ma"; comp = "full"; }
      else if (rB && mA) { primary = ph < NORM.ph ? "met-acid" : ph > NORM.ph ? "resp-alk" : "ambig-ma-rb"; comp = "full"; }
      else if (rA && mA) primary = "mixed-acid";
      else if (rB && mB) primary = "mixed-alk";
      else { primary = rA ? "resp-acid" : rB ? "resp-alk" : mA ? "met-acid" : "met-alk"; comp = "normal-ph"; }
    }
    // pH 7.40 with both values abnormal: test both possible primary disorders against their compensation rules.
    // If neither fits, it is a mixed disorder (two opposing primary processes), not a "fully compensated" single one.
    if (primary === "ambig-ma-rb" || primary === "ambig-ra-ma") {
      var isMA = primary === "ambig-ma-rb";
      var cMet = compensation(isMA ? "met-acid" : "met-alk", paco2, hco3), cResp = compensation(isMA ? "resp-alk" : "resp-acid", paco2, hco3);
      var metFits = cMet && !cMet.extra, respFits = cResp && !cResp.extra;
      if (!metFits && !respFits) { primary = isMA ? "met-acid" : "resp-acid"; r.mixedNormal = true; r.altCheck = isMA ? cResp : cMet; }
      else if (respFits && !metFits) { primary = isMA ? "resp-alk" : "resp-acid"; r.altFits = true; }
      else if (metFits && !respFits) primary = isMA ? "met-acid" : "met-alk";
    }
    r.primary = primary; r.comp = comp;

    var nm = NAME[primary];
    if (nm) {
      r.label = comp === "un" ? "Uncompensated " + nm
        : comp === "partial" ? "Partially compensated " + nm
        : comp === "full" ? "Fully compensated " + nm
        : cap(nm) + " with normal pH";
      r.check = compensation(primary, paco2, hco3);
      if (r.check && r.check.extra) r.extraLabel = NAME[r.check.extra];
      // Normal pH with a second disorder on the compensation rule: a mixed disorder, not "fully compensated"
      if (comp === "full" && r.check && r.check.extra) {
        r.mixedNormal = true;
        r.label = "Mixed " + nm + " and " + NAME[r.check.extra] + " (normal pH)";
        r.mixedNote = "pH is normal because two opposing primary disorders cancel out: " + r.check.verdict.replace(/^(\S)/, function (c) { return c.toLowerCase(); }) +
          (r.altCheck ? " Read the other way, " + r.altCheck.verdict.replace(/^(\S)/, function (c) { return c.toLowerCase(); }) : "") + " Look for both causes.";
      }
      if (r.altFits) r.mixedNote = "pH is exactly 7.40. This fits " + (primary === "resp-alk" ? "chronic respiratory alkalosis (the one disorder that can fully normalize pH)" : "chronic respiratory acidosis") + ", but a mixed disorder can look the same; decide from the history.";
      if (r.check && r.check.timing && r.check.timing !== "between" && primary.indexOf("resp") === 0) r.timing = r.check.timing;
    } else if (primary === "mixed-acid") {
      r.label = "Mixed respiratory and metabolic acidosis";
      r.mixedNote = "High pCO₂ and low HCO₃ both lower the pH: two primary disorders, with no compensation to assess.";
    } else if (primary === "mixed-alk") {
      r.label = "Mixed respiratory and metabolic alkalosis";
      r.mixedNote = "Low pCO₂ and high HCO₃ both raise the pH: two primary disorders, with no compensation to assess.";
    } else if (primary === "ambig-ra-ma") {
      r.label = "Fully compensated respiratory acidosis or metabolic alkalosis";
      r.mixedNote = "pH is exactly 7.40, so it doesn't show which came first. Decide from the history (e.g. COPD vs vomiting or diuretics); a mixed disorder is also possible.";
    } else if (primary === "ambig-ma-rb") {
      r.label = "Fully compensated metabolic acidosis or respiratory alkalosis";
      r.mixedNote = "pH is exactly 7.40, so it doesn't show which came first. Decide from the history; a mixed disorder is also possible.";
    } else if (primary === "normal") {
      r.label = "Normal acid–base status";
    } else {
      r.label = "Values don't fit a single pattern";
      r.mixedNote = "Check the entries against the printout.";
    }
    if (r.check && !r.check.extra && comp === "un" && /expected range/.test(r.check.verdict)) {
      r.check.verdict += " pCO₂ has not yet left 35–45, which is why the traditional label still reads “uncompensated”.";
    }
    if (r.borderline) r.notes.push({ tone: "warn", text: "pH is outside 7.35–7.45 but pCO₂ and HCO₃ are inside their normal ranges. Read with caution and check the entries." });
    if (comp === "full" && r.check && !r.check.extra && primary !== "resp-alk") {
      r.notes.push({ tone: "", text: "Compensation seldom brings pH all the way back to normal (chronic respiratory alkalosis is the usual exception). A normal pH with both values abnormal can be a mixed disorder; use the history." });
    }
    if (primary === "met-acid" || (r.check && r.check.extra === "met-acid")) {
      r.notes.push({ tone: "", key: "ag", text: "Anion gap not assessed: add Na and Cl under Electrolytes (optional) to calculate it." });
    }
    // Tone for the card
    r.tone = primary === "normal" ? "ok" : r.severe ? "crit" : "warn";
    return r;
  }


  /* ---------- Electrolytes and chemistry (all optional) ----------
     Anion gap = Na − (Cl + HCO₃); albumin-corrected AG = AG + 2.5 × (4.0 − albumin g/dL) (Figge 1998);
     delta ratio = (AG − normal AG) ÷ (24 − HCO₃); corrected Na = Na + 1.6 (Katz) or 2.4 (Hillier) per 100 mg/dL glucose above 100;
     effective osmolality = 2 Na + glucose/18; calculated osmolality = 2 Na + glucose/18 + BUN/2.8; osmolal gap = measured − calculated. */
  var UKET = { 0: "negative", 0.5: "trace", 1: "1+", 2: "2+", 3: "3+", 4: "4+" };
  var AGREF = { classic: { mean: 12, lo: 8, hi: 16, label: "12 ± 4 (8–16)" }, ise: { mean: 7, lo: 3, hi: 11, label: "3–11 (ion-selective)" } };
  var ERANGE = { na: [135, 145], k: [3.5, 5.0], cl: [98, 107], ica: [1.12, 1.32], glu: [70, 180], alb: [3.5, 5.0], osm: [275, 295] };
  function electrolytes(e, ab, lactate) {
    if (!e) return null;
    // v16.1: every laboratory value gets an explicit status, and units are never inferred from magnitude.
    //   ok · extreme (used, but "confirm with the laboratory") · invalid (implausible entry: not used, reported) · unit (unit not picked: not used, reported)
    // E.errors: messages for values that are NOT used (invalid or unit not confirmed). E.issues: everything the copied report must carry.
    var E = { notes: [], errors: [], issues: [], st: {} }, any = false, n = function (v) { return v != null && isFinite(v) ? v : null; };
    var issue = function (key, text, level, used) { E.issues.push({ key: key, text: text, level: level || "warn" }); if (!used) E.errors.push(text); };
    // [field, label, unit, invalid below, invalid above, extreme below, extreme above, decimals]
    function check(key, raw, label, unit, invLo, invHi, exLo, exHi, d) {
      if (raw == null) return null;
      any = true;
      if (raw < invLo || raw > invHi) { E.st[key] = "invalid"; issue(key, label + " " + rawTxt(raw) + " " + unit + " is not a plausible result (accepted " + invLo + "–" + invHi + "): check the entry. Not interpreted.", "crit"); return null; }
      if (raw < exLo || raw > exHi) { E.st[key] = "extreme"; issue(key, label + " " + fmt(raw, d) + " " + unit + " is extremely " + (raw < exLo ? "low" : "high") + ": confirm with the laboratory now; it is interpreted as entered.", "crit", true); return raw; }
      E.st[key] = "ok"; return raw;
    }
    var na = n(e.na), k = n(e.k), cl = n(e.cl), ica = n(e.ica), glu = n(e.glu), alb = n(e.alb), bhb = n(e.bhb), bun = n(e.bun), osm = n(e.osm);
    E.raw = { na: na, k: k, cl: cl, ica: ica, glu: glu, alb: alb, bhb: bhb, bun: bun, osm: osm };
    var v_;
    if ((v_ = check("na", na, "Na", "mmol/L", 90, 200, 110, 170, 0)) != null) E.na = v_;
    if ((v_ = check("k", k, "K", "mmol/L", 0.5, 12, 2.0, 8.0, 1)) != null) E.k = v_;
    if ((v_ = check("cl", cl, "Cl", "mmol/L", 50, 160, 70, 135, 0)) != null) E.cl = v_;
    // Ionized calcium: unit required (mmol/L or mg/dL; mg/dL ÷ 4.008 = mmol/L)
    if (ica != null) {
      any = true;
      if (e.icaUnit !== "mmol" && e.icaUnit !== "mgdl") {
        E.st.ica = "unit"; E.icaAsk = true;
        issue("ica", "Ionized Ca " + rawTxt(ica) + ": unit not confirmed, so it is not interpreted (" + rawTxt(ica) + " mmol/L and " + rawTxt(ica) + " mg/dL = " + (ica / 4.008).toFixed(2) + " mmol/L are very different). Pick mmol/L or mg/dL.", "crit");
      } else {
        var icm = e.icaUnit === "mgdl" ? ica / 4.008 : ica;
        if (e.icaUnit === "mgdl") E.notes.push("Ionized Ca " + rawTxt(ica) + " mg/dL = " + icm.toFixed(2) + " mmol/L");
        if ((v_ = check("ica", icm, "Ionized Ca", "mmol/L", 0.1, 5, 0.6, 2.0, 2)) != null) { E.ica = v_; E.icaUnit = e.icaUnit; E.icaRaw = ica; }
      }
    }
    // Glucose: unit required (mg/dL or mmol/L; mmol/L × 18 = mg/dL). Extreme values are kept and flagged, not discarded.
    if (glu != null) {
      any = true;
      if (e.gluUnit !== "mmol" && e.gluUnit !== "mgdl") {
        E.st.glu = "unit"; E.gluAsk = true;
        var asMg = glu, asMmol = glu * 18, crit = asMg < 70 || asMmol < 70 || asMmol >= 600 || asMg >= 600;
        issue("glu", "Glucose " + rawTxt(glu) + ": unit not confirmed, so it is not interpreted. As mg/dL it would be " + fmt(asMg, 0) + " mg/dL" + (asMg < 54 ? " (level 2 hypoglycemia)" : asMg < 70 ? " (hypoglycemia)" : "") +
          "; as mmol/L it would be " + fmt(asMmol, 0) + " mg/dL" + (asMmol < 54 ? " (level 2 hypoglycemia)" : asMmol < 70 ? " (hypoglycemia)" : asMmol >= 600 ? " (HHS range)" : "") + ". Pick the unit.", crit ? "crit" : "warn");
      } else {
        var gmg = e.gluUnit === "mmol" ? glu * 18 : glu;
        if (e.gluUnit === "mmol") E.notes.push("Glucose " + rawTxt(glu) + " mmol/L = " + fmt(gmg, 0) + " mg/dL");
        if ((v_ = check("glu", gmg, "Glucose", "mg/dL", 1, 5000, 20, 1500, 0)) != null) { E.glu = v_; E.gluMmol = v_ / 18; E.gluUnit = e.gluUnit; E.gluRaw = glu; }
      }
    }
    // Albumin: unit required (g/dL or g/L; g/L ÷ 10 = g/dL). An implausible value is reported, never re-read in the other unit.
    if (alb != null) {
      any = true;
      if (e.albUnit !== "gdl" && e.albUnit !== "gl") {
        E.st.alb = "unit"; E.albAsk = true;
        issue("alb", "Albumin " + rawTxt(alb) + ": unit not confirmed (g/dL or g/L), so it is not used to correct the anion gap. Pick the unit.", "warn");
      } else {
        var agd = e.albUnit === "gl" ? alb / 10 : alb;
        if (e.albUnit === "gl") E.notes.push("Albumin " + fmt(alb, 0) + " g/L = " + agd.toFixed(1) + " g/dL");
        if (agd > 6.5) { E.st.alb = "invalid"; issue("alb", "Albumin " + rawTxt(alb) + " " + (e.albUnit === "gl" ? "g/L = " + agd.toFixed(1) + " g/dL" : "g/dL") + " is implausible: check the value and the unit" + (e.albUnit === "gdl" ? " (g/L?)" : "") + ". Not used.", "warn"); }
        else if ((v_ = check("alb", agd, "Albumin", "g/dL", 0.1, 6.5, 1.0, 6.0, 1)) != null) { E.alb = v_; E.albUnit = e.albUnit; E.albRaw = alb; }
      }
    }
    if ((v_ = check("bhb", bhb, "β-hydroxybutyrate", "mmol/L", 0, 30, -1, 15, 1)) != null) E.bhb = v_;
    // BUN or urea: unit required (urea mmol/L × 2.8 = BUN mg/dL); it changes the total osmolality and the osmolal gap
    if (bun != null) {
      any = true;
      if (e.bunUnit !== "urea" && e.bunUnit !== "mgdl") {
        E.st.bun = "unit"; E.bunAsk = true;
        issue("bun", "BUN/urea " + rawTxt(bun) + ": unit not confirmed (BUN mg/dL or urea mmol/L), so it is not used for total osmolality or the osmolal gap. Pick the unit.", "warn");
      } else {
        var bmg = e.bunUnit === "urea" ? bun * 2.8 : bun;
        if (e.bunUnit === "urea") E.notes.push("Urea " + rawTxt(bun) + " mmol/L = BUN " + fmt(bmg, 0) + " mg/dL");
        if ((v_ = check("bun", bmg, "BUN", "mg/dL", 0.5, 400, 2, 200, 0)) != null) { E.bun = v_; E.bunUnit = e.bunUnit; }
      }
    }
    if ((v_ = check("osm", osm, "Measured osmolality", "mOsm/kg", 150, 600, 240, 400, 0)) != null) E.osm = v_;
    E.dm = e.dm === true;
    var uk = n(e.uket); if (uk != null) { any = true; if (uk < 0 || uk > 4) issue("uket", "Urine ketones must be negative to 4+.", "warn"); else E.uket = uk; }
    if (!any) return null;
    var ref = AGREF[e.agRef] || AGREF.classic; E.ref = ref; E.refKey = AGREF[e.agRef] ? e.agRef : "classic";
    var abOk = ab && !ab.errors.length, h = abOk ? ab.hco3 : null;
    E.hco3 = h;
    // Anion gap
    if (E.na != null && E.cl != null && h != null) {
      E.ag = E.na - (E.cl + h);
      if (E.k != null) E.agK = E.ag + E.k;
      E.agCorr = E.alb != null ? E.ag + 2.5 * (4.0 - E.alb) : null;
      E.agUse = E.agCorr != null ? E.agCorr : E.ag;
      E.agHigh = E.agUse > ref.hi; E.agLow = E.agUse < ref.lo;
      var metA = abOk && (ab.primary === "met-acid" || ab.primary === "mixed-acid" || (ab.check && ab.check.extra === "met-acid") || ab.primary === "ambig-ma-rb");
      E.metA = metA;
      E.agType = E.agHigh ? "high" : metA ? "normal" : null;
      if (E.agHigh && h < 24 - 0.5) {
        E.dr = (E.agUse - ref.mean) / (24 - h);
        E.drText = E.dr < 0.4 ? "mostly a normal anion gap (hyperchloremic) acidosis" : E.dr < 0.8 ? "combined high and normal anion gap acidosis, or kidney failure"
          : E.dr <= 2 ? "pure high anion gap acidosis; DKA is often near 1, lactic acidosis near 1.6"
          : "high anion gap acidosis plus metabolic alkalosis, or a pre-existing compensated respiratory acidosis";
      } else if (E.agHigh && h >= 24 - 0.5) E.hiddenHAG = true;
      if (lactate != null && isFinite(lactate) && E.agHigh) E.unexplained = (E.agUse - ref.mean) - lactate - (E.bhb != null ? E.bhb : 0);
    }
    // Sodium: corrected for glucose
    if (E.na != null && E.glu != null && E.glu >= 200) { E.naKatz = E.na + 1.6 * (E.glu - 100) / 100; E.naHill = E.na + 2.4 * (E.glu - 100) / 100; }
    var naT = E.naKatz != null ? E.naKatz : E.na;
    if (E.na != null) E.naStatus = E.na < 125 ? "profound" : E.na < 130 ? "moderate" : E.na < 135 ? "mild" : E.na >= 160 ? "severe-high" : E.na > 145 ? "high" : "normal";
    if (E.naKatz != null && E.na < 135 && naT >= 135) E.pseudoNa = true;   // low Na explained by hyperglycemia
    if (E.k != null) E.kStatus = E.k < 2.5 ? "severe-low" : E.k < 3.0 ? "mod-low" : E.k < 3.5 ? "low" : E.k >= 6.5 ? "severe-high" : E.k >= 6.0 ? "mod-high" : E.k >= 5.5 ? "high" : "normal";
    if (E.ica != null) E.icaStatus = E.ica < ERANGE.ica[0] ? "low" : E.ica > ERANGE.ica[1] ? "high" : "normal";
    if (E.glu != null) E.gluStatus = E.glu < 54 ? "severe-low" : E.glu < 70 ? "low" : E.glu >= 600 ? "very-high" : E.glu >= 200 ? "high" : E.glu > 180 ? "raised" : "normal";
    // Osmolality
    if (E.na != null && E.glu != null) E.effOsm = 2 * E.na + E.glu / 18;
    if (E.na != null && E.glu != null && E.bun != null) E.calcOsm = 2 * E.na + E.glu / 18 + E.bun / 2.8;
    if (E.calcOsm != null && E.osm != null) E.osmGap = E.osm - E.calcOsm;
    // DKA and HHS, 2024 consensus (ADA/EASD/JBDS/AACE/DTS). Each criterion is true, false, or null (not assessed).
    // DKA: D glucose ≥ 200 mg/dL or known diabetes; K β-OHB ≥ 3.0 mmol/L or urine ketones ≥ 2+; A pH < 7.3 and/or HCO₃ < 18.
    // HHS: glucose ≥ 600; effective osmolality > 300 or total > 320; β-OHB < 3.0 or urine ketones < 2+; pH ≥ 7.3 and HCO₃ ≥ 15.
    // β-OHB (quantitative) is used before urine ketones when both are entered. "A" is applied exactly as written
    // (pH < 7.3 OR HCO₃ < 18); when it is met by pH alone with HCO₃ ≥ 18, a mixed (respiratory) acidosis is flagged.
    var Kv = E.bhb != null ? E.bhb >= 3 : E.uket != null ? E.uket >= 2 : null;
    E.kTxt = E.bhb != null ? "β-OHB " + E.bhb.toFixed(1) : E.uket != null ? "urine ketones " + UKET[E.uket] : null;
    var Dv = (E.glu != null && E.glu >= 200) || E.dm ? true : E.glu != null ? false : null;
    var Av = abOk ? (ab.ph < 7.3 || h < 18) : null;
    if (Av === true || Kv === true || (Dv === true && E.glu != null && E.glu >= 250)) {
      var st = Dv === true && Kv === true && Av === true ? "met" : Dv === false || Kv === false || Av === false ? "notmet" : "possible";
      E.dka = { D: Dv, K: Kv, A: Av, state: st, euglycemic: st === "met" && E.glu != null && E.glu < 200,
        ketoNoD: Kv === true && Av === true && Dv === false, phOnly: abOk && ab.ph < 7.3 && h >= 18 };
      if (st === "met") {
        // Severity (2024 consensus; not all criteria need be met, so the worst finding sets the grade):
        // severe β-OHB > 6.0, pH < 7.0 or HCO₃ < 10; moderate pH 7.0–7.25 or HCO₃ 10–< 15; mild pH > 7.25–< 7.30 or HCO₃ 15–18.
        // Mental status (alert / drowsy / stupor or coma) is part of the grade and is not assessed by the app.
        var why = [];
        if (E.bhb != null && E.bhb > 6) why.push("β-OHB " + E.bhb.toFixed(1) + " > 6.0");
        if (ab.ph < 7.0) why.push("pH " + fmt(ab.ph, 2) + " < 7.00");
        if (h < 10) why.push("HCO₃ " + fmt(h, 1) + " < 10");
        var sev = why.length ? "severe" : null;
        if (!sev) {
          if (ab.ph <= 7.25) why.push("pH " + fmt(ab.ph, 2) + " (7.00–7.25)");
          if (h < 15) why.push("HCO₃ " + fmt(h, 1) + " (10–14.9)");
          sev = why.length ? "moderate" : "mild";
          if (sev === "mild") { if (ab.ph < 7.3) why.push("pH " + fmt(ab.ph, 2) + " (7.26–7.29)"); if (h < 18) why.push("HCO₃ " + fmt(h, 1) + " (15–17.9)"); }
        }
        E.dka.sev = sev; E.dka.sevWhy = why;
      }
    }
    if (E.glu != null && E.glu >= 600) {
      // Hyperosmolality: calculated effective osmolality > 300 (2 Na + glucose) or calculated total > 320 (adds urea).
      // The consensus defines both by calculation, so a measured osmolality is shown as support but never stands in for them.
      var oSrc = null, Ov = null;
      if (E.effOsm != null && E.effOsm > 300) { Ov = true; oSrc = "calculated effective osmolality " + fmt(E.effOsm, 0) + " (> 300)"; }
      else if (E.calcOsm != null && E.calcOsm > 320) { Ov = true; oSrc = "calculated total osmolality " + fmt(E.calcOsm, 0) + " (> 320)"; }
      else if (E.effOsm != null && E.calcOsm != null) Ov = false;   // both calculated and neither high; without BUN the total is unknown
      var KAbs = Kv == null ? null : !Kv, AAbs = abOk ? ab.ph >= 7.3 && h >= 15 : null;
      E.hhs = { O: Ov, oSrc: oSrc, measOnly: Ov == null && E.osm != null, K: KAbs, A: AAbs,
        state: Ov === true && KAbs === true && AAbs === true ? "met" : Ov === false || KAbs === false || AAbs === false ? "notmet" : "possible" };
      if (Ov === true && (KAbs === false || AAbs === false)) E.hhs.mixed = true;   // hyperosmolar with ketonemia or acidosis
      if (E.dka && E.dka.state === "met" && Ov === true) E.overlap = true;   // DKA with HHS-range glucose and osmolality
    }
    return E;
  }
  function rawTxt(v) { return v == null || !isFinite(v) ? "—" : String(+(+v).toFixed(3)); }   // a typed value as typed: 9000, 1.6, 0.05
  var ELNAME = { na: "Na", k: "K", cl: "Cl", ica: "iCa", glu: "Glucose", alb: "Albumin", bhb: "β-hydroxybutyrate", bun: "BUN/urea", osm: "Measured osmolality" };
  function elLines(E) {   // value lines for the message
    if (!E) return [];
    var L = [], st = E.st || {};
    Object.keys(st).forEach(function (k) {
      if (st[k] === "unit") L.push(ELNAME[k] + " " + rawTxt(E.raw[k]) + ": unit not confirmed (not interpreted)");
      else if (st[k] === "invalid") L.push(ELNAME[k] + " " + rawTxt(E.raw[k]) + ": invalid entry (not interpreted)");
    });
    if (E.na != null) L.push("Na " + fmt(E.na, 0) + " mmol/L" + arrow(E.na, ERANGE.na[0], ERANGE.na[1]));
    if (E.k != null) L.push("K " + E.k.toFixed(1) + " mmol/L" + arrow(E.k, ERANGE.k[0], ERANGE.k[1]));
    if (E.cl != null) L.push("Cl " + fmt(E.cl, 0) + " mmol/L" + arrow(E.cl, ERANGE.cl[0], ERANGE.cl[1]));
    if (E.ica != null) L.push("iCa " + E.ica.toFixed(2) + " mmol/L" + arrow(E.ica, ERANGE.ica[0], ERANGE.ica[1]));
    if (E.glu != null) L.push("Glucose " + (E.gluUnit === "mmol" ? fmt(E.gluMmol, 1) + " mmol/L (" + fmt(E.glu, 0) + " mg/dL)" : fmt(E.glu, 0) + " mg/dL") + arrow(E.glu, ERANGE.glu[0], ERANGE.glu[1]) + (st.glu === "extreme" ? " (extreme: confirm with the lab)" : ""));
    if (E.alb != null) L.push("Albumin " + E.alb.toFixed(1) + " g/dL" + arrow(E.alb, ERANGE.alb[0], null));
    if (E.bhb != null) L.push("β-hydroxybutyrate " + E.bhb.toFixed(1) + " mmol/L" + (E.bhb >= 3 ? " " + UP : ""));
    if (E.bun != null) L.push(E.bunUnit === "urea" ? "Urea " + fmt(E.bun / 2.8, 1) + " mmol/L" : "BUN " + fmt(E.bun, 0) + " mg/dL");
    if (E.osm != null) L.push("Measured osmolality " + fmt(E.osm, 0) + " mOsm/kg" + arrow(E.osm, ERANGE.osm[0], ERANGE.osm[1]));
    return L;
  }
  // Every unresolved input problem, for the app's check card and the top of the copied message.
  // m: { abRaw, el, ox, pao2, fio2Pct, support, vent, extra: [{ text, level }] }
  // pO2 or FiO2 entered but outside the accepted range: oxygenation is not interpreted
  function oxOutOfRange(pao2, fio2Pct) {   // range only: a pO2 above the alveolar value is still read (v16.3)
    return vStat("pao2", pao2) === "invalid" || vStat("fio2Pct", fio2Pct) === "invalid";
  }
  // One wording for a rejected pO2 or FiO2, wherever it is reported (ABG tab, Ventilator tab, both messages)
  var OX_NA = "P/F, the oxygenation index, ARDS grading and the weaning oxygenation check are not assessed";
  function pao2IssueText(pao2, fio2Pct) {
    return "pO₂ " + fmt(pao2, 0) + (vStat("fio2Pct", fio2Pct) === "valid" ? " on FiO₂ " + fmt(fio2Pct, 0) + "%" : "") + " is outside the accepted range (pO₂ 10–700, FiO₂ 21–100): oxygenation is not interpreted, and " + OX_NA + ". Recheck the gas.";
  }
  function alvIssueText(pao2, fio2Pct, paco2, A) {
    return "pO₂ " + fmt(pao2, 0) + " on FiO₂ " + fmt(fio2Pct, 0) + "% is higher than the alveolar pO₂ (≈ " + fmt(A, 0) + " for pCO₂ " + fmt(paco2, 0) + " at sea level), which is not possible: check the FiO₂ entry and the sample (an air bubble raises pO₂). Oxygenation is not interpreted, and " + OX_NA + ".";
  }
  function fio2IssueText(fio2Pct) { return "FiO₂ " + fmt(fio2Pct, 0) + "% is outside 21–100%: oxygenation is not interpreted, and " + OX_NA + ". Check the entry."; }
  // The line shown when there are no suggestions: never "no problem" when part of the gas was not assessed
  function nothingLine(abBad, oxBad) {
    return abBad && oxBad ? "Acid–base and oxygenation not assessed: see the input checks above."
      : abBad ? "Acid–base not assessed: see the input checks above."
      : oxBad ? "No acid–base problem on this gas; oxygenation not assessed: see the input checks above."
      : "No acid–base or oxygenation problem on this gas; correlate clinically.";
  }
  function collectIssues(m) {
    var I = [], add = function (t, lvl) { if (t && !I.some(function (x) { return x.text === t; })) I.push({ text: t, level: lvl || "warn" }); };
    var ab = m.abRaw;
    if (ab && ab.errors && ab.errors.length) ab.errors.forEach(function (e) { add(ab.mismatch ? e : "Acid–base not interpreted: " + e, "crit"); });
    else if (ab && ab.extreme) add(ab.extreme, "crit");
    if (oxOutOfRange(null, m.fio2Pct)) add(fio2IssueText(m.fio2Pct), "crit");
    else if (oxOutOfRange(m.pao2, null)) add(pao2IssueText(m.pao2, m.fio2Pct), "crit");
    // the ventilator engine reports the same rejected values in the same words, so the two tabs always agree
    var vv = m.vent;
    if (vv && vv.fio2Bad != null && !oxOutOfRange(null, m.fio2Pct)) add(fio2IssueText(vv.fio2Bad), "crit");
    else if (vv && vv.pao2Bad != null && !oxOutOfRange(m.pao2, m.fio2Pct)) add(pao2IssueText(vv.pao2Bad, vv.fio2Raw), "crit");
    var sp = m.support;
    if (sp && sp.mode === "nc" && num_(sp.ncFlow) != null && sp.ncFlow > 6) add("Nasal cannula " + fmt(sp.ncFlow, 0) + " L/min: the FiO₂ estimate (20 + 4 × L/min) is unreliable above 6 L/min, so P/F and the desired FiO₂ are rough.", "warn");
    if (m.el && m.el.issues) m.el.issues.forEach(function (x) { add(x.text, x.level); });
    if (m.vent && m.vent.issues) m.vent.issues.forEach(function (x) { add(x.text, x.level); });
    (m.extra || []).forEach(function (x) { add(x.text, x.level); });
    return I.sort(function (a, b) { return (a.level === "crit" ? 0 : 1) - (b.level === "crit" ? 0 : 1); });
  }
  function elCalcLines(E) {   // calculated values for the message
    if (!E) return [];
    var L = [];
    if (E.ag != null) {
      var aw = function () { return E.agHigh ? " " + UP : E.agLow ? " " + DOWN : ""; };
      L.push("Anion gap (Na − Cl − HCO₃): " + fmt(E.ag, 0) + (E.agCorr == null ? aw() : "") + (E.agCorr != null ? " · albumin-corrected " + fmt(E.agCorr, 0) + aw() : "") + " · normal " + E.ref.lo + "–" + E.ref.hi);
      if (E.dr != null) L.push("Delta ratio: " + fmt(E.dr, 1) + " → " + E.drText);
      else if (E.hiddenHAG) L.push("Delta ratio: not applicable, as HCO₃ is not low; a high gap with a normal or high HCO₃ means a hidden high-gap acidosis plus metabolic alkalosis");
    }
    if (E.naKatz != null) L.push("Corrected Na: " + fmt(E.naKatz, 0) + " (Katz, 1.6) · " + fmt(E.naHill, 0) + " (Hillier, 2.4) mmol/L");
    if (E.effOsm != null && E.glu >= 250) L.push("Effective osmolality: " + fmt(E.effOsm, 0) + " mOsm/kg" + (E.effOsm > 300 ? " " + UP : "") + " (2 Na + glucose/18)");
    if (E.osmGap != null) L.push("Osmolal gap: " + fmt(E.osmGap, 0) + (E.osmGap > 10 ? " " + UP : "") + " mOsm/kg (measured " + fmt(E.osm, 0) + " − calculated " + fmt(E.calcOsm, 0) + "; normal < 10)");
    return L;
  }

  function elInterp(E, ab) {   // [{ text, tone }] for the message interpretation and the app card
    if (!E) return [];
    var L = [], add = function (t, tone) { L.push({ text: t, tone: tone || "" }); };
    if (E.ag != null) {
      var agTxt = "Anion gap " + fmt(E.agUse, 0) + (E.agCorr != null ? " (albumin-corrected)" : "");
      if (E.agLow) add(agTxt + ": low (check the entries; hypoalbuminemia" + (E.agCorr != null ? "" : " if not corrected") + ", paraproteins such as myeloma, lithium or bromide)", "");
      else if (E.metA && !E.agHigh && E.alb == null) add("Normal anion gap without albumin: a low albumin can hide a high gap, so add albumin if it is low", "");
      var ketoFull = E.dka && E.dka.state === "met";
      if (E.agHigh && E.unexplained != null && !ketoFull) add((E.bhb != null ? "Lactate and β-OHB account" : "Lactate accounts") + (E.unexplained > 5 ? " for only part of the gap (≈ " + fmt(E.unexplained, 0) + " mmol/L unexplained): look for " + (E.bhb == null ? "ketones, " : "") + "kidney failure or toxins" : " for most of the anion gap"), E.unexplained > 5 ? "warn" : "");
    }
    if (E.dka) {
      var D = E.dka, need = [];
      if (D.state === "met") {
        add("DKA biochemical criteria met (ADA/EASD 2024): " + D.sev + " by " + D.sevWhy.join(", ") + " (pH " + fmt(ab.ph, 2) + ", HCO₃ " + fmt(E.hco3, 1) + ", " + E.kTxt + (D.euglycemic ? "; euglycemic: glucose " + fmt(E.glu, 0) + " with known diabetes" : "") + ")" + (E.overlap ? ", with HHS-range glucose and osmolality (overlapping DKA–HHS)" : "") +
          ". Severity also depends on mental status, which needs bedside assessment", D.sev === "severe" ? "crit" : "warn");
        if (D.phOnly) add("pH " + fmt(ab.ph, 2) + " is below 7.3 but HCO₃ " + fmt(E.hco3, 1) + " is 18 or more: the acidemia is not explained by ketoacidosis alone. Look for a coexisting respiratory acidosis (pCO₂ " + fmt(ab.paco2, 0) + ") and treat the severity grade by pH with caution", "warn");
      }
      else if (D.ketoNoD) add("Ketoacidosis (" + E.kTxt + ") with glucose < 200 and no known diabetes ticked: euglycemic DKA if the patient has diabetes (SGLT2 inhibitor, pregnancy, fasting); otherwise starvation or alcoholic ketoacidosis", "warn");
      else if (D.state === "possible") {
        if (D.D == null) need.push("glucose (or tick Known diabetes)");
        if (D.K == null) need.push("ketones (β-OHB ≥ 3.0 mmol/L or urine ketones ≥ 2+)");
        if (D.A == null) need.push("a valid pH and HCO₃");
        add("DKA possible, not confirmed: needs " + need.join(", "), "warn");
      } else if (D.state === "notmet" && D.A === true && D.D === true && D.K === false) add("DKA criteria not met: ketones below the threshold (" + E.kTxt + "); look for another cause of the acidosis", "");
    }
    if (E.hhs && !(E.dka && E.dka.state === "met")) {
      var H = E.hhs, hn = [];
      if (H.state === "met") add("HHS biochemical criteria met (ADA/EASD 2024): glucose " + fmt(E.glu, 0) + " mg/dL, " + H.oSrc + ", no significant ketonemia (" + E.kTxt + "), pH ≥ 7.3 and HCO₃ ≥ 15", "crit");
      else if (H.state === "possible") {
        if (H.O == null) hn.push(H.measOnly ? "Na (and BUN) to calculate osmolality: measured " + fmt(E.osm, 0) + (E.osm > 320 ? " supports hyperosmolality, but the criteria use calculated values" : "") : E.na == null ? "Na for the osmolality" : "BUN for the total osmolality");
        if (H.K == null) hn.push("ketones (β-OHB < 3.0 or urine ketones < 2+)");
        if (H.A == null) hn.push("a valid pH and HCO₃");
        add("HHS possible, not confirmed: glucose " + fmt(E.glu, 0) + " mg/dL" + (H.O ? " and " + H.oSrc : "") + "; needs " + hn.join(", "), "crit");
      } else if (H.mixed) add("Hyperosmolar: " + H.oSrc + ", with " + [H.K === false ? "significant ketonemia" : "", H.A === false ? "acidosis" : ""].filter(Boolean).join(" and ") + ". Mixed features: the consensus advises treating it as DKA", "crit");
      else add("HHS criteria not met (" + [H.O === false ? "calculated osmolality not high" : "", H.K === false ? "significant ketones" : "", H.A === false ? "acidosis present" : ""].filter(Boolean).join("; ") + ")", "");
    }
    if (E.kStatus && E.kStatus !== "normal") {
      var kw = { "severe-low": "Severe hypokalemia", "mod-low": "Moderate hypokalemia", low: "Mild hypokalemia", high: "Mild hyperkalemia", "mod-high": "Moderate hyperkalemia", "severe-high": "Severe hyperkalemia" }[E.kStatus];
      add(kw + " (K " + E.k.toFixed(1) + ")", /severe|mod-high/.test(E.kStatus) ? "crit" : "warn");
    }
    if (E.naStatus && E.naStatus !== "normal") {
      if (E.pseudoNa) add("Na " + fmt(E.na, 0) + " is low only from hyperglycemia: corrected Na " + fmt(E.naKatz, 0) + "–" + fmt(E.naHill, 0) + " (translocational)", "");
      else add({ mild: "Mild hyponatremia", moderate: "Moderate hyponatremia", profound: "Profound hyponatremia", high: "Hypernatremia", "severe-high": "Severe hypernatremia" }[E.naStatus] + " (Na " + fmt(E.na, 0) + (E.naKatz != null ? "; corrected for glucose " + fmt(E.naKatz, 0) : "") + ")", E.naStatus === "profound" || E.naStatus === "severe-high" ? "crit" : "warn");
    } else if (E.naKatz != null && E.naKatz > 145) add("Corrected Na " + fmt(E.naKatz, 0) + " is high: free-water deficit under the hyperglycemia", "warn");
    if (E.icaStatus && E.icaStatus !== "normal") add((E.icaStatus === "low" ? "Low" : "High") + " ionized calcium (" + E.ica.toFixed(2) + " mmol/L)", E.ica < 0.9 || E.ica > 1.6 ? "crit" : "warn");
    if (E.gluStatus === "severe-low" || E.gluStatus === "low") add((E.gluStatus === "severe-low" ? "Clinically significant hypoglycemia" : "Hypoglycemia") + " (glucose " + fmt(E.glu, 0) + " mg/dL)", "crit");
    else if ((E.gluStatus === "high" || E.gluStatus === "very-high" || E.gluStatus === "raised") && !E.dka && !(E.hhs && E.hhs.state !== "notmet")) add("Hyperglycemia (glucose " + fmt(E.glu, 0) + " mg/dL)", "");
    if (E.osmGap != null && E.osmGap > 10) add("High osmolal gap (" + fmt(E.osmGap, 0) + "): unmeasured osmoles" + (E.agHigh ? " with a high anion gap → suspect methanol or ethylene glycol" : ""), E.agHigh ? "crit" : "warn");
    return L;
  }

  /* ---------- Oxygenation grade (Shapiro-style) ---------- */
  // Room air: normal ≥ 80, mild 60–79, moderate 40–59, severe < 40. Over 60 y: subtract 1 mmHg per year
  // from the mild and moderate limits (capped at age 90 here). Severe < 40 at any age.
  // On O2: uncorrected (< acceptable limit), corrected (limit–100), overcorrected (> 100).
  function oxygenation(inp) {
    var pao2 = inp.pao2, fio2Pct = inp.fio2Pct, age = inp.age;
    if (pao2 == null || !isFinite(pao2) || vOK("pao2", pao2) == null) return null;   // shared validation
    if (fio2Pct == null || !isFinite(fio2Pct)) return oxNoFio2(pao2, age);           // v16.4: read the pO2 even without FiO2
    if (vOK("fio2Pct", fio2Pct) == null) return null;
    var alvA = inp.paco2 != null ? pao2AboveAlv(pao2, inp.paco2, fio2Pct) : null;   // v16.3: read as entered, with a hint
    var hasAge = age != null && isFinite(age);
    var adj = hasAge && age > 60 ? Math.min(age, 90) - 60 : 0;
    var o = { pao2: pao2, fio2Pct: fio2Pct, adj: adj, hasAge: hasAge };
    o.mildLimit = 80 - adj;
    o.modLimit = Math.max(40, 60 - adj);
    o.grade = pao2 < 40 ? "severe" : pao2 < o.modLimit ? "moderate" : pao2 < o.mildLimit ? "mild" : "none";
    o.onO2 = fio2Pct > 21.5;
    o.predicted = fio2Pct * 5;                              // minimum predicted PaO2 ≈ FiO2% × 5
    o.pf = pao2 / (fio2Pct / 100);
    // Impairment relative to FiO2 (P/F), reported separately from whether the pO2 itself is adequate on this support
    o.impair = o.onO2 && o.pf <= 300 ? (o.pf <= 100 ? "severely" : o.pf <= 200 ? "moderately" : "mildly") : null;
    var impTxt = o.impair ? ", with " + o.impair + " impaired oxygenation (P/F " + Math.round(o.pf) + ")" : "";
    if (!o.onO2) {
      if (o.grade === "none") {
        o.label = "normal oxygenation"; o.tone = "ok"; o.state = "normal";
        o.detail = "pO₂ " + fmt(pao2, 0) + " on room air is at or above " + fmt(o.mildLimit, 0) + (adj ? " (age-adjusted)" : "") + ".";
        if (pao2 > 100 && alvA == null) o.detail += " Above 100 on room air: hyperventilation, or check FiO₂ and for an air bubble.";
      } else {
        o.label = o.grade + " hypoxemia"; o.tone = o.grade === "severe" ? "crit" : "warn"; o.state = "hypoxemia";
        o.detail = "pO₂ " + fmt(pao2, 0) + " on room air: " + (o.grade === "mild" ? fmt(o.modLimit, 0) + "–" + fmt(o.mildLimit - 1, 0)
          : o.grade === "moderate" ? "40–" + fmt(o.modLimit - 1, 0) : "below 40") + (adj && o.grade !== "severe" ? " (age-adjusted)" : "") + ".";
      }
    } else {
      if (pao2 < o.mildLimit) {
        o.label = "uncorrected hypoxemia"; o.tone = o.grade === "severe" || o.impair === "severely" ? "crit" : "warn"; o.state = "uncorrected";
        o.detail = "pO₂ " + fmt(pao2, 0) + " on FiO₂ " + fmt(fio2Pct, 0) + "% is still below " + fmt(o.mildLimit, 0) + (adj ? " (age-adjusted)" : "") +
          " (" + o.grade + " hypoxemia range).";
      } else if (pao2 <= 100) {
        o.label = "corrected hypoxemia" + (o.impair ? " on FiO₂ " + fmt(fio2Pct, 0) + "%" + impTxt : ""); o.tone = o.impair === "severely" ? "crit" : o.impair ? "warn" : "ok"; o.state = "corrected";
        o.detail = "pO₂ " + fmt(pao2, 0) + " on FiO₂ " + fmt(fio2Pct, 0) + "% is " + fmt(o.mildLimit, 0) + "–100: adequate on this support.";
        if (o.impair) o.detail += " P/F " + Math.round(o.pf) + " shows " + o.impair + " impaired gas exchange: the pO₂ is adequate only because of the oxygen.";
      } else {
        o.label = o.impair ? "pO₂ above 100 on FiO₂ " + fmt(fio2Pct, 0) + "% (O₂ can be lowered)" + impTxt : "overcorrected hypoxemia"; o.tone = o.impair === "severely" ? "crit" : "warn"; o.state = "over";
        o.detail = "pO₂ " + fmt(pao2, 0) + " on FiO₂ " + fmt(fio2Pct, 0) + "% is above 100: oxygen can be lowered toward the SpO₂ target.";
        if (o.impair) o.detail += " This is not normal oxygenation: P/F " + Math.round(o.pf) + " shows " + o.impair + " impaired gas exchange.";
        if (pao2 >= o.predicted && !o.impair) o.detail += " It is at or above FiO₂ × 5 (" + fmt(o.predicted, 0) + "), so the patient may not be hypoxemic on room air.";
      }
    }
    if (!hasAge) o.detail += " Age not entered: limits not age-adjusted.";
    if (alvA != null) {
      o.aboveAlv = alvA;
      o.detail += " This pO₂ is above what FiO₂ " + fmt(fio2Pct, 0) + "% can give (alveolar ≈ " + fmt(alvA, 0) + " at pCO₂ " + fmt(inp.paco2, 0) + "): the patient is probably on more oxygen than entered, or the sample has air. Set the oxygen support for P/F and the FiO₂ advice.";
    }
    return o;
  }



  // v16.4: oxygenation from the pO2 alone when the oxygen support (FiO2) has not been entered yet. The hypoxemia grade
  // needs only the pO2; whether it is on room air or corrected by oxygen, P/F and the A-a gradient need the FiO2.
  function oxNoFio2(pao2, age) {
    var hasAge = age != null && isFinite(age), adj = hasAge && age > 60 ? Math.min(age, 90) - 60 : 0;
    var o = { pao2: pao2, fio2Pct: null, adj: adj, hasAge: hasAge, noFio2: true, onO2: null, pf: null, impair: null };
    o.mildLimit = 80 - adj; o.modLimit = Math.max(40, 60 - adj);
    o.grade = pao2 < 40 ? "severe" : pao2 < o.modLimit ? "moderate" : pao2 < o.mildLimit ? "mild" : "none";
    o.state = o.grade === "none" ? "normal" : "hypoxemia";
    o.label = (o.grade === "none" ? "no hypoxemia" : o.grade + " hypoxemia") + " (oxygen support not entered)";
    o.tone = o.grade === "none" ? "" : o.grade === "severe" ? "crit" : "warn";
    var rng = o.grade === "mild" ? fmt(o.modLimit, 0) + "–" + fmt(o.mildLimit - 1, 0) : o.grade === "moderate" ? "40–" + fmt(o.modLimit - 1, 0) : "below 40";
    o.detail = "pO₂ " + fmt(pao2, 0) + (o.grade === "none" ? " is at or above " + fmt(o.mildLimit, 0) + ": no hypoxemia" : " is in the " + o.grade + " hypoxemia range (" + rng + ")") +
      (adj && o.grade !== "severe" ? " (age-adjusted)" : "") + ". The oxygen support is not entered, so the app cannot tell room air from oxygen (corrected or uncorrected hypoxemia); P/F, the A-a gradient and the FiO₂ advice need it.";
    if (!hasAge) o.detail += " Age not entered: limits not age-adjusted.";
    return o;
  }

  /* ---------- Oxygen / ventilatory support ---------- */
  // s: { mode: "ra"|"nc"|"mask"|"niv"|"mv", ncFlow, fio2Pct, dev ("venturi"|"mask"|"nrm"|"hfnc"), hfFlow,
  //      nivType ("bipap"|"cpap"), ipap, epap, peep, vt, rr, pplat, mawp, height, sex ("m"|"f"), pco2Target }
  var DEVICES = { venturi: "Venturi mask", mask: "Simple face mask", nrm: "Non-rebreather mask", hfnc: "HFNC" };
  function num_(v) { return v != null && isFinite(v) ? v : null; }
  function supportFio2(s) {
    if (!s || s.mode === "ra") return 21;
    if (s.mode === "nc") return num_(s.ncFlow) != null && s.ncFlow > 0 ? ncToFio2(s.ncFlow) : null;
    return num_(s.fio2Pct);
  }
  // Positive pressure at end-expiration, where it exists (for ARDS criteria)
  function endExpPressure(s) {
    if (!s) return null;
    if (s.mode === "mv") return num_(s.peep);
    if (s.mode === "niv") return num_(s.epap);
    return null;
  }
  function supportLine(s, fio2Pct) {
    var f = fio2Pct != null ? fmt(fio2Pct, 0) + "%" : "—";
    if (!s || s.mode === "ra") return "Room air";
    if (s.mode === "nc") return "Nasal cannula " + (num_(s.ncFlow) != null ? fmt(s.ncFlow, 1) + " L/min" : "—") + " (FiO₂ ≈ " + f + ")";
    if (s.mode === "mask") {
      var d = DEVICES[s.dev] || "Mask";
      return d + (s.dev === "hfnc" && num_(s.hfFlow) != null ? " " + fmt(s.hfFlow, 0) + " L/min" : "") + ", FiO₂ " + (s.dev === "mask" || s.dev === "nrm" ? "≈ " : "") + f;
    }
    if (s.mode === "niv") {
      if (s.nivType === "cpap") return "NIV (CPAP) " + (num_(s.epap) != null ? fmt(s.epap, 0) : "—") + " cmH₂O, FiO₂ " + f;
      var ps = num_(s.ipap) != null && num_(s.epap) != null ? " (PS " + fmt(s.ipap - s.epap, 0) + ")" : "";
      return "NIV (BiPAP) IPAP " + (num_(s.ipap) != null ? fmt(s.ipap, 0) : "—") + " / EPAP " + (num_(s.epap) != null ? fmt(s.epap, 0) : "—") + " cmH₂O" + ps + ", FiO₂ " + f;
    }
    var vm = VMODES[s.vmode] ? s.vmode : "acvc", parts = ["FiO₂ " + f];
    if (num_(s.peep) != null) parts.push("PEEP " + fmt(s.peep, 0));
    if ((isVC(vm) || isPRVC(vm)) && num_(s.vt) != null) parts.push("TV " + fmt(s.vt, 0) + " mL");
    if (isPC(vm) && num_(s.pinsp) != null) parts.push("Pinsp " + fmt(s.pinsp, 0));
    var psL = num_(s.psupp) != null ? s.psupp : vm === "psv" ? num_(s.pinsp) : null;
    if (hasPS(vm) && psL != null) parts.push("PS " + fmt(psL, 0));
    if (vm !== "psv" && num_(s.rr) != null) parts.push((isSIMV(vm) ? "fsimv " : "BUR ") + fmt(s.rr, 0));
    return "Ventilator " + VMODES[vm] + " (" + parts.join(", ") + ")";
  }
  function modeName(s) { return !s ? "" : s.mode === "niv" ? "NIV" : s.mode === "mv" ? "ventilator" : s.mode === "mask" ? (DEVICES[s.dev] || "mask") : s.mode === "nc" ? "nasal cannula" : "room air"; }

  // Which pO2 the desired-FiO2 calculation aims for
  function effectiveTarget(o) { // { custom, age, retainer, hypercap, mode, pf }
    if (o.custom != null && isFinite(o.custom)) return { value: o.custom, why: "custom target", kind: "custom" };
    if (o.retainer) return { value: 60, why: "CO₂ retainer: SpO₂ 88–92% ≈ pO₂ 55–65", kind: "co2" };
    if (o.mode === "mv" && o.pf != null && o.pf <= 300) return { value: 65, why: "ventilated with P/F ≤ 300: ARDSNet pO₂ 55–80", kind: "ards" };
    if (o.hypercap && o.mode !== "mv") return { value: 60, why: "hypercapnia: SpO₂ 88–92% ≈ pO₂ 55–65", kind: "co2" };
    if (o.age != null && isFinite(o.age)) return { value: ageTarget(o.age), why: "age-based: 104 − 0.4 × age", kind: "age" };
    return null;
  }
  // Don't advise more oxygen when pO2 is already adequate (unless the user set a custom target)
  function applyAdequacy(r, ox, tgt, pao2) {
    if (!r || r.errors.length || !tgt || tgt.kind === "custom" || pao2 == null) return r;
    var limit = tgt.kind === "age" ? (ox ? ox.mildLimit : 80) : 55;
    r.adequateLimit = limit;
    var cur = r.fio2Pct != null ? r.fio2Pct : r.fio2;
    var winHi = tgt.kind === "ards" ? 80 : tgt.kind === "co2" ? 65 : null;   // inside the target window: keep
    if (winHi != null && pao2 >= 55 && pao2 <= winHi && r.change !== "same") { r.change = "same"; r.adequate = true; r.inWindow = "55–" + winHi; return r; }
    if (pao2 >= limit && (r.change === "up" || (cur != null && r.fio2Req > cur))) { r.change = "same"; r.adequate = true; }
    return r;
  }

  /* ---------- Mechanical ventilation: settings, pressures, mechanics ----------
     s (mode "mv"): { vmode: acvc|acpc|prvc|simv|psv, fio2Pct, vt (set TV), pinsp (Pinsp or PS above PEEP), rr (BUR = set rate),
       ie ({i, e, text} from parseIE), flow (peak flow L/min), peep, ppeak, pplat, mawp, peeptot (total PEEP, expiratory hold),
       vte, vti, ftot (Ftotal), height, sex, pco2Target } */
  // Mode names as on the Mindray SV-series screen (common name in brackets where it differs)
  var VMODES = { acvc: "V-A/C (ACVC)", acpc: "P-A/C (ACPC)", prvc: "PRVC", simv: "V-SIMV", psimv: "P-SIMV", prvcsimv: "PRVC-SIMV", psv: "CPAP/PSV" };
  function isVC(m) { return m === "acvc" || m === "simv"; }
  function isPC(m) { return m === "acpc" || m === "psimv"; }
  function isPRVC(m) { return m === "prvc" || m === "prvcsimv"; }
  function isSIMV(m) { return m === "simv" || m === "psimv" || m === "prvcsimv"; }
  function hasPS(m) { return m === "psv" || isSIMV(m); }
  // "1:2", "1:2.5", "1/3", "2" (→ 1:2). Returns null (blank), NaN (unreadable) or { i, e, text }
  function parseIE(t) {
    if (t == null) return null;
    t = String(t).trim().replace(/,/g, ".").replace(/\s+/g, "");
    if (!t) return null;
    var m = t.match(/^(\d*\.?\d+)[:\/](\d*\.?\d+)$/), i, e;
    if (m) { i = +m[1]; e = +m[2]; }
    else if (/^\d*\.?\d+$/.test(t) && +t >= 1 && +t <= 10) { i = 1; e = +t; }
    else return NaN;
    if (!(i > 0 && e > 0) || i / e > 4 || e / i > 10) return NaN;
    return { i: i, e: e, text: fmt(i, 1) + ":" + fmt(e, 1) };
  }
  // ARDSNet PEEP/FiO2 tables (lower PEEP/higher FiO2; higher PEEP/lower FiO2), keyed by FiO2 %
  var PEEP_LO = { 30: [5, 5], 40: [5, 8], 50: [8, 10], 60: [10, 10], 70: [10, 14], 80: [14, 14], 90: [14, 18], 100: [18, 24] };
  var PEEP_HI = { 30: [5, 14], 40: [14, 16], 50: [16, 18], 60: [20, 20], 70: [20, 20], 80: [20, 22], 90: [22, 22], 100: [22, 24] };
  function peepTable(fio2Pct) {
    if (fio2Pct == null || !isFinite(fio2Pct)) return null;
    var k = Math.min(100, Math.round(fio2Pct / 10) * 10);
    if (k < 30) return { below: true };
    return { fio2: k, lo: PEEP_LO[k], hi: PEEP_HI[k] };
  }
  function rangeTxt(a) { return a[0] === a[1] ? String(a[0]) : a[0] + "–" + a[1]; }
  // No validated adult severity bands exist for OI or OSI: the PALICC-2 bands are for children, so none are applied here.
  function oiGrade(oi) {
    if (oi == null || !isFinite(oi)) return null;
    return { label: "higher means worse oxygenation for the airway pressure used; no validated adult severity bands (PALICC-2 bands are pediatric)", tone: "" };
  }

  // ARDSNet predicted body weight
  // ARDSNet: male 50 + 0.91 × (cm − 152.4); female 45.5 + 0.91 × (cm − 152.4). No sex entered → no PBW (never assume male).
  function pbw(heightCm, sex) {
    if (num_(heightCm) == null || heightCm < 120 || heightCm > 230) return null;
    if (sex !== "m" && sex !== "f") return null;
    return (sex === "f" ? 45.5 : 50) + 0.91 * (heightCm - 152.4);
  }
  // pCO2 to aim for on the ventilator. P/F <= 300: ARDSNet pH rules (goal 7.30–7.45, RR max 35; pH < 7.15 → RR 35).
  // Otherwise expected compensation for metabolic disorders, or the pCO2 that gives pH 7.40 (7.38 if chronic) at the current HCO3.
  // pH that a given pCO₂ would give at the current HCO₃ (Henderson–Hasselbalch; assumes HCO₃ does not change)
  function phAt(pco2, h) { return pco2 > 0 && h > 0 ? 9 - Math.log(24 * pco2 / h) / Math.LN10 : null; }
  function targetPco2(ab, retainer, ardsRange, paco2) {
    if (!ab || ab.errors.length) return null;
    var p = ab.primary, ex = ab.check ? ab.check.extra : null, h = ab.hco3, T = null;
    var metA = p === "met-acid" || p === "mixed-acid" || ex === "met-acid";
    if (ardsRange) {
      var p730 = Math.pow(10, 9 - 7.30) * h / 24, floor = p730 < 25;
      if (ab.ph < 7.15) T = metA ? { value: Math.max(1.5 * h + 8, 10), why: "ARDSNet pH < 7.15: rate up to 35; Winter's pCO₂ for HCO₃ " + fmt(h, 1), severe: true, goal: 7.15 }
        : { value: Math.max(25, p730), why: "ARDSNet pH < 7.15: rate up to 35", severe: true, goal: 7.15 };
      else if (ab.ph < 7.30) T = { value: Math.max(25, p730), why: floor ? "ARDSNet: aim for pH 7.30 but not below pCO₂ 25" : "pCO₂ for pH 7.30 at HCO₃ " + fmt(h, 1) + " (ARDSNet goal)", goal: 7.30, floor: floor };
      else if (ab.ph <= 7.45 && paco2 != null) T = { value: paco2, why: "pH within the ARDSNet goal 7.30–7.45" };
    }
    if (!T) {
      if (metA) T = { value: 1.5 * h + 8, why: "Winter's expected pCO₂ for HCO₃ " + fmt(h, 1) };
      else if (p === "met-alk") T = { value: 0.7 * h + 20, why: "expected compensation for HCO₃ " + fmt(h, 1) };
      else {
        var chronic = retainer || (p === "resp-acid" && ab.check && (ab.check.timing === "chronic" || ab.check.timing === "between"));
        var ph = chronic ? 7.38 : 7.40;
        T = { value: Math.pow(10, 9 - ph) * h / 24, why: "pCO₂ for pH " + fmt(ph, 2) + " at HCO₃ " + fmt(h, 1) + (chronic ? "; avoids post-hypercapnic alkalosis" : "") };
      }
    }
    T.hco3 = h; T.phAt = phAt(T.value, h);
    T.reach = T.goal == null || (T.phAt != null && T.phAt >= T.goal - 0.005);
    return T;
  }

  function pos_(v) { return v != null && isFinite(v) && v > 0 ? v : null; }
  // Fix common entry slips: volumes typed in litres, height in metres or inches. Returns a copy + notes.
  function normalizeVent(s) {
    if (!s) return { s: s, notes: [] };
    var o = {}, notes = []; for (var k in s) o[k] = s[k];
    ["vt", "vte", "vti"].forEach(function (k) {
      var v = num_(o[k]); if (v != null && v > 0 && v <= 2) { o[k] = Math.round(v * 1000); notes.push((k === "vt" ? "TV" : k === "vte" ? "VTE" : "VTi") + " read as " + o[k] + " mL (typed in litres)"); }
    });
    var h = num_(o.height);
    if (h != null && h >= 1.2 && h <= 2.3) { o.height = Math.round(h * 100); notes.push("Height read as " + o.height + " cm (typed in metres)"); }
    else if (h != null && h >= 48 && h <= 90) { o.height = Math.round(h * 2.54); notes.push("Height read as " + o.height + " cm (typed in inches)"); }
    return { s: o, notes: notes };
  }
  // gas (optional): { paused: true } when the acid–base reading is paused because pH, pCO2 and HCO3 disagree
  function ventCalc(s, ab, paco2, pao2, fio2Pct, retainer, gas) {
    if (!s || s.mode !== "mv") return null;
    s = normalizeVent(s).s;
    var vm = VMODES[s.vmode] ? s.vmode : "acvc", o = { vmode: vm, pbw: pbw(s.height, s.sex) };
    // Inconsistent or rejected measurements are flagged and every value that depends on them is withheld (v16.1, v16.2)
    o.issues = [];
    var vIssue = function (key, text, level) { o.issues.push({ key: key, text: text, level: level || "warn" }); };
    // v16.2: the gas values go through the same shared validation as the ABG tab; a rejected value never enters a calculation
    var pao2V = vOK("pao2", pao2), fiV = vOK("fio2Pct", fio2Pct), pco2V = vOK("paco2", paco2);
    var alvA = pao2AboveAlv(pao2, paco2, fio2Pct);
    if (alvA != null) { o.pao2Alv = { p: pao2V, f: fiV, c: pco2V, A: alvA }; pao2V = null; }
    o.pao2St = vStat("pao2", pao2); o.fio2St = vStat("fio2Pct", fio2Pct); o.pco2St = vStat("paco2", paco2);
    if (o.pao2St === "invalid") { o.pao2Bad = pao2; o.fio2Raw = fio2Pct; }
    if (o.fio2St === "invalid") o.fio2Bad = fio2Pct;
    if (o.pco2St === "invalid") o.pco2Bad = paco2;
    o.pco2Unverified = !!(gas && gas.paused) && pco2V != null;   // the gas is internally inconsistent: pCO2 may be the wrong value
    if (!o.pbw && pbw(s.height, "m")) o.pbwNeedSex = true;   // height entered, sex missing
    var vte = pos_(s.vte), vti = pos_(s.vti), vtSet = isVC(vm) || isPRVC(vm) ? pos_(s.vt) : null;
    // ΔPsupp (pressure support) in CPAP/PSV and the SIMV modes; older entries put PS in the Pinsp box on PSV
    var ps = hasPS(vm) ? (num_(s.psupp) != null && s.psupp >= 0 ? s.psupp : vm === "psv" ? pos_(s.pinsp) : null) : null;
    var pinsp = isPC(vm) ? pos_(s.pinsp) : vm === "psv" ? ps : null;
    o.ps = ps; o.simv = isSIMV(vm);
    // Delivered volume: exhaled (VTE) first, then the set TV, then VTi
    o.vt = vte != null ? vte : vtSet != null ? vtSet : vti;
    o.vtSrc = vte != null ? "VTE" : vtSet != null ? "set TV" : vti != null ? "VTi" : null;
    if (o.vt != null && o.vt <= 0) o.vt = null;
    if (o.vt != null && o.pbw) o.vtkg = o.vt / o.pbw;
    if (vtSet != null && o.pbw) o.vtSetKg = vtSet / o.pbw;
    var bur = vm === "psv" ? null : pos_(s.rr), ftot = pos_(s.ftot);
    o.fmand = num_(s.fmand) != null && s.fmand >= 0 ? s.fmand : null; o.fspn = num_(s.fspn) != null && s.fspn >= 0 ? s.fspn : null;
    if (ftot == null && o.fmand != null && o.fspn != null && o.fmand + o.fspn > 0) ftot = o.fmand + o.fspn;
    o.bur = bur;
    o.f = ftot != null && ftot > 0 ? ftot : bur != null && bur > 0 ? bur : null;
    o.fSrc = ftot != null && ftot > 0 ? "Ftotal" : o.f != null ? "BUR" : null;
    if (ftot != null && bur != null) o.trig = ftot - bur;
    // A new set rate can be estimated only when breaths are machine-delivered (no meaningful patient triggering).
    o.spont = isSIMV(vm) ? ((o.fspn != null && o.fspn >= 1) || (o.trig != null && o.trig >= 1)) : (o.trig != null && o.trig >= 2);
    o.ftotMissing = ftot == null && bur != null && vm !== "psv";
    if (o.vt != null && o.f != null) o.ve = o.vt * o.f / 1000;
    // Measured minute volume beats VT × rate, especially in SIMV where breaths differ (v16.2: only when plausible, and,
    // outside SIMV, only when it roughly agrees with VT × total rate; otherwise neither is assumed)
    var mvM = num_(s.mv);
    if (mvM != null && mvM > 0) {
      if (vStat("mv", mvM) === "invalid") { o.mvBad = mvM; vIssue("mv", "Measured minute ventilation " + fmt(mvM, 1) + " L/min is outside 0.5–60 L/min: it is not used. Check the entry and the unit."); }
      else if (o.ve != null && !isSIMV(vm) && (mvM / o.ve > 2 || mvM / o.ve < 0.5)) {
        o.mvDisputed = { m: mvM, c: o.ve }; o.veCalc = o.ve; o.ve = null;
        vIssue("mv", "Measured minute ventilation " + fmt(mvM, 1) + " L/min and VT × rate (" + fmt(o.mvDisputed.c, 1) + " L/min) differ more than 2-fold: recheck MV, VT and Ftotal (wrong field or unit, or a large leak). Minute ventilation, the ventilatory ratio and ventilation targets are not assessed until they agree.");
      }
      else {
        o.veCalc = o.ve; o.ve = mvM; o.veSrc = "measured";
        if (mvM < 2 || mvM > 30) { o.mvExtreme = true; vIssue("mv", "Measured minute ventilation " + fmt(mvM, 1) + " L/min is extreme: confirm it on the ventilator; it is used as entered."); }
      }
    }
    if (pos_(s.mvspn) != null && o.ve) { o.mvspn = s.mvspn; o.spontShare = Math.min(100, s.mvspn / o.ve * 100); }
    if (num_(s.mvleak) != null && s.mvleak >= 0 && o.ve) { o.mvleak = s.mvleak; o.leakMV = s.mvleak / (o.ve + s.mvleak) * 100; }
    var vtspn = pos_(s.vtespn); if (vtspn != null) { o.vtspn = vtspn; if (o.pbw) o.vtspnKg = vtspn / o.pbw; }
    if (o.pbw) o.vePred = o.pbw * 0.1;                  // 100 mL/kg PBW per min
    if (o.ve != null && o.pbw && pco2V != null) { o.vr = (o.ve * 1000 * pco2V) / (o.pbw * 100 * 37.5); if (o.pco2Unverified) o.vrUnverified = true; }
    var peep = num_(s.peep), ptot = num_(s.peeptot), ppk = pos_(s.ppeak), ppl = pos_(s.pplat);
    o.peepM = num_(s.peepm) != null && s.peepm >= 0 ? s.peepm : null;   // measured end-expiratory PEEP (ventilator display)
    if (ppk != null && peep != null && ppk < peep - 1) {
      o.badPpk = true;
      vIssue("ppeak", "Peak pressure " + fmt(ppk, 0) + " is below PEEP " + fmt(peep, 0) + ", which is impossible: recheck both. Peak-based values (dynamic compliance, resistance, mechanical power) are withheld.");
      ppk = null;
    }
    if (ptot != null && peep != null && ptot < peep - 1) {
      o.badPeepTot = true;
      vIssue("peeptot", "Total PEEP " + fmt(ptot, 0) + " is below set PEEP " + fmt(peep, 0) + ": both cannot be right, because an end-expiratory hold in a passive patient reads at least the set PEEP. Recheck both (full expiratory hold, no patient effort, same breath). Auto-PEEP, driving pressure and compliance are not calculated until they agree.");
    }
    // End-expiratory pressure for driving pressure, compliance and mechanical power (v16.2). A valid expiratory-hold total
    // PEEP is the reference; without one, set PEEP (or the measured PEEP when it is within 2 of set). When set and measured
    // PEEP disagree and no hold settles it, nothing is assumed: the dependent values are withheld.
    var ptotV = ptot != null && !o.badPeepTot ? ptot : null;
    if (o.badPeepTot) o.peepEff = null;
    else if (ptotV != null) {
      if (o.peepM != null && o.peepM > ptotV + 2) o.peepUnres = { m: o.peepM, ref: ptotV, hold: true };
      else { o.peepEff = Math.max(ptotV, o.peepM != null ? o.peepM : peep != null ? peep : ptotV); o.peepSrc = "total PEEP"; }
    }
    else if (o.peepM != null && peep != null && Math.abs(o.peepM - peep) > 2) o.peepUnres = { m: o.peepM, ref: peep, hold: false };
    else if (o.peepM != null || peep != null) { o.peepEff = o.peepM != null ? o.peepM : peep; o.peepSrc = o.peepM != null ? "measured PEEP" : "set PEEP"; }
    if (o.peepUnres) {
      var U = o.peepUnres;
      o.peepUnresTxt = U.hold ? "measured PEEP " + fmt(U.m, 0) + " is above the expiratory-hold total PEEP " + fmt(U.ref, 0) : "set PEEP " + fmt(U.ref, 0) + ", measured " + fmt(U.m, 0) + ", no expiratory hold";
      vIssue("peepm", U.hold
        ? "Measured PEEP " + fmt(U.m, 0) + " is above the expiratory-hold total PEEP " + fmt(U.ref, 0) + ": both cannot be right (active breathing or a reading during a transient?). The app does not assume which is right: driving pressure, compliance and mechanical power are not assessed until a repeat hold in a passive patient settles it."
        : "Measured PEEP " + fmt(U.m, 0) + " differs from set PEEP " + fmt(U.ref, 0) + " by more than 2 and no expiratory-hold total PEEP was entered: " + (U.m < U.ref ? "a leak (cuff, circuit), active breathing" : "auto-PEEP (incomplete exhalation), active breathing") + " or a reading error. The app does not assume which value is right: driving pressure, compliance and mechanical power are not assessed until an expiratory hold in a passive patient confirms the end-expiratory pressure.");
    }
    if (ptotV != null && peep != null) o.autoPeep = ptotV - peep;
    var peepRef = o.peepEff != null ? o.peepEff : peep;
    if (ppl != null && peepRef != null && ppl < peepRef) {
      o.badPlat = true;
      vIssue("pplat", "Plateau " + fmt(ppl, 0) + " is below PEEP " + fmt(peepRef, 0) + ", which is impossible: recheck both. Plateau-based values and advice are withheld.");
    }
    if (ppk != null && ppl != null && ppl > ppk + 1) {
      o.badPeak = true;
      vIssue("pplat", "Plateau " + fmt(ppl, 0) + " is above the peak pressure " + fmt(ppk, 0) + ", which is impossible: plateau-based values and advice (VT, driving pressure, compliance) are withheld. Repeat the inspiratory hold (about 0.5 s) with the patient passive and read the plateau once the pressure has settled.");
    }
    if (o.badPlat || o.badPeak) ppl = null;
    o.pplV = ppl;   // the plateau that may be used, or null
    // Driving pressure = plateau − PEEP (total PEEP if measured). Pinsp and peak pressure are not substitutes for a plateau.
    if (ppl != null && o.peepEff != null && !o.badPlat) o.dp = ppl - o.peepEff;
    if (o.dp != null && o.spont) o.dpUnverified = true;   // plateau (or hold) taken while the patient triggers breaths
    if (isPC(vm) && pinsp != null) o.dPinsp = pinsp;
    if (o.vt != null && o.dp != null && o.dp > 0) { o.cstat = o.vt / o.dp; o.cstatSrc = "plateau"; }
    if (ppk != null && o.peepEff != null && o.vt != null && ppk - o.peepEff > 0) o.cdyn = o.vt / (ppk - o.peepEff);
    if (ppk != null && ppl != null && ppk >= ppl) o.gap = ppk - ppl;
    if (o.gap != null && isVC(vm) && pos_(s.flow) != null) o.raw = o.gap / (s.flow / 60);   // constant (square-wave) flow
    // Values the ventilator measures itself (Mindray: Cstat, Cdyn, Ri, RCexp, RSBI)
    if (pos_(s.cstatm) != null) { o.cstatM = s.cstatm; if (o.cstat == null) { o.cstat = s.cstatm; o.cstatSrc = "ventilator"; } }
    if (pos_(s.cdynm) != null) o.cdynM = s.cdynm;
    if (pos_(s.ri) != null) { o.riM = s.ri; if (o.raw == null) { o.raw = s.ri; o.rawSrc = "ventilator"; } }
    if (o.raw != null && o.cstat != null) o.tau = o.raw * o.cstat / 1000;                   // seconds
    if (pos_(s.rcexp) != null && s.rcexp < 10) { o.tau = s.rcexp; o.tauSrc = "RCexp"; }
    if (pos_(s.rsbim) != null) o.rsbiM = s.rsbim;
    if (pos_(s.ftrig) != null) o.ftrig = s.ftrig;
    if (pos_(s.tslope) != null && s.tslope < 3) o.tslope = s.tslope;
    if (peep != null && peep < 5) o.peepLow = true;
    // Ti is fixed by the set rate and I:E (or Tinsp); the expiratory time actually available shrinks when the patient
    // breathes above the set rate, so Te uses the actual total rate
    var cycSet = bur != null ? 60 / bur : o.f != null ? 60 / o.f : null, cycAct = o.f != null ? 60 / o.f : cycSet;
    if (s.ie && typeof s.ie === "object" && vm !== "psv") {
      o.ie = s.ie;
      if (cycSet != null) { o.ti = cycSet * s.ie.i / (s.ie.i + s.ie.e); o.te = Math.max(0, cycAct - o.ti); if (cycAct < cycSet - 0.05) o.teAct = true; }
    }
    if (o.ie) o.tiSrc = "I:E " + o.ie.text;
    // No I:E: pressure modes use the set inspiratory time; volume control uses TV ÷ peak flow (constant, square-wave flow)
    if (!o.ie && vm !== "psv" && cycSet != null) {
      var tiD = null, how = "";
      if (pos_(s.ti) != null && s.ti < 10) { tiD = s.ti; how = "set Ti"; }
      else if (isVC(vm) && vtSet != null && pos_(s.flow) != null) { tiD = (vtSet / 1000) / (s.flow / 60); how = "TV ÷ peak flow"; }
      if (tiD != null && tiD > 0 && tiD < cycSet) {
        o.ti = tiD; o.te = Math.max(0, cycAct - tiD); o.tiSrc = how; o.ieDerived = "1:" + fmt((cycSet - tiD) / tiD, 1);
        if (cycAct < cycSet - 0.05) o.teAct = true;
      }
      else if (tiD != null && tiD >= cycSet) o.tiLong = { ti: tiD, cyc: cycSet, how: how };
    }
    if (hasPS(vm) && num_(s.ets) != null && s.ets > 0 && s.ets < 90) o.ets = s.ets;
    if (vte != null && vti != null && vti > 0) o.leak = (vti - vte) / vti * 100;
    if (vte != null && vtSet != null && isVC(vm)) o.vtDiff = (vte - vtSet) / vtSet * 100;
    if (ftot != null && bur != null && ftot < bur - 1) {
      o.fLow = true;
      vIssue("ftot", "Ftotal " + fmt(ftot, 0) + " is below the set rate " + fmt(bur, 0) + ", which cannot happen in assist-control or SIMV modes. Recheck both; rate calculations are withheld.");
    }
    o.rateSettable = vm !== "psv" && !o.fLow && !o.spont;
    if (o.pplV != null && o.spont) vIssue("pplat", "A plateau was entered while the patient is triggering breaths: it is reliable only from a hold in a passive patient. Interpret plateau-based values with caution: driving pressure and compliance are shown as unverified.");
    // Effort and drive (assisted breathing): P0.1; end-expiratory occlusion ΔPocc → Pmus ≈ 0.75 × |ΔPocc|,
    // dynamic transpulmonary driving pressure ≈ (peak − PEEP) + 0.66 × |ΔPocc| (Bertoni 2019)
    var p01 = num_(s.p01); if (p01 != null) o.p01 = Math.abs(p01);
    var pocc = num_(s.pocc);
    if (pocc != null && pocc !== 0) {
      o.pocc = -Math.abs(pocc); o.pmus = 0.75 * Math.abs(pocc);
      var dpaw = ppk != null && o.peepEff != null ? ppk - o.peepEff : (vm === "psv" || isPC(vm)) && pinsp != null ? pinsp : null;
      if (dpaw != null) o.dpl = dpaw + 0.66 * Math.abs(pocc);
    }
    // Pulse oximetry: SpO2/FiO2 and oxygen saturation index
    var mawp = pos_(s.mawp);
    if (mawp != null && (vStat("mawp", mawp) === "invalid" || (peep != null && mawp < peep - 1) || (ppk != null && mawp > ppk + 1))) {
      o.badMawp = vStat("mawp", mawp) === "invalid" ? "outside 1–60" : peep != null && mawp < peep - 1 ? "below PEEP " + fmt(peep, 0) : "above the peak pressure " + fmt(ppk, 0);
      vIssue("mawp", "Mean airway pressure " + fmt(mawp, 0) + " is " + o.badMawp + ", which is impossible (it lies between PEEP and the peak): the oxygenation and saturation indices are not assessed. Recheck the entry.");
      mawp = null;
    }
    o.mawpV = mawp;
    var spo2 = num_(s.spo2);
    if (spo2 != null && vStat("spo2", spo2) === "invalid") {
      o.spo2Bad = spo2;
      vIssue("spo2", spo2 > 100 ? "SpO₂ " + fmt(spo2, 0) + "% is not possible: check the entry. It is not used." : "SpO₂ " + fmt(spo2, 0) + "% is below the range used here (51–100%), so S/F and the saturation index are not calculated: confirm with an ABG.", spo2 > 100 ? "warn" : "crit");
    }
    if (spo2 != null && !o.spo2Bad && fiV) {
      o.spo2 = spo2; o.sf = spo2 / (fiV / 100);
      if (mawp != null && spo2 <= 97) o.osi = (fiV / 100) * mawp * 100 / spo2;
      if (spo2 <= 97 && o.sf <= 315) { o.sfRange = true; if (num_(s.peep) != null && s.peep >= 5) o.sfSev = o.sf <= 148 ? "severe" : o.sf <= 235 ? "moderate" : "mild"; }
    }
    // Mechanical power, J/min: volume control 0.098·RR·VT·(Ppeak − ½·ΔP); pressure control 0.098·RR·VT·(ΔPinsp + PEEP)
    var vtL = o.vt != null ? o.vt / 1000 : null;
    if (vtL != null && o.f != null) {
      if (isVC(vm) && ppk != null && ppl != null && peep != null && !o.badPlat) {
        if (o.peepUnres || o.badPeepTot) o.mpNA = o.peepUnres ? "end-expiratory pressure unresolved" : "total PEEP below set PEEP";
        else o.mp = 0.098 * o.f * vtL * (ppk - (ppl - peep) / 2);
      }
      else if ((isPC(vm) || isPRVC(vm)) && peep != null && (pinsp != null || ppk != null)) o.mp = 0.098 * o.f * vtL * (pinsp != null ? pinsp + peep : ppk);
    }
    if (vm === "psv" && o.vt != null && o.f != null) o.rsbi = o.f / (o.vt / 1000);
    // RSBI is a weaning index only on minimal support (PS ≤ 8, or CPAP / T-piece)
    o.rsbiOK = !(ps != null && ps > 8) && !isSIMV(vm);
    if (ps != null && ps > ((pinsp != null && isPC(vm)) ? pinsp : 99) - 0.5 && isPC(vm)) o.psOverPinsp = true;
    if (mawp != null && fiV != null && pao2V != null) { o.oi = (fiV / 100) * mawp * 100 / pao2V; o.oiG = oiGrade(o.oi); }
    var pf = pao2V != null && fiV ? pao2V / (fiV / 100) : null;
    o.pf = pf; o.ardsRange = pf != null && pf <= 300;
    o.peep = peep; o.fio2Pct = fiV;
    if (pf == null && o.sf != null && o.spo2 <= 97 && o.sf <= 315) o.ardsRangeSF = true;   // global ARDS definition 2023
    o.wean = weanScreen(o, s, ab, fiV);
    if (o.ardsRange) o.peepTab = peepTable(fiV);
    if (num_(s.pco2Target) != null && s.pco2Target > 0) {
      o.target = { value: s.pco2Target, why: "your custom target", custom: true, reach: true };
      if (ab && !ab.errors.length) { o.target.hco3 = ab.hco3; o.target.phAt = phAt(s.pco2Target, ab.hco3); }
    } else o.target = targetPco2(ab, retainer, o.ardsRange, pco2V);
    if (o.target && vm !== "psv" && o.f != null && pco2V != null && !o.pco2Unverified && o.target.value > 0) {
      if (!o.fLow) o.rrNeed = o.f * pco2V / o.target.value;
      if (o.ve != null && !o.mvExtreme) o.veNeed = o.ve * pco2V / o.target.value;   // no projection from an unconfirmed extreme MV
    }
    return o;
  }
  // Readiness for a spontaneous breathing trial (numbers only; clinical items listed as reminders)
  function weanScreen(o, s, ab, fio2Pct) {
    // ok: true (met), false (not met) or null (not assessed: the value is invalid or missing; never counted as met)
    var C = [], add = function (k, label, ok, val) { C.push({ k: k, label: label, ok: ok, val: val }); };
    // v16.2: oxygenation only from a valid PaO2 (P/F) or, failing that, a valid SpO2 (its source named); otherwise not assessed
    var oxWhy = o.pao2Bad != null ? "pO₂ " + fmt(o.pao2Bad, 0) + " is invalid" : o.fio2Bad != null ? "FiO₂ " + fmt(o.fio2Bad, 0) + "% is invalid"
      : o.pao2Alv ? "pO₂ " + fmt(o.pao2Alv.p, 0) + " is above what FiO₂ " + fmt(o.pao2Alv.f, 0) + "% can give (check FiO₂)" : null;
    if (o.pf != null) add("ox", "Oxygenation: P/F ≥ 150", o.pf >= 150, "P/F " + Math.round(o.pf));
    else if (o.spo2 != null && fio2Pct != null) add("ox", "Oxygenation: SpO₂ > 90% on FiO₂ ≤ 40%" + (oxWhy ? " (from SpO₂ because " + oxWhy + "; pulse oximetry only)" : ""), o.spo2 > 90 && fio2Pct <= 40, "SpO₂ " + fmt(o.spo2, 0) + "% on " + fmt(fio2Pct, 0) + "%");
    else if (oxWhy) add("ox", "Oxygenation", null, "not assessed: " + oxWhy + " and there is no valid SpO₂");
    if (o.peep != null) add("peep", "PEEP ≤ 8", o.peep <= 8, "PEEP " + fmt(o.peep, 0));
    if (fio2Pct != null) add("fio2", "FiO₂ ≤ 40–50%", fio2Pct <= 50, "FiO₂ " + fmt(fio2Pct, 0) + "%");
    else if (o.fio2Bad != null) add("fio2", "FiO₂ ≤ 40–50%", null, "not assessed: FiO₂ " + fmt(o.fio2Bad, 0) + "% is invalid");
    var ft = pos_(s.ftot); if (ft != null) add("rr", "Rate ≤ 35/min", ft <= 35, fmt(ft, 0) + "/min");
    if (o.vtkg != null && pos_(s.vte) != null) add("vt", "VT > 5 mL/kg PBW", o.vtkg > 5, fmt(o.vtkg, 1) + " mL/kg");
    var rsbiW = o.rsbi != null ? o.rsbi : o.rsbiM;
    // RSBI is shown but never decides readiness: AARC 2024 suggests it is not needed to decide on an SBT
    var rsbiInfo = rsbiW != null && o.rsbiOK ? { label: "RSBI (information only)", val: String(Math.round(rsbiW)), ok: rsbiW < 105 } : null;
    if (ab && !ab.errors.length) add("ph", "No significant respiratory acidosis (pH ≥ 7.30)", ab.ph >= 7.30, "pH " + fmt(ab.ph, 2));
    if (o.p01 != null) add("p01", "P0.1 not high (≤ 3.5)", o.p01 <= 3.5, fmt(o.p01, 1));
    var assessed = C.filter(function (c) { return c.ok !== null; });
    var known = assessed.length, met = assessed.filter(function (c) { return c.ok; }).length, na = C.length - known;
    // low support judged on the FiO2 actually validated (an invalid FiO2 is never "≤ 50%")
    var fiLow = fio2Pct != null && fio2Pct <= 50;
    var lowSupport = (o.vmode === "psv" && (o.ps == null || o.ps <= 10)) || (o.peep != null && o.peep <= 8 && fiLow);
    var hasOx = assessed.some(function (c) { return c.k === "ox"; });
    var spont = o.vmode === "psv" || (o.fspn != null && o.fspn >= 1) || (o.trig != null && o.trig >= 1);          // breathing on their own
    var entryErr = !!(o.fLow || o.badPeak || o.badPlat || o.tiLong);
    var ctx = lowSupport && spont && !entryErr;
    return { items: C, known: known, met: met, na: na, allMet: known >= 4 && met === known && !na, relevant: ctx && hasOx,
      incomplete: ctx && !hasOx && !!oxWhy, rsbi: rsbiInfo };
  }
  // Stress index (Ranieri 2000): during constant-flow, passive inflation P(t) = a·t^b + c.
  // b > 1.1 upward concavity (tidal overdistension), b < 0.9 downward concavity (tidal recruitment), ≈ 1 linear.
  // The fit skips the first 25% of inflation (the resistive step) and the last 5%; c is free, b by grid search.
  function stressIndex(p, s0, s1) {
    if (s1 - s0 < 12) return null;
    var a0 = Math.round(s0 + 0.25 * (s1 - s0)), a1 = Math.round(s0 + 0.95 * (s1 - s0)), T = [], P = [];
    for (var i = a0; i <= a1; i++) { T.push((i - s0) / (s1 - s0)); P.push(p[i]); }
    if (T.length < 8 || !(P[P.length - 1] > P[0])) return null;
    var best = null;
    for (var bb = 0.5; bb <= 2.0001; bb += 0.01) {
      var X = T.map(function (t) { return Math.pow(t, bb); }), mx = 0, my = 0, m = X.length;
      for (var k = 0; k < m; k++) { mx += X[k]; my += P[k]; } mx /= m; my /= m;
      var sxy = 0, sxx = 0; for (var k2 = 0; k2 < m; k2++) { sxy += (X[k2] - mx) * (P[k2] - my); sxx += (X[k2] - mx) * (X[k2] - mx); }
      if (!(sxx > 0)) continue;
      var aa = sxy / sxx, cc = my - aa * mx, sse = 0; if (!(aa > 0)) continue;
      for (var k3 = 0; k3 < m; k3++) { var r = P[k3] - (aa * X[k3] + cc); sse += r * r; }
      if (!best || sse < best.sse) best = { b: bb, sse: sse };
    }
    return best ? Math.round(best.b * 100) / 100 : null;
  }

  // Kept for older callers: short summary lines
  // What the driving pressure was calculated from (v16.2: provenance is always shown)
  function dpBasis(v) {
    return v.peepSrc === "total PEEP" ? "plateau − total PEEP " + fmt(v.peepEff, 0) + " from the expiratory hold" : v.peepSrc === "measured PEEP" ? "plateau − measured PEEP " + fmt(v.peepEff, 0) : "plateau − PEEP";
  }
  // The first n suggestions, but never without a critical one (high-priority warnings must not fall off the end)
  function capSugg(list, n) {
    if (!list || list.length <= n) return list || [];
    var keep = list.slice(0, n), crit = list.slice(n).filter(function (x) { return x.tone === "crit"; });
    if (!crit.length) return keep;
    var drop = keep.length + crit.length - n, out = [];
    for (var i = keep.length - 1; i >= 0 && drop > 0; i--) if (keep[i].tone !== "crit") { keep[i] = null; drop--; }
    keep.forEach(function (x) { if (x) out.push(x); });
    return list.filter(function (x) { return out.indexOf(x) > -1 || crit.indexOf(x) > -1; });
  }
  function ventLines(v, s) {
    if (!v) return [];
    var L = [];
    if (v.vtkg != null) L.push("VT " + fmt(v.vt, 0) + " mL = " + fmt(v.vtkg, 1) + " mL/kg PBW");
    if (v.ve != null) L.push("Minute ventilation: " + fmt(v.ve, 1) + " L/min");
    if (v.dp != null) L.push("Driving pressure: " + fmt(v.dp, 0) + " cmH₂O");
    if (v.oi != null) L.push("Oxygenation index: " + fmt(v.oi, 1));
    return L;
  }

  // Ventilator interpretation: [{ key, text, tone, msg }] — msg = goes into the copied message
  function ventInterp(v, sp, ab) {
    if (!v || !sp) return [];
    var L = [], add = function (key, text, tone, msg) { L.push({ key: key, text: text, tone: tone || "", msg: msg !== false }); };
    var ppl = v.pplV != null ? v.pplV : null, ppk = num_(sp.ppeak);
    var p = ab ? ab.primary : null, ex = ab && ab.check ? ab.check.extra : null;
    var metAcid = p === "met-acid" || p === "mixed-acid" || ex === "met-acid";
    var stiff = v.cstat != null ? v.cstat < 40 : ppl != null && ppl > 30 ? true : null;
    var unv = v.dpUnverified && v.cstatSrc !== "ventilator" ? " (unverified: plateau taken while the patient was triggering)" : "";
    if (v.badPlat) add("check", "Plateau is below PEEP: recheck the plateau (inspiratory hold) and PEEP entries.", "warn");
    normalizeVent(sp).notes.forEach(function (t) { add("check", "Entry: " + t + ".", "", false); });
    if (v.badPeak) add("check", "Plateau is above the peak pressure: recheck both (the plateau cannot exceed the peak).", "warn", false);
    if (v.fLow) add("check", "Ftotal " + fmt(sp.ftot, 0) + " is below the set rate " + fmt(v.bur, 0) + ": in assist-control the total rate cannot be below BUR; recheck the entries.", "warn", false);
    if (v.vtDiff != null && v.vtDiff >= 20) add("vtdiff", "VTE is " + fmt(v.vtDiff, 0) + "% above the set TV in volume control: breath stacking (double triggering), a flow-sensor error, or a mode with adaptive volume; check the screen.", "warn");
    else if (v.vtDiff != null && v.vtDiff <= -15) add("vtdiff", "VTE is " + fmt(-v.vtDiff, 0) + "% below the set TV: leak (cuff, circuit, chest-tube air leak) or a flow-sensor error.", "warn");
    if (v.tiLong) add("check", "Inspiratory time ≈ " + fmt(v.tiLong.ti, 1) + " s (" + v.tiLong.how + ") is longer than the breath cycle " + fmt(v.tiLong.cyc, 1) + " s at this rate: recheck TV, peak flow, Ti or rate.", "warn", false);
    if (v.ieDerived && v.te != null) add("te0", "No I:E entered: Ti ≈ " + fmt(v.ti, 2) + " s from " + v.tiSrc + (v.tiSrc === "TV ÷ peak flow" ? " (assumes square-wave flow and no inspiratory pause)" : "") + ", so I:E ≈ " + v.ieDerived + ".", "", false);
    var resist = v.raw != null ? v.raw > 15 : v.gap != null ? v.gap > 10 : null;
    var cTxt = v.cstat != null ? " (Cstat " + fmt(v.cstat, 0) + " mL/cmH₂O" + (v.cstatSrc === "ventilator" ? ", ventilator" : "") + ")" : "";
    var rTxt = v.rawSrc === "ventilator" ? " (Ri " + fmt(v.raw, 0) + " cmH₂O/L/s)" : v.gap != null ? " (peak − plateau " + fmt(v.gap, 0) + ")" : "";
    if (stiff && resist) add("mech", "Low compliance" + cTxt + " and high airway resistance" + rTxt + unv + ": a stiff lung or chest wall plus an airway problem.", "warn");
    else if (stiff) add("mech", "Low compliance" + cTxt + (resist === false && !unv ? " with normal airway resistance" : "") + unv + ": stiff lungs or chest wall (ARDS, pulmonary edema, pneumonia, atelectasis, mainstem intubation, pneumothorax, large effusion, abdominal distension).", "warn");
    else if (resist) add("mech", "High airway resistance" + rTxt + (stiff === false && !unv ? " with normal compliance" : "") + unv + ": airway problem (bronchospasm, secretions or mucus plug, kinked or bitten tube, small tube).", "warn");
    else if ((stiff === false || resist === false) && unv) add("mech", "Compliance and resistance are not interpreted: the plateau was taken while the patient was triggering breaths. Repeat the hold with the patient passive.", "");
    else if (stiff === false && resist === false) add("mech", "Compliance and airway resistance are within normal limits" + cTxt + ".", "ok");
    else if (stiff === false) add("mech", "Compliance is normal" + cTxt + ".", "ok");
    else if (ppk != null && ppk > 35) add("mech", "Peak pressure " + fmt(ppk, 0) + " is high: do an inspiratory hold (plateau) to tell airway resistance from stiff lungs.", "warn");
    if (v.dp != null) {
      if (v.dp > 15) add("dp", "Driving pressure " + fmt(v.dp, 0) + " (" + dpBasis(v) + ") is above 15: high lung stress" + (v.dpUnverified ? " (unverified: plateau taken while the patient was triggering)" : "") + ".", "warn");
      else if (v.dpUnverified) add("dp", "Driving pressure " + fmt(v.dp, 0) + " is unverified: the plateau was taken while the patient was triggering, so it is not compared with the goal.", "", false);
      else add("dp", "Driving pressure " + fmt(v.dp, 0) + " (" + dpBasis(v) + ") is within 15.", "ok", false);
    } else if (v.peepUnres) add("dp", "Driving pressure not assessed: the end-expiratory pressure is unresolved (" + v.peepUnresTxt + "). Do an expiratory hold in a passive patient.", "warn");
    else if (v.badPeepTot) add("dp", "Driving pressure not assessed: total PEEP is below set PEEP; recheck both.", "warn", false);
    else if (!v.badPlat && !v.badPeak) add("dp", "Driving pressure not available: it needs a plateau pressure (inspiratory hold)." + (v.dPinsp != null ? " ΔPinsp " + fmt(v.dPinsp, 0) + " is the set pressure above PEEP; it equals the driving pressure only if flow falls to zero before the breath ends." : ""), "", false);
    if (ppl != null && ppl > 30) add("pplat", "Plateau " + fmt(ppl, 0) + " is above 30: overdistension risk.", "warn");
    if (v.pbwNeedSex) add("pbw", "Select Male or Female: predicted body weight, mL/kg and the lung-protective volume are not calculated without sex (PBW differs by 4.5 kg).", "warn");
    if (v.vtkg != null) {
      if (v.vtkg > 8) add("vt", "VT " + fmt(v.vtkg, 1) + " mL/kg PBW" + (v.vtSrc === "VTE" ? " (exhaled)" : "") + " is above the lung-protective range (4–8).", "warn");
      else if (v.vtkg < 4) add("vt", "VT " + fmt(v.vtkg, 1) + " mL/kg PBW is below 4: check height, sex and volume.", "warn");
      else add("vt", "VT " + fmt(v.vtkg, 1) + " mL/kg PBW is in the lung-protective range (4–8).", "ok", false);
    }
    if (v.autoPeep != null) {
      if (v.autoPeep >= 2) add("autopeep", "Auto-PEEP " + fmt(v.autoPeep, 0) + " cmH₂O: air trapping (dynamic hyperinflation).", "warn");
      else add("autopeep", "No significant auto-PEEP (total PEEP " + fmt(sp.peeptot, 0) + ").", "ok", false);
    }
    if (v.te != null && v.tau != null) {
      var tsrc = v.tauSrc === "RCexp" ? " (RCexp " + fmt(v.tau, 2) + " s)" : "";
      if (v.te < 3 * v.tau) add("te", "Expiratory time " + fmt(v.te, 1) + " s is shorter than 3 time constants" + tsrc + " (" + fmt(3 * v.tau, 1) + " s): air trapping likely.", "warn");
      else add("te", "Expiratory time " + fmt(v.te, 1) + " s is enough to exhale (3 time constants" + tsrc + " = " + fmt(3 * v.tau, 1) + " s).", "ok", false);
    }
    if (v.ie && v.ie.i > v.ie.e) add("ie", "Inverse I:E (" + v.ie.text + "): watch for auto-PEEP and low BP.", "warn");
    if (v.leak != null && v.leak >= 10 && !v.simv) add("leak", "VTE is " + fmt(v.leak, 0) + "% lower than VTi: possible leak (cuff, circuit, chest tube air leak).", "warn");
    else if (v.leak != null && Math.abs(v.leak) >= 10 && v.simv) add("leak", "VTi and VTE differ by " + fmt(Math.abs(v.leak), 0) + "%: in SIMV they can come from different breaths (mandatory vs pressure-support); compare them on the same breath" + (v.leakMV != null ? "; MVleak " + fmt(v.mvleak, 1) + " L/min (" + fmt(v.leakMV, 0) + "%)" : "") + ".", v.leakMV != null && v.leakMV >= 10 ? "warn" : "", false);
    else if (v.leak != null && v.leak <= -10) add("leak", "VTE is higher than VTi: recheck the readings or flow sensor.", "");
    if (v.leakMV != null && v.leakMV >= 10 && !(v.leak != null && v.leak >= 10)) add("leak", "MVleak " + fmt(v.mvleak, 1) + " L/min is " + fmt(v.leakMV, 0) + "% of the delivered volume: leak (cuff, circuit, chest tube).", "warn");
    else if (v.leakMV != null && v.leakMV < 10 && v.leak == null) add("leak", "MVleak " + fmt(v.mvleak, 1) + " L/min: no significant leak.", "ok", false);
    var ftot = num_(sp.ftot);
    if (v.simv) {
      var fsp = v.fspn != null ? v.fspn : v.trig != null && v.trig > 0 ? v.trig : null;
      if (fsp != null || v.vtspn != null || v.spontShare != null)
        add("simv", "SIMV: " + (v.fmand != null ? fmt(v.fmand, 0) : v.bur != null ? fmt(v.bur, 0) : "?") + " mandatory + " + (fsp != null ? fmt(fsp, 0) : "?") + " spontaneous (pressure-support) breaths/min" +
          (v.vtspn != null ? "; spontaneous VT " + fmt(v.vtspn, 0) + " mL" + (v.vtspnKg != null ? " (" + fmt(v.vtspnKg, 1) + " mL/kg PBW)" : "") : "") +
          (v.spontShare != null ? "; " + fmt(v.spontShare, 0) + "% of the minute volume is spontaneous" : "") + ".", "");
      if (v.psOverPinsp) add("simv", "Pressure support " + fmt(v.ps, 0) + " is at or above Pinsp " + fmt(sp.pinsp, 0) + ": the spontaneous breaths get as much support as the mandatory ones" + (v.vtspn != null && v.vt != null ? " (spontaneous VT " + fmt(v.vtspn, 0) + " vs " + fmt(v.vt, 0) + " mL)" : "") + ".", "warn");
      if (v.vtspnKg != null && v.vtspnKg > 8) add("vt", "Spontaneous VT " + fmt(v.vtspnKg, 1) + " mL/kg PBW is above 8: the pressure support is generous, or the drive is high.", "warn");
      if (ftot != null && ftot > 30) add("trig", "Total RR " + fmt(ftot, 0) + "/min is high: look for pain, agitation, fever, hypoxemia, acidosis or dyssynchrony.", "warn");
    } else if (v.trig != null && v.vmode !== "psv") {
      if (v.trig >= 2) add("trig", "Patient triggering " + fmt(v.trig, 0) + "/min above the set rate (Ftotal " + fmt(ftot, 0) + " vs BUR " + fmt(v.bur, 0) + ")" +
        (metAcid && ab && ab.ph < 7.30 ? ": breathing hard to compensate for the metabolic acidosis." : ftot > 30 ? ": high respiratory drive (pain, agitation, fever, hypoxemia, acidosis, dyssynchrony)." : "."), metAcid || ftot > 30 ? "warn" : "");
      else if (Math.abs(v.trig) < 1) add("trig", "Ftotal = BUR: no patient-triggered breaths (sedated or paralyzed, low drive, or over-ventilated).", "");
    } else if (ftot != null && ftot > 30) add("trig", "Total RR " + fmt(ftot, 0) + "/min is high: look for pain, agitation, fever, hypoxemia, acidosis or dyssynchrony.", "warn");
    if (v.ve != null && v.vePred) {
      var vx = v.ve / v.vePred;
      if (vx >= 1.5) add("ve", "Minute ventilation " + fmt(v.ve, 1) + " L/min is " + fmt(vx, 1) + "× predicted: high CO₂ load or dead space (fever, sepsis, metabolic acidosis, ARDS).", "warn");
    }
    if (v.vr != null && v.vr >= 2) add("vr", "Ventilatory ratio " + fmt(v.vr, 1) + " (normal ≈ 1): high dead space or CO₂ production.", "warn");
    if (v.oi != null) add("oi", "Oxygenation index " + fmt(v.oi, 1) + ": " + v.oiG.label + ". Follow the trend.", "", false);
    if (v.mp != null && v.mp > 17) add("mp", "Mechanical power " + fmt(v.mp, 0) + " J/min is above 17 (linked to higher mortality).", "warn");
    if (v.p01 != null) add("p01", "P0.1 " + fmt(v.p01, 1) + " cmH₂O: " + (v.p01 > 3.5 ? "high respiratory drive and likely high effort (> 3.5)." : v.p01 < 1 ? "low drive (< 1): likely over-assisted or oversedated; risk of diaphragm disuse." : "drive in the usual range (1–3.5)."), v.p01 > 3.5 || v.p01 < 1 ? "warn" : "ok");
    if (v.pmus != null) add("pmus", "Occlusion ΔPocc −" + fmt(Math.abs(v.pocc), 0) + " → Pmus ≈ " + fmt(v.pmus, 0) + " cmH₂O" + (v.pmus > 15 ? ": excessive inspiratory effort (> 15)" : v.pmus > 10 ? ": high inspiratory effort (> 10)" : v.pmus < 3 ? ": very low effort (possible over-assistance)" : ": effort in an acceptable range") +
      (v.dpl != null ? "; dynamic transpulmonary driving pressure ≈ " + fmt(v.dpl, 0) + (v.dpl > 20 ? " (> 20: excessive lung stress)" : v.dpl > 15 ? " (> 15: high lung stress)" : "") : "") + ".", v.pmus > 10 || (v.dpl != null && v.dpl > 15) || v.pmus < 3 ? "warn" : "ok");
    if (v.sf != null && v.pf == null) add("sf", "SpO₂/FiO₂ " + Math.round(v.sf) + (v.spo2 > 97 ? " (SpO₂ > 97%: the ratio is not valid for ARDS grading. If a P/F assessment is needed, get an ABG; do not change oxygen just to make the ratio usable)." : v.sfRange ? ": meets the ARDS oxygenation criterion (S/F ≤ 315 with SpO₂ ≤ 97%)" + (v.sfSev ? ", " + v.sfSev + " range." : "; no severity grade without PEEP ≥ 5.") : " (above 315)."), v.sfRange ? "warn" : "", v.spo2 <= 97);
    if (v.osi != null) add("osi", "Oxygen saturation index " + fmt(v.osi, 1) + ": no validated adult severity bands (PALICC-2 bands are pediatric); follow the trend.", "", false);
    var si = sp.scalars && sp.scalars.si;
    if (si && si.value != null) add("si", "Stress index ≈ " + fmt(si.value, 2) + " on " + si.n + " passive volume-control breaths (photo estimate): " + (si.verdict === "over" ? "upward concavity (> 1.1), suggests tidal overdistension." : si.verdict === "recruit" ? "downward concavity (< 0.9), suggests tidal recruitment (PEEP may be low)." : "straight rise (0.9–1.1), no sign of overdistension or tidal recruitment.") + (si.flowOk === false ? " Flow was not square, so the index is not valid here." : ""), si.verdict !== "ok" && si.flowOk !== false ? "warn" : "ok", si.flowOk !== false);
    if (v.rsbiM != null && (!v.rsbiOK || v.rsbi == null)) add("rsbi", "RSBI " + Math.round(v.rsbiM) + " (ventilator)" + (v.rsbiOK ? (v.rsbiM < 105 ? ": < 105; one data point, not a gate for a breathing trial (AARC 2024)." : ": ≥ 105, rapid shallow breathing; one data point, not a gate for a breathing trial (AARC 2024).")
      : ": not a weaning index here" + (v.ps != null && v.ps > 8 ? " (pressure support " + fmt(v.ps, 0) + " makes breaths bigger)" : "") + (v.simv ? "; in SIMV it is counted on the spontaneous breaths only" : "") + ". Measure it on PS 5–8 or CPAP."), v.rsbiOK ? (v.rsbiM < 105 ? "ok" : "warn") : "", v.rsbiOK);
    if (v.rsbi != null && !v.rsbiOK) add("rsbi", "RSBI " + Math.round(v.rsbi) + " on pressure support " + fmt(v.ps, 0) + ": support above 8 makes breaths bigger, so this overstates readiness; measure it on PS 5–8 or CPAP.", "", true);
    else if (v.rsbi != null) add("rsbi", "RSBI " + Math.round(v.rsbi) + (v.rsbi < 105 ? " (< 105)" : " (≥ 105): rapid shallow breathing") + ". One data point, not a gate for a breathing trial (AARC 2024).", v.rsbi < 105 ? "ok" : "warn");
    if (v.peepLow && !v.ardsRange && !v.ardsRangeSF) add("peep", "PEEP " + (sp.peep === 0 ? "0 (OFF)" : fmt(sp.peep, 0)) + ": low PEEP (0–5) is acceptable without ARDS if oxygenation holds" + (v.cstat != null && v.cstat < 40 ? "; with low compliance (Cstat " + fmt(v.cstat, 0) + ") or a rising FiO₂, try PEEP 5 and recheck" : "") + ".", "", true);
    if (v.cstatM != null && v.cstat != null && v.cstatSrc !== "ventilator" && Math.abs(v.cstatM - v.cstat) / v.cstatM > 0.25) add("check", "Calculated Cstat " + fmt(v.cstat, 0) + " differs from the ventilator's " + fmt(v.cstatM, 0) + " mL/cmH₂O: the plateau may not come from a true hold.", "", false);
    if (v.tauSrc === "RCexp" && v.te != null) {}   // shown in the "te" line
    if (v.peepTab && !v.peepTab.below && num_(sp.peep) != null)
      add("peeptab", "PEEP " + fmt(sp.peep, 0) + " at FiO₂ " + v.peepTab.fio2 + "%: ARDSNet lower-PEEP table " + rangeTxt(v.peepTab.lo) + ", higher-PEEP table " + rangeTxt(v.peepTab.hi) + ".", "", false);
    return L;
  }


  /* ---------- Ventilator scalars (waveforms): guided reading ----------
     Sources: Tobin MJ (ed). Principles and Practice of Mechanical Ventilation, 3rd ed. 2013 —
     ch. 53 Tobin, Jubran, Laghi (ineffective and double triggering, flow scalloping, sawtooth flow, condensate, leaks);
     ch. 8 Brochard, Lellouche (autotriggering, early/delayed cycling, rise time, cycle-off criterion);
     ch. 6 Mancebo (scooping in assist-control); ch. 30 Leatherman (expiratory flow limitation, plateau/pH rules).
     Reverse triggering: Akoumianaki E, et al. Chest 2013;143:927–38. */
  var ALLM = ["acvc", "acpc", "prvc", "simv", "psimv", "prvcsimv", "psv"], PRESSM = ["acpc", "prvc", "psimv", "prvcsimv", "psv"], CTRL = ["acvc", "acpc", "prvc", "simv", "psimv", "prvcsimv"];
  var SCALARS = [
    { id: "f_trap", g: "Flow", modes: ALLM, tone: "warn", title: "Expiratory flow doesn't reach zero",
      look: "Expiratory (negative) flow is still below the zero line when the next breath starts.",
      means: "Air trapping with auto-PEEP (dynamic hyperinflation).",
      action: "measure total PEEP with an expiratory hold; lengthen expiration (lower rate or VT, shorter inspiratory time), treat bronchospasm; on PS lower the support or raise the cycle-off %.",
      src: "Tobin ch. 53; Leatherman ch. 30" },
    { id: "f_ineff", g: "Flow", modes: ALLM, tone: "warn", title: "Ineffective efforts (missed triggers)",
      look: "During expiration, a small bump in flow toward zero (with a slight dip in pressure) but no breath follows.",
      means: "Efforts too weak to overcome the recoil of trapped gas; usually too much assistance (high PS or VT) with hyperinflation, especially in COPD.",
      action: "lower PS until VT ≈ 6 mL/kg PBW or shorten inspiration, raise the cycle-off % on PS (COPD often ≥ 50%), check trigger sensitivity, consider external PEEP if auto-PEEP is present, avoid oversedation.",
      src: "Brochard & Lellouche ch. 8; Tobin ch. 53" },
    { id: "f_double", g: "Flow", modes: ALLM, tone: "warn", title: "Double triggering",
      look: "Two breaths back to back with little or no exhalation between them; volume stacks above one breath.",
      means: "The patient's own inspiration outlasts the machine's (low VT, short inspiratory time); the stacked breath gives far more than the set VT.",
      action: "in volume control lengthen inspiration (lower flow or add a short pause) or allow VT 7–8 mL/kg PBW if plateau stays < 30; on PS lower the cycle-off % and avoid a very fast rise; treat high drive (pain, acidosis, anxiety).",
      src: "Tobin ch. 53; ARDSNet" },
    { id: "f_saw", g: "Flow", modes: ALLM, tone: "warn", title: "Sawtooth flow",
      look: "Fine regular oscillations on the flow (and pressure) tracing, mostly in expiration.",
      means: "Secretions in the airway or tube, or water in the circuit.",
      action: "suction the airway and drain condensate from the circuit.",
      src: "Jubran & Tobin (Tobin ch. 53)" },
    { id: "f_obstr", g: "Flow", modes: ALLM, tone: "warn", title: "Obstructive expiratory flow",
      look: "Low peak expiratory flow followed by a long, scooped (concave) tail.",
      means: "Expiratory flow limitation (bronchospasm, COPD, asthma, secretions); sets up air trapping.",
      action: "bronchodilator, check for secretions or a kinked tube, allow a long expiratory time, follow plateau and auto-PEEP.",
      src: "Leatherman ch. 30" },
    { id: "f_early", g: "Flow", modes: ALLM, tone: "warn", title: "Early (premature) cycling",
      look: "Inspiratory flow stops abruptly, then pressure dips below PEEP or flow turns inspiratory again, often with a second breath.",
      means: "The ventilator ends inspiration before the patient does: cycle-off % too high or set inspiratory time too short.",
      action: "lower the cycle-off % on PS (stiff, restrictive lungs often need a low threshold), lengthen inspiratory time in pressure control, or in volume control lengthen inspiration (lower flow or add a short pause).",
      src: "Brochard & Lellouche ch. 8" },
    { id: "f_late", g: "Pressure", modes: ["psv", "simv", "psimv", "prvcsimv"], tone: "warn", title: "Delayed cycling",
      look: "A pressure spike at the end of inspiration with a long, slowly falling inspiratory flow tail.",
      means: "Inflation continues into the patient's expiration (the patient pushes to exhale); common in COPD with a low cycle-off %.",
      action: "raise the cycle-off % (COPD often ≥ 50% of peak flow) or lower PS.",
      src: "Brochard & Lellouche ch. 8; Tobin ch. 53" },
    { id: "p_scoop", g: "Pressure", modes: ["acvc", "simv"], tone: "warn", title: "Scooped pressure (flow starvation)",
      look: "The inspiratory pressure curve is concave (scalloped) instead of a smooth rise, often after a deep dip before the breath.",
      means: "Set inspiratory flow is below the patient's demand; the patient works hard through the breath.",
      action: "raise the peak flow (e.g. 60 → 80–90 L/min) or use a pressure-targeted mode; treat the cause of high drive (pain, fever, acidosis, anxiety).",
      src: "Tobin ch. 53; Mancebo ch. 6" },
    { id: "p_dip", g: "Pressure", modes: ALLM, tone: "warn", title: "Big dip before each breath (trigger delay)",
      look: "A deep or long negative pressure deflection before the ventilator responds.",
      means: "Hard work to trigger: insensitive trigger, auto-PEEP that must be overcome first, or very high drive.",
      action: "check the trigger setting (flow triggering is more sensitive), measure auto-PEEP and consider external PEEP if present, address the drive.",
      src: "Brochard & Lellouche ch. 8; Tobin ch. 53" },
    { id: "p_auto", g: "Pressure", modes: ALLM, tone: "warn", title: "Auto-triggering",
      look: "Breaths start with no dip in airway pressure (no patient effort), often fast and regular, above the set rate.",
      means: "False triggers from a leak, water in the circuit, cardiac oscillations, or a trigger set too sensitive.",
      action: "look for leaks and condensate; make the trigger less sensitive and see whether the rate falls.",
      src: "Brochard & Lellouche ch. 8; Tobin ch. 53" },
    { id: "p_over", g: "Pressure", modes: PRESSM, tone: "", title: "Pressure overshoot at the start",
      look: "A spike above the set pressure at the start of inspiration.",
      means: "Rise time (pressurization) too fast; can end the breath early or cause double cycles.",
      action: "slow the rise time.",
      src: "Brochard & Lellouche ch. 8" },
    { id: "p_slow", g: "Pressure", modes: PRESSM, tone: "", title: "Slow pressure rise",
      look: "Pressure climbs slowly and reaches the set level late; the flow peak is low and rounded.",
      means: "Rise time too slow for the patient's demand; adds work of breathing.",
      action: "shorten the rise time (faster pressurization).",
      src: "Brochard & Lellouche ch. 8" },
    { id: "p_rev", g: "Pressure", modes: CTRL, tone: "warn", title: "Reverse triggering",
      look: "A machine-timed breath (no dip before it) followed by a patient effort during or just after it: a dip mid-breath or a second, stacked breath.",
      means: "The machine breath entrains the patient's respiratory muscles, usually under deep sedation; can stack volumes.",
      action: "reassess sedation, adjust the rate or inspiratory time, and watch for stacked volumes.",
      src: "Akoumianaki, Chest 2013" },
    { id: "v_leak", g: "Volume", modes: ALLM, tone: "warn", title: "Volume doesn't return to baseline",
      look: "The expiratory volume curve ends above zero and resets at the next breath.",
      means: "Leak: cuff, circuit, or bronchopleural fistula (chest-tube air leak).",
      action: "check cuff pressure and tube position, circuit connections and the chest drain.",
      src: "Tobin ch. 53" }
  ];
  var SC = {}; SCALARS.forEach(function (f) { SC[f.id] = f; });
  function scalarsFor(vm) { vm = VMODES[vm] ? vm : "acvc"; return SCALARS.filter(function (f) { return f.modes.indexOf(vm) > -1; }); }
  function scalarIds(sp) {
    var vm = sp && VMODES[sp.vmode] ? sp.vmode : "acvc";
    var ids = sp && sp.scalars && sp.scalars.ids ? sp.scalars.ids : [];
    return ids.filter(function (id) { return SC[id] && SC[id].modes.indexOf(vm) > -1; });
  }
  function scalarBlock(sp) {
    var ids = scalarIds(sp);
    var au = sp && sp.scalars && sp.scalars.auto ? sp.scalars.auto : {}, hdr = "Scalars:";
    if (sp && sp.scalars && sp.scalars.autoInfo) hdr = "Scalars (" + sp.scalars.autoInfo + "; confirm at the bedside):";
    var si = sp && sp.scalars && sp.scalars.si, siL = si && si.value != null && si.flowOk !== false
      ? "• Stress index ≈ " + fmt(si.value, 2) + " (" + si.n + " passive breaths): " + (si.verdict === "over" ? "upward concavity, tidal overdistension" : si.verdict === "recruit" ? "downward concavity, tidal recruitment" : "linear, no overdistension or tidal recruitment") : null;
    if (ids.length) return [hdr].concat(ids.map(function (id) {
      var a = au[id];
      return "• " + SC[id].title + (a ? " (" + a.how + (a.n != null ? " " + a.n + "/" + a.of + " breaths" : a.conf ? ", " + a.conf + " confidence" : "") + ")" : "") + ": " + lc(SC[id].means);
    })).concat(siL ? [siL] : []);
    if (siL && sp.scalars.autoInfo && !sp.scalars.normal) return [hdr, "• No asynchrony pattern detected on the photo", siL];
    if (sp && sp.scalars && sp.scalars.autoInfo && !sp.scalars.normal) return [hdr, "• No asynchrony pattern detected on the photo"];
    if (sp && sp.scalars && sp.scalars.normal) return ["Scalars: no asynchrony, air trapping or leak seen"];
    return null;
  }


  /* ---------- Auto-read of scalar tracings ----------
     Input: one value per screen column (inspiration / higher pressure = positive), any units.
     Breath-by-breath rules follow the patterns in SCALARS (Tobin ch. 53; Brochard & Lellouche ch. 8). */
  function movAvg(a, w) {
    var n = a.length, h = Math.floor(w / 2), out = new Array(n);
    for (var i = 0; i < n; i++) { var s = 0, c = 0; for (var j = Math.max(0, i - h); j <= Math.min(n - 1, i + h); j++) { s += a[j]; c++; } out[i] = s / c; }
    return out;
  }
  function median_(a) { var b = a.filter(function (x) { return x != null && isFinite(x); }).sort(function (x, y) { return x - y; }), n = b.length; return n ? (n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2) : null; }
  function confOf(n, of) { if (!n) return null; var fr = of ? n / of : 1; return n >= 2 && fr >= 0.5 ? "high" : n >= 2 || fr >= 0.34 ? "moderate" : "low"; }
  function amax(a, i0, i1) { var m = -Infinity, k = i0; for (var i = i0; i <= i1; i++) if (a[i] > m) { m = a[i]; k = i; } return { v: m, i: k }; }
  function amin(a, i0, i1) { var m = Infinity, k = i0; for (var i = i0; i <= i1; i++) if (a[i] < m) { m = a[i]; k = i; } return { v: m, i: k }; }
  function rateOf(onsets, secsPerCol) {
    if (!secsPerCol || onsets.length < 2) return null;
    var span = (onsets[onsets.length - 1] - onsets[0]) * secsPerCol; return span > 0 ? (onsets.length - 1) * 60 / span : null;
  }

  // o: { secsPerCol, noise (screen units of jitter, default 1.2) }
  function analyzeFlow(raw, o) {
    o = o || {};
    var n = raw.length, R = { kind: "flow", findings: {}, events: [], notes: [] };
    if (n < 40) { R.error = "The box is too narrow: include at least three breaths."; return R; }
    var f = movAvg(raw, 3), fs = movAvg(raw, 5), noise = o.noise != null ? o.noise : 1.2;
    var Ai = amax(f, 0, n - 1).v, Ae = -amin(f, 0, n - 1).v;
    if (!(Ai > 0) || !(Ae > 0)) { R.error = "No inspiratory and expiratory flow on either side of the zero line: re-tap the zero line."; return R; }
    // inspirations: rise above 20% of peak flow; foot = start of the rise; end = flow back to zero
    var thOn = 0.2 * Ai, ins = [], inI = f[0] > thOn, st = 0, partial0 = inI;
    for (var i = 1; i < n; i++) {
      if (!inI && f[i] > thOn && f[i - 1] <= thOn) {
        // foot of the breath: walk back along the steep inspiratory rise only (not the slower passive return of expiration)
        var sc = Math.max(f[i] - f[i - 1], i + 1 < n ? f[i + 1] - f[i] : 0), lim = Math.max(0.04 * Ai, 0.35 * sc), j = i;
        while (j > 0 && f[j] - f[j - 1] > lim) j--;
        inI = true; st = j;
      }
      else if (inI && f[i] <= 0) { ins.push({ s: st, e: i, partial: partial0 }); partial0 = false; inI = false; }
    }
    if (inI) ins.push({ s: st, e: n - 1, open: true });
    ins.forEach(function (b) { b.peak = amax(f, b.s, b.e).v; });
    function pct75(a) { var b2 = a.slice().sort(function (x, y) { return x - y; }); return b2.length ? b2[Math.min(b2.length - 1, Math.floor(0.75 * b2.length))] : null; }
    var refPk = pct75(ins.map(function (b) { return b.peak; })), refTi = pct75(ins.map(function (b) { return b.e - b.s; })), smallIns = [];
    if (ins.length >= 3) ins = ins.filter(function (b) { var small = b.peak < 0.45 * refPk && (b.e - b.s) < 0.6 * refTi; if (small) smallIns.push(b); return !small; });
    ins.forEach(function (b) {
      var pk = amax(f, b.s, b.e); b.peak = pk.v; b.pk = pk.i;
      var a = 0; for (var k = b.s; k <= b.e; k++) if (f[k] > 0) a += f[k]; b.area = a;
      var q = Math.round(b.s + 0.75 * (b.e - b.s)); b.flat = b.peak > 0 ? f[q] / b.peak : null;
    });
    var full = ins.filter(function (b) { return !b.partial && !b.open; });
    R.breaths = ins.filter(function (b) { return !b.partial; }).length;
    R.onsets = ins.filter(function (b) { return !b.partial; }).map(function (b) { return b.s; });
    if (ins.length < 2) { R.error = "Fewer than two breaths found: widen the box to include at least three breaths, or re-tap the line."; return R; }
    var flats = full.map(function (b) { return b.flat; }), fm = median_(flats);
    R.shape = fm == null ? null : fm > 0.85 ? "square" : fm < 0.7 ? "decelerating" : "mixed";
    // expirations
    var ex = [];
    for (var k2 = 0; k2 < ins.length; k2++) {
      var a0 = ins[k2].e, a1 = k2 + 1 < ins.length ? ins[k2 + 1].s : n - 1;
      if (a1 - a0 < 3) continue;
      var mn = amin(f, a0, a1); var area = 0; for (var q2 = a0; q2 <= a1; q2++) if (f[q2] < 0) area -= f[q2];
      ex.push({ s: a0, e: a1, complete: k2 + 1 < ins.length, min: mn.v, mi: mn.i, dur: a1 - a0, area: area, prevIns: ins[k2] });
    }
    if (ins[0].s > 6) { var mn0 = amin(f, 0, ins[0].s); ex.unshift({ s: 0, e: ins[0].s, complete: false, lead: true, min: mn0.v, mi: mn0.i, dur: ins[0].s, area: 0 }); }
    var comp = ex.filter(function (x) { return x.complete; });
    var durs = comp.map(function (x) { return x.dur; }).sort(function (a, b) { return a - b; });
    var medDur = durs.length ? durs[Math.min(durs.length - 1, Math.floor(0.75 * durs.length))] : null;
    var cnt = { f_trap: 0, f_ineff: 0, f_double: 0, f_saw: 0, f_obstr: 0, f_early: 0 }, offZero = 0, ineffBreaths = 0;
    smallIns.forEach(function (b) {   // a small inspiratory blip inside expiration: an effort that did not become a breath
      var host = null; ex.forEach(function (x) { if (b.s >= x.s && b.e <= x.e) host = x; });
      var early = host && !host.lead && (b.s - host.s) < 0.2 * host.dur;
      if (early) { cnt.f_early++; R.events.push({ x: b.pk || b.s, type: "f_early" }); } else { cnt.f_ineff++; ineffBreaths++; R.events.push({ x: b.s, type: "f_ineff" }); }
    });
    if (comp.length >= 2 && medDur) comp.forEach(function (x) { if (x.dur < 0.4 * medDur && x.prevIns && x.area < 0.5 * x.prevIns.area) x.dbl = true; });
    ex.forEach(function (x) {
      var depth = Math.abs(Math.min(x.min, -1e-9));
      if (depth < 0.15 * Ae && x.complete) return;
      // trapping: flow still clearly below zero and still returning when the next breath starts
      if (x.complete && !x.dbl) {
        var endV = f[x.e], m = Math.max(3, Math.round(0.12 * x.dur)), rise = (f[x.e] - f[Math.max(x.s, x.e - m)]) / depth;
        if ((endV < -0.1 * depth && rise > 0.03) || endV < -0.25 * depth) { cnt.f_trap++; R.events.push({ x: x.e, type: "f_trap" }); }
        else if (Math.abs(endV) > 0.1 * depth && Math.abs(rise) < 0.02) offZero++;
      }
      // bumps in expiration: flow moves toward zero then away again, without a breath
      var from = x.lead ? x.s + 2 : x.mi + Math.max(2, Math.round(0.06 * x.dur)), to = x.e - 2, hadIneff = false;
      for (var i3 = from + 1; i3 < to; i3++) {
        if (!(fs[i3] >= fs[i3 - 1] && fs[i3] > fs[i3 + 1])) continue;
        if (smallIns.some(function (b) { return i3 >= b.s - 3 && i3 <= b.e + 3; })) continue;
        var W = Math.max(4, Math.round(0.3 * x.dur)), dropMin = amin(fs, i3, Math.min(x.e, i3 + W)).v;
        var v0 = i3; while (v0 > x.s && fs[v0 - 1] <= fs[v0]) v0--;
        var riseL = fs[i3] - fs[v0], drop = fs[i3] - dropMin, need = Math.max(0.08 * depth, 3 * noise);
        if (riseL >= need && drop >= need && fs[i3] < thOn) {
          var early = !x.lead && (i3 - x.s) < 0.2 * x.dur && fs[v0] < -0.4 * depth;
          if (early) { cnt.f_early++; R.events.push({ x: i3, type: "f_early" }); }
          else { cnt.f_ineff++; hadIneff = true; R.events.push({ x: i3, type: "f_ineff" }); }
          i3 += 3;
        }
      }
      if (hadIneff) ineffBreaths++;
      // sawtooth: fine oscillation on the expiratory limb
      var seg = []; for (var i4 = x.mi; i4 <= x.e; i4++) seg.push(f[i4]);
      if (seg.length >= 20) {
        var sm = movAvg(seg, 9), amp = Math.max(0.035 * depth, 1.4 * noise), osc = 0, last = 0;
        for (var i5 = 0; i5 < seg.length; i5++) { var r = seg[i5] - sm[i5]; if (r > amp && last !== 1) { osc++; last = 1; } else if (r < -amp && last !== -1) { osc++; last = -1; } }
        if (osc >= 8 && osc / seg.length >= 0.08) { cnt.f_saw++; R.events.push({ x: Math.round((x.mi + x.e) / 2), type: "f_saw" }); }
      }
      // obstructive tail: most of expiration spent at 10–45% of peak expiratory flow
      if (x.complete && x.e - x.mi > 10) {
        var tail = 0, tot = 0; for (var i6 = x.mi; i6 <= x.e; i6++) { var rr = -f[i6] / depth; tot++; if (rr > 0.1 && rr < 0.45) tail++; }
        if (tail / tot > 0.6) { cnt.f_obstr++; }
      }
    });
    // double triggering: an expiration far shorter than usual, with most of the breath not exhaled
    comp.forEach(function (x) { if (x.dbl) { cnt.f_double++; R.events.push({ x: x.e, type: "f_double" }); } });
    var ofComp = comp.length || 1, ofAll = ex.length || 1, ofTrap = comp.filter(function (x) { return !x.dbl; }).length || 1;
    R.findings.f_trap = cnt.f_trap ? { n: cnt.f_trap, of: ofTrap } : null;
    R.findings.f_ineff = cnt.f_ineff ? { n: cnt.f_ineff, of: ofAll, breaths: ineffBreaths } : null;
    R.findings.f_early = cnt.f_early ? { n: cnt.f_early, of: ofAll } : null;
    R.findings.f_double = cnt.f_double ? { n: cnt.f_double, of: ofComp } : null;
    R.findings.f_saw = cnt.f_saw && cnt.f_saw / ofAll >= 0.34 ? { n: cnt.f_saw, of: ofAll } : null;
    R.findings.f_obstr = cnt.f_obstr && cnt.f_obstr / ofComp >= 0.5 ? { n: cnt.f_obstr, of: ofComp } : null;
    if (offZero >= Math.max(2, 0.5 * ofComp)) R.notes.push("Expiratory flow flattens slightly away from the zero line in most breaths: the zero line may be tapped a little off. Re-tap it if trapping looks doubtful.");
    R.rate = rateOf(R.onsets, o.secsPerCol);
    Object.keys(R.findings).forEach(function (k) { if (!R.findings[k]) delete R.findings[k]; else R.findings[k].conf = confOf(R.findings[k].n, R.findings[k].of); });
    return R;
  }

  // o: { vmode, baseline (optional, same units), secsPerCol, bur, noise }
  function analyzePaw(raw, o) {
    o = o || {};
    var n = raw.length, R = { kind: "paw", findings: {}, events: [], notes: [] }, vm = VMODES[o.vmode] ? o.vmode : "acvc";
    if (n < 40) { R.error = "The box is too narrow: include at least three breaths."; return R; }
    var p = movAvg(raw, 3), p5 = movAvg(raw, 5), noise = o.noise != null ? o.noise : 1.2;
    var srt = p.slice().sort(function (a, b) { return a - b; });
    var b = o.baseline != null && isFinite(o.baseline) ? o.baseline : median_(srt.slice(Math.floor(n * 0.05), Math.max(6, Math.floor(n * 0.45))));
    var top = srt[n - 1], Ap = top - b;
    R.baseline = b;
    if (!(Ap > 4 * noise)) { R.error = "No clear pressure rise above the baseline: re-tap the line or the PEEP level."; return R; }
    var thr = b + 0.35 * Ap, br = [], up = p[0] > thr;
    for (var i = 1; i < n; i++) {
      if (!up && p[i] > thr && p[i - 1] <= thr) { var j = i; while (j > 0 && p[j - 1] < p[j] - 0.004 * Ap) j--; br.push({ on: i, foot: j }); up = true; }
      else if (up && p[i] < b + 0.2 * Ap && p[i - 1] >= b + 0.2 * Ap) { if (br.length && br[br.length - 1].end == null) br[br.length - 1].end = i; up = false; }
    }
    br = br.filter(function (x) { return x.end != null; });
    R.breaths = br.length; R.onsets = br.map(function (x) { return x.foot; }); R.spans = br.map(function (x) { return [x.foot, x.end]; });
    // width at half height ≈ inspiratory time (the slow fall after the breath is not counted)
    R.w50 = br.map(function (x) { var pk = amax(p, x.foot, x.end), h = b + 0.5 * (pk.v - b), a0 = x.foot, a1 = x.end; while (a0 < pk.i && p[a0] < h) a0++; while (a1 > pk.i && p[a1] < h) a1--; return a1 - a0; });
    if (br.length < 2) { R.error = "Fewer than two breaths found: widen the box or re-tap the line."; return R; }
    var cyc = []; for (var k = 1; k < br.length; k++) cyc.push(br[k].foot - br[k - 1].foot);
    var cs = cyc.slice().sort(function (a, b) { return a - b; });
    var medCyc = cs.length ? cs[Math.min(cs.length - 1, Math.floor(0.75 * cs.length))] : n / br.length;
    var c = { trig: 0, nodip: 0, p_dip: 0, p_scoop: 0, p_over: 0, f_late: 0, p_slow: 0, f_double: 0, middip: 0, p_rev: 0 }, sis = [];
    br.forEach(function (x, k) {
      var w = Math.max(4, Math.round(0.15 * medCyc)), lo = amin(p, Math.max(0, x.foot - w), Math.min(n - 1, x.foot + 2));
      x.dip = b - lo.v;
      var trig = x.dip > Math.max(0.04 * Ap, 2 * noise);
      if (x.foot - w < 0 && !trig) x.trig = null;            // breath at the left edge: no lead-in to judge the trigger
      else { x.trig = trig; if (trig) c.trig++; else c.nodip++; }
      if (x.dip > Math.max(0.15 * Ap, 3 * noise)) { c.p_dip++; R.events.push({ x: lo.i, type: "p_dip" }); }
      var pk = amax(p, x.foot, x.end), len = x.end - x.foot;
      if (len < 6) return;
      if (isVC(vm)) {
        // scooped rise: curve sags below the straight line from foot to peak.
        // In a patient-triggered breath this is flow starvation; in a passive (machine-timed) breath it is the
        // stress-index shape (upward concavity = tidal overdistension), so passive breaths go to the stress index.
        var s0 = x.foot, s1 = pk.i, dsum = 0, dn = 0;
        if (s1 - s0 >= 6) {
          for (var q = Math.round(s0 + 0.2 * (s1 - s0)); q <= Math.round(s0 + 0.8 * (s1 - s0)); q++) { var line = p[s0] + (p[s1] - p[s0]) * (q - s0) / (s1 - s0); dsum += (line - p[q]) / Ap; dn++; }
          var passive = x.trig === false && x.dip < Math.max(0.02 * Ap, noise);
          if (passive) { var si = stressIndex(p, s0, s1); if (si != null) { x.si = si; sis.push(si); } }
          else if (dn && dsum / dn > 0.07) { c.p_scoop++; R.events.push({ x: Math.round((s0 + s1) / 2), type: "p_scoop" }); }
          // dip during the machine breath (patient effort mid-breath)
          var Wd = Math.max(4, Math.round(0.3 * (s1 - s0)));
          for (var q2 = s0 + 2; q2 < s1 - 1; q2++) {
            if (p[q2] >= p[q2 - 1] && p[q2] > p[q2 + 1]) { var after = amin(p, q2, Math.min(s1, q2 + Wd)).v; if (p[q2] - after > Math.max(0.04 * Ap, 2.5 * noise)) { c.middip++; x.middip = true; R.events.push({ x: q2, type: "middip" }); break; } }
          }
        }
      } else {
        var m0 = Math.round(x.foot + 0.35 * len), m1 = Math.round(x.foot + 0.75 * len), pl = [];
        for (var q3 = m0; q3 <= m1; q3++) pl.push(p[q3]);
        var plat = median_(pl), amp = plat - b;
        if (amp > 0) {
          var early = amax(p, x.foot, Math.round(x.foot + 0.3 * len)).v, late = amax(p, Math.round(x.foot + 0.75 * len), x.end).v;
          if (early - plat > Math.max(0.08 * amp, 2.5 * noise)) { c.p_over++; R.events.push({ x: x.foot + 2, type: "p_over" }); }
          var t90 = x.foot; while (t90 < x.end && p[t90] < b + 0.9 * amp) t90++;
          var slow = (t90 - x.foot) / len > 0.4;
          if (slow) { c.p_slow++; R.events.push({ x: t90, type: "p_slow" }); }
          var lateIdx = amax(p, Math.round(x.foot + 0.75 * len), x.end).i;
          if (!slow && late - plat > Math.max(0.08 * amp, 2.5 * noise) && late - p[x.end] > 0.5 * (late - plat)) { c.f_late++; R.events.push({ x: lateIdx, type: "f_late" }); }
        }
      }
      if (k > 0 && medCyc && (x.foot - br[k - 1].foot) < 0.45 * medCyc) { c.f_double++; x.stacked = true; R.events.push({ x: x.foot, type: "f_double" }); }
    });
    // reverse triggering: machine-timed breath (no dip) with effort during it, or followed by a stacked breath
    if (CTRL.indexOf(vm) > -1) br.forEach(function (x, k) {
      var flat = x.dip < Math.max(0.02 * Ap, noise);   // clearly no effort before the breath
      if (x.trig === false && flat && (x.middip || (br[k + 1] && br[k + 1].stacked))) { c.p_rev++; R.events.push({ x: x.foot, type: "p_rev" }); }
    });
    R.rate = rateOf(R.onsets, o.secsPerCol);
    var N = br.length;
    // auto-triggering: on PS every breath should start with a patient effort; on assist-control, untriggered breaths faster than the set rate
    var known = c.trig + c.nodip, untrigShare = known ? c.nodip / known : 0;
    if (vm === "psv" && known >= 2 && untrigShare >= 0.5) { R.findings.p_auto = { n: c.nodip, of: known }; }
    else if (vm !== "psv" && R.rate != null && o.bur && R.rate > o.bur + 2 && untrigShare >= 0.5) R.findings.p_auto = { n: c.nodip, of: known };
    else if (vm !== "psv" && untrigShare >= 0.8) R.notes.push("No trigger dip before most breaths: machine-timed breaths (or auto-triggering if the rate is above the set rate).");
    R.triggered = c.trig; R.untriggered = c.nodip;
    if (sis.length >= 2) { var smd = median_(sis); R.si = { value: smd, n: sis.length, of: N, verdict: smd > 1.1 ? "over" : smd < 0.9 ? "recruit" : "ok" }; }
    [["p_dip", 1], ["p_scoop", 1], ["p_over", 1], ["f_late", 1], ["p_slow", 1], ["f_double", 1], ["p_rev", 1]].forEach(function (z) { if (c[z[0]]) R.findings[z[0]] = { n: c[z[0]], of: N }; });
    if (c.middip && !c.p_rev) R.notes.push("A dip during the breath in " + c.middip + " of " + N + " breaths: the patient is pulling during the machine breath (flow starvation or effort out of phase).");
    Object.keys(R.findings).forEach(function (k) { R.findings[k].conf = confOf(R.findings[k].n, R.findings[k].of); });
    return R;
  }
  // Volume tracing (Tobin ch. 53): a flat expiratory plateau above zero that is reset at the next breath = leak;
  // volume still falling when the next breath starts = air trapping; a breath far larger than the rest = stacking.
  function analyzeVolume(raw, o) {
    o = o || {};
    var n = raw.length, R = { kind: "vol", findings: {}, events: [], notes: [] };
    if (n < 40) { R.error = "The box is too narrow: include at least three breaths."; return R; }
    var v = movAvg(raw, 3), noise = o.noise != null ? o.noise : 1.2, srt = v.slice().sort(function (a, b) { return a - b; });
    var base = srt[Math.floor(0.03 * n)], p90 = srt[Math.floor(0.9 * n)], A = p90 - base;
    if (!(A > 6 * noise)) { R.error = "No clear breaths on the volume tracing."; return R; }
    var thr = base + 0.3 * A, lo = base + 0.15 * A, starts = [], up = v[0] > thr, i;
    for (i = 1; i < n; i++) {
      if (!up && v[i] > thr && v[i - 1] <= thr) {   // foot = lowest point since the previous peak (robust to noise)
        var from = starts.length ? amax(v, starts[starts.length - 1], i).i : 0; starts.push(amin(v, from, i).i); up = true;
      }
      else if (up && v[i] < lo) up = false;
    }
    if (starts.length < 3) { R.error = "Fewer than three breaths on the volume tracing: widen the box."; return R; }
    var br = []; for (var k = 0; k < starts.length; k++) { var e = k + 1 < starts.length ? starts[k + 1] : n - 1, pk = amax(v, starts[k], e); br.push({ s: starts[k], e: e, pk: pk.i, pv: pk.v - base, last: k + 1 === starts.length }); }
    R.breaths = br.length;
    var medPk = median_(br.map(function (b) { return b.pv; })), cnt = { v_leak: 0, f_trap: 0, f_double: 0 }, of = 0;
    br.forEach(function (b) {
      if (b.pv > 1.6 * medPk) { cnt.f_double++; R.events.push({ x: b.pk, type: "f_double" }); }
      if (b.last) return;
      var f0 = b.e, pre = f0, dur = f0 - b.pk; if (dur < 8) return;
      of++;
      // a reset: a near-vertical fall to the baseline just before the next breath
      var L = Math.max(5, Math.round(0.1 * dur)), mx = amax(v, Math.max(b.pk + 1, f0 - L), f0);
      if (mx.v - v[f0] > 0.12 * medPk) pre = mx.i;
      var endLv = (v[pre] - base) / medPk, m = Math.max(3, Math.round(0.15 * (pre - b.pk))), slope = (v[pre] - v[Math.max(b.pk, pre - m)]) / medPk;
      if (endLv <= 0.1) return;
      if (slope < -0.04) { cnt.f_trap++; R.events.push({ x: pre, type: "f_trap" }); }
      else { cnt.v_leak++; R.events.push({ x: pre, type: "v_leak" }); }
    });
    of = of || 1;
    if (cnt.v_leak) R.findings.v_leak = { n: cnt.v_leak, of: of };
    if (cnt.f_trap) R.findings.f_trap = { n: cnt.f_trap, of: of };
    if (cnt.f_double) R.findings.f_double = { n: cnt.f_double, of: br.length };
    Object.keys(R.findings).forEach(function (k3) { R.findings[k3].conf = confOf(R.findings[k3].n, R.findings[k3].of); });
    return R;
  }
  // A flow "blip" that sits inside a pressure breath is a delivered (small) breath, not a missed effort.
  // dx converts flow-box columns to pressure-box columns (same screen time axis).
  function crossCheck(F, P, dx) {
    if (!F || F.error || !P || P.error || !P.spans || !P.spans.length) return F;
    var inBreath = function (xf) { var xp = xf + dx; return P.spans.some(function (sp) { return xp >= sp[0] - 4 && xp <= sp[1] + 4; }); };
    var dropped = 0;
    F.events = F.events.filter(function (e) { if ((e.type === "f_ineff" || e.type === "f_early") && inBreath(e.x)) { dropped++; return false; } return true; });
    ["f_ineff", "f_early"].forEach(function (id) {
      if (!F.findings[id]) return;
      var n = F.events.filter(function (e) { return e.type === id; }).length;
      if (!n) delete F.findings[id]; else { F.findings[id].n = n; F.findings[id].conf = confOf(n, F.findings[id].of); }
    });
    if (dropped) F.notes.push(dropped + " small flow blip" + (dropped > 1 ? "s" : "") + " lined up with a pressure breath, so counted as delivered breath" + (dropped > 1 ? "s" : "") + ", not missed efforts.");
    return F;
  }
  // Combine flow and pressure reads into catalogue findings that apply to the mode
  function mergeReads(reads, vm) {
    var ok = {}, out = {}; scalarsFor(vm).forEach(function (f) { ok[f.id] = 1; });
    (reads || []).forEach(function (R) {
      if (!R || R.error) return;
      Object.keys(R.findings).forEach(function (id) {
        if (!ok[id]) return;
        var fd = R.findings[id], cur = out[id];
        if (!cur || fd.n / fd.of > cur.n / cur.of) out[id] = { n: fd.n, of: fd.of, conf: fd.conf, from: R.kind };
      });
    });
    return out;
  }

  // Message blocks for an intubated patient (user's layout)
  // opts: { unverified: true } while AI-filled values are not yet checked: values are listed, interpretations withheld
  function ventBlocks(sp, v, fio2Pct, ab, opts) {
    if (!sp || sp.mode !== "mv") return [];
    v = v || {}; var sp0 = sp; sp = normalizeVent(sp).s; opts = opts || {};
    var vm = VMODES[sp.vmode] ? sp.vmode : "acvc", B = [];
    var A = ["Present settings:", "Mode: " + VMODES[vm], "FiO₂: " + (fio2Pct != null ? fmt(fio2Pct, 0) + "%" + (v.fio2Bad != null ? " (invalid: outside 21–100%; not used)" : "") : "—")];
    if ((isVC(vm) || isPRVC(vm)) && pos_(sp.vt) != null) A.push("TV: " + fmt(sp.vt, 0) + " mL" + (v.vtSetKg != null ? " (" + fmt(v.vtSetKg, 1) + " mL/kg PBW)" : ""));
    if (isPC(vm) && pos_(sp.pinsp) != null) A.push("Pinsp (ΔPinsp): " + fmt(sp.pinsp, 0) + " cmH₂O above PEEP");
    if (vm !== "psv" && pos_(sp.rr) != null) A.push((isSIMV(vm) ? "BUR (fsimv): " : "BUR: ") + fmt(sp.rr, 0) + "/min");
    if (v.ie) A.push("I:E: " + v.ie.text);
    else if (v.ieDerived) A.push("I:E: ≈ " + v.ieDerived + " (calculated from " + v.tiSrc + ")");
    if (vm !== "psv" && pos_(sp.ti) != null) A.push("Ti (Tinsp): " + fmt(sp.ti, 2) + " s");
    if (isVC(vm) && pos_(sp.flow) != null) A.push("Peak flow rate: " + fmt(sp.flow, 0) + " L/min");
    if (num_(sp.peep) != null) A.push("PEEP: " + (sp.peep === 0 ? "0 (OFF)" : fmt(sp.peep, 0) + " cmH₂O"));
    if (v.ps != null) A.push("PS (ΔPsupp): " + fmt(v.ps, 0) + " cmH₂O above PEEP");
    if (v.ftrig != null) A.push("F-Trig: " + fmt(v.ftrig, 1) + " L/min");
    if (v.tslope != null) A.push("Rise time (Tslope): " + fmt(v.tslope, 2) + " s");
    if (v.ets != null) A.push("Cycle-off (Exp%): " + fmt(v.ets, 0) + "%");
    B.push(A);
    var P = ["Pressures"];
    if (pos_(sp.ppeak) != null) P.push("Peak pressure: " + fmt(sp.ppeak, 0) + " cmH₂O" + (v.badPpk ? " (invalid: below PEEP; recheck)" : sp.ppeak > 35 ? " " + UP : ""));
    if (pos_(sp.pplat) != null) P.push("Plateau pressure: " + fmt(sp.pplat, 0) + " cmH₂O" + (v.badPeak ? " (invalid: above the peak; recheck)" : v.badPlat ? " (invalid: below PEEP; recheck)"
      : (sp.pplat > 30 ? " " + UP : "") + (v.dpUnverified ? " (unverified: taken while the patient was triggering)" : " (goal ≤ 30)")));
    if (num_(sp.peeptot) != null && v.badPeepTot) P.push("Total PEEP: " + fmt(sp.peeptot, 0) + " cmH₂O (invalid: below set PEEP; recheck)");
    if (pos_(sp.mawp) != null) P.push("Mean airway pressure: " + fmt(sp.mawp, 0) + " cmH₂O" + (v.badMawp ? " (invalid: " + v.badMawp + "; recheck)" : ""));
    if (v.peepM != null) P.push("PEEP (measured): " + fmt(v.peepM, 0) + " cmH₂O" + (v.peepUnres ? " (unverified: disagrees with " + (v.peepUnres.hold ? "the expiratory-hold total PEEP" : "set PEEP") + "; see the input checks)" : ""));
    if (num_(sp.peeptot) != null && !v.badPeepTot) P.push("Total PEEP: " + fmt(sp.peeptot, 0) + " cmH₂O (expiratory hold" + (v.autoPeep != null ? "; auto-PEEP " + fmt(Math.max(0, v.autoPeep), 0) : "") + ")");
    if (pos_(sp.vte) != null) P.push("VTE: " + fmt(sp.vte, 0) + " mL" + (v.pbw ? " (" + fmt(sp.vte / v.pbw, 1) + " mL/kg PBW)" : ""));
    if (pos_(sp.vti) != null) P.push("VTi: " + fmt(sp.vti, 0) + " mL" + (v.leak != null && v.leak >= 10 && !v.simv ? " (VTE " + fmt(v.leak, 0) + "% lower: leak?)" : ""));
    if (v.vtspn != null) P.push("VTE spn: " + fmt(v.vtspn, 0) + " mL" + (v.vtspnKg != null ? " (" + fmt(v.vtspnKg, 1) + " mL/kg PBW)" : ""));
    if (v.veSrc === "measured") P.push("MV: " + fmt(v.ve, 1) + " L/min" + (v.mvspn != null ? " (MVspn " + fmt(v.mvspn, 1) + ")" : "") + (v.mvleak != null ? "; MVleak " + fmt(v.mvleak, 1) : ""));
    else if (v.mvDisputed) P.push("MV: " + fmt(v.mvDisputed.m, 1) + " L/min (unverified: VT × rate gives " + fmt(v.mvDisputed.c, 1) + "; recheck)");
    else if (v.mvBad != null) P.push("MV: " + fmt(v.mvBad, 1) + " L/min (invalid: outside 0.5–60; not used)");
    if (pos_(sp.ftot) != null || (v.fmand != null && v.fspn != null)) P.push("Ftotal: " + fmt(v.f, 0) + "/min" + (v.fmand != null || v.fspn != null ? " (fmand " + (v.fmand != null ? fmt(v.fmand, 0) : "–") + ", fspn " + (v.fspn != null ? fmt(v.fspn, 0) : "–") + ")" : v.trig != null && v.trig >= 2 && vm !== "psv" ? " (" + fmt(v.trig, 0) + " above BUR)" : ""));
    // Driving pressure always carries its basis; it is compared with the goal only when the measurements behind it are valid
    if (v.dp != null) P.push("Driving pressure: " + fmt(v.dp, 0) + " cmH₂O" + (v.dp > 15 ? " " + UP : "") + (v.dpUnverified ? " (unverified: plateau taken while the patient was triggering; " + dpBasis(v) + ")" : " (" + dpBasis(v) + "; goal ≤ 15)"));
    else P.push(v.badPlat ? "Driving pressure: not assessed (plateau below PEEP; recheck)" : v.badPeak ? "Driving pressure: not assessed (plateau above peak; recheck)" : v.badPeepTot ? "Driving pressure: not assessed (total PEEP below set PEEP; recheck)"
      : v.peepUnres ? "Driving pressure: not assessed (end-expiratory pressure unresolved: " + v.peepUnresTxt + "; do an expiratory hold)" : "Driving pressure: needs plateau pressure (inspiratory hold)");
    B.push(P);
    var C = [];
    if (v.pbw) C.push("PBW " + fmt(v.pbw, 1) + " kg (6 mL/kg = " + Math.round(6 * v.pbw) + " mL)");
    else if (v.pbwNeedSex) C.push("PBW: not calculated (sex not selected)");
    if (v.pao2Bad != null || v.fio2Bad != null) C.push("P/F and oxygenation index: not assessed (" + (v.fio2Bad != null ? "FiO₂ " + fmt(v.fio2Bad, 0) + "%" : "pO₂ " + fmt(v.pao2Bad, 0)) + " is invalid; recheck)");
    else if (v.pao2Alv) C.push("P/F and oxygenation index: not calculated (pO₂ " + fmt(v.pao2Alv.p, 0) + " is above what FiO₂ " + fmt(v.pao2Alv.f, 0) + "% can give; check FiO₂)");
    if (v.oi != null) C.push("Oxygenation index: " + fmt(v.oi, 1) + " (no adult severity bands; follow the trend)");
    if (v.spo2Bad != null) C.push("SpO₂: " + fmt(v.spo2Bad, 0) + "% (" + (v.spo2Bad > 100 ? "invalid" : "outside 51–100%") + "; not used for S/F)");
    if (v.sf != null) C.push("SpO₂/FiO₂: " + Math.round(v.sf) + " (SpO₂ " + fmt(v.spo2, 0) + "%)" + (v.spo2 > 97 ? "; not valid above 97%" : v.sfRange ? " " + DOWN + "; ARDS oxygenation range (≤ 315)" + (v.sfSev ? ", " + v.sfSev : "") : ""));
    if (v.osi != null) C.push("Oxygen saturation index: " + fmt(v.osi, 1) + " (no adult severity bands; follow the trend)");
    if (C.length) B.push(C);
    var M = ["Mechanics"];
    if (v.cstat == null && (v.peepUnres || v.badPeepTot) && v.pplV != null) M.push("Static compliance: not assessed (" + (v.peepUnres ? "end-expiratory pressure unresolved" : "total PEEP below set PEEP") + ")");
    if (v.cstat != null) M.push("Static compliance: " + fmt(v.cstat, 0) + " mL/cmH₂O" + (v.cstat < 40 ? " " + DOWN : "") + (v.cstatSrc === "ventilator" ? " (ventilator-measured; normal 40–100)" : v.dpUnverified ? " (unverified: plateau taken while the patient was triggering)" : " (from plateau; normal 40–100)") + (v.cstatM != null && v.cstatSrc !== "ventilator" ? "; ventilator Cstat " + fmt(v.cstatM, 0) : ""));
    if (v.cdynM != null) M.push("Dynamic compliance (Cdyn): " + fmt(v.cdynM, 0) + " mL/cmH₂O");
    if (v.raw != null) M.push("Airway resistance" + (v.rawSrc === "ventilator" ? " (Ri)" : "") + ": " + fmt(v.raw, 0) + " cmH₂O/L/s" + (v.raw > 15 ? " " + UP : "") + (v.rawSrc === "ventilator" ? " (normal ≈ 5–10 with a tube)" : " (peak − plateau " + fmt(v.gap, 0) + "; normal ≈ 5–10 with a tube)"));
    else if (v.gap != null) M.push("Peak − plateau: " + fmt(v.gap, 0) + " cmH₂O" + (v.gap > 10 ? " " + UP : "") + " (resistive pressure; normal ≤ 5–10)");
    if (v.te != null && v.tau != null) M.push("Expiratory time: " + fmt(v.te, 1) + " s" + (v.teAct ? " at ftotal " + fmt(v.f, 0) : "") + " vs 3 time constants" + (v.tauSrc === "RCexp" ? " (RCexp " + fmt(v.tau, 2) + " s)" : "") + " " + fmt(3 * v.tau, 1) + " s" + (v.te < 3 * v.tau ? " (air trapping risk)" : " (enough to exhale)"));
    if (v.ve != null) M.push("Minute ventilation" + (v.veSrc === "measured" ? " (measured)" : "") + ": " + fmt(v.ve, 1) + " L/min" + (v.vePred ? (v.ve / v.vePred >= 1.5 ? " " + UP : "") + " (predicted " + fmt(v.vePred, 1) + ")" : ""));
    else if (v.mvDisputed) M.push("Minute ventilation: not assessed (measured " + fmt(v.mvDisputed.m, 1) + " vs VT × rate " + fmt(v.mvDisputed.c, 1) + " L/min; recheck)");
    if (v.vr != null) M.push("Ventilatory ratio: " + fmt(v.vr, 1) + (v.vrUnverified ? " (unverified: the gas is internally inconsistent)" : (v.vr >= 2 ? " " + UP : "") + " (normal ≈ 1)"));
    if (v.mp != null) M.push("Mechanical power: " + fmt(v.mp, 0) + " J/min" + (v.mp > 17 ? " " + UP : "") + " (> 17 linked to higher mortality)");
    else if (v.mpNA) M.push("Mechanical power: not assessed (" + v.mpNA + ")");
    if (v.rsbi != null) M.push("RSBI: " + Math.round(v.rsbi) + (v.rsbiOK ? " (< 105 favours weaning)" : " (on PS " + fmt(v.ps, 0) + ": not a weaning index; measure on PS 5–8 or CPAP)"));
    else if (v.rsbiM != null) M.push("RSBI (ventilator): " + Math.round(v.rsbiM) + (v.rsbiOK ? " (< 105 favours weaning)" : " (not a weaning index at this support" + (v.simv ? "; spontaneous breaths only" : "") + ")"));
    if (M.length > 1) B.push(M);
    var E = ["Effort and drive"];
    if (v.p01 != null) E.push("P0.1: " + fmt(v.p01, 1) + " cmH₂O" + (v.p01 > 3.5 ? " " + UP : v.p01 < 1 ? " " + DOWN : "") + " (usual 1–3.5)");
    if (v.pmus != null) E.push("ΔPocc: −" + fmt(Math.abs(v.pocc), 0) + " cmH₂O → Pmus ≈ " + fmt(v.pmus, 0) + (v.pmus > 10 ? " " + UP : "") + " (> 10 high)" + (v.dpl != null ? "; ΔPL,dyn ≈ " + fmt(v.dpl, 0) + (v.dpl > 15 ? " " + UP : "") + " (> 15 high)" : ""));
    if (E.length > 1) B.push(E);
    if (opts.unverified) { B.push(["Ventilator interpretation and weaning screen: not assessed until the AI-filled values are checked against the ventilator screen."]); return B; }
    var I = ventInterp(v, sp, ab).filter(function (x) { return x.msg; }).map(function (x) { return x.text; });
    if (I.length) B.push(["Ventilator interpretation:"].concat(I));
    var SB = scalarBlock(sp0);
    if (SB) B.push(SB);
    var W = v.wean;
    var mark = function (c) { return (c.ok === null ? "– " : c.ok ? "✓ " : "✗ ") + c.label + " (" + c.val + ")"; };
    if (W && W.known >= 3 && W.relevant && (vm === "psv" || isSIMV(vm) || W.allMet)) {
      B.push(["Weaning screen (numbers only):"].concat(W.items.map(mark))
        .concat([W.allMet ? "Meets the numeric criteria; also needs: cause improving, stable without or on low-dose vasopressors, awake, good cough, manageable secretions." : "Not yet: " + W.items.filter(function (c) { return c.ok === false; }).map(function (c) { return c.label; }).join("; ") + "."]));
    } else if (W && W.incomplete && W.known >= 2) {
      B.push(["Weaning screen (numbers only):"].concat(W.items.map(mark)).concat(["Screen incomplete: oxygenation is not assessed, so this is not a pass. Recheck the gas (or use a valid SpO₂)."]));
    }
    return B;
  }
  var VENT_KEYS = ["vcheck", "vtdiff", "simv", "simvwean", "rr", "vdrive", "effort", "shunt", "o2", "pplat", "vt", "dp", "autopeep", "raw", "leak", "si", "ards", "ardsSF", "ardsRx", "peep", "psv", "wean", "extub", "ie", "flow", "mp"];
  function isVentKey(k) { return VENT_KEYS.indexOf(k) > -1 || k.indexOf("sc_") === 0; }
  // m: { support (vent fields, scalars), vent, fio2Pct, linked, ph, paco2, pao2, ab, ox, g, rf, r, tgt, retainer }
  function ventMessage(m) {
    var sp = Object.assign({}, normalizeVent(m.support || {}).s, { mode: "mv" });
    var B = [["Ventilator assessment"]];
    var ab = m.linked && m.ab && !m.ab.errors.length ? m.ab : null;
    if (m.linked && m.ph != null && m.paco2 != null && m.pao2 != null) {
      var ix = indices(m.pao2, m.paco2, m.fio2Pct);
      B[0].push("ABG: pH " + fmt(m.ph, 2) + ", pCO₂ " + n1(m.paco2) + ", pO₂ " + n1(m.pao2) + (vStat("pao2", m.pao2) === "invalid" ? " (invalid)" : "") + (m.fio2Pct != null ? " on FiO₂ " + fmt(m.fio2Pct, 0) + "%" : "") + (ix ? " (P/F " + Math.round(ix.pf) + ")" : ""));
      var head = interpretation(ab); if (head) B[0].push(head + (m.ox ? ", with " + m.ox.label : ""));
    }
    var vIs = collectIssues({ abRaw: m.linked ? m.ab : null, vent: m.vent, pao2: m.linked ? m.pao2 : null, paco2: m.linked ? m.paco2 : null, fio2Pct: m.fio2Pct, extra: m.extraIssues });
    if (vIs.length) B.push(["⚠️ Input checks (resolve before acting):"].concat(vIs.map(function (x) { return "• " + x.text; })));
    ventBlocks(sp, m.vent, m.fio2Pct, ab, { unverified: !!m.aiPending }).forEach(function (b) { B.push(b); });
    if (m.aiPending) { B.push(["Suggestions: withheld until the AI-filled values are checked against the ventilator screen."]); return B.map(function (b) { return b.join("\n"); }).join("\n\n"); }
    var sg = suggestions({ ab: ab, ox: m.linked ? m.ox : null, r: m.linked ? m.r : null, g: m.linked ? m.g : null, rf: m.linked ? m.rf : null, retainer: m.retainer,
      paco2: m.linked ? m.paco2 : null, pao2: m.linked ? m.pao2 : null, fio2Pct: m.fio2Pct, support: sp, vent: m.vent, tgt: m.tgt }).filter(function (x) { return isVentKey(x.key); });
    if (sg.length) B.push(["Suggestions:"].concat(capSugg(sg, 10).map(function (x) { return "• " + x.text + (x.src ? " [" + x.src + "]" : ""); })));
    return B.map(function (b) { return b.join("\n"); }).join("\n\n");
  }

  function desiredMV(r, pao2) {
    if (r.level === "over") return ">100% (not reachable with FiO₂ alone: optimise PEEP)";
    if (r.adequate) return fmt(r.fio2Pct, 0) + "% (keep; pO₂ " + fmt(pao2, 0) + (r.inWindow ? " within " + r.inWindow : " adequate") + ")";
    return r.level === "ra" ? "21%" : Math.round(r.fio2Req) + "%";
  }

  /* ---------- Complete interpretation ---------- */
  function lc(s) { return s.charAt(0).toLowerCase() + s.slice(1); }

  // P/F, and A-aDO2 (room air, vs age) or a/A (on O2), with the likely mechanism
  function gasExchange(m) {
    var ix = indices(m.pao2, m.paco2, m.fio2Pct); if (!ix || ix.PAO2 <= 0) return null;
    var aA = m.pao2 / ix.PAO2; if (aA > 1) return null;
    var g = { pf: ix.pf, Aa: ix.AaGrad, aA: aA, onO2: m.fio2Pct > 21.5 };
    var sp = m.support, pe = endExpPressure(sp);
    g.ctx = sp && sp.mode === "mv" && pe != null ? " on PEEP " + fmt(pe, 0) : sp && sp.mode === "niv" && pe != null ? " on " + (sp.nivType === "cpap" ? "CPAP " : "EPAP ") + fmt(pe, 0)
      : sp && sp.mode === "mask" && sp.dev === "hfnc" && num_(sp.hfFlow) != null ? " on HFNC " + fmt(sp.hfFlow, 0) + " L/min" : "";
    g.pfText = "P/F " + Math.round(ix.pf) + g.ctx + (ix.pf <= 100 ? " (≤ 100)" : ix.pf <= 200 ? " (≤ 200)" : ix.pf <= 300 ? " (≤ 300)" : "");
    // Does the P/F meet the ARDS oxygenation criterion's support condition (2023 global definition)?
    g.ardsSupport = !!(sp && ((sp.mode === "mv") || (sp.mode === "niv" && pe != null && pe >= 5) || (sp.mode === "mask" && sp.dev === "hfnc" && num_(sp.hfFlow) != null && sp.hfFlow >= 30)));
    // Severity (mild/moderate/severe) is graded only for intubated patients; this app also requires PEEP ≥ 5 entered (Berlin rule,
    // applied conservatively because sources differ on whether the global definition keeps it for intubated patients)
    g.intub = !!(sp && sp.mode === "mv"); g.pe = pe;
    g.sevOk = g.intub && pe != null && pe >= 5;
    if (!g.onO2 && m.age != null && isFinite(m.age)) {
      g.exp = expectedAa(m.age); g.widened = ix.AaGrad > g.exp;
      g.gradText = "A-aDO₂ " + Math.round(ix.AaGrad) + (g.widened ? " (widened; age norm ≤ " + Math.round(g.exp) + ")" : " (normal for age)");
    } else {
      g.widened = aA < 0.75;
      g.gradText = "a/A " + fmt(aA, 2) + (g.widened ? " (low)" : " (normal)");
    }
    var hypox = m.ox && m.ox.grade !== "none";
    g.mech = g.widened ? "V/Q mismatch, shunt or diffusion defect" : hypox ? "hypoventilation or low inspired O₂" : "";
    return g;
  }

  // Type 1 / Type 2 respiratory failure
  function respFailure(ab, pao2, paco2) {
    var ok = ab && !ab.errors.length;
    var respAcid = ok && (ab.primary === "resp-acid" || ab.primary === "mixed-acid" || ab.primary === "ambig-ra-ma" || (ab.check && ab.check.extra === "resp-acid"));
    if (respAcid && paco2 > 45) {
      if (ab.ph < 7.35) {
        var t = ab.check && ab.check.primary === "resp-acid" && !ab.check.extra ? ab.check.timing : null;
        return { type: 2, acidotic: true, text: "Type 2 (hypercapnic) respiratory failure" + (t === "acute" ? ", acute" : t === "between" ? ", acute-on-chronic" : t === "chronic" ? ", chronic pattern" : "") + " with acidemia" };
      }
      return { type: 2, acidotic: false, text: "Chronic hypercapnia, compensated (pH ≥ 7.35)" };
    }
    if (pao2 != null && isFinite(pao2) && pao2 < 60) return { type: 1, text: "Type 1 (hypoxemic) respiratory failure" };
    return null;
  }

  function fullInterpretation(m) {
    var L = [], ab = m.ab && !m.ab.errors.length ? m.ab : null;
    var head = interpretation(ab, m.el);
    if (head && m.ox) head += ", with " + m.ox.label;
    else if (!head && m.ox) head = cap(m.ox.label);
    if (head) L.push(head);
    if (ab && ab.label && ab.primary !== "normal") L.push("Traditional: " + lc(ab.label));
    elInterp(m.el, ab).forEach(function (x) { L.push(x.text); });
    if (m.ox) L.push("Oxygenation: " + m.ox.detail);   // v16.4: the oxygenation reading in words, not only in the headline
    if (m.rf) L.push(m.rf.text);
    if (m.g) L.push("Gas exchange: " + m.g.pfText + "; " + m.g.gradText + (m.g.mech ? " → " + m.g.mech : ""));
    return L;
  }

  /* ---------- Guideline-based suggestions ----------
     Sources: BTS 2017 oxygen guideline; GOLD 2026 + NICE QS10 (NIV); SSC 2026 (bicarbonate, lactate);
     BICARICU-2 (JAMA 2025); ADA/EASD/JBDS 2024 hyperglycaemic crises; Global ARDS definition 2023;
     ATS 2024 ARDS guideline; MSD Manual (metabolic alkalosis). */
  var PRIORITY = ["check", "vcheck", "vtdiff", "sev", "glu", "k", "dka", "hhs", "osm", "na", "mixed", "niv", "nivOpt", "fatigue", "rr", "vdrive", "effort", "shunt", "o2", "pplat", "vt", "dp", "autopeep", "raw", "leak", "si",
                  "sc_f_trap", "sc_f_double", "sc_p_scoop", "sc_f_ineff", "sc_p_rev", "sc_p_auto", "sc_v_leak", "sc_f_saw", "sc_f_early", "sc_f_late", "sc_p_dip", "sc_f_obstr", "sc_p_over", "sc_p_slow",
                  "ards", "ardsSF", "ardsRx", "peep", "hfnc", "bicarb", "cause", "lactate", "ica", "psv", "simv", "wean", "simvwean", "extub", "ie", "flow", "mp", "drive", "alk", "hypervent", "hypovent", "chronicCO2", "def"];
  // Each suggestion: short text (message) + optional detail (app) + source tag. Mode-aware: ra, nc, mask, niv, mv.
  function suggestions(c) {
    var S = {}, add = function (key, text, src, tone, more) { if (!S[key]) S[key] = { key: key, text: text, src: src || "", tone: tone || "", more: more || "" }; };
    var ab = c.ab && !c.ab.errors.length ? c.ab : null;
    var sp = c.support || { mode: "nc" }, mode = sp.mode, v = c.vent || null;
    var onPP = mode === "niv" || mode === "mv";
    var p = ab ? ab.primary : null, ex = ab && ab.check ? ab.check.extra : null;
    var metAcid = p === "met-acid" || p === "mixed-acid" || ex === "met-acid";
    var metAlk = p === "met-alk" || p === "mixed-alk" || ex === "met-alk";
    var respAcid = p === "resp-acid" || p === "mixed-acid" || p === "ambig-ra-ma" || ex === "resp-acid";
    var hypercap = !!(ab && respAcid && c.paco2 > 45);
    var co2Risk = !!(c.retainer || hypercap);
    var spo2 = co2Risk ? "88–92%" : "94–98%";
    var L = c.lactate != null && isFinite(c.lactate) ? c.lactate : null;
    var ox = c.ox, r = c.r && !c.r.errors.length ? c.r : null;
    var g = c.g, pf = g ? g.pf : null;
    var ardsRange = !!(g && pf <= 300 && g.ardsSupport);
    var ardsSev = pf == null ? "" : pf <= 100 ? "severe" : pf <= 200 ? "moderate" : "mild";
    var E = c.el || null, dka = !!(E && E.dka && E.dka.state === "met");
    var hhsAny = !!(E && E.hhs && (E.hhs.state === "met" || E.hhs.state === "possible"));
    var insulinCtx = dka || hhsAny || !!(E && E.dka && E.dka.state === "possible" && E.dka.D === true);   // insulin likely to be started

    if (c.mismatch) add("check", "Recheck the entries: HCO₃ or TCO₂ does not fit the pH and pCO₂.", "", "warn",
      "Usually a typo, or values copied from different samples (e.g. a serum bicarbonate drawn at another time).");
    if (ab && ab.ph < 7.20) add("sev", "Severe acidemia: treat the cause now, monitor closely (HDU/ICU), repeat the ABG after each intervention.", "", "crit");
    if (ab && ab.ph > 7.60) add("sev", "Severe alkalemia: needs urgent correction; check K⁺ and ionized calcium.", "MSD Manual", "crit",
      "Alkalemia lowers ionized calcium and, with hypokalemia, raises the risk of arrhythmia.");
    if (p === "mixed-acid") add("mixed", mode === "mv" ? "Mixed respiratory and metabolic acidosis on the ventilator: raise minute ventilation (see RR) while treating the metabolic cause."
      : "Mixed respiratory and metabolic acidosis: arrange ventilatory support early while treating the metabolic cause.", "", "crit");

    /* ---- Ventilation ---- */
    if (mode === "mv") {
      var vm = VMODES[sp.vmode] ? sp.vmode : "acvc", bur = vm === "psv" ? null : num_(sp.rr), ftotN = num_(sp.ftot);
      if (v && v.rsbiM != null && !v.rsbiOK && v.rsbiM < 105) add("psv", "RSBI " + Math.round(v.rsbiM) + " on the screen is not a weaning index at this support" + (v.ps != null ? " (PS " + fmt(v.ps, 0) + ")" : "") + ": recheck it during a trial on PS 5–8 or CPAP.", "Yang & Tobin, NEJM 1991", "",
        "RSBI = rate ÷ VT in litres, measured while breathing with little or no support. Pressure support makes each breath bigger and the RSBI falsely low.");
      if (isSIMV(vm)) {
        if (v && v.psOverPinsp) add("simv", "PS " + fmt(v.ps, 0) + " is at or above Pinsp " + fmt(sp.pinsp, 0) + ": the mandatory breaths add little. If the patient breathes reliably, CPAP/PSV alone does the same job; if not, a full assist mode (P-A/C) is simpler.", "", "",
          "In SIMV the mandatory rate (fsimv) gives set breaths and the patient's extra breaths get pressure support. When PS equals or exceeds Pinsp the two breath types are about the same size.");
        add("simvwean", "For liberation, use a daily spontaneous breathing trial (PS 5–8, PEEP ≤ 5) rather than stepping down fsimv: SIMV weaning failed more often and took longer than pressure-support weaning or daily trials.", "Brochard, AJRCCM 1994; Esteban, NEJM 1995", "",
          "Brochard 1994: weaning failure 42% with SIMV vs 23% with pressure support. Esteban 1995: a once-daily trial of spontaneous breathing led to extubation about three times faster than SIMV.");
      }
      if (v && v.peepLow && !ardsRange && !(v.ardsRangeSF) && num_(sp.peep) != null) add("peep", "PEEP " + (sp.peep === 0 ? "OFF (0)" : fmt(sp.peep, 0)) + ": acceptable without ARDS if oxygenation holds (lower PEEP 0–5 was noninferior to PEEP 8)" + (v.cstat != null && v.cstat < 40 ? "; with low compliance (" + fmt(v.cstat, 0) + ") try PEEP 5 and watch SpO₂ and Cstat" : "") + ".", "RELAx, JAMA 2020", "",
        "RELAx randomized 980 ICU patients without ARDS: lower PEEP (0–5) gave 18 vs 17 ventilator-free days, with slightly more rescue therapy for hypoxemia. Raise PEEP before FiO₂ if oxygenation worsens.");
      if (vm === "psv") {
        var sclP = scalarIds(sp), overAssist = (v && v.vtkg != null && v.vtkg > 8) || sclP.indexOf("f_trap") > -1 || sclP.indexOf("f_ineff") > -1 || (v && v.autoPeep != null && v.autoPeep >= 2);
        if (hypercap && ab.ph < 7.30) add("rr", overAssist
          ? "Acidotic hypercapnia on PS with air trapping or a large VT: more support will worsen hyperinflation. Switch to a controlled mode with VT 6–8 mL/kg, a moderate rate and a long expiration, and treat the obstruction."
          : "Acidotic hypercapnia on pressure support: raise PS or return to a controlled mode (ACVC/ACPC).", overAssist ? "Brochard & Lellouche ch. 8; Leatherman ch. 30" : "", "warn");
        if (v && v.rsbi != null && v.rsbi >= 105) add("psv", "RSBI " + Math.round(v.rsbi) + " (≥ 105): rapid shallow breathing on this support. Look for the cause (pain, anxiety, secretions, high load, weakness). It is one data point: readiness for a breathing trial is a clinical decision, and AARC 2024 suggests RSBI is not needed to make it.", "AARC 2024; Yang & Tobin, NEJM 1991", "warn",
          "RSBI = breathing rate ÷ VT in litres. Yang & Tobin found < 105 predicted weaning success, but AARC 2024 suggests calculating it is not needed to decide readiness for a spontaneous breathing trial (conditional, moderate certainty).");
      } else if (v && v.target && v.rrNeed != null && ab) {
        var fNow = v.f, up = v.rrNeed > fNow, diff = Math.abs(v.rrNeed - fNow);
        var permissive = ardsRange && respAcid && ab.ph >= 7.30 && up;
        var canLower = !up && bur != null && bur > v.rrNeed + 1;
        var nowTxt = bur != null ? "set " + fmt(bur, 0) + (v.trig != null && v.trig >= 2 ? ", total " + fmt(fNow, 0) : "") : "total " + fmt(fNow, 0);
        var scl = scalarIds(sp);
        var trapping = (v.autoPeep != null && v.autoPeep >= 2) || (v.te != null && v.tau != null && v.te < 3 * v.tau) || scl.indexOf("f_trap") > -1;
        var obstr = v.raw != null ? v.raw > 15 : v.gap != null && v.gap > 10;
        var stiffL = v.cstat != null && v.cstat < 40;
        var obstructive = trapping || scl.indexOf("f_obstr") > -1 || (obstr && !stiffL);
        var plt = v.pplV != null ? v.pplV : null;
        if (obstructive && plt != null && plt > 30) add("rr", "Obstructive pattern with plateau " + fmt(plt, 0) + " > 30: lower the rate (minute ventilation) to cut hyperinflation and accept hypercapnia.", "Leatherman, Tobin ch. 30", "warn",
          "Severe airflow obstruction: aim for plateau < 30 (≤ 25 ideal) and pH ≥ 7.2. Plateau > 30 → less minute ventilation; pH < 7.2 with plateau < 25 → more; pH < 7.2 with plateau 25–30 → no change.");
        else if (obstructive && plt != null && ab.ph < 7.2 && plt <= 30 && up) add("rr", plt < 25 ? "Obstructive pattern, pH < 7.2 with plateau < 25: the rate can be raised cautiously (recheck plateau and auto-PEEP after the change)."
          : "Obstructive pattern, pH < 7.2 with plateau 25–30: no rate change; consider a buffer only if the acidosis itself is causing harm.", "Leatherman, Tobin ch. 30", "warn",
          "Severe airflow obstruction: aim for plateau < 30 (≤ 25 ideal) and pH ≥ 7.2. A faster rate shortens expiration and adds to hyperinflation.");
        else if (diff >= 2 && up && trapping) add("rr", "Air trapping" + (v.autoPeep != null && v.autoPeep >= 2 ? " (auto-PEEP " + fmt(v.autoPeep, 0) + ")" : " (short expiratory time)") +
          ": do not raise the rate to clear CO₂. Accept permissive hypercapnia (keep pH ≥ 7.15) while treating the obstruction; lower RR if auto-PEEP rises.", "", "warn",
          "A faster rate shortens expiration and adds to dynamic hyperinflation. Lower minute ventilation, a shorter inspiratory time and bronchodilators reduce auto-PEEP; the pCO₂ usually falls as the obstruction improves.");
        else if (v.target.goal != null && !v.target.reach && v.target.floor) add("rr", "pH " + fmt(ab.ph, 2) + " with pCO₂ " + fmt(c.paco2, 0) + ": ventilation alone cannot reach the ARDSNet goal of pH 7.30. Even at the pCO₂ floor of 25 the pH would be ≈ " + fmt(v.target.phAt, 2) + " at HCO₃ " + fmt(v.target.hco3, 1) +
          (c.paco2 > 26 && up && v.rateSettable ? "; a rate of ≈ " + Math.round(Math.min(v.rrNeed, 35)) + "/min would get there only if plateau stays ≤ 30 and expiratory flow still reaches zero" : "") + ". Treat the metabolic cause; that is what will move the pH.", "ARDSNet", "warn",
          "Projected pH = 9 − log10(24 × pCO₂ ÷ HCO₃), assuming HCO₃ stays the same. ARDSNet: for pH 7.15–7.30 raise RR until pH > 7.30 or pCO₂ < 25 (RR ≤ 35); below 7.15, RR 35, then VT in 1 mL/kg steps, and bicarbonate may be given.");
        else if (diff >= 2 && v.target.phAt != null && Math.abs(v.target.phAt - 7.40) > Math.abs(ab.ph - 7.40) + 0.005 && (v.target.phAt < 7.35 || v.target.phAt > 7.45)) {
          var tTxt = (v.target.custom ? "your custom target pCO₂ " : "pCO₂ ") + fmt(v.target.value, 0) + (v.target.custom ? "" : " (" + v.target.why + ")");
          add("rr", (ab.ph >= 7.35 && ab.ph <= 7.45 ? "pH " + fmt(ab.ph, 2) + " is normal: no rate change for the pCO₂ alone. Moving to " + tTxt + " would give pH ≈ " + fmt(v.target.phAt, 2) + "."
              : "Do not " + (up ? "raise" : "lower") + " the rate to reach " + tTxt + ": it would take pH from " + fmt(ab.ph, 2) + " to ≈ " + fmt(v.target.phAt, 2) + ", worsening the " + (ab.ph < 7.35 ? "acidemia" : "alkalemia") + "." +
                (metAcid && !up && ab.ph < 7.35 && ex === "resp-alk" ? " A pCO₂ below the Winter's value is helping the pH; look for the cause of the extra drive instead." : "")),
            "", ab.ph < 7.35 || ab.ph > 7.45 ? "warn" : "",
            "Projected pH = 9 − log10(24 × pCO₂ ÷ HCO₃), with HCO₃ held constant. Compensation formulas describe what the body does; they are not ventilator targets when the pH would move the wrong way.");
        }
        else if (diff >= 2 && up && !v.rateSettable) {
          var need = Math.round((c.paco2 / v.target.value - 1) * 100);
          add("rr", "To bring pCO₂ toward " + fmt(v.target.value, 0) + " (" + v.target.why + "; projected pH ≈ " + fmt(v.target.phAt, 2) + "), alveolar ventilation would need to rise by about " + need + "%" + (v.veNeed != null ? " (minute ventilation ≈ " + fmt(v.ve, 1) + " → " + fmt(v.veNeed, 1) + " L/min)" : "") +
            ". No new set rate is calculated: the patient is " + (v.simv ? "taking spontaneous breaths between the mandatory ones" : "triggering " + fmt(v.trig, 0) + " breaths/min above the set rate (total " + fmt(v.f, 0) + " vs set " + fmt(v.bur, 0) + ")") +
            ", so raising the set rate may only replace the patient's own breaths. Reassess effort, synchrony, VT and measured minute ventilation first, and watch expiratory time, breath stacking, auto-PEEP and plateau.", "", ab.ph < 7.25 ? "warn" : "",
            "Theoretical estimate: assumes VT, dead space and CO₂ production stay the same. A set rate below the patient's own rate changes nothing; a set rate above it turns triggered breaths into mandatory ones and shortens expiration.");
        }
        else if (diff >= 2 && permissive) add("rr", "pH ≥ 7.30 on lung-protective ventilation: permissive hypercapnia is acceptable; no RR increase needed.", "ARDSNet", "",
          "ARDSNet pH goal is 7.30–7.45. If pH falls to 7.15–7.30, increase RR (max 35) until pH > 7.30 or pCO₂ < 25; if pH < 7.15, RR 35 then VT +1 mL/kg steps.");
        else if (diff >= 2 && (up || canLower)) {
          var rrNew = Math.min(v.rrNeed, 35);
          var rrT = (up ? "Raise" : "Lower") + " the set RR to ≈ " + Math.round(rrNew) + "/min (" + nowTxt + (v.ftotMissing ? "; Ftotal not entered, so this assumes no patient-triggered breaths" : "") + ") to bring pCO₂ toward " + fmt(v.target.value, 0) + " (" + v.target.why + "; projected pH ≈ " + fmt(v.target.phAt, 2) + " if HCO₃ is unchanged)";
          if (up && ab.ph < 7.20) {
            var teNew = v.ti != null ? 60 / rrNew - v.ti : null;
            rrT += "; with pH < 7.20 do it only if plateau stays ≤ 30" + (plt == null ? " (no plateau entered: do an inspiratory hold first)" : "") + " and expiratory flow still reaches zero" +
              (teNew != null ? " (expiratory time would fall to ≈ " + fmt(Math.max(0, teNew), 1) + " s" + (v.tau != null && teNew < 3 * v.tau ? ", under 3 time constants: air trapping likely" : "") + ")" : "") +
              (metAcid ? ", and treat the metabolic cause, which ventilation cannot fix" : "");
          }
          if (up && obstr) rrT += "; with high airway resistance, raise the rate only if expiratory flow still reaches zero (check auto-PEEP)";
          if (v.rrNeed > 35) rrT += ab.ph < 7.15 ? "; 35 is the ARDSNet maximum: if pH stays < 7.15, raise VT in 1 mL/kg steps (plateau may exceed 30) and bicarbonate may be given"
            : "; that needs > 35/min, so accept some hypercapnia (keep pH ≥ 7.15) with VT 6–8 mL/kg PBW";
          add("rr", rrT + ".", up && !v.target.custom ? "ARDSNet" : "", ab.ph < 7.25 || ab.ph > 7.55 ? "warn" : "",
            (up ? (v.veNeed != null ? "Minute ventilation needed ≈ " + fmt(v.veNeed, 1) + " L/min. " : "") + "At high rates check expiratory time and auto-PEEP (expiratory hold), plateau ≤ 30 and VT 4–8 mL/kg PBW."
              : "A low pCO₂ on the ventilator often means a high set rate or an agitated, pained or febrile patient breathing over the set rate; check before cutting support.") +
            (metAcid ? " In metabolic acidosis keep pCO₂ near the Winter's value: a 'normal' 40 is too high and worsens acidemia." : "") +
            " This is a theoretical estimate: it assumes VT, dead space and CO₂ production stay the same and that the patient breathes at the set rate (patient-triggered breaths may already exceed it). A faster rate also adds dead-space ventilation and shortens expiration. Recheck the ABG after any change.");
        }
      }
      // v16.2: the warning stays (critical) but gives no set-rate number: the rate needed cannot be read from the total rate
      var ownVent = v && metAcid && ab && ab.ph < 7.30 && ((v.trig != null && v.trig >= 2) || (vm === "psv" && ftotN != null));
      if (ownVent) {
        var veTxt = v.ve != null ? "; minute ventilation " + fmt(v.ve, 1) + " L/min" + (v.veSrc === "measured" ? " measured" : "") : "";
        add("vdrive", (vm === "psv" ? "On pressure support the patient generates all of the ventilation (total " + fmt(ftotN, 0) + "/min" + veTxt + ")"
            : "Patient is breathing " + fmt(v.trig, 0) + "/min above the set rate (total " + fmt(ftotN, 0) + " vs set " + fmt(bur, 0) + veTxt + ")") +
          " to compensate for the acidosis. Sedation, paralysis or a switch to a controlled mode can abruptly remove this ventilation and worsen the acidemia. Plan beforehand how minute ventilation will be maintained: the set rate cannot be inferred from the total rate alone; account for VT, dead space, expiratory time, auto-PEEP, plateau and driving pressure, and recheck the ABG soon after.",
          "", "crit",
          "Expert interpretation: losing the patient's compensatory hyperventilation after intubation, sedation or paralysis can drop the pH quickly and cause arrest in severe metabolic acidosis. Guideline protocol (ARDSNet, for ARDS): set the initial rate to approximate the baseline minute ventilation, not above 35/min; that ceiling belongs to the ARDSNet protocol, not to every patient or mode. Physiology: matching a high minute ventilation by rate alone shortens expiration (check auto-PEEP with an expiratory hold); a larger VT raises plateau and driving pressure.");
      }
      else if (ftotN != null && ftotN > 30) add("vdrive", "Total RR " + fmt(ftotN, 0) + "/min is high: look for pain, agitation, fever, hypoxemia, acidosis or dyssynchrony before adding sedation.", "", "warn");
      var lowerHow = isPC(vm) || vm === "psv" ? "lower Pinsp/PS" : "lower VT";
      if (v && v.vtkg != null && v.vtkg > 8) add("vt", "VT " + fmt(v.vtkg, 1) + " mL/kg PBW is high: " + (isPC(vm) || vm === "psv" ? "lower the inspiratory pressure to get" : "reduce toward") + " " + (ardsRange ? "6" : "6–8") + " mL/kg PBW (" + Math.round((ardsRange ? 6 : 7) * v.pbw) + " mL).", ardsRange ? "ATS 2024; ARDSNet" : "SSC 2026", "warn",
        "ARDS: 6 mL/kg PBW (range 4–8) with plateau ≤ 30 cmH₂O. SSC 2026 suggests 6–8 mL/kg PBW for sepsis-related hypoxemic failure without ARDS.");
      if (v && v.vtkg != null && v.vtkg < 4) add("vt", "VT " + fmt(v.vtkg, 1) + " mL/kg PBW is below 4: check the height, sex and volume.", "ARDSNet", "warn");
      if (v && v.pplV != null && v.pplV > 30) add("pplat", "Plateau " + fmt(v.pplV, 0) + " cmH₂O > 30: " + lowerHow + " in 1 mL/kg steps (down to 4 mL/kg PBW).", "ARDSNet", "warn");
      if (v && v.dp != null && v.dp > 15) add("dp", "Driving pressure " + fmt(v.dp, 0) + " cmH₂O is high" + (v.dpUnverified ? " (unverified: the plateau was taken while the patient was triggering; confirm with a hold in a passive patient)" : "") + ": " +
        (ab && ab.ph < 7.15 ? "once pH is ≥ 7.15, " + lowerHow + " (toward 4–6 mL/kg PBW)" : lowerHow) + " and reassess PEEP.", "Amato, NEJM 2015", "",
        "Driving pressure (plateau − PEEP) was the ventilation variable most strongly associated with survival in ARDS; about 15 cmH₂O is the commonly used upper limit. This is observational evidence, not a guideline target.");
      if (v && v.autoPeep != null && v.autoPeep >= 2) add("autopeep", "Auto-PEEP " + fmt(v.autoPeep, 0) + " cmH₂O (air trapping): lengthen expiration (lower RR or VT, raise inspiratory flow), treat bronchospasm; watch BP.", "", "warn",
        "Dynamic hyperinflation raises intrathoracic pressure, lowers venous return and makes triggering harder. If BP falls suddenly, briefly disconnect the circuit to let the lungs empty.");
      else if (v && v.te != null && v.tau != null && v.te < 3 * v.tau) add("autopeep", "Expiratory time " + fmt(v.te, 1) + " s is under 3 time constants (" + fmt(3 * v.tau, 1) + " s): check for air trapping (expiratory hold; expiratory flow should reach zero).", "", "warn",
        "Time constant τ = resistance × compliance; about 3τ is needed to exhale ~95% of the breath. Lower RR, shorter inspiration or treating the airway lengthens the time available.");
      var resist = v && (v.raw != null ? v.raw > 15 : v.gap != null && v.gap > 10);
      if (resist) add("raw", "High airway resistance (" + (v.raw != null ? (v.rawSrc === "ventilator" ? "Ri " : "Raw ") + fmt(v.raw, 0) + " cmH₂O/L/s" + (v.rawSrc === "ventilator" ? "" : ", ") : "") + (v.rawSrc === "ventilator" ? "" : "peak − plateau " + fmt(v.gap, 0)) + "): suction, check the tube for kinks or biting, bronchodilator if wheezy.", "", "warn",
        "High peak with a normal plateau points to the airway or tube rather than the lung. Resistance from peak − plateau ÷ flow is valid with constant (square-wave) flow in volume control.");
      if (v && v.leak != null && v.leak >= 10) add("leak", "VTE is " + fmt(v.leak, 0) + "% lower than VTi: look for a leak (cuff pressure, circuit, chest-tube air leak).", "", "warn");
      else if (v && v.vtDiff != null && v.vtDiff <= -15) add("leak", "VTE is " + fmt(-v.vtDiff, 0) + "% below the set TV: look for a leak (cuff pressure, circuit, chest-tube air leak) or recalibrate the flow sensor.", "", "warn");
      if (v && v.vtDiff != null && v.vtDiff >= 20) add("vtdiff", "VTE " + fmt(sp.vte, 0) + " mL is " + fmt(v.vtDiff, 0) + "% above the set TV " + fmt(sp.vt, 0) + " mL: look for double triggering (stacked breaths) on the screen and check the flow sensor; base the mL/kg on what the patient actually gets.", "", "warn");
      if (v && (v.fLow || v.badPeak || v.tiLong)) add("vcheck", "Recheck the ventilator entries: " + [v.fLow ? "Ftotal is below the set rate" : "", v.badPeak ? "plateau is above the peak" : "", v.tiLong ? "inspiratory time is longer than the breath cycle" : ""].filter(Boolean).join("; ") + ".", "", "warn");
      // Effort and drive
      if (v && (v.p01 != null || v.pmus != null)) {
        var hiEff = (v.p01 != null && v.p01 > 3.5) || (v.pmus != null && v.pmus > 10), hiLung = v.dpl != null && v.dpl > 15, loEff = (v.p01 != null && v.p01 < 1) || (v.pmus != null && v.pmus < 3);
        if (hiEff || hiLung) add("effort", "High " + (hiEff ? "drive/effort" : "lung stress") + " (" + [v.p01 != null ? "P0.1 " + fmt(v.p01, 1) : "", v.pmus != null ? "Pmus ≈ " + fmt(v.pmus, 0) : "", v.dpl != null ? "ΔPL,dyn ≈ " + fmt(v.dpl, 0) : ""].filter(Boolean).join(", ") +
          "): treat the cause (pain, anxiety, acidosis, hypoxemia, fever, asynchrony); if it persists, raise support" + (hasPS(vm) ? " or return to a controlled mode" : "") + ", and in ARDS keep the lung stress down (sedation if needed).", "Telias AJRCCM 2020; Bertoni Crit Care 2019; Goligher AJRCCM 2020", "warn",
          "P0.1 > 3.5 cmH₂O detected high effort (80% sensitive, 77% specific). From an end-expiratory occlusion: Pmus ≈ ¾ × |ΔPocc|; ΔPL,dyn ≈ (peak − PEEP) + ⅔ × |ΔPocc|. Ventilator-displayed P0.1 differs between brands; when lung and diaphragm protection conflict, protect the lung first.");
        else if (loEff) add("effort", "Low drive/effort (" + [v.p01 != null ? "P0.1 " + fmt(v.p01, 1) : "", v.pmus != null ? "Pmus ≈ " + fmt(v.pmus, 0) : ""].filter(Boolean).join(", ") + "): likely over-assisted or oversedated; " + (vm === "psv" ? "lower PS" : "lighten sedation and allow assisted breathing") + " to avoid diaphragm disuse, if gas exchange and lung stress allow.", "Telias AJRCCM 2020; Goligher AJRCCM 2020", "",
          "P0.1 ≤ 1.0 cmH₂O detected low effort (100% sensitive, 92% specific). Weak effort over days is linked to diaphragm atrophy.");
      }
      // Stress index from the photo (passive, constant-flow breaths)
      var siS = sp.scalars && sp.scalars.si;
      if (siS && siS.value != null && siS.flowOk !== false && siS.verdict !== "ok") add("si", siS.verdict === "over"
        ? "Stress index ≈ " + fmt(siS.value, 2) + " (upward concavity) suggests tidal overdistension: lower VT or PEEP and recheck plateau and driving pressure."
        : "Stress index ≈ " + fmt(siS.value, 2) + " (downward concavity) suggests tidal recruitment: a higher PEEP may help if driving pressure falls and BP holds.", "Ranieri, Anesthesiology 2000; Terragni, Anesthesiology 2013", "",
        "Valid only for passive breaths with constant (square-wave) flow in volume control; a stiff chest wall or abdomen can also raise it. A photo estimate: confirm on the ventilator.");
      // Global ARDS definition by SpO2/FiO2 when there is no PaO2
      if (v && v.sfRange && pf == null) add("ardsSF", "SpO₂/FiO₂ " + Math.round(v.sf) + " (SpO₂ " + fmt(v.spo2, 0) + "%) meets the ARDS oxygenation criterion" + (v.sfSev ? " (" + v.sfSev + " range)" : " (no severity grade without PEEP ≥ 5)") + ": if bilateral opacities are not explained by heart failure or fluid overload, treat as ARDS (VT 6 mL/kg PBW" + (v.pbw ? " = " + Math.round(6 * v.pbw) + " mL" : "") + ", plateau ≤ 30); confirm with an ABG.", "Global ARDS definition 2023", "warn");
      // Weaning and extubation
      var W = v && v.wean;
      var oxBySpo2 = W && W.items.some(function (it) { return it.k === "ox" && /from SpO₂ because/.test(it.label); });
      if (W && W.relevant && W.allMet && W.known >= 4) {
        add("wean", "Passes the numeric screen" + (oxBySpo2 ? " (oxygenation judged from SpO₂ only, because the pO₂ entry is invalid)" : "") + ": if the cause is improving, BP is stable on no or low-dose vasopressors, and the patient is awake with a good cough, consider a spontaneous breathing trial (30 min on PS ≤ 8 with PEEP ≤ 5, or T-piece; do not raise FiO₂ during it). Readiness is a clinical decision.", "ACCP/ATS 2017; AARC 2024; Subirà JAMA 2019", "ok",
          "Stop the trial for RR > 35, SpO₂ < 90%, HR > 140 or a 20% change, SBP > 180 or < 90, agitation, sweating or rising work of breathing. A 30-minute PS trial gave more successful extubations than a 2-hour T-piece trial (82% vs 74%).");
        add("extub", "If the trial is passed: extubate straight to NIV when at high risk (hypercapnia, COPD, heart failure, other serious comorbidity); otherwise HFNC is reasonable. Cuff-leak test if at high risk of stridor (steroids at least 4 h before extubation if the leak is small).", "ACCP/ATS 2017; ERS 2022", "",
          "ACCP/ATS: preventive NIV for high-risk patients ventilated > 24 h (strong recommendation). ERS 2022: NIV over HFNC when at high risk of extubation failure; HFNC over conventional oxygen when at low risk.");
      } else if (W && W.relevant && vm === "psv" && W.known >= 3 && !W.allMet)
        add("wean", "Numeric screen not met (readiness is still a clinical decision): " + W.items.filter(function (c) { return !c.ok; }).map(function (c) { return c.label + " (" + c.val + ")"; }).join("; ") + ".", "ACCP/ATS 2017", "");
      if (ardsRange && v && v.peepTab && !v.peepTab.below && num_(sp.peep) != null) {
        var tb = v.peepTab;
        if (pf <= 200 && sp.peep < tb.hi[0]) add("peep", "Moderate–severe ARDS range: higher PEEP is suggested (ARDSNet higher-PEEP table at FiO₂ " + tb.fio2 + "%: " + rangeTxt(tb.hi) + "; now " + fmt(sp.peep, 0) + "), without prolonged recruitment maneuvers; watch BP and driving pressure.", "ATS 2024", "",
          "ATS 2024: higher PEEP without lung recruitment maneuvers in moderate–severe ARDS (conditional). ESICM 2023 made no recommendation for or against higher PEEP; both recommend against prolonged recruitment maneuvers.");
        else if (pf > 200 && sp.peep < tb.lo[0]) add("peep", "PEEP " + fmt(sp.peep, 0) + " is below the ARDSNet lower-PEEP table for FiO₂ " + tb.fio2 + "% (" + rangeTxt(tb.lo) + "): consider raising PEEP rather than FiO₂.", "ARDSNet", "");
      }
      if (v && v.ie && v.ie.i > v.ie.e) add("ie", "Inverse I:E (" + v.ie.text + "): risk of auto-PEEP and low BP; usual is 1:1 to 1:3.", "", "warn");
      if (isVC(vm) && num_(sp.flow) != null && sp.flow < 40 && v && v.trig != null && v.trig >= 2) add("flow", "Peak flow " + fmt(sp.flow, 0) + " L/min is low for an actively breathing patient: flow starvation is possible; about 60 L/min is usual.", "", "");
      scalarIds(sp).forEach(function (id) {
        var f = SC[id], txt = f.action;
        if (id === "f_trap" && v && v.autoPeep != null) txt = "auto-PEEP measured " + fmt(Math.max(0, v.autoPeep), 0) + " cmH₂O; " + txt.replace(/^measure total PEEP with an expiratory hold; /, "");
        if (id === "f_double" && ardsRange) txt += " In ARDS the stacked breath defeats low-VT ventilation, so fix it rather than ignore it.";
        if (v && v.ftrig != null && (id === "f_ineff" || id === "p_dip")) txt += " F-Trig now " + fmt(v.ftrig, 1) + " L/min" + (v.ftrig > 2 ? ": try 1–2." : ".");
        if (v && v.ftrig != null && id === "p_auto") txt += " F-Trig now " + fmt(v.ftrig, 1) + " L/min" + (v.ftrig < 2 ? ": raise it a little." : ".");
        if (v && v.tslope != null && (id === "p_over" || id === "p_slow")) txt += " Tslope now " + fmt(v.tslope, 2) + " s.";
        if (v && v.ets != null && (id === "f_ineff" || id === "f_late" || id === "f_early")) txt += " Cycle-off now " + fmt(v.ets, 0) + "%" + ((id === "f_ineff" || id === "f_late") && v.ets < 40 ? ": try 40–60%." : id === "f_early" && v.ets > 30 ? ": try lower (10–25%)." : ".");
        add("sc_" + id, f.title + " on the scalars: " + txt, f.src, f.tone, f.means);
      });
      if (v && v.mp != null && v.mp > 17) add("mp", "Mechanical power " + fmt(v.mp, 0) + " J/min (> 17 is linked to higher mortality): reduce its parts (VT, driving pressure, RR) where the pH allows.", "Serpa Neto, ICM 2018", "",
        "Observational association, not a guideline target. Simplified formulas: volume control 0.098 × RR × VT × (peak − ½ × driving pressure); pressure control 0.098 × RR × VT × (ΔPinsp + PEEP).");
    } else if (mode === "niv") {
      if (hypercap && ab.ph < 7.35) add("nivOpt", "Still acidotic on NIV: raise IPAP (pressure support) toward 20–30 cmH₂O, fix leak and asynchrony, and recheck the ABG in 1–2 h" +
        (ab.ph < 7.25 ? "; pH < 7.25 despite optimal NIV → consider intubation" : "") + ".", "BTS/ICS 2016", ab.ph < 7.25 ? "crit" : "warn",
        "BTS/ICS: start IPAP around 15 and increase to 20–30 cmH₂O within 10–30 minutes (faster with severe acidosis, higher in larger patients). Common causes of NIV failure: mask leak, too little pressure support, asynchrony.");
      else if (!hypercap && ox && ox.grade !== "none" && !(c.rf && c.rf.type === 2))
        add("hfnc", "Hypoxemic failure on NIV: HFNC is suggested over NIV; whichever is used, don't delay intubation if failing.", "ERS 2022", "warn",
          "ERS 2022 conditional recommendations: HFNC over conventional O₂ and over NIV in acute hypoxemic respiratory failure. Prolonging noninvasive support in patients who are failing may delay intubation and worsen mortality.");
    } else {
      if (hypercap && ab.ph < 7.35) {
        add("niv", "Acidotic hypercapnia: in a COPD exacerbation, start NIV if pH < 7.35 and pCO₂ > 45 persist after optimal medical therapy" +
          (ab.ph <= 7.25 ? "; pH ≤ 7.25 is life-threatening, so involve ICU early" : "") + ".", "GOLD 2026; BTS/ICS 2016; NICE", ab.ph <= 7.25 ? "crit" : "warn",
          "GOLD lists respiratory acidosis (PaCO₂ ≥ 45 mmHg and pH ≤ 7.35) as an indication for NIV. BTS/ICS 2016 uses pH < 7.35 with pCO₂ > 6.5 kPa (≈ 49 mmHg) persisting after initial medical therapy; NICE asks for NIV when acidotic hypercapnia is not improving after 1 h of optimal medical therapy. Target SpO₂ 88–92% on NIV.");
      }
      if (p === "met-acid" && ex === "resp-acid") add("fatigue", "pCO₂ above the Winter's range = failing respiratory compensation: assess for fatigue, sedation or weakness and prepare ventilatory support.", "", "warn",
        "If the patient is intubated, set minute ventilation high enough to bring pCO₂ toward the expected value.");
      if (!hypercap && !co2Risk && pf != null && pf <= 300 && ox && ox.grade !== "none" && !(mode === "mask" && sp.dev === "hfnc"))
        add("hfnc", "Hypoxemic respiratory failure: HFNC is suggested over conventional oxygen (and over NIV).", pf < 200 ? "ERS 2022; SSC 2026" : "ERS 2022", "",
          "ERS 2022 conditional recommendations. SSC 2026 (sepsis): HFNC over conventional oxygen when P/F < 200 or SpO₂/FiO₂ < 235, and HFNC over NIV. Watch for failure; prolonged failing noninvasive support may delay intubation.");
    }
    if (hypercap && ab.ph < 7.35 && mode !== "mv") add("hypovent", "Look for the cause of hypoventilation: COPD/asthma, sedatives or opioids, neuromuscular weakness, obesity hypoventilation.", "", "");
    else if (hypercap && mode !== "mv") add("chronicCO2", "Compensated hypercapnia: compare with baseline pCO₂ and avoid excess O₂.", "", "");

    /* ---- Metabolic ---- */
    var hidAlk = !!(E && E.agHigh && (E.hiddenHAG || (E.dr != null && E.dr > 2)));
    if (E && E.ag != null && (metAcid || E.agHigh)) {
      if (E.agHigh && E.dka && E.dka.state === "met") add("cause", "High anion gap (" + fmt(E.agUse, 0) + ") fits the ketoacidosis" + (L != null && L > 2 ? "; lactate " + fmt(L, 1) + " adds to it (look for sepsis or hypoperfusion)" : "") + ". Check creatinine: it often rises with volume depletion.", "ADA/EASD 2024", "");
      else if (E.agHigh) {
        var lacPart = L != null && L > 2 ? (E.unexplained != null && E.unexplained <= 5 ? "lactic acidosis (lactate " + fmt(L, 1) + ") accounts for it: look for shock or sepsis, hypoxia, ischemia, seizures, metformin. "
          : "lactate " + fmt(L, 1) + " explains only part of it. ") : "";
        add("cause", "High anion gap (" + fmt(E.agUse, 0) + "): " + lacPart + "Check " + [L == null ? "lactate" : "", E.bhb == null ? "ketones (β-OHB)" : "", E.glu == null ? "glucose" : "", E.bun == null ? "creatinine/urea" : "creatinine"].filter(Boolean).join(", ") +
          ", and ask about methanol (including adulterated lambanog), ethylene glycol, salicylate and paracetamol.", "Kraut & Madias, CJASN 2007", "",
          "Causes (GOLDMARK): glycols, 5-oxoproline (chronic paracetamol), L- and D-lactate, methanol, aspirin, renal failure, ketoacidosis. Delta ratio " + (E.dr != null ? fmt(E.dr, 1) + " = " + E.drText : "needs a low HCO₃") + ". A measured osmolality (osmolal gap) helps when a toxic alcohol is possible.");
      } else add("cause", "Normal anion gap (hyperchloremic) acidosis: think diarrhea or GI/fistula losses, large-volume 0.9% saline, renal tubular acidosis, acetazolamide, ureteric diversion, or DKA recovery. A urine anion gap (Na + K − Cl) helps: negative suggests GI loss, positive suggests RTA.", "Kraut & Madias, CJASN 2007", "",
        "Check K: low K with diarrhea or proximal/distal RTA; high K with type 4 RTA (hypoaldosteronism)." + (E.alb == null ? " Low albumin lowers the anion gap; add albumin to correct it." : ""));
    }
    if (metAcid) {
      if (L != null && L > 2) add("cause", "Lactic acidosis likely (lactate " + fmt(L, 1) + "): look for shock or sepsis, hypoxia, ischemia, seizures, drugs (e.g. metformin); still check glucose/ketones and creatinine.", "", "",
        "Send Na and Cl (± albumin) when available to calculate the anion gap and look for a second process.");
      else if (L != null) add("cause", "Lactate normal: think ketoacidosis (check glucose and ketones), renal failure, toxins, or normal-gap causes (diarrhea, RTA, large-volume saline).", "", "",
        "Send Na and Cl (± albumin) when available to calculate the anion gap.");
      else add("cause", "Find the cause: check lactate, glucose/ketones and creatinine; ask about diarrhea and toxins (methanol, ethylene glycol, salicylate).", "", "",
        "Send Na and Cl (± albumin) when available to calculate the anion gap.");
      if (dka) add("bicarb", ab.ph < 7.0 ? "DKA with pH < 7.0: bicarbonate may be considered (100 mmol in 400 mL water over 2 h, repeat until pH > 7.0); it is not routine." : "Bicarbonate is not recommended in DKA at pH ≥ 7.0; fluids and insulin clear the ketoacids.", "ADA/EASD 2024", ab.ph < 7.0 ? "warn" : "",
        "The 2024 consensus: routine bicarbonate is not recommended; consider it only if pH < 7.0. Watch K, which falls further with bicarbonate.");
      if (ab.ph <= 7.2) add("bicarb", "Bicarbonate is not routine: consider it in septic shock with pH ≤ 7.2 and AKI stage 2–3; in DKA only if pH < 7.0.", "SSC 2026; ADA/EASD 2024", "warn",
        "SSC 2026 makes this a conditional suggestion on very low-certainty evidence; BICARICU-2 (JAMA 2025) found no mortality benefit in severe metabolic acidemia with AKI. SSC 2026 suggests against bicarbonate to improve hemodynamics in hypoperfusion-induced lactic acidemia." +
        (mode === "mv" ? " On the ventilator, bicarbonate generates CO₂: raise minute ventilation to clear it." : ""));
      else add("bicarb", "Bicarbonate is not indicated at this pH; treat the cause.", "SSC 2026", "",
        "SSC 2026 suggests against bicarbonate to improve hemodynamics or cut vasopressors in hypoperfusion-induced lactic acidemia.");
      if (c.def && !c.def.none && ab.ph <= 7.2 && !(dka && ab.ph >= 7.0)) add("def", "The HCO₃ deficit is a theoretical distribution-space estimate, not a dose: the decision to give bicarbonate rests on the cause and the evidence above; if given, give part and recheck the ABG.", "", "");
    }
    if (L != null && L > 2) add("lactate", "Lactate " + fmt(L, 1) + ": if sepsis is suspected, repeat lactate to guide resuscitation, with capillary refill time as an adjunct" +
      (L >= 4 ? "; for sepsis-induced hypoperfusion give ≥ 30 mL/kg IV crystalloid within 3 h" : "") + ".", "SSC 2026", L >= 4 ? "warn" : "",
      "SSC 2026 suggests measuring lactate, using serial lactate to guide resuscitation, and using capillary refill time as an adjunct. Aim for a falling lactate rather than normalization at any cost.");
    if (p === "met-acid" && ex === "resp-alk") add("drive", mode === "mv" ? "pCO₂ below the Winter's range on the ventilator: check the set rate and whether the patient is over-breathing (pain, agitation, fever, sepsis)."
      : "pCO₂ below the Winter's range: something else is driving breathing (sepsis, salicylate, liver disease, PE, pain or anxiety).", "", "");
    if (metAlk || hidAlk) add("alk", "Look for vomiting/NG losses, diuretics, volume depletion, hypokalemia; " + (E && E.k != null ? "K⁺ " + E.k.toFixed(1) + (E.k < 3.5 ? " is low: replace it, and check Mg." : "; check Mg.") : "check K⁺ and Mg.") + " Chloride-responsive alkalosis corrects with IV 0.9% saline + K⁺." +
      (mode === "mv" && respAcid ? " After chronic hypercapnia, avoid over-ventilating (post-hypercapnic alkalosis)." : ""), "MSD Manual", "");
    if ((p === "resp-alk" || p === "mixed-alk") && mode !== "mv") add("hypervent", "Find the driver of hyperventilation: hypoxemia, sepsis, PE, pain or anxiety, liver disease, salicylate, pregnancy.", "", "");

    /* ---- Electrolytes (optional) ---- */
    if (E) {
      if (E.gluStatus === "severe-low" || E.gluStatus === "low") add("glu", "Glucose " + fmt(E.glu, 0) + " mg/dL: treat now (15–20 g oral glucose if able, otherwise IV dextrose such as 50% dextrose 25–50 mL) and recheck in 15 min.", "ADA Standards of Care", "crit",
        "< 70 mg/dL is level 1 and < 54 mg/dL level 2 hypoglycemia. Find the cause (insulin or sulfonylurea, sepsis, liver failure, adrenal insufficiency, alcohol).");
      if (E.k == null && insulinCtx) add("k", "K " + (E.st && E.st.k === "invalid" ? "entry is not valid" : "not entered") + ": check serum potassium before any insulin. Hold insulin if K < 3.5 and replace K first.", "ADA/EASD 2024", "crit",
        "Insulin drives potassium into cells; starting it with an unknown or low K risks arrhythmia. The consensus delays insulin until K is above 3.5 mmol/L.");
      if (E.k != null) {
        if (E.k >= 6.0) add("k", "K " + E.k.toFixed(1) + (E.k >= 6.5 ? " (severe)" : " (moderate)") + ": 12-lead ECG and cardiac monitoring now; IV calcium if ECG changes (30 mL 10% calcium gluconate over 10 min, or 10 mL 10% calcium chloride); " +
          (dka ? "in DKA the insulin infusion will shift K into cells, so give no K and recheck in 2 h" : "insulin–glucose (10 units soluble insulin with 25 g glucose)" + (E.k >= 6.5 ? " plus nebulised salbutamol 10–20 mg" : "") + ", then remove K (stop K-raising drugs, treat the cause, dialysis if refractory)") + ".", "UKKA 2023", "crit",
          "Exclude a falsely high K (hemolysis, a fist-clench draw). Monitor glucose for 6 h after insulin–glucose. Acidemia shifts K out of cells, so K can fall quickly as the pH corrects.");
        else if (dka && E.k >= 3.5) add("k", "K " + E.k.toFixed(1) + " in DKA: start insulin; " + (E.k < 5.0 ? "add K to the fluids (about 20–30 mmol per litre) to keep K 4–5" : "no K for now, as insulin will lower it") + "; recheck K 2 h after starting insulin, then every 4 h.", "ADA/EASD 2024", "",
          "Acidosis and insulin deficiency shift K out of cells, so a normal or high K in DKA hides a total-body deficit.");
        else if (E.k >= 5.5) add("k", "K " + E.k.toFixed(1) + " (mild hyperkalemia): repeat to exclude hemolysis; review kidney function and K-raising drugs (ACE inhibitor/ARB, spironolactone, trimethoprim, heparin, K supplements).", "UKKA 2023", "warn");
        else if (insulinCtx && E.k < 3.5) add("k", "K " + E.k.toFixed(1) + (dka ? " in DKA" : " before insulin") + ": hold insulin; give K (about 10 mmol/h) until K is above 3.5, then start insulin.", "ADA/EASD 2024", "crit",
          "Insulin drives K into cells and can cause arrhythmia when K is already low. Keep K 4–5 mmol/L; about 20–30 mmol per litre of fluid is usually enough once K < 5.0.");
        else if (E.k < 3.5) add("k", "K " + E.k.toFixed(1) + (E.k < 2.5 ? " (severe)" : E.k < 3.0 ? " (moderate)" : " (mild)") + ": replace K (" + (E.k < 3.0 ? "IV with ECG monitoring" : "oral if able") + ") and check and replace Mg." + (metAlk ? " Hypokalemia keeps a metabolic alkalosis going." : ""), "", E.k < 3.0 ? "crit" : "warn",
          "Look for GI or urinary loss, diuretics, insulin or β-agonists. Low K with acidosis (diarrhea, RTA, DKA) means a large total-body deficit.");
      }
      if (dka) add("dka", "DKA (" + E.dka.sev + "): isotonic saline or balanced crystalloid 500–1000 mL/h for the first 2–4 h (smaller boluses if heart or kidney disease), fixed-rate IV insulin 0.1 U/kg/h once K is confirmed above 3.5, and " + (E.glu != null && E.glu < 250 ? "5–10% dextrose with the insulin from the start, as glucose is already below 250 mg/dL" : "add 5–10% dextrose when glucose < 250 mg/dL") + ". Find the trigger (infection, missed insulin, MI, SGLT2 inhibitor).", "ADA/EASD 2024", E.dka.sev === "severe" ? "crit" : "warn",
        "Resolved when ketones < 0.6 mmol/L plus venous pH ≥ 7.3 or HCO₃ ≥ 18 (do not use the anion gap or urine ketones). Reduce insulin to 0.05 U/kg/h when glucose < 250 mg/dL. The 2024 criteria are written for venous gases; an arterial pH runs about 0.03 higher.");
      else if (E.dka && E.dka.state === "possible" && E.dka.K == null) add("dka", (E.glu != null ? "Glucose " + fmt(E.glu, 0) : "Known diabetes") + " with acidosis: measure β-hydroxybutyrate (≥ 3.0 mmol/L) or urine ketones (≥ 2+) before calling it DKA.", "ADA/EASD 2024", "warn");
      else if (E.dka && E.dka.ketoNoD) add("dka", "Ketoacidosis with glucose < 200: if the patient has diabetes this is euglycemic DKA (tick Known diabetes; stop SGLT2 inhibitors; insulin with dextrose from the start). Without diabetes think of starvation or alcoholic ketoacidosis.", "ADA/EASD 2024", "warn");
      if (E.hhs && E.hhs.state === "possible" && !dka) add("hhs", "Possible HHS, not confirmed: " + (E.hhs.K == null ? "measure β-hydroxybutyrate (or urine ketones) to tell HHS from DKA. " : "") + "IV fluids first either way (isotonic saline 500–1000 mL/h for 2–4 h, less in heart or kidney disease), with glucose falling no faster than 90–120 mg/dL/h.", "ADA/EASD 2024", "crit");
      if (E.hhs && E.hhs.state === "met" && !dka) add("hhs", "HHS: IV fluids first (isotonic saline 500–1000 mL/h for 2–4 h, less in heart or kidney disease); let glucose fall no faster than 90–120 mg/dL/h and Na no more than 10 mmol/L in 24 h; insulin 0.05 U/kg/h if ketones are absent or mild.", "ADA/EASD 2024", "crit",
        "Some clinicians hold insulin until glucose stops falling with fluids alone, to avoid a rapid fall in osmolality (aim for 3–8 mOsm/kg/h). Use 0.45% saline only if osmolality is not falling despite fluids and insulin. High risk of thrombosis: give prophylaxis.");
      if (E.osmGap != null && E.osmGap > 10) add("osm", "Osmolal gap " + fmt(E.osmGap, 0) + (E.agHigh ? " with a high anion gap: treat as methanol (including adulterated lambanog) or ethylene glycol poisoning until proven otherwise; give fomepizole or ethanol, correct severe acidemia with bicarbonate, consider early hemodialysis, and call the poison centre (UP-PGH NPMCC)." : ": look for ethanol, isopropanol, mannitol, propylene glycol or early toxic-alcohol ingestion (before the anion gap rises)."), "", E.agHigh ? "crit" : "warn",
          "Normal is < 10 mOsm/kg (most people −10 to +10). Ethanol raises it by about its level in mg/dL ÷ 4 (published divisors 3.7–4.6); DKA, lactic acidosis and kidney failure raise it modestly. A normal gap does not exclude a late toxic alcohol, when the parent alcohol has already been metabolised. In methanol poisoning, bicarbonate is used for acidemia (unlike lactic acidosis) because a low pH drives formate into the eye and brain.");
      if (E.naStatus === "high" || E.naStatus === "severe-high" || (E.naKatz != null && E.naKatz > 145 && E.na >= 125)) add("na", "Na " + fmt(E.naKatz != null && E.naKatz > E.na ? E.naKatz : E.na, 0) + (E.naKatz != null && E.naKatz > E.na ? " (corrected for glucose)" : "") + " is high: water deficit. Give free water (enteral water or 5% dextrose) and find the cause (poor intake, osmotic diuresis, diabetes insipidus); lower it gradually if it is chronic.", "", E.naStatus === "severe-high" ? "crit" : "warn");
      if ((E.naStatus === "profound" || E.naStatus === "moderate") && !E.pseudoNa) {
        add("na", "Na " + fmt(E.na, 0) + ": confirm it is hypotonic (osmolality < 275), assess volume and urine Na/osmolality. Severe symptoms (vomiting, seizures, drowsiness): 150 mL 3% saline over 20 min, repeat while checking Na; limit the rise to 10 mmol/L in 24 h and 8 mmol/L each day after.", "ESE/ESICM/ERBP 2014", E.naStatus === "profound" ? "crit" : "warn",
          "Mild 130–135, moderate 125–129, profound < 125 mmol/L. The aim with hypertonic saline is a 5 mmol/L rise; overcorrection risks osmotic demyelination.");
      }
      if (E.pseudoNa && E.naStatus !== "normal") add("na", "Low Na is explained by hyperglycemia (corrected Na " + fmt(E.naKatz, 0) + "): no hypertonic saline; watch the corrected Na as glucose falls.", "Katz 1973; Hillier 1999", "");
      if (E.icaStatus === "low") add("ica", "Ionized Ca " + E.ica.toFixed(2) + " is low: check Mg; give IV calcium if symptomatic (tetany, seizures, arrhythmia), with hyperkalemia or during massive transfusion." + (ab && ab.ph > 7.45 ? " Alkalemia lowers it further." : ""), "", E.ica < 0.9 ? "crit" : "");
      else if (E.icaStatus === "high") add("ica", "Ionized Ca " + E.ica.toFixed(2) + " is high: hydrate with IV 0.9% saline if symptomatic and look for hyperparathyroidism, malignancy, vitamin D or thiazides.", "", E.ica > 1.6 ? "crit" : "");
    }

    /* ---- Oxygenation ---- */
    var dev = r ? (r.level === "nc" && (mode === "nc" || mode === "ra") ? " (≈ NC " + fmt(r.lpm, 1) + " L/min)"
      : r.level === "high" && (mode === "nc" || mode === "ra") ? (r.fio2Req <= VENTURI_MAX ? " (Venturi mask or HFNC)" : " (HFNC or non-rebreather)") : "") : "";
    var want = r && (r.level === "nc" || r.level === "high") ? " Estimated FiO₂ ≈ " + Math.round(r.fio2Req) + "%" + dev + " (assumes the a/A ratio stays the same; titrate to SpO₂)." : "";
    var tgtNote = c.tgt ? "Desired FiO₂ is calculated for pO₂ " + Math.round(c.tgt.value) + " (" + c.tgt.why + ")." : "";
    if (r && r.adequate) want = " pO₂ is already adequate, so no increase is needed.";
    if (ox) {
      var low = (!ox.onO2 && ox.grade !== "none") || ox.state === "uncorrected";
      var high = ox.state === "over";
      if (mode === "mv" && ardsRange && c.pao2 != null) {
        if (c.pao2 < 55) add("o2", "pO₂ below the ARDSNet goal (55–80): raise FiO₂ and/or PEEP using the PEEP/FiO₂ table." + want + " (The PEEP/FiO₂ table is for confirmed ARDS.)", "ARDSNet; ATS 2024", "warn", tgtNote);
        else if (c.pao2 <= 80) add("o2", "pO₂ " + fmt(c.pao2, 0) + " is within the ARDSNet goal (55–80): keep FiO₂/PEEP, wean FiO₂ when stable.", "ARDSNet", "", tgtNote);
        else add("o2", "pO₂ " + fmt(c.pao2, 0) + " is above the ARDSNet goal (55–80): wean FiO₂ first, then PEEP." + want + " The ARDSNet goal applies once ARDS is confirmed; otherwise use your unit's usual target.", "ARDSNet", "warn", tgtNote);
      } else if (mode === "mv") {
        var tgtMV = "the lowest FiO₂ that keeps SpO₂ in target";
        if (low) add("o2", "Raise FiO₂ and/or PEEP" + (ardsRange ? " (use the ARDSNet PEEP/FiO₂ table; higher PEEP if moderate–severe ARDS)" : "") + "." + want, ardsRange ? "ARDSNet; ATS 2024" : "", "warn");
        else if (high) add("o2", "Wean FiO₂ first, then PEEP, to " + tgtMV + "; avoid hyperoxia." + want, "UK-ROX 2025; SSC 2026", "warn",
          "UK-ROX (JAMA 2025, 16,500 ventilated adults): a conservative SpO₂ target of 90% did not lower 90-day mortality versus usual care. SSC 2026 suggests either a lower (about 90–93%) or a higher (≥ 96%) SpO₂ target in sepsis-related hypoxemic failure, so neither is mandated. Avoid unnecessary hyperoxia.");
        else if (ox.state === "corrected") add("o2", "Oxygenation adequate: keep FiO₂ at the lowest level that holds " + (ardsRange ? "pO₂ 55–80 / SpO₂ 88–95%" : "the SpO₂ target") + ".", ardsRange ? "ARDSNet" : "", "");
      } else if (mode === "niv") {
        var t2 = co2Risk ? "88–92% (all hypercapnic failure on NIV)" : spo2;
        if (low) add("o2", "Raise FiO₂ and/or EPAP to SpO₂ " + t2 + "." + want, co2Risk ? "BTS/ICS 2016" : "BTS 2017", "warn");
        else if (high) add("o2", "Wean FiO₂ to SpO₂ " + t2 + "; avoid hyperoxia." + want, co2Risk ? "BTS/ICS 2016" : "BTS 2017", "warn");
        else if (ox.state === "corrected") add("o2", "Keep FiO₂ titrated to SpO₂ " + t2 + ".", co2Risk ? "BTS/ICS 2016" : "BTS 2017", "");
      } else {
        if (low) add("o2", "Titrate O₂ to SpO₂ " + spo2 + "." + want, "BTS 2017", ox.grade === "severe" ? "crit" : "warn", tgtNote);
        else if (high) add("o2", "Wean O₂ to SpO₂ " + spo2 + "; avoid hyperoxia." + want, "BTS 2017", "warn", tgtNote);
        else if (ox.state === "corrected") add("o2", "Keep O₂ titrated to SpO₂ " + spo2 + "; stop once the target holds on room air.", "BTS 2017", "", tgtNote);
        if (mode === "mask" && (sp.dev === "mask" || sp.dev === "nrm") && (low || high)) S.o2.more = (S.o2.more ? S.o2.more + " " : "") + "FiO₂ on a simple or non-rebreather mask is only an estimate; a Venturi mask or HFNC gives a known FiO₂.";
      }
    }
    if (r && r.level === "over") add("shunt", mode === "mv" ? "FiO₂ 100% won't reach the target (shunt): optimise PEEP, consider prone positioning for severe ARDS, and escalate (ECMO in selected severe cases)."
      : "O₂ alone won't reach the target (shunt): needs positive pressure (CPAP/NIV or intubation with PEEP) and ICU review.", mode === "mv" ? "ATS 2024" : "", "crit");
    var type2 = c.rf && c.rf.type === 2;
    if (g && pf <= 300 && !(type2 && mode !== "mv")) {
      var ardsMore = "2023 global definition: P/F ≤ 300 (or SpO₂/FiO₂ ≤ 315 with SpO₂ ≤ 97%) on HFNO ≥ 30 L/min, NIV/CPAP ≥ 5 cmH₂O or invasive ventilation, with bilateral opacities (or ultrasound B-lines/consolidation) within 1 week of a known risk, not fully explained by heart failure or fluid overload. Severity is graded only when intubated: mild 200–300, moderate 100–200, severe ≤ 100. Oxygenation alone does not make the diagnosis.";
      if (ardsRange && g.sevOk) add("ards", "P/F " + Math.round(pf) + g.ctx + " meets the ARDS oxygenation criterion (" + ardsSev + " range). This grades oxygenation only: ARDS also needs bilateral opacities not explained by heart failure or fluid overload, within 1 week of a known risk.", "Global ARDS definition 2023", "warn", ardsMore);
      else if (ardsRange && g.intub) add("ards", "P/F " + Math.round(pf) + " on invasive ventilation is ≤ 300, but no severity grade is given " + (g.pe == null ? "without a PEEP entry" : "at PEEP " + fmt(g.pe, 0)) + " (graded at PEEP ≥ 5). ARDS also needs bilateral opacities not explained by heart failure or fluid overload.", "Global ARDS definition 2023", "warn", ardsMore);
      else if (ardsRange) add("ards", "P/F " + Math.round(pf) + g.ctx + " meets the non-intubated ARDS oxygenation criterion (no severity grade off the ventilator). ARDS also needs bilateral opacities not explained by heart failure or fluid overload.", "Global ARDS definition 2023", "warn", ardsMore);
      else add("ards", "P/F ≤ 300: if bilateral opacities not explained by heart failure or fluid overload, consider ARDS.", "Global ARDS definition 2023", "",
        "The P/F criterion formally applies on HFNO ≥ 30 L/min, NIV/CPAP ≥ 5 cmH₂O or invasive ventilation; in resource-limited settings no PEEP or flow minimum is required.");
      if (mode === "mv" && pf <= 200) add("ardsRx", "If ARDS: " + (S.vt ? "" : "VT 6 mL/kg PBW" + (v && v.pbw ? " (" + Math.round(6 * v.pbw) + " mL)" : "") + ", ") + "plateau ≤ 30" + (S.peep || (v && v.peepTab && !v.peepTab.below && num_(sp.peep) != null && sp.peep >= v.peepTab.hi[0]) ? "" : ", higher PEEP") + (pf < 150 ? ", early prone positioning (> 12–16 h/day)" : "") + ".", pf < 150 ? "ATS 2024; ESICM 2023" : "ATS 2024; ARDSNet", "",
        "ATS 2024 also suggests corticosteroids, neuromuscular blockade in early severe ARDS, and VV-ECMO in selected severe cases; ATS and ESICM recommend against prolonged recruitment maneuvers. Prone positioning for moderate–severe ARDS is a strong recommendation in both (ATS > 12 h/day, ESICM > 16 h/day).");
      else if (mode !== "mv" && pf <= 200 && c.fio2Pct >= 40) add("ardsRx", "If ARDS and intubated: lung-protective ventilation (4–8 mL/kg PBW, plateau < 30); prone > 12 h/day if severe.", "ATS 2024", "");
    }
    return PRIORITY.filter(function (k) { return S[k]; }).map(function (k) { return S[k]; });
  }

  /* ---------- Bedside message (user's template) ---------- */
  var DOWN = "⬇️", UP = "⬆️";
  var RANGE = { ph: [7.35, 7.45], co2: [35, 45], hco3: [22, 26], tco2: [23, 27], be: [-2, 3], so2: [95, 100], lactate: [0, 2] };  // i-STAT arterial
  function arrow(v, lo, hi) {
    if (v == null || !isFinite(v)) return "";
    if (lo != null && v < lo) return " " + DOWN;
    if (hi != null && v > hi) return " " + UP;
    return "";
  }
  function n1(v) { return fmt(v, 1); }

  // P/F and A–a without needing age (the O2-requirement calc needs age; these don't)
  function indices(pao2, paco2, fio2Pct) {
    if ([pao2, paco2, fio2Pct].some(function (v) { return v == null || !isFinite(v); })) return null;
    if (vOK("fio2Pct", fio2Pct) == null || vOK("pao2", pao2) == null || vOK("paco2", paco2) == null) return null;   // out-of-range entries are reported, not used
    if (pao2AboveAlv(pao2, paco2, fio2Pct) != null) return null;
    var PAO2 = P_DRY * fio2Pct / 100 - paco2 / RQ;
    return { pf: pao2 / (fio2Pct / 100), PAO2: PAO2, AaGrad: PAO2 - pao2 };
  }

  // HCO3 deficit (mEq) = factor × weight (kg) × (desired − actual); desired 24, factor 0.5 by default
  function bicarbDeficit(weight, hco3, factor, desired) {
    factor = factor || 0.5; desired = desired || 24;
    if (weight == null || hco3 == null || !isFinite(weight) || !isFinite(hco3) || weight <= 0 || weight > 400) return null;
    if (hco3 >= desired) return { none: true, weight: weight, hco3: hco3, factor: factor, desired: desired };
    return { value: factor * weight * (desired - hco3), weight: weight, hco3: hco3, factor: factor, desired: desired };
  }

  // Interpretation in the "Severe metabolic acidosis with concomitant respiratory alkalosis" style
  function interpretation(ab, E) {
    if (!ab || ab.errors.length) return "";
    var p = ab.primary, c = ab.check, s;
    var agOk = E && E.ag != null;
    if (p === "normal" && agOk && E.agHigh) return "High anion gap metabolic acidosis with coexisting metabolic alkalosis (pH, pCO₂ and HCO₃ all normal)";
    if (p === "met-acid" || p === "met-alk") {
      s = NAME[p] + (c && c.extra ? " with concomitant " + NAME[c.extra] : " with appropriate respiratory compensation");
    } else if (p === "resp-acid" || p === "resp-alk") {
      s = c && c.extra ? NAME[p] + " with concomitant " + NAME[c.extra]
        : (c && c.timing === "between" ? "acute-on-chronic " : c && c.timing ? c.timing + " " : "") + NAME[p];
    } else if (p === "mixed-acid") s = "mixed respiratory and metabolic acidosis";
    else if (p === "mixed-alk") s = "mixed respiratory and metabolic alkalosis";
    else if (p === "ambig-ra-ma") s = "respiratory acidosis or metabolic alkalosis, fully compensated (pH 7.40: decide from the history)";
    else if (p === "ambig-ma-rb") s = "metabolic acidosis or respiratory alkalosis, fully compensated (pH 7.40: decide from the history)";
    else if (p === "normal") return "Normal acid–base status";
    else return "Values do not fit together; recheck the ABG";
    if (p === "met-acid" && c && c.extra === "resp-acid" && ab.paco2 <= 45) s = s.replace("with concomitant respiratory acidosis", "with inadequate respiratory compensation (relative respiratory acidosis)");
    if (agOk) {
      var tag = (E.agHigh ? "high" : "normal") + " anion gap metabolic acidosis";
      if (/metabolic acidosis/.test(s)) { if (E.agHigh || E.metA) s = s.replace("metabolic acidosis", tag); }
      else if (E.agHigh) s += " + " + tag;
      if (E.agHigh && E.dr != null && E.dr < 0.8) s += " + normal anion gap metabolic acidosis";
      if (E.agHigh && E.dr != null && E.dr > 2 && !/metabolic alkalosis/.test(s)) s += " + metabolic alkalosis";
    }
    return ab.severe ? "Severe " + s : cap(s);
  }

  // Compensation section, line by line, in the template's format
  function compensationLines(ab) {
    if (!ab || ab.errors.length) return [];
    var c = ab.check, L = ["Compensation"];
    if (c && (c.primary === "met-acid" || c.primary === "met-alk")) {
      var acid = c.primary === "met-acid", k = acid ? "1.5" : "0.7", b = acid ? "8" : "20", pm = c.pm;
      L.push(acid ? "Winter’s Formula:" : "Metabolic Alkalosis Formula:");
      L.push("Expected pCO₂ = (" + k + " × HCO₃) + " + b + " ± " + pm);
      L.push("= (" + k + " × " + n1(c.hco3) + ") + " + b + " ± " + pm);
      L.push("= " + n1(c.center) + " ± " + pm + " mmHg (" + n1(c.lo) + "–" + n1(c.hi) + " mmHg)");
      L.push("");
      L.push("Actual pCO₂: " + n1(c.paco2) + " mmHg, " + (c.extra === "resp-acid" ? "higher than expected" : c.extra === "resp-alk" ? "lower than expected" : "within expected range"));
      if (ab.mixedNormal) L.push("Normal pH with pCO₂ outside the expected range: mixed disorder (two primary processes), not full compensation");
    } else if (c && (c.primary === "resp-acid" || c.primary === "resp-alk")) {
      var ra = c.primary === "resp-acid", p = n1(c.paco2);
      L.push(ra ? "Respiratory Acidosis:" : "Respiratory Alkalosis:");
      var rows = ra
        ? [["Acute", "0.1", c.acute], ["Chronic", "0.35", c.chronic]]
        : [["Acute", "0.2", c.acute], ["Chronic", "0.4", c.chronic]];
      rows.forEach(function (rw) {
        L.push(rw[0] + ": Expected HCO₃ = 24 " + (ra ? "+ " + rw[1] + " × (pCO₂ − 40)" : "− " + rw[1] + " × (40 − pCO₂)") + " ± 2");
        L.push("= 24 " + (ra ? "+ " + rw[1] + " × (" + p + " − 40)" : "− " + rw[1] + " × (40 − " + p + ")") + " ± 2");
        L.push("= " + n1(rw[2]) + " ± 2 mmol/L (" + n1(rw[2] - 2) + "–" + n1(rw[2] + 2) + " mmol/L)");
      });
      L.push("");
      var v = c.extra === "met-acid" ? "lower than expected" : c.extra === "met-alk" ? "higher than expected"
        : c.timing === "acute" ? "fits acute compensation" : c.timing === "chronic" ? "fits chronic compensation" : "between acute and chronic";
      L.push("Actual HCO₃: " + n1(c.hco3) + " mmol/L, " + v);
      if (ab.mixedNormal) L.push("Normal pH with HCO₃ outside the expected range: mixed disorder (two primary processes), not full compensation");
    } else if (ab.primary === "normal") {
      L.push("Not applicable: pH, pCO₂ and HCO₃ are within normal limits");
    } else if (ab.primary === "mixed-acid") {
      L.push("Not applicable: high pCO₂ and low HCO₃ both lower the pH (two primary disorders)");
    } else if (ab.primary === "mixed-alk") {
      L.push("Not applicable: low pCO₂ and high HCO₃ both raise the pH (two primary disorders)");
    } else {
      L.push("Not assessed: the primary disorder is unclear");
    }
    return L;
  }

  function desiredText(r, sp, tgt, pao2) {
    var mode = sp ? sp.mode : "nc";
    if (r.level === "over") return ">100% (not reachable with O2 alone)";
    if (r.adequate) {
      var curF = fmt(r.fio2Pct, 0) + "%";
      return mode === "ra" ? "21% (room air; pO₂ " + fmt(pao2, 0) + " adequate)"
        : curF + " (keep" + (mode === "nc" && sp.ncFlow != null ? " NC " + fmt(sp.ncFlow, 1) + " L/min" : "") + "; pO₂ " + fmt(pao2, 0) + (r.inWindow ? " within " + r.inWindow : " adequate") + ")";
    }
    var forT = tgt && tgt.kind !== "age" ? " for pO₂ " + fmt(tgt.value, 0) : "";
    var v = r.level === "ra" ? "21%" : Math.round(r.fio2Req) + "%";
    if (mode === "ra" || mode === "nc") return r.level === "ra" ? "21% (room air)" : v + forT + (r.level === "nc" ? " (NC " + fmt(r.lpm, 1) + " L/min)" : " (beyond nasal cannula)");
    if (mode === "niv") return v + forT + " (on NIV)";
    if (mode === "mv") return v + forT + " (on ventilator)";
    return v + forT + (sp && sp.dev ? " (" + (DEVICES[sp.dev] || "mask") + ")" : "");
  }

  // v16.4: the desired-FiO2 working and the O2 requirement, written out for the copied message (same steps as the app card)
  function o2Requirement(r, sp, pao2) {
    var mode = sp ? sp.mode : "nc", onDevice = mode === "mv" || mode === "niv", req = fmt(r.fio2Req, 0) + "%";
    var where = mode === "mv" ? " on the ventilator" : mode === "niv" ? " on NIV" : "";
    if (r.adequate) return "no increase: pO₂ " + fmt(pao2, 0) + " is already adequate" + (r.inWindow ? " (within " + r.inWindow + ")" : " (≥ " + fmt(r.adequateLimit, 0) + ")") + "; keep the current oxygen" + (mode === "ra" ? " (room air)" : " and wean toward the SpO₂ target");
    if (r.level === "over") return "more than 100%: oxygen alone cannot reach the target (shunt physiology); PEEP or CPAP matters more than FiO₂" + (onDevice ? "" : ", so escalate support (HFNC, NIV or intubation as appropriate)");
    if (r.level === "ra") return "none: room air (21%) reaches the target" + (mode === "ra" ? "" : "; wean the oxygen toward room air");
    if (onDevice) return "set FiO₂ ≈ " + req + where;
    if (r.level === "nc") return "nasal cannula ≈ " + fmt(r.lpm, 1) + " L/min, from L/min = (FiO₂ − 20) ÷ 4 = (" + fmt(r.fio2Req, 1) + " − 20) ÷ 4 (NC gives about 20 + 4 × L/min, up to 6 L/min = 44%)" +
      (r.lpm < 1 ? "; below 1 L/min, so trial room air with SpO₂ monitoring, or use the lowest flow the flowmeter allows" : "");
    return req + " is more than a nasal cannula gives (44% at 6 L/min): " + (r.fio2Req <= VENTURI_MAX ? "Venturi mask at about " + req + " or HFNC" : "HFNC or a non-rebreather mask");
  }
  function desiredLines(m, isMV) {
    var r = m.r && !m.r.errors.length ? m.r : null, L = [];
    if (r) {
      L.push("Desired FiO2: " + (isMV ? desiredMV(r, m.pao2) : desiredText(r, m.support, m.tgt, m.pao2)) + (r.level === "ra" || r.adequate ? "" : " · estimate; titrate to SpO₂"));
      var T = m.tgt, tTxt = T ? (T.kind === "age" && m.age != null ? "104 − 0.4 × age " + fmt(m.age, 0) : T.why) : "";
      L.push("Computation (target pO₂ " + fmt(r.target, 0) + (tTxt ? ", " + tTxt : "") + "):");
      L.push("PAO₂ = 713 × FiO₂ − pCO₂ ÷ 0.8 = 713 × " + fmt(r.fio2Pct / 100, 2) + " − " + n1(m.paco2) + " ÷ 0.8 = " + fmt(r.PAO2, 1) + " mmHg");
      L.push("a/A = pO₂ ÷ PAO₂ = " + n1(m.pao2) + " ÷ " + fmt(r.PAO2, 1) + " = " + fmt(r.aA, 3));
      L.push("FiO₂ needed = (target ÷ a/A + pCO₂ ÷ 0.8) ÷ 713 = (" + fmt(r.target, 0) + " ÷ " + fmt(r.aA, 3) + " + " + fmt(r.paco2Term, 1) + ") ÷ 713 = " + fmt(r.fio2Req, 1) + "%");
      L.push("O₂ requirement: " + o2Requirement(r, m.support, m.pao2));
    } else if (m.pao2 != null && m.paco2 != null && m.fio2Pct != null && pao2AboveAlv(m.pao2, m.paco2, m.fio2Pct) != null)
      L.push("Desired FiO2 and O₂ requirement: not calculated, because pO₂ " + fmt(m.pao2, 0) + " is above what FiO₂ " + fmt(m.fio2Pct, 0) + "% can give (alveolar ≈ " + fmt(pao2AboveAlv(m.pao2, m.paco2, m.fio2Pct), 0) + "). The patient is probably on more oxygen than entered, or the sample has air: set the actual oxygen support.");
    else if (m.pao2 != null && m.paco2 != null && vOK("pao2", m.pao2) != null) {
      var need = [];
      if (m.fio2Pct == null) need.push("the current oxygen (room air, nasal cannula flow or FiO₂)");
      if (!m.tgt) need.push("age (target pO₂ = 104 − 0.4 × age) or a custom target");
      if (need.length) L.push("Desired FiO2 and O₂ requirement: need " + need.join(" and ") + ".");
    }
    return L;
  }

  /* m: { ph, paco2, pao2, hco3, tco2, be, so2, ab, ox, r, fio2Pct, def, support, vent } — any may be null */
  function message(m) {
    var blocks = [], v = [];
    var ab = m.ab && !m.ab.errors.length ? m.ab : null;
    var hco3 = m.hco3 != null ? m.hco3 : ab ? ab.hco3 : null;
    var pLo = m.ox ? m.ox.mildLimit : 80;
    if (m.ph != null) v.push("pH " + fmt(m.ph, 2) + arrow(m.ph, RANGE.ph[0], RANGE.ph[1]));
    if (m.paco2 != null) v.push("pCO₂ " + n1(m.paco2) + " mmHg" + arrow(m.paco2, RANGE.co2[0], RANGE.co2[1]));
    if (m.pao2 != null) v.push("pO₂ " + n1(m.pao2) + " mmHg" + (vStat("pao2", m.pao2) === "invalid" ? " (invalid: outside 10–700; not used)" : arrow(m.pao2, pLo, null)));
    if (hco3 != null) v.push("HCO₃ " + n1(hco3) + " mmol/L" + arrow(hco3, RANGE.hco3[0], RANGE.hco3[1]) + (m.hco3 == null ? " (calc)" : ""));
    if (m.tco2 != null) v.push("TCO₂ " + n1(m.tco2) + " mmol/L" + arrow(m.tco2, RANGE.tco2[0], RANGE.tco2[1]));
    if (m.be != null) v.push("BE " + (m.be > 0 ? "+" : "") + n1(m.be) + " mmol/L" + arrow(m.be, RANGE.be[0], RANGE.be[1]));
    if (m.so2 != null) v.push("SO₂ " + n1(m.so2) + "%" + arrow(m.so2, RANGE.so2[0], null));
    if (m.lactate != null) v.push("Lactate " + n1(m.lactate) + " mmol/L" + arrow(m.lactate, null, 2));
    if (v.length) blocks.push(v);
    var elV = elLines(m.el);
    if (elV.length) blocks.push(elV);
    var issues = collectIssues({ abRaw: m.abRaw || m.abPaused || m.ab, el: m.el, ox: m.ox, pao2: m.pao2, paco2: m.paco2, fio2Pct: m.fio2Pct, support: m.support, vent: m.vent, extra: m.extraIssues });
    if (issues.length) blocks.push(["⚠️ Input checks (resolve before acting):"].concat(issues.map(function (x) { return "• " + x.text; })));

    var isMV = !!(m.support && m.support.mode === "mv");
    if (!isMV && m.support && m.fio2Pct != null) blocks.push(["Support: " + supportLine(m.support, m.fio2Pct)]);
    var ix = indices(m.pao2, m.paco2, m.fio2Pct), o = [];
    if (ix) { o.push("P/F Ratio: " + Math.round(ix.pf)); o.push("A-aDO₂: " + Math.round(ix.AaGrad) + " mmHg"); }
    if (o.length) blocks.push(o);

    var d = [], r = m.r && !m.r.errors.length ? m.r : null;
    desiredLines(m, isMV).forEach(function (x) { d.push(x); });
    if (m.def && !m.def.none) d.push("HCO3 deficit: " + Math.round(m.def.value) + " mEq (theoretical estimate, not a dose)");
    if (d.length) blocks.push(d);

    if (isMV) ventBlocks(m.support, m.vent, m.fio2Pct, ab, { unverified: !!m.aiPending }).forEach(function (b) { blocks.push(b); });
    if (ab) {
      var cl = compensationLines(ab);
      // the template keeps "Actual …" as its own paragraph
      var gap = cl.indexOf("");
      if (gap > -1) { blocks.push(cl.slice(0, gap)); blocks.push(cl.slice(gap + 1)); } else blocks.push(cl);
    }
    var elC = elCalcLines(m.el);
    if (elC.length) blocks.push(elC);
    var g = gasExchange({ pao2: m.pao2, paco2: m.paco2, fio2Pct: m.fio2Pct, age: m.age, ox: m.ox, support: m.support });
    var rf = respFailure(ab, m.pao2, m.paco2);
    var fi = fullInterpretation({ ab: ab, ox: m.ox, g: g, rf: rf, el: m.el });
    if (m.abPaused) fi.unshift("Acid–base reading paused: entered HCO₃ " + n1(m.abPaused.hco3) + " does not fit pH and pCO₂ (calculated " + n1(m.abPaused.hco3Calc) + "). Verify that all three values come from the same blood gas.");
    if (fi.length) blocks.push(["ABG Interpretation:"].concat(fi));
    if (ab || m.ox) {
      var sg = suggestions({ ab: ab, ox: m.ox, r: r, g: g, rf: rf, lactate: m.lactate, def: m.def, retainer: m.retainer, mismatch: m.mismatch, paco2: m.paco2, pao2: m.pao2, fio2Pct: m.fio2Pct, support: m.support, vent: m.vent, tgt: m.tgt, el: m.el });
      if (m.aiPending) sg = sg.filter(function (x) { return !isVentKey(x.key); });
      var elN = m.el ? 2 : 0;
      var lines = capSugg(sg, m.maxSugg || (isMV ? 10 : 7) + elN).map(function (x) { return "• " + x.text + (x.src ? " [" + x.src + "]" : ""); });
      if (!lines.length) lines = ["• " + nothingLine(!!(m.abRaw && m.abRaw.errors && m.abRaw.errors.length), oxOutOfRange(m.pao2, m.fio2Pct, m.paco2))];
      blocks.push(["Suggestions:"].concat(lines));
    }
    return blocks.map(function (b) { return b.join("\n"); }).join("\n\n");
  }

  // One-line chart interpretation, e.g. "Partially compensated respiratory acidosis (fits chronic) with mild hypoxemia"
  function chartLine(ab, ox) {
    var s = "";
    if (ab && !ab.errors.length) {
      s = ab.label;
      if (ab.check && ab.check.extra) s += " + concurrent " + NAME[ab.check.extra];
      else if (ab.check && ab.check.timing === "between") s += " (acute-on-chronic or still compensating)";
      else if (ab.timing) s += " (fits " + ab.timing + ")";
    }
    if (ox) s = s ? s + " with " + ox.label : cap(ox.label);
    return s;
  }

  return {
    oxOutOfRange: oxOutOfRange, nothingLine: nothingLine, pao2AboveAlv: pao2AboveAlv, vStat: vStat, vOK: vOK, LIM: LIM, capSugg: capSugg, dpBasis: dpBasis,
    VMODES: VMODES, isVC: isVC, isPC: isPC, isSIMV: isSIMV, hasPS: hasPS, analyzeFlow: analyzeFlow, analyzePaw: analyzePaw, analyzeVolume: analyzeVolume, mergeReads: mergeReads, crossCheck: crossCheck, normalizeVent: normalizeVent, stressIndex: stressIndex, weanScreen: weanScreen, movAvg: movAvg, SCALARS: SCALARS, scalarsFor: scalarsFor, scalarIds: scalarIds, scalarBlock: scalarBlock, ventMessage: ventMessage, isVentKey: isVentKey, parseIE: parseIE, peepTable: peepTable, oiGrade: oiGrade, ventInterp: ventInterp, ventBlocks: ventBlocks, desiredMV: desiredMV,
    effectiveTarget: effectiveTarget, applyAdequacy: applyAdequacy, supportFio2: supportFio2, supportLine: supportLine, modeName: modeName, pbw: pbw, targetPco2: targetPco2, ventCalc: ventCalc, ventLines: ventLines, desiredText: desiredText, endExpPressure: endExpPressure, DEVICES: DEVICES,
    gasExchange: gasExchange, respFailure: respFailure, fullInterpretation: fullInterpretation, suggestions: suggestions,
    chartLine: chartLine, interpretation: interpretation, compensationLines: compensationLines, message: message, electrolytes: electrolytes, elLines: elLines, collectIssues: collectIssues, elCalcLines: elCalcLines, elInterp: elInterp, AGREF: AGREF, ERANGE: ERANGE,
    bicarbDeficit: bicarbDeficit, indices: indices, arrow: arrow, RANGE: RANGE,
    calc: calc, acidBase: acidBase, oxygenation: oxygenation, compensation: compensation, hco3FromPh: hco3FromPh,
    parseFio2: parseFio2, describeFio2: describeFio2, fmt: fmt,
    ncToFio2: ncToFio2, fio2ToNc: fio2ToNc, ageTarget: ageTarget, expectedAa: expectedAa,
    P_DRY: P_DRY, RQ: RQ, NC_MAX_PCT: NC_MAX_PCT, NC_MAX_LPM: NC_MAX_LPM, VENTURI_MAX: VENTURI_MAX, RA: RA, NORM: NORM
  };
})();
if (typeof module !== "undefined") module.exports = ABG;
