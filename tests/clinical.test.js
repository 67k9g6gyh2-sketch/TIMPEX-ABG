// Clinical regression tests for TIMPEX Gas & Vent (node --test). Numbers are checked against the formulas the app states;
// passing them shows the code does what it says, not that it is clinically safe at the bedside.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { ABG, pipeline, hh } = require("./helpers.js");

const MV = (extra) => Object.assign({ mode: "mv", vmode: "acvc", fio2Pct: 40, peep: 5, vt: 420, rr: 16, height: 170, sex: "m" }, extra || {});

test("1. normal ABG", () => {
  const x = pipeline({ ph: 7.40, paco2: 40, hco3: 24, pao2: 95 });
  assert.equal(x.ab.primary, "normal");
  assert.equal(ABG.interpretation(x.ab), "Normal acid–base status");
  assert.match(x.msg, /Normal acid–base status, with normal oxygenation/);
  assert.ok(!x.keys.includes("bicarb"));
});

test("2. uncompensated metabolic acidosis: pCO2 normal but above Winter's range", () => {
  const x = pipeline({ ph: 7.25, paco2: 40, hco3: hh(7.25, 40), pao2: 95 });
  assert.equal(x.ab.label, "Uncompensated metabolic acidosis");
  assert.equal(x.ab.check.extra, "resp-acid");
  // pCO2 40 is not high, so this is inadequate compensation, not hypercapnia
  assert.match(ABG.interpretation(x.ab), /inadequate respiratory compensation \(relative respiratory acidosis\)/);
});

test("3. metabolic acidosis with appropriate Winter's compensation", () => {
  const h = hh(7.30, 30);                       // 14.4 → Winter's 29.6 ± 2
  const x = pipeline({ ph: 7.30, paco2: 30, hco3: h, pao2: 95 });
  assert.equal(x.ab.primary, "met-acid");
  assert.equal(x.ab.check.extra, undefined);
  assert.equal(ABG.interpretation(x.ab), "Metabolic acidosis with appropriate respiratory compensation");
  const c = x.ab.check; assert.ok(Math.abs(c.center - (1.5 * h + 8)) < 1e-9);
});

test("4. metabolic acidosis with concurrent respiratory alkalosis", () => {
  const x = pipeline({ ph: 7.32, paco2: 22, hco3: hh(7.32, 22), pao2: 100 });
  assert.equal(x.ab.check.extra, "resp-alk");
  assert.match(ABG.interpretation(x.ab), /metabolic acidosis with concomitant respiratory alkalosis/i);
});

test("5a. normal pH, pCO2 20, HCO3 12: mixed metabolic acidosis + respiratory alkalosis (Case A)", () => {
  const x = pipeline({ ph: 7.40, paco2: 20, hco3: 12, pao2: 100 });
  assert.equal(x.ab.mixedNormal, true);
  assert.doesNotMatch(x.ab.label, /fully compensated/i);
  assert.match(x.ab.label, /Mixed metabolic acidosis and respiratory alkalosis/);
  assert.match(ABG.interpretation(x.ab), /metabolic acidosis with concomitant respiratory alkalosis/i);
  assert.match(x.msg, /mixed disorder/);
});

test("5b. normal pH, pCO2 60, HCO3 36: mixed respiratory acidosis + metabolic alkalosis (Case B)", () => {
  const x = pipeline({ ph: 7.40, paco2: 60, hco3: 36, pao2: 70 });
  assert.equal(x.ab.mixedNormal, true);
  assert.doesNotMatch(x.ab.label, /fully compensated/i);
  assert.match(ABG.interpretation(x.ab), /respiratory acidosis with concomitant metabolic alkalosis/i);
  // both rules were tested: chronic HCO3 31 ± 2 is exceeded, and the metabolic-alkalosis pCO2 range (40–50) is exceeded
  assert.equal(x.ab.altCheck.extra, "resp-acid");
});

test("5c. normal pH that fits chronic respiratory alkalosis stays a single disorder with a caution", () => {
  const x = pipeline({ ph: 7.40, paco2: 32, hco3: hh(7.40, 32), pao2: 100 });
  assert.equal(x.ab.primary, "resp-alk");
  assert.ok(!x.ab.mixedNormal);
  assert.match(x.ab.mixedNote, /mixed disorder can look the same/);
});

test("5d. pH 7.38 with pCO2 below Winter's: mixed, not 'fully compensated'", () => {
  const x = pipeline({ ph: 7.38, paco2: 20, hco3: hh(7.38, 20), pao2: 100 });
  assert.equal(x.ab.mixedNormal, true);
  assert.doesNotMatch(x.msg, /Traditional: fully compensated/);
});

test("6. Henderson–Hasselbalch mismatch pauses the acid–base reading", () => {
  const x = pipeline({ ph: 7.40, paco2: 40, hco3: 10, pao2: 95, wt: 60 });
  assert.equal(x.ab, null);
  assert.equal(x.abRaw.mismatch, true);
  assert.match(x.abRaw.errors[0], /paused/);
  assert.match(x.abRaw.errors[0], /same blood gas/);
  assert.match(x.msg, /Acid–base reading paused/);
  assert.doesNotMatch(x.msg, /Compensation|metabolic acidosis|HCO3 deficit|Winter/);
  assert.ok(x.keys.includes("check"));
  assert.ok(!x.keys.includes("bicarb") && !x.keys.includes("cause"));
  // a value from the same gas (rounding only) is accepted
  assert.equal(pipeline({ ph: 7.40, paco2: 40, hco3: 24.4, pao2: 95 }).abRaw.errors.length, 0);
  // small absolute but large relative gap at a low HCO3 is caught
  assert.equal(pipeline({ ph: 7.00, paco2: 20, hco3: 3.2, pao2: 95 }).abRaw.mismatch, true);
});

test("7. no PBW, mL/kg or PBW-based advice without an explicit sex", () => {
  assert.equal(ABG.pbw(170, null), null);
  assert.equal(ABG.pbw(170, undefined), null);
  assert.equal(ABG.pbw(170, ""), null);
  const x = pipeline({ ph: 7.40, paco2: 40, hco3: 24, pao2: 95, sp: MV({ sex: null, vt: 700 }) });
  assert.equal(x.vent.pbw, null);
  assert.equal(x.vent.vtkg, undefined);
  assert.equal(x.vent.pbwNeedSex, true);
  assert.ok(!x.keys.includes("vt"), "no mL/kg advice without sex");
  assert.ok(ABG.ventInterp(x.vent, MV({ sex: null }), x.ab).some((l) => l.key === "pbw" && /Select Male or Female/.test(l.text)));
  assert.match(x.msg, /PBW: not calculated \(sex not selected\)/);
});

test("8. ARDSNet PBW for men and women", () => {
  assert.ok(Math.abs(ABG.pbw(170, "m") - (50 + 0.91 * (170 - 152.4))) < 1e-9);
  assert.ok(Math.abs(ABG.pbw(170, "f") - (45.5 + 0.91 * (170 - 152.4))) < 1e-9);
  assert.ok(Math.abs(ABG.pbw(152.4, "m") - 50) < 1e-9);
  assert.ok(Math.abs(ABG.pbw(152.4, "f") - 45.5) < 1e-9);
  const x = pipeline({ ph: 7.40, paco2: 40, hco3: 24, pao2: 95, sp: MV({ sex: "f", vt: 420 }) });
  assert.ok(Math.abs(x.vent.vtkg - 420 / (45.5 + 0.91 * 17.6)) < 1e-9);
});

test("9. adequate pO2 on high FiO2 is not called normal: impairment is reported separately", () => {
  const ox = ABG.oxygenation({ pao2: 105, fio2Pct: 100, age: 50 });
  assert.equal(ox.state, "over");
  assert.equal(Math.round(ox.pf), 105);
  assert.equal(ox.impair, "moderately");                        // P/F 101–200
  assert.doesNotMatch(ox.label, /^normal|^overcorrected hypoxemia$/);
  assert.match(ox.label, /impaired oxygenation \(P\/F 105\)/);
  const sev = ABG.oxygenation({ pao2: 90, fio2Pct: 100, age: 50 });
  assert.equal(sev.impair, "severely"); assert.equal(sev.tone, "crit");
  const ok = ABG.oxygenation({ pao2: 90, fio2Pct: 28, age: 50 });   // P/F 321: no impairment
  assert.equal(ok.impair, null); assert.equal(ok.label, "corrected hypoxemia");
  const ra = ABG.oxygenation({ pao2: 95, fio2Pct: 21, age: 50 });
  assert.equal(ra.label, "normal oxygenation");
});

test("10. ARDS oxygenation criterion: PEEP and support requirements", () => {
  const base = { ph: 7.40, paco2: 40, hco3: 24, pao2: 60 };      // FiO2 40% → P/F 150
  const peep8 = pipeline(Object.assign({}, base, { sp: MV({ peep: 8 }) }));
  assert.match(peep8.text("ards"), /meets the ARDS oxygenation criterion \(moderate range\)/);
  assert.match(peep8.text("ards"), /bilateral opacities/);
  const peep3 = pipeline(Object.assign({}, base, { sp: MV({ peep: 3 }) }));
  assert.match(peep3.text("ards"), /no severity grade/);
  assert.doesNotMatch(peep3.text("ards"), /moderate range/);
  const niv = pipeline(Object.assign({}, base, { sp: { mode: "niv", nivType: "cpap", epap: 6, fio2Pct: 40 } }));
  assert.match(niv.text("ards"), /non-intubated ARDS oxygenation criterion \(no severity grade/);
  const hf20 = pipeline(Object.assign({}, base, { sp: { mode: "mask", dev: "hfnc", hfFlow: 20, fio2Pct: 40 } }));
  assert.match(hf20.text("ards"), /consider ARDS/);
  assert.doesNotMatch(hf20.text("ards"), /meets/);
  // SpO2/FiO2: needs SpO2 ≤ 97%, and a grade needs PEEP ≥ 5
  const v3 = ABG.ventCalc(MV({ peep: 3, spo2: 92, fio2Pct: 60 }), null, null, null, 60, false);
  assert.equal(v3.sfRange, true); assert.equal(v3.sfSev, undefined);
  const v8 = ABG.ventCalc(MV({ peep: 8, spo2: 92, fio2Pct: 60 }), null, null, null, 60, false);
  assert.equal(v8.sfSev, "moderate");                           // 153: 148 < S/F ≤ 235
  const v98 = ABG.ventCalc(MV({ peep: 8, spo2: 98, fio2Pct: 60 }), null, null, null, 60, false);
  assert.ok(!v98.sfRange);
});

test("11. driving pressure and compliance only from a plateau; ventilator Cstat kept with its source", () => {
  const withPlat = ABG.ventCalc(MV({ pplat: 25, peep: 5, vt: 400 }), null, null, null, 40, false);
  assert.equal(withPlat.dp, 20); assert.equal(withPlat.cstat, 20); assert.equal(withPlat.cstatSrc, "plateau");
  const pc = ABG.ventCalc(MV({ vmode: "acpc", pinsp: 15, ppeak: 22, peep: 5, vte: 450 }), null, null, null, 40, false);
  assert.equal(pc.dp, undefined, "Pinsp is not a driving pressure");
  assert.equal(pc.cstat, undefined, "no Cstat without a plateau");
  assert.equal(pc.dPinsp, 15);
  assert.ok(pc.cdyn > 0, "dynamic compliance from peak is still shown");
  const blocks = ABG.ventBlocks(MV({ vmode: "acpc", pinsp: 15, ppeak: 22 }), pc, 40, null).map((b) => b.join("\n")).join("\n");
  assert.match(blocks, /Driving pressure: needs plateau pressure/);
  const prvc = ABG.ventCalc(MV({ vmode: "prvc", ppeak: 28, peep: 5 }), null, null, null, 40, false);
  assert.equal(prvc.dp, undefined, "peak − PEEP is not a driving pressure");
  const vent = ABG.ventCalc(MV({ vmode: "acpc", pinsp: 15, peep: 5, vte: 450, cstatm: 32 }), null, null, null, 40, false);
  assert.equal(vent.cstat, 32); assert.equal(vent.cstatSrc, "ventilator");
  const both = ABG.ventCalc(MV({ pplat: 25, peep: 5, vt: 400, cstatm: 30 }), null, null, null, 40, false);
  assert.equal(both.cstat, 20); assert.equal(both.cstatM, 30);
});

test("12. unattainable pH goal is stated, not hidden behind a pCO2 target", () => {
  // pH 7.20, pCO2 26, HCO3 10, ARDS-range oxygenation on the ventilator
  const x = pipeline({ ph: 7.20, paco2: 26, hco3: 10, pao2: 90, sp: MV({ fio2Pct: 60, peep: 10, rr: 20 }) });
  const T = x.vent.target;
  assert.equal(T.value, 25);
  assert.equal(T.reach, false);
  const expected = 9 - Math.log10(24 * 25 / 10);               // 7.22
  assert.ok(Math.abs(T.phAt - expected) < 1e-9);
  assert.ok(T.phAt < 7.30);
  assert.match(x.text("rr"), /cannot reach the ARDSNet goal of pH 7\.30/);
  assert.match(x.text("rr"), /≈ 7\.22/);
  // where the goal is reachable, projected pH is shown and ≥ the goal
  const y = pipeline({ ph: 7.22, paco2: 60, hco3: hh(7.22, 60), pao2: 90, sp: MV({ fio2Pct: 60, peep: 10, rr: 16 }) });
  assert.equal(y.vent.target.reach, true);
  assert.ok(y.vent.target.phAt >= 7.295);
  assert.match(y.text("rr"), /projected pH ≈ 7\.30/);
});

test("13. severe acidemia: rate advice carries lung-protective, expiration and metabolic caveats", () => {
  const h = hh(7.10, 40);                                       // ≈ 12
  const x = pipeline({ ph: 7.10, paco2: 40, hco3: h, pao2: 150, sp: MV({ fio2Pct: 40, rr: 14, ti: 1.0 }) });
  assert.ok(x.keys.includes("sev"));
  const rr = x.text("rr");
  assert.match(rr, /Raise the set RR/);
  assert.match(rr, /only if plateau stays ≤ 30/);
  assert.match(rr, /no plateau entered/);
  assert.match(rr, /expiratory time would fall to/);
  assert.match(rr, /metabolic cause/);
  assert.match(rr, /projected pH/);
  // air trapping still blocks a rate increase
  const trap = pipeline({ ph: 7.10, paco2: 40, hco3: h, pao2: 150, sp: MV({ fio2Pct: 40, rr: 14, peeptot: 10, peep: 5 }) });
  assert.match(trap.text("rr"), /Air trapping.*do not raise the rate/);
});

test("13b. no rate change that would push a normal pH out of range", () => {
  // pH 7.41, pCO2 51, HCO3 31.5: metabolic alkalosis + respiratory acidosis; the compensation pCO2 (42) would give pH ≈ 7.49
  const x = pipeline({ ph: 7.41, paco2: 51, hco3: hh(7.41, 51), pao2: 120, sp: MV({ fio2Pct: 30, rr: 24, ftot: 36 }) });
  assert.doesNotMatch(x.text("rr"), /Raise the set RR/);
  assert.match(x.text("rr"), /pH 7\.41 is normal: no rate change/);
});

const DKA_GAS = { ph: 7.10, paco2: 20, hco3: hh(7.10, 20), pao2: 100 };

test("14. DKA with serum β-hydroxybutyrate", () => {
  const x = pipeline(Object.assign({}, DKA_GAS, { el: { na: 130, k: 5.0, cl: 96, glu: 520, gluUnit: "mgdl", bhb: 6.2 } }));
  assert.equal(x.E.dka.state, "met");
  assert.equal(x.E.dka.sev, "severe");                          // HCO3 < 10
  assert.match(x.msg, /DKA biochemical criteria met \(ADA\/EASD 2024\): severe/);
  assert.ok(x.keys.includes("dka"));
});

test("15. DKA with urine ketones (2+ or more), and below the threshold", () => {
  const x = pipeline(Object.assign({}, DKA_GAS, { el: { glu: 520, gluUnit: "mgdl", uket: 3 } }));
  assert.equal(x.E.dka.state, "met");
  assert.match(x.msg, /urine ketones 3\+/);
  const low = pipeline(Object.assign({}, DKA_GAS, { el: { glu: 520, gluUnit: "mgdl", uket: 1 } }));
  assert.equal(low.E.dka.state, "notmet");
  assert.match(low.msg, /DKA criteria not met: ketones below the threshold/);
  // β-OHB is used before urine ketones when both are entered
  const both = pipeline(Object.assign({}, DKA_GAS, { el: { glu: 520, gluUnit: "mgdl", uket: 3, bhb: 1.0 } }));
  assert.equal(both.E.dka.state, "notmet");
  // ketones not measured → possible, not met
  const none = pipeline(Object.assign({}, DKA_GAS, { el: { glu: 520, gluUnit: "mgdl" } }));
  assert.equal(none.E.dka.state, "possible");
  assert.match(none.msg, /DKA possible, not confirmed: needs ketones/);
  assert.doesNotMatch(none.msg, /DKA biochemical criteria met/);
});

test("16. euglycemic DKA needs known diabetes; without it, other ketoacidoses are raised", () => {
  const gas = { ph: 7.15, paco2: 22, hco3: hh(7.15, 22), pao2: 100 };
  const eu = pipeline(Object.assign({}, gas, { el: { glu: 160, gluUnit: "mgdl", bhb: 5, dm: true, k: 4.2 } }));
  assert.equal(eu.E.dka.state, "met"); assert.equal(eu.E.dka.euglycemic, true);
  assert.match(eu.msg, /euglycemic/);
  assert.match(eu.text("dka"), /dextrose with the insulin from the start/);
  const noDm = pipeline(Object.assign({}, gas, { el: { glu: 160, gluUnit: "mgdl", bhb: 5 } }));
  assert.equal(noDm.E.dka.state, "notmet"); assert.equal(noDm.E.dka.ketoNoD, true);
  assert.match(noDm.msg, /euglycemic DKA if the patient has diabetes/);
  assert.match(noDm.msg, /starvation or alcoholic ketoacidosis/);
});

const HHS_GAS = { ph: 7.36, paco2: 38, hco3: hh(7.36, 38), pao2: 85 };

test("17. HHS with complete biochemical criteria", () => {
  const x = pipeline(Object.assign({}, HHS_GAS, { age: 75, el: { na: 148, k: 4.4, cl: 110, glu: 980, gluUnit: "mgdl", bhb: 0.8, bun: 60, bunUnit: "mgdl" } }));
  assert.equal(x.E.hhs.state, "met");
  assert.ok(x.E.effOsm > 300);
  assert.match(x.msg, /HHS biochemical criteria met \(ADA\/EASD 2024\)/);
  assert.ok(x.keys.includes("hhs"));
});

test("18. HHS with ketones not measured is only 'possible'", () => {
  const x = pipeline(Object.assign({}, HHS_GAS, { age: 75, el: { na: 148, glu: 980, gluUnit: "mgdl" } }));
  assert.equal(x.E.hhs.state, "possible");
  assert.match(x.msg, /HHS possible, not confirmed/);
  assert.doesNotMatch(x.msg, /HHS biochemical criteria met/);
  assert.match(x.text("hhs"), /measure β-hydroxybutyrate/);
  // significant ketones → not HHS
  const k = pipeline(Object.assign({}, HHS_GAS, { age: 75, el: { na: 148, glu: 980, gluUnit: "mgdl", bhb: 4 } }));
  assert.equal(k.E.hhs.state, "notmet");
  // DKA with HHS-range glucose and osmolality → overlap, not two diagnoses
  const ov = pipeline(Object.assign({}, DKA_GAS, { el: { na: 140, glu: 900, gluUnit: "mgdl", bhb: 6 } }));
  assert.equal(ov.E.dka.state, "met"); assert.equal(ov.E.overlap, true);
  assert.match(ov.msg, /overlapping DKA–HHS/);
  assert.doesNotMatch(ov.msg, /HHS biochemical criteria met/);
});

test("19. RSBI is information, never an SBT gate", () => {
  const sp = MV({ vmode: "psv", psupp: 5, peep: 5, fio2Pct: 35, vte: 250, ftot: 30, height: 170, sex: "m" });   // RSBI 120
  const x = pipeline({ ph: 7.40, paco2: 40, hco3: 24, pao2: 90, sp });
  assert.equal(Math.round(x.vent.rsbi), 120);
  assert.ok(!x.vent.wean.items.some((c) => c.k === "rsbi"), "RSBI is not a screen item");
  assert.equal(x.vent.wean.rsbi.val, "120");
  assert.doesNotMatch(x.text("psv"), /not ready/i);
  assert.match(x.text("psv"), /clinical decision/);
  assert.match(x.text("psv"), /AARC 2024/);
  if (x.keys.includes("wean")) assert.doesNotMatch(x.text("wean"), /RSBI/);
});

test("20. adult OI and OSI get no pediatric (PALICC-2) severity grades", () => {
  const v = ABG.ventCalc(MV({ mawp: 20, spo2: 90, fio2Pct: 80 }), null, null, 60, 80, false);
  assert.ok(v.oi > 16 && v.osi > 12);
  assert.doesNotMatch(v.oiG.label, /mild|moderate|severe/);
  const lines = ABG.ventInterp(v, MV({ mawp: 20, spo2: 90 }), null).filter((l) => l.key === "oi" || l.key === "osi").map((l) => l.text).join(" ");
  assert.doesNotMatch(lines, /mild|moderate|severe range|PALICC\)/);
  assert.match(lines, /pediatric/);
  const blocks = ABG.ventBlocks(MV({ mawp: 20, spo2: 90 }), v, 80, null).map((b) => b.join("\n")).join("\n");
  assert.doesNotMatch(blocks, /Normal Value|moderate oxygenation|severe oxygenation/);
});

test("21. desired FiO2 and HCO3 deficit are reported as estimates, not prescriptions", () => {
  const x = pipeline({ ph: 7.10, paco2: 30, hco3: hh(7.10, 30), pao2: 55, sp: { mode: "nc", ncFlow: 2 }, wt: 60 });
  assert.match(x.msg, /Desired FiO2: .*estimate; titrate to SpO₂/);
  assert.match(x.msg, /HCO3 deficit: \d+ mEq \(theoretical estimate, not a dose\)/);
  assert.match(x.text("o2"), /Estimated FiO₂ ≈ \d+%.*assumes the a\/A ratio stays the same; titrate to SpO₂/);
  assert.match(x.text("def"), /not a dose/);
  assert.doesNotMatch(x.msg, /give \d+ mEq/i);
});

test("25. electrolytes: anion gap, albumin correction (Figge) and delta ratio", () => {
  const gas = { ph: 7.10, paco2: 20, hco3: hh(7.10, 20), pao2: 100 };
  const x = pipeline(Object.assign({}, gas, { el: { na: 140, cl: 100, alb: 2.0, albUnit: "gdl" } }));
  assert.ok(Math.abs(x.E.ag - (140 - 100 - gas.hco3)) < 1e-9);
  assert.ok(Math.abs(x.E.agCorr - (x.E.ag + 2.5 * (4.0 - 2.0))) < 1e-9);
  assert.ok(Math.abs(x.E.dr - ((x.E.agCorr - 12) / (24 - gas.hco3))) < 1e-9);
  assert.match(ABG.interpretation(x.ab, x.E), /high anion gap metabolic acidosis/);
  // albumin in g/L is converted (unit picked explicitly since v16.1)
  const gl = pipeline(Object.assign({}, gas, { el: { na: 140, cl: 100, alb: 20, albUnit: "gl" } }));
  assert.equal(gl.E.alb, 2.0);
});

test("26. potassium: insulin is held below 3.5 when DKA is being treated", () => {
  const x = pipeline(Object.assign({}, DKA_GAS, { el: { glu: 520, gluUnit: "mgdl", bhb: 6, k: 3.1 } }));
  assert.match(x.text("k"), /hold insulin/);
  const ok = pipeline(Object.assign({}, DKA_GAS, { el: { glu: 520, gluUnit: "mgdl", bhb: 6, k: 4.5 } }));
  assert.doesNotMatch(ok.text("k"), /hold insulin/);
  const hi = pipeline({ ph: 7.30, paco2: 35, hco3: hh(7.30, 35), pao2: 95, el: { k: 6.7 } });
  assert.match(hi.text("k"), /12-lead ECG/);
});

test("27. seeded mini-fuzz (3,000 gases): no NaN/undefined/null and no contradictions", () => {
  let seed = 4242; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = (a) => a[Math.floor(rnd() * a.length)], maybe = (p, v) => (rnd() < p ? v : null);
  let n = 0;
  for (let i = 0; i < 3000; i++) {
    const ph = +(6.9 + rnd() * 0.8).toFixed(2), paco2 = Math.round(15 + rnd() * 80), pao2 = Math.round(40 + rnd() * 250);
    const hc = hh(ph, paco2); if (hc < 3 || hc > 55) continue;
    const mode = pick(["ra", "nc", "mask", "niv", "mv"]);
    const sp = mode === "mv" ? MV({ vmode: pick(["acvc", "acpc", "prvc", "psv", "simv", "psimv"]), sex: pick(["m", "f", null]), pplat: maybe(0.5, 26), pinsp: 14, psupp: maybe(0.5, 8), ti: maybe(0.5, 1), spo2: maybe(0.4, 93), mawp: maybe(0.4, 14), fio2Pct: pick([30, 50, 100]) })
      : mode === "nc" ? { mode, ncFlow: pick([1, 3, 5]) } : mode === "mask" ? { mode, dev: pick(["venturi", "hfnc"]), hfFlow: 40, fio2Pct: 50 } : mode === "niv" ? { mode, nivType: "bipap", ipap: 14, epap: 6, fio2Pct: 40 } : { mode };
    const el = rnd() < 0.5 ? { na: maybe(0.8, 125 + Math.round(rnd() * 30)), k: maybe(0.8, +(2.5 + rnd() * 5).toFixed(1)), cl: maybe(0.8, 90 + Math.round(rnd() * 25)), glu: maybe(0.6, pick([90, 300, 700])), gluUnit: "mgdl",
      bhb: maybe(0.4, pick([0.5, 4])), uket: maybe(0.3, pick([0, 1, 2, 4])), dm: rnd() < 0.3, alb: maybe(0.3, 2.5), albUnit: "gdl", bun: maybe(0.3, 30), bunUnit: "mgdl", osm: maybe(0.2, 320) } : null;
    const hco3 = rnd() < 0.9 ? hc : Math.round(5 + rnd() * 35);
    const x = pipeline({ ph, paco2, pao2, hco3, sp, el, lactate: maybe(0.4, 3), wt: maybe(0.5, 60) });
    assert.doesNotMatch(x.msg, /NaN|undefined|\bnull\b|Infinity/, `${ph}/${paco2}/${hco3} ${mode}`);
    const m = x.msg;
    if (x.abRaw && x.abRaw.mismatch) assert.doesNotMatch(m, /Compensation\n|Winter|HCO3 deficit|Bicarbonate|anion gap metabolic/);
    assert.ok(!(/DKA biochemical criteria met/.test(m) && /HHS biochemical criteria met/.test(m)), "DKA and HHS both 'met'");
    if (/HHS biochemical criteria met|DKA biochemical criteria met/.test(m)) assert.ok(x.E && (x.E.bhb != null || x.E.uket != null), "met without a ketone result");
    if (/Traditional: fully compensated/.test(m)) assert.ok(!(x.ab.check && x.ab.check.extra), "fully compensated with a second disorder");
    if (/Driving pressure: \d/.test(m)) assert.ok(sp.pplat, "driving pressure without a plateau");
    if (x.ox && x.ox.onO2) assert.doesNotMatch(m, /normal oxygenation/);
    if (sp.mode === "mv" && !sp.sex) assert.doesNotMatch(m, /\(\d+\.\d mL\/kg PBW\)|VT \d+\.\d mL\/kg PBW|PBW \d+(\.\d)? kg/);
    assert.doesNotMatch(m, /not ready/i);
    n++;
  }
  assert.ok(n > 2000);
});
