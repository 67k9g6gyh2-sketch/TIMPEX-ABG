// v16.1 post-release safety tests. They check the copied message (generated output), not only internal values.
// Passing them shows the code follows the stated rules; it does not establish bedside clinical safety.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { ABG, pipeline, hh } = require("./helpers.js");

const MV = (extra) => Object.assign({ mode: "mv", vmode: "acvc", fio2Pct: 40, peep: 5, vt: 400, rr: 14, height: 170, sex: "m" }, extra || {});
const N = { ph: 7.40, paco2: 40, hco3: 24, pao2: 95 };
const checks = (msg) => (msg.split("⚠️ Input checks (resolve before acting):\n")[1] || "").split("\n\n")[0];

/* ---------- Finding A: glucose units ---------- */
test("A1. glucose 7 without a unit is not interpreted, and the message says why with both readings", () => {
  const x = pipeline(Object.assign({}, N, { el: { glu: 7 } }));
  assert.equal(x.E.glu, undefined);
  assert.match(x.msg, /Glucose 7: unit not confirmed \(not interpreted\)/);
  assert.match(checks(x.msg), /As mg\/dL it would be 7 mg\/dL \(level 2 hypoglycemia\); as mmol\/L it would be 126 mg\/dL/);
  assert.doesNotMatch(x.msg, /Glucose 126/);
  assert.ok(!x.keys.includes("glu"), "no treatment advice from an unconfirmed unit");
});
test("A2. glucose 7 mg/dL is kept, flagged as extreme, and the hypoglycemia advice stays", () => {
  const x = pipeline(Object.assign({}, N, { el: { glu: 7, gluUnit: "mgdl" } }));
  assert.equal(x.E.glu, 7); assert.equal(x.E.st.glu, "extreme"); assert.equal(x.E.gluStatus, "severe-low");
  assert.match(x.msg, /Glucose 7 mg\/dL ⬇️ \(extreme: confirm with the lab\)/);
  assert.match(checks(x.msg), /extremely low: confirm with the laboratory now/);
  assert.match(x.msg, /Clinically significant hypoglycemia \(glucose 7 mg\/dL\)/);
  assert.match(x.text("glu"), /treat now/);
});
test("A3. glucose classes at 35, 53, 70 mg/dL and 7, 20, 35 mmol/L", () => {
  const E = (g, u) => ABG.electrolytes({ glu: g, gluUnit: u }, null, null);
  assert.equal(E(35, "mgdl").gluStatus, "severe-low");          // level 2: < 54
  assert.equal(E(53, "mgdl").gluStatus, "severe-low");
  assert.equal(E(54, "mgdl").gluStatus, "low");                 // level 1: 54–69
  assert.equal(E(70, "mgdl").gluStatus, "normal");
  assert.equal(E(7, "mmol").glu, 126); assert.equal(E(7, "mmol").gluStatus, "normal");
  assert.equal(E(20, "mmol").glu, 360); assert.equal(E(20, "mmol").gluStatus, "high");
  assert.equal(E(35, "mmol").glu, 630); assert.equal(E(35, "mmol").gluStatus, "very-high");
  const m = pipeline(Object.assign({}, N, { el: { glu: 35, gluUnit: "mmol" } })).msg;
  assert.match(m, /Glucose 35 mmol\/L \(630 mg\/dL\)/);
});
test("A4. missing or invalid unit, and changing the unit after entry", () => {
  for (const u of [undefined, null, "", "mg", "MGDL", "x"]) assert.equal(ABG.electrolytes({ glu: 30, gluUnit: u }, null, null).st.glu, "unit");
  const a = ABG.electrolytes({ glu: 30, gluUnit: "mgdl" }, null, null), b = ABG.electrolytes({ glu: 30, gluUnit: "mmol" }, null, null);
  assert.equal(a.gluStatus, "severe-low"); assert.equal(b.glu, 540); assert.equal(b.gluStatus, "high");
});
test("A5. implausible glucose is reported, not silently dropped", () => {
  const x = pipeline(Object.assign({}, N, { el: { glu: 9000, gluUnit: "mgdl" } }));
  assert.equal(x.E.st.glu, "invalid");
  assert.match(x.msg, /Glucose 9000: invalid entry \(not interpreted\)/);
  assert.match(checks(x.msg), /not a plausible result/);
});

/* ---------- Finding B: ionized calcium units ---------- */
test("B1. iCa needs a unit; 1.6 mmol/L and 1.6 mg/dL are opposite emergencies", () => {
  const none = pipeline(Object.assign({}, N, { el: { ica: 1.6 } }));
  assert.equal(none.E.ica, undefined); assert.ok(!none.keys.includes("ica"));
  assert.match(checks(none.msg), /Ionized Ca 1\.6: unit not confirmed.*0\.40 mmol\/L/);
  const mm = ABG.electrolytes({ ica: 1.6, icaUnit: "mmol" }, null, null);
  assert.equal(mm.ica, 1.6); assert.equal(mm.icaStatus, "high");
  const mg = ABG.electrolytes({ ica: 1.6, icaUnit: "mgdl" }, null, null);
  assert.ok(Math.abs(mg.ica - 1.6 / 4.008) < 1e-9); assert.equal(mg.icaStatus, "low"); assert.equal(mg.st.ica, "extreme");
  assert.match(mg.notes.join(" "), /1\.6 mg\/dL = 0\.40 mmol\/L/);
  assert.equal(ABG.electrolytes({ ica: 4.8, icaUnit: "mgdl" }, null, null).icaStatus, "normal");   // 1.20 mmol/L
  assert.equal(ABG.electrolytes({ ica: 1.2, icaUnit: "mmol" }, null, null).icaStatus, "normal");
});
test("B2. iCa range boundaries", () => {
  const st = (v) => ABG.electrolytes({ ica: v, icaUnit: "mmol" }, null, null).st.ica;
  assert.equal(st(0.09), "invalid"); assert.equal(st(0.1), "extreme"); assert.equal(st(0.59), "extreme"); assert.equal(st(0.6), "ok");
  assert.equal(st(2.0), "ok"); assert.equal(st(2.01), "extreme"); assert.equal(st(5), "extreme"); assert.equal(st(5.01), "invalid");
});

/* ---------- Finding C: albumin units ---------- */
const AG_GAS = { ph: 7.20, paco2: 32, hco3: hh(7.20, 32), pao2: 95 };
test("C1. albumin 5 g/L = 0.5 g/dL: corrected AG ≈ 21.6, high gap; with g/dL it would be 10.3", () => {
  const gl = pipeline(Object.assign({}, AG_GAS, { el: { na: 135, cl: 110, alb: 5, albUnit: "gl" } }));
  assert.equal(gl.E.alb, 0.5);
  assert.ok(Math.abs(gl.E.ag - 12.8) < 0.05);
  assert.ok(Math.abs(gl.E.agCorr - 21.55) < 0.05);
  assert.equal(gl.E.agHigh, true);
  assert.match(gl.msg, /high anion gap metabolic acidosis/i);
  assert.match(gl.msg, /albumin-corrected 22 ⬆️/);
  assert.match(checks(gl.msg), /Albumin 0\.5 g\/dL is extremely low/);
  const none = pipeline(Object.assign({}, AG_GAS, { el: { na: 135, cl: 110, alb: 5 } }));
  assert.equal(none.E.agCorr, null);                             // not corrected with an unconfirmed unit
  assert.match(checks(none.msg), /Albumin 5: unit not confirmed/);
});
test("C2. albumin conversions and implausible values", () => {
  const A = (v, u) => ABG.electrolytes({ alb: v, albUnit: u }, null, null);
  for (const [v, want] of [[8, 0.8], [14, 1.4], [25, 2.5], [35, 3.5]]) assert.equal(A(v, "gl").alb, want);
  for (const v of [0.5, 2.5, 3.5]) assert.equal(A(v, "gdl").alb, v);
  const bad = A(35, "gdl");                                      // 35 g/dL: implausible, not re-read as g/L
  assert.equal(bad.alb, undefined); assert.equal(bad.st.alb, "invalid");
  assert.match(bad.errors.join(" "), /implausible.*\(g\/L\?\)/);
});

/* ---------- Finding D: set vs total rate ---------- */
const D_GAS = { ph: 7.20, paco2: 50, hco3: hh(7.20, 50), pao2: 95 };
test("D1. BUR 14 / Ftotal 28: no set-rate number; ventilation requirement with limits", () => {
  const x = pipeline(Object.assign({}, D_GAS, { sp: MV({ ftot: 28, pplat: 22, pco2Target: 40 }) }));
  assert.equal(x.vent.rateSettable, false);
  assert.doesNotMatch(x.text("rr"), /Raise the set RR/);
  assert.match(x.text("rr"), /alveolar ventilation would need to rise by about 25%/);
  assert.match(x.text("rr"), /triggering 14 breaths\/min above the set rate \(total 28 vs set 14\)/);
  assert.match(x.text("rr"), /Reassess effort, synchrony, VT and measured minute ventilation/);
  assert.doesNotMatch(x.msg, /set RR to ≈ 35/);
});
test("D2. rate matrix: BUR 14 with Ftotal 14, 20, missing; BUR 20 with Ftotal 16", () => {
  const r = (ft, rr) => pipeline(Object.assign({}, D_GAS, { sp: MV({ rr: rr || 14, ftot: ft, pplat: 22, pco2Target: 40 }) }));
  const p14 = r(14); assert.equal(p14.vent.rateSettable, true); assert.match(p14.text("rr"), /Raise the set RR to ≈ 18\/min \(set 14\)/);
  const p20 = r(20); assert.equal(p20.vent.rateSettable, false); assert.doesNotMatch(p20.text("rr"), /Raise the set RR/);
  const miss = r(null); assert.match(miss.text("rr"), /Ftotal not entered, so this assumes no patient-triggered breaths/);
  const low = r(16, 20); assert.equal(low.vent.fLow, true); assert.equal(low.vent.rrNeed, undefined);
  assert.ok(!low.keys.includes("rr"));
  assert.match(checks(low.msg), /Ftotal 16 is below the set rate 20/);
});
test("D3. auto-PEEP still blocks a faster rate", () => {
  const x = pipeline(Object.assign({}, D_GAS, { sp: MV({ ftot: 14, pplat: 22, pco2Target: 40, peeptot: 9 }) }));
  assert.match(x.text("rr"), /Air trapping.*do not raise the rate/);
});
// Expectation changed in v16.2 (spec "v16.2 Safety Corrections", issue B): v16.1 asserted the unconditional instruction
// "raise the set rate to at least 32", which the v16.2 review found unsafe. The critical warning is kept without a number.
test("D4 (expectations updated in v16.2). severe metabolic acidosis with compensatory triggering: warning kept, no set-rate number", () => {
  const x = pipeline({ ph: 7.10, paco2: 25, hco3: hh(7.10, 25), pao2: 150, sp: MV({ rr: 14, ftot: 32, pplat: 24 }) });
  assert.match(x.text("vdrive"), /Sedation, paralysis or a switch to a controlled mode can abruptly remove this ventilation/);
  assert.doesNotMatch(x.text("vdrive"), /raise the set rate to at least/i);
  assert.doesNotMatch(x.text("rr"), /Raise the set RR to ≈/);
});
test("D5. SIMV with spontaneous breaths: no set-rate number", () => {
  const x = pipeline(Object.assign({}, D_GAS, { sp: MV({ vmode: "simv", rr: 12, fspn: 8, fmand: 12, ftot: 20, psupp: 10, pco2Target: 40 }) }));
  assert.equal(x.vent.rateSettable, false);
  assert.doesNotMatch(x.text("rr"), /Raise the set RR/);
  assert.match(x.text("rr"), /spontaneous breaths between the mandatory ones/);
});

/* ---------- Findings E and F: contradictory pressures ---------- */
test("E1 (wording updated in v16.2). total PEEP below set PEEP: flagged, auto-PEEP/DP/compliance withheld, never 'no auto-PEEP'", () => {
  const sp = MV({ peep: 10, peeptot: 3, pplat: 25 });
  const x = pipeline(Object.assign({}, N, { sp }));
  assert.equal(x.vent.badPeepTot, true);
  assert.equal(x.vent.autoPeep, undefined); assert.equal(x.vent.dp, undefined); assert.equal(x.vent.cstat, undefined);
  const lines = ABG.ventInterp(x.vent, sp, x.ab).map((l) => l.text).join(" ");
  assert.doesNotMatch(lines + x.msg, /No significant auto-PEEP/);
  assert.match(checks(x.msg), /Total PEEP 3 is below set PEEP 10/);
  assert.match(x.msg, /Total PEEP: 3 cmH₂O \(invalid: below set PEEP; recheck\)/);
  // wording changed in v16.2 ("not available" → "not assessed", the status vocabulary the v16.2 spec asks for)
  assert.match(x.msg, /Driving pressure: not assessed \(total PEEP below set PEEP; recheck\)/);
});
test("F1. plateau above peak: flagged, plateau-based advice withheld, valid advice kept", () => {
  const sp = MV({ ppeak: 25, pplat: 40, peep: 5, vt: 700 });     // VT 700 = 10.6 mL/kg: valid, independent advice
  const x = pipeline(Object.assign({}, N, { sp }));
  assert.equal(x.vent.badPeak, true); assert.equal(x.vent.pplV, null);
  assert.ok(!x.keys.includes("pplat"), "no 'plateau > 30' advice from an invalid plateau");
  assert.ok(x.keys.includes("vt"), "VT advice from valid values is kept");
  assert.match(checks(x.msg), /Plateau 40 is above the peak pressure 25.*Repeat the inspiratory hold \(about 0\.5 s\)/);
  assert.match(x.msg, /Plateau pressure: 40 cmH₂O \(invalid: above the peak; recheck\)/);
  assert.doesNotMatch(x.msg, /Plateau 40 cmH₂O > 30/);
});
test("F2. plateau below PEEP, valid combinations, missing plateau, zero PEEP, measured PEEP, active breathing", () => {
  const below = pipeline(Object.assign({}, N, { sp: MV({ pplat: 4, peep: 8, ppeak: 20 }) }));
  assert.equal(below.vent.badPlat, true); assert.match(checks(below.msg), /Plateau 4 is below PEEP 8/);
  const okv = pipeline(Object.assign({}, N, { sp: MV({ ppeak: 30, pplat: 25, peep: 5 }) }));
  assert.equal(okv.vent.dp, 20); assert.equal(okv.vent.issues.length, 0); assert.doesNotMatch(okv.msg, /Input checks/);
  const none = pipeline(Object.assign({}, N, { sp: MV({ ppeak: 30, peep: 5 }) }));
  assert.match(none.msg, /Driving pressure: needs plateau pressure/);
  const zero = pipeline(Object.assign({}, N, { sp: MV({ ppeak: 22, pplat: 18, peep: 0 }) }));
  assert.equal(zero.vent.dp, 18); assert.equal(zero.vent.issues.length, 0);
  const meas = pipeline(Object.assign({}, N, { sp: MV({ peep: 8, peepm: 4 }) }));
  assert.match(checks(meas.msg), /Measured PEEP 4 differs from set PEEP 8.*leak/);
  const active = pipeline(Object.assign({}, N, { sp: MV({ rr: 14, ftot: 26, ppeak: 30, pplat: 24, peep: 5 }) }));
  assert.match(checks(active.msg), /plateau was entered while the patient is triggering/);
});

/* ---------- Validation errors in the copied report ---------- */
test("V1. the copied message never looks reassuring when an input is rejected", () => {
  const ph = pipeline({ ph: 6.2, paco2: 40, hco3: null, pao2: 95 });
  assert.match(checks(ph.msg), /Acid–base not interpreted: pH of 6\.20 is outside 6\.30–8\.00/);
  assert.doesNotMatch(ph.msg, /Normal acid–base status|No acid–base or oxygenation problem/);
  assert.match(ph.msg, /Acid–base not assessed: see the input checks above/);
  const ext = pipeline({ ph: 6.5, paco2: 30, hco3: null, pao2: 95 });
  assert.ok(ext.ab, "extreme pH 6.50 is interpreted");
  assert.match(checks(ext.msg), /pH 6\.50 is extreme: confirm the analyzer result/);
  const po2 = pipeline({ ph: 7.40, paco2: 40, hco3: 24, pao2: 800, sp: { mode: "mask", dev: "nrm", fio2Pct: 100 } });
  assert.match(checks(po2.msg), /pO₂ 800 on FiO₂ 100% is outside the accepted range/);
  const nc = pipeline({ ph: 7.40, paco2: 40, hco3: 24, pao2: 70, sp: { mode: "nc", ncFlow: 8 } });
  assert.match(checks(nc.msg), /Nasal cannula 8 L\/min: the FiO₂ estimate .* is unreliable above 6 L\/min/);
  const mm = pipeline({ ph: 7.40, paco2: 40, hco3: 10, pao2: 95 });
  assert.match(checks(mm.msg), /Acid–base reading paused/);
});
test("V2. extreme but possible electrolytes are interpreted and flagged; impossible ones are reported", () => {
  const x = pipeline(Object.assign({}, N, { el: { na: 105, k: 8.6 } }));
  assert.equal(x.E.na, 105); assert.equal(x.E.k, 8.6);
  assert.match(checks(x.msg), /Na 105 mmol\/L is extremely low/);
  assert.match(checks(x.msg), /K 8\.6 mmol\/L is extremely high/);
  assert.match(x.text("k"), /12-lead ECG/);
  const bad = pipeline(Object.assign({}, N, { el: { na: 250 } }));
  assert.match(bad.msg, /Na 250: invalid entry \(not interpreted\)/);
});
test("V3. AI-filled ventilator values: suggestions withheld until confirmed", () => {
  const sp = MV({ pplat: 34 });
  const g = { ph: 7.40, paco2: 40, hco3: 24, pao2: 95 };
  const x = pipeline(Object.assign({}, g, { sp }));
  assert.ok(x.keys.includes("pplat"));
  const held = ABG.message(Object.assign({ ab: x.ab, ox: x.ox, fio2Pct: 40, support: sp, vent: x.vent, aiPending: true,
    extraIssues: [{ text: "Ventilator values were filled from a photo by AI and are not yet checked against the screen", level: "crit" }] }, g));
  assert.doesNotMatch(held, /Plateau 34 cmH₂O > 30/);
  assert.match(checks(held), /filled from a photo by AI/);
  const vm = ABG.ventMessage({ support: sp, vent: x.vent, fio2Pct: 40, aiPending: true, extraIssues: [{ text: "AI values not checked", level: "crit" }] });
  assert.match(vm, /Suggestions: withheld until the AI-filled values are checked/);
});

/* ---------- Missing potassium in DKA ---------- */
test("K1. DKA met with K missing: potassium check before any insulin", () => {
  const x = pipeline({ ph: 7.10, paco2: 20, hco3: hh(7.10, 20), pao2: 100, el: { glu: 520, gluUnit: "mgdl", bhb: 6.2 } });
  assert.match(x.text("k"), /K not entered: check serum potassium before any insulin/);
  assert.match(x.text("dka"), /once K is confirmed above 3\.5/);
  const inv = pipeline({ ph: 7.10, paco2: 20, hco3: hh(7.10, 20), pao2: 100, el: { glu: 520, gluUnit: "mgdl", bhb: 6.2, k: 20 } });
  assert.match(inv.text("k"), /K entry is not valid/);
  const hhs = pipeline({ ph: 7.36, paco2: 38, hco3: hh(7.36, 38), pao2: 90, el: { na: 148, glu: 980, gluUnit: "mgdl" } });
  assert.match(hhs.text("k"), /check serum potassium before any insulin/);   // possible HHS: insulin likely
  const none = pipeline(Object.assign({}, N, { el: { glu: 120, gluUnit: "mgdl" } }));
  assert.ok(!none.keys.includes("k"));
});

/* ---------- Randomized: statuses and messages stay consistent ---------- */
test("R1. 3,000 random partial and invalid inputs: no unconfirmed or invalid value is interpreted", () => {
  let seed = 161161; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = (a) => a[Math.floor(rnd() * a.length)], maybe = (p, v) => (rnd() < p ? v : null);
  let n = 0;
  for (let i = 0; i < 3000; i++) {
    const ph = maybe(0.9, +(6.2 + rnd() * 1.0).toFixed(2)), paco2 = maybe(0.9, Math.round(10 + rnd() * 100));
    const hc = ph != null && paco2 != null ? hh(ph, paco2) : null;
    const el = { glu: maybe(0.7, pick([7, 35, 53, 70, 120, 400, 9000])), gluUnit: pick([null, "mgdl", "mmol", "bad"]), ica: maybe(0.5, pick([0.05, 1.1, 1.6, 4.8])), icaUnit: pick([null, "mmol", "mgdl"]),
      alb: maybe(0.5, pick([0.5, 2.5, 5, 25, 35])), albUnit: pick([null, "gdl", "gl"]), na: maybe(0.6, pick([95, 105, 140, 250])), k: maybe(0.6, pick([0.3, 2.9, 4, 8.6])), cl: maybe(0.5, 100), bun: maybe(0.4, 30), bunUnit: pick([null, "mgdl", "urea"]) };
    const sp = rnd() < 0.5 ? MV({ ftot: maybe(0.6, pick([10, 14, 28])), peeptot: maybe(0.3, pick([3, 8])), pplat: maybe(0.5, pick([4, 25, 40])), ppeak: maybe(0.5, 30), pco2Target: maybe(0.3, 40) }) : { mode: "ra" };
    const x = pipeline({ ph, paco2, hco3: hc != null && hc > 2 && hc < 60 ? hc : null, pao2: maybe(0.9, pick([50, 95, 800])), sp, el });
    n++;
    const m = x.msg;
    assert.doesNotMatch(m, /NaN|undefined|\bnull\b|Infinity/);
    for (const k of ["glu", "ica", "alb", "bun"]) {
      const st = x.E && x.E.st[k];
      if (st === "unit" || st === "invalid") {
        assert.equal(x.E[k], undefined, k + " used despite " + st);
        assert.match(m, /Input checks/);
      }
    }
    if (x.E && x.E.st.glu === "unit") assert.ok(!x.keys.includes("glu"));
    if (x.vent && (x.vent.badPeak || x.vent.badPlat)) { assert.ok(!x.keys.includes("pplat")); assert.equal(x.vent.dp, undefined); }
    if (x.vent && x.vent.badPeepTot) assert.doesNotMatch(m, /auto-PEEP \d/);
    if (/Raise the set RR to ≈/.test(x.text("rr"))) assert.equal(x.vent.rateSettable, true);
  }
  assert.ok(n === 3000);
});

/* ---------- Additional finding: out-of-range pO2 still produced P/F and "no oxygenation problem" ---------- */
test("O1. pO₂ 800 on FiO₂ 100%: no P/F or A-aDO₂ from it, and no 'no oxygenation problem' line", () => {
  const x = pipeline({ ph: 7.40, paco2: 40, hco3: 24, pao2: 800, sp: { mode: "mask", dev: "nrm", fio2Pct: 100 } });
  assert.match(checks(x.msg), /pO₂ 800 on FiO₂ 100% is outside the accepted range/);
  assert.doesNotMatch(x.msg, /P\/F Ratio: 800/);
  assert.doesNotMatch(x.msg, /A-aDO₂:/);
  assert.doesNotMatch(x.msg, /No acid–base or oxygenation problem/);
  assert.match(x.msg, /No acid–base problem on this gas; oxygenation not assessed: see the input checks above/);
  assert.equal(x.g, null);
  const ok = pipeline({ ph: 7.40, paco2: 40, hco3: 24, pao2: 400, sp: { mode: "mask", dev: "nrm", fio2Pct: 100 } });
  assert.match(ok.msg, /P\/F Ratio: 400/);                     // boundary side: valid values still give P/F
  assert.equal(ABG.nothingLine(true, true), "Acid–base and oxygenation not assessed: see the input checks above.");
});
test("O2. pO₂ 800 with FiO₂ not yet known is still listed as an input check", () => {
  const iss = ABG.collectIssues({ pao2: 800, fio2Pct: null, ox: null });
  assert.equal(iss.length, 1); assert.match(iss[0].text, /^pO₂ 800 is outside the accepted range/);
  assert.equal(ABG.collectIssues({ pao2: 95, fio2Pct: null, ox: null }).length, 0);
});
