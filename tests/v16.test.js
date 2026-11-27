// v16 regression tests: the five reviewed issues, the three defects found in the v16 audit, boundaries, units and a
// randomized contradiction check. Passing them shows the code follows the stated rules, not that it is clinically safe.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { ABG, pipeline, hh } = require("./helpers.js");

const MV = (extra) => Object.assign({ mode: "mv", vmode: "acvc", fio2Pct: 40, peep: 5, vt: 450, rr: 16, height: 170, sex: "m" }, extra || {});
const el = (ph, paco2, e) => ABG.electrolytes(e, ABG.acidBase({ ph, paco2 }), null);

/* ---------- Issue 1: DKA acidosis criterion is pH < 7.3 OR HCO3 < 18, exactly ---------- */
test("v16-1a. DKA met when only the pH criterion is met (pH 7.20, pCO2 60, HCO3 22.8)", () => {
  const x = pipeline({ ph: 7.20, paco2: 60, hco3: hh(7.20, 60), pao2: 90, el: { glu: 380, gluUnit: "mgdl", bhb: 4.0 } });
  assert.equal(x.E.dka.A, true);
  assert.equal(x.E.dka.state, "met");
  assert.equal(x.E.dka.phOnly, true);
  assert.match(x.msg, /DKA biochemical criteria met/);
  assert.match(x.msg, /not explained by ketoacidosis alone.*respiratory acidosis/);
});
test("v16-1b. DKA met when only the HCO3 criterion is met (pH 7.33, HCO3 16)", () => {
  const pc = 16 * Math.pow(10, 9 - 7.33) / 24;                // consistent pCO2 ≈ 31
  const x = pipeline({ ph: 7.33, paco2: pc, hco3: 16, pao2: 90, el: { glu: 380, gluUnit: "mgdl", bhb: 4.0 } });
  assert.equal(x.E.dka.state, "met"); assert.equal(x.E.dka.phOnly, false);
  assert.doesNotMatch(x.msg, /not explained by ketoacidosis alone/);
});
test("v16-1c. acidosis criterion boundaries: pH 7.30 with HCO3 18.0 is not met; 7.29 or 17.9 is", () => {
  const E = (ph, h) => ABG.electrolytes({ glu: 380, gluUnit: "mgdl", bhb: 4 }, ABG.acidBase({ ph, paco2: h * Math.pow(10, 9 - ph) / 24 }), null);
  assert.equal(E(7.30, 18.0).dka.A, false); assert.equal(E(7.30, 18.0).dka.state, "notmet");
  assert.equal(E(7.29, 18.0).dka.A, true);
  assert.equal(E(7.30, 17.9).dka.A, true);
});
// Expectation changed in v16.3 at the user's request: the gas is interpreted as entered (the entered HCO₃, often a
// chemistry bicarbonate, is the one the DKA criteria use), with a quiet note showing the calculated HCO₃.
test("v16-1d (expectations updated in v16.3). a HCO₃ that does not fit is used as entered for acid–base and DKA", () => {
  const x = pipeline({ ph: 7.20, paco2: 60, hco3: 15, pao2: 90, el: { glu: 380, gluUnit: "mgdl", bhb: 4.0 } });
  assert.ok(x.ab); assert.equal(x.ab.hco3, 15); assert.ok(x.ab.hco3Diff);
  assert.equal(x.E.dka.state, "met");
  assert.match(x.msg, /DKA biochemical criteria met .*HCO₃ 15/);
  assert.doesNotMatch(x.msg, /paused|Input checks/);
});

/* ---------- Issue 2: severity includes β-OHB > 6.0; worst finding sets the grade ---------- */
test("v16-2a. β-OHB 6.1 makes it severe even with mild acid–base values", () => {
  const x = pipeline({ ph: 7.28, paco2: 38, hco3: hh(7.28, 38), pao2: 90, el: { glu: 400, gluUnit: "mgdl", bhb: 6.1 } });
  assert.equal(x.E.dka.sev, "severe");
  assert.ok(x.E.dka.sevWhy.some((w) => /β-OHB 6\.1 > 6\.0/.test(w)));
  assert.match(x.msg, /severe by β-OHB 6\.1 > 6\.0/);
  assert.match(x.msg, /mental status, which needs bedside assessment/);
});
test("v16-2b. β-OHB exactly 6.0 is not severe", () => {
  const x = pipeline({ ph: 7.28, paco2: 38, hco3: hh(7.28, 38), pao2: 90, el: { glu: 400, gluUnit: "mgdl", bhb: 6.0 } });
  assert.equal(x.E.dka.sev, "mild");
});
test("v16-2c. pH and HCO3 severity boundaries", () => {
  const sev = (ph, h, bhb) => ABG.electrolytes({ glu: 400, gluUnit: "mgdl", bhb: bhb || 4 }, ABG.acidBase({ ph, paco2: h * Math.pow(10, 9 - ph) / 24 }), null).dka.sev;
  assert.equal(sev(7.26, 17), "mild");
  assert.equal(sev(7.25, 17), "moderate");
  assert.equal(sev(7.00, 16), "moderate");
  assert.equal(sev(6.99, 16), "severe");
  assert.equal(sev(7.28, 15.0), "mild");
  assert.equal(sev(7.28, 14.9), "moderate");
  assert.equal(sev(7.28, 10.0), "moderate");
  assert.equal(sev(7.28, 9.9), "severe");
  assert.equal(sev(7.35, 17.0), "mild");                         // met by HCO3 alone
});

/* ---------- Issue 3: custom pCO2 targets get projected pH and the same safety rules ---------- */
test("v16-3a. custom target 25 at pH 7.40: projected pH 7.60, no rate increase", () => {
  const x = pipeline({ ph: 7.40, paco2: 40, hco3: 24, pao2: 95, sp: MV({ pco2Target: 25 }) });
  assert.equal(x.vent.target.custom, true);
  assert.ok(Math.abs(x.vent.target.phAt - (9 - Math.log10(24 * 25 / 24))) < 1e-9);   // 7.60
  assert.doesNotMatch(x.text("rr"), /Raise the set RR/);
  assert.match(x.text("rr"), /pH 7\.40 is normal: no rate change.*≈ 7\.60/);
  assert.doesNotMatch(x.msg, /projected pH ≈ —/);
});
test("v16-3b. custom target that would worsen acidemia is refused", () => {
  const x = pipeline({ ph: 7.30, paco2: 40, hco3: hh(7.30, 40), pao2: 95, sp: MV({ pco2Target: 60 }) });
  assert.doesNotMatch(x.text("rr"), /Lower the set RR/);
  assert.match(x.text("rr"), /Do not lower the rate.*worsening the acidemia/);
  assert.doesNotMatch(x.text("rr"), /Winter's value is helping/);   // pCO2 40 is not below Winter's here
});
test("v16-3c. custom target that would worsen alkalemia is refused", () => {
  const x = pipeline({ ph: 7.50, paco2: 30, hco3: hh(7.50, 30), pao2: 95, sp: MV({ pco2Target: 25, rr: 16 }) });
  assert.doesNotMatch(x.text("rr"), /Raise the set RR/);
  assert.match(x.text("rr"), /worsening the alkalemia/);
});
test("v16-3d. a helpful custom target passes, with projected pH and the estimate's limits", () => {
  const x = pipeline({ ph: 7.25, paco2: 60, hco3: hh(7.25, 60), pao2: 95, sp: MV({ pco2Target: 45 }) });
  assert.match(x.text("rr"), /Raise the set RR.*your custom target; projected pH ≈ 7\.37/);
  const more = x.sg.find((s) => s.key === "rr").more;
  assert.match(more, /theoretical estimate/);
  assert.match(more, /patient-triggered breaths/);
  assert.match(more, /plateau ≤ 30 and VT 4–8 mL\/kg PBW/);
});
test("v16-3e. custom target without a valid pH gives no rate advice", () => {
  const x = pipeline({ ph: null, paco2: 40, hco3: null, pao2: 95, sp: MV({ pco2Target: 30 }) });
  assert.equal(x.vent.target.phAt, undefined);
  assert.ok(!x.keys.includes("rr"));
});
test("v16-3f. custom targets still respect air trapping", () => {
  const x = pipeline({ ph: 7.25, paco2: 60, hco3: hh(7.25, 60), pao2: 95, sp: MV({ pco2Target: 45, peep: 5, peeptot: 10 }) });
  assert.match(x.text("rr"), /Air trapping.*do not raise the rate/);
});

/* ---------- Audit finding A: calculated Winter's target must not lower the rate into worse acidemia ---------- */
test("v16-A. metabolic acidosis with pCO2 below Winter's: no advice to lower the rate", () => {
  for (const [ph, pc, rr] of [[7.32, 22, 24], [7.30, 20, 28], [7.25, 18, 30]]) {
    const x = pipeline({ ph, paco2: pc, hco3: hh(ph, pc), pao2: 200, sp: MV({ rr }) });
    assert.ok(x.vent.target.phAt < ph, "Winter's target would lower pH");
    assert.doesNotMatch(x.text("rr"), /Lower the set RR/);
    assert.match(x.text("rr"), /Do not lower the rate.*worsening the acidemia/);
    // the "below Winter's" explanation only when pCO2 is truly below the Winter's range
    assert.equal(/Winter's value is helping the pH/.test(x.text("rr")), x.ab.check.extra === "resp-alk");
  }
});

/* ---------- Issue 4: HHS osmolality source ---------- */
const HHS = { ph: 7.36, paco2: 38, hco3: hh(7.36, 38), pao2: 90 };
test("v16-4a. measured osmolality alone does not confirm HHS and is never shown as 'effective'", () => {
  const x = pipeline(Object.assign({}, HHS, { el: { glu: 800, gluUnit: "mgdl", bhb: 0.8, osm: 340 } }));
  assert.equal(x.E.hhs.state, "possible");
  assert.equal(x.E.hhs.measOnly, true);
  assert.match(x.msg, /measured 340 supports hyperosmolality, but the criteria use calculated values/);
  assert.doesNotMatch(x.msg, /osmolality —|HHS biochemical criteria met/);
});
test("v16-4b. HHS met by calculated effective osmolality names that source", () => {
  const x = pipeline(Object.assign({}, HHS, { el: { na: 145, glu: 800, gluUnit: "mgdl", bhb: 0.8 } }));
  assert.equal(x.E.hhs.state, "met");
  assert.match(x.msg, /calculated effective osmolality 334 \(> 300\)/);
});
test("v16-4c. HHS met by calculated total osmolality when effective is ≤ 300", () => {
  const x = pipeline(Object.assign({}, HHS, { el: { na: 128, glu: 650, gluUnit: "mgdl", bhb: 0.5, bun: 100, bunUnit: "mgdl" } }));   // eff 292, total 328
  assert.ok(x.E.effOsm <= 300 && x.E.calcOsm > 320);
  assert.equal(x.E.hhs.state, "met");
  assert.match(x.msg, /calculated total osmolality 328 \(> 320\)/);
});
test("v16-4d. effective ≤ 300 without BUN: possible, asks for BUN", () => {
  const x = pipeline(Object.assign({}, HHS, { el: { na: 128, glu: 650, gluUnit: "mgdl", bhb: 0.5 } }));
  assert.equal(x.E.hhs.state, "possible");
  assert.match(x.msg, /BUN for the total osmolality/);
});
test("v16-4e. hyperosmolar with acidosis: mixed features, treat as DKA", () => {
  const x = pipeline({ ph: 7.25, paco2: 30, hco3: hh(7.25, 30), pao2: 90, el: { na: 145, glu: 800, gluUnit: "mgdl", bhb: 2.0 } });
  assert.equal(x.E.hhs.mixed, true);
  assert.match(x.msg, /Mixed features: the consensus advises treating it as DKA/);
});

/* ---------- Issue 5: SpO2 > 97% ---------- */
test("v16-5. SpO2 above 97%: ratio not valid; ABG if needed; no advice to change oxygen", () => {
  const v = ABG.ventCalc(MV({ fio2Pct: 60, spo2: 99 }), null, null, null, 60, false);
  assert.ok(!v.sfRange);
  const t = ABG.ventInterp(v, MV({ spo2: 99 }), null).find((l) => l.key === "sf").text;
  assert.match(t, /not valid for ARDS grading/);
  assert.match(t, /get an ABG/);
  assert.match(t, /do not change oxygen just to make the ratio usable/);
  assert.doesNotMatch(t, /wean FiO₂/i);
});

/* ---------- Audit findings B and C: units are never guessed where both are plausible ---------- */
test("v16-B (expectations updated in v16.1). glucose is never read without a unit", () => {
  // v16 inferred mmol/L below 10 and mg/dL from 70; v16.1 removes all inference (finding A: 7 could be 7 mg/dL)
  for (const g of [7, 8, 10, 30, 45, 69, 70, 120]) {
    const E = ABG.electrolytes({ glu: g }, null, null);
    assert.equal(E.glu, undefined); assert.equal(E.gluAsk, true); assert.equal(E.st.glu, "unit");
    assert.match(E.errors.join(" "), /unit not confirmed/);
  }
  assert.equal(ABG.electrolytes({ glu: 30, gluUnit: "mgdl" }, null, null).gluStatus, "severe-low");
  assert.equal(ABG.electrolytes({ glu: 45, gluUnit: "mmol" }, null, null).glu, 810);
});
test("v16-C (expectations updated in v16.1). ionized Ca and albumin are never read without a unit", () => {
  for (const v of [1.1, 1.6, 2.5, 4.6]) { const E = ABG.electrolytes({ ica: v }, null, null); assert.equal(E.ica, undefined); assert.equal(E.icaAsk, true); }
  assert.ok(Math.abs(ABG.electrolytes({ ica: 2.5, icaUnit: "mgdl" }, null, null).ica - 2.5 / 4.008) < 1e-9);
  assert.equal(ABG.electrolytes({ ica: 2.5, icaUnit: "mmol" }, null, null).ica, 2.5);
  assert.equal(ABG.electrolytes({ alb: 25 }, null, null).alb, undefined);
  assert.equal(ABG.electrolytes({ alb: 25, albUnit: "gl" }, null, null).alb, 2.5);
  assert.ok(Math.abs(ABG.electrolytes({ bun: 10, bunUnit: "urea" }, null, null).bun - 28) < 1e-9);
});

/* ---------- Mixed and consistent/inconsistent combinations ---------- */
test("v16-mixed. mixed respiratory and metabolic acidosis with ketosis is flagged, not hidden", () => {
  const x = pipeline({ ph: 7.10, paco2: 55, hco3: hh(7.10, 55), pao2: 80, el: { glu: 450, gluUnit: "mgdl", bhb: 5 } });
  assert.equal(x.ab.primary, "mixed-acid");
  assert.equal(x.E.dka.state, "met");
  assert.equal(x.E.dka.phOnly, false);                          // HCO3 16.6 < 18
});

/* ---------- Randomized: no contradictory outputs ---------- */
test("v16-fuzz. 4,000 random gases: v16 rules hold everywhere", () => {
  let seed = 16016; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = (a) => a[Math.floor(rnd() * a.length)], maybe = (p, v) => (rnd() < p ? v : null);
  let n = 0;
  for (let i = 0; i < 4000; i++) {
    const ph = +(6.9 + rnd() * 0.8).toFixed(2), paco2 = Math.round(15 + rnd() * 85);
    const hc = hh(ph, paco2); if (hc < 3 || hc > 55) continue;
    const sp = rnd() < 0.6 ? MV({ rr: pick([12, 16, 24]), ftot: maybe(0.4, 30), pco2Target: maybe(0.4, pick([25, 35, 45, 60])), pplat: maybe(0.4, 27), ti: maybe(0.5, 1), spo2: maybe(0.3, pick([92, 99])), fio2Pct: pick([30, 60]), peeptot: maybe(0.2, 9) }) : { mode: "nc", ncFlow: 3 };
    const e = rnd() < 0.7 ? { na: maybe(0.7, 120 + Math.round(rnd() * 40)), k: maybe(0.5, 4), cl: maybe(0.5, 100), glu: maybe(0.8, pick([150, 250, 450, 650, 900])), gluUnit: "mgdl",
      bhb: maybe(0.5, pick([1, 3, 6, 6.1, 8])), uket: maybe(0.3, pick([0, 1, 2, 3])), dm: rnd() < 0.3, bun: maybe(0.4, pick([15, 60, 100])), bunUnit: "mgdl", osm: maybe(0.3, pick([300, 340])) } : null;
    const x = pipeline({ ph, paco2, hco3: hc, pao2: Math.round(60 + rnd() * 200), sp, el: e });
    const m = x.msg; n++;
    assert.doesNotMatch(m, /projected pH ≈ —|osmolality —|NaN|undefined|\bnull\b/);
    const rr = x.text("rr");
    if (/^(Raise|Lower) the set RR/.test(rr) && x.vent && x.vent.target && x.vent.target.phAt != null) {
      const away = Math.abs(x.vent.target.phAt - 7.40) > Math.abs(ph - 7.40) + 0.005 && (x.vent.target.phAt < 7.35 || x.vent.target.phAt > 7.45);
      assert.ok(!away, `rate advice moves pH away: ${ph}/${paco2} → ${x.vent.target.phAt.toFixed(2)} (${x.vent.target.why})`);
    }
    if (x.E && x.E.dka && x.E.dka.state === "met") {
      assert.ok(ph < 7.3 || hc < 18, "DKA met without the acidosis criterion");
      const severe = (x.E.bhb != null && x.E.bhb > 6) || ph < 7.0 || hc < 10;
      assert.equal(x.E.dka.sev === "severe", severe, `severity ${x.E.dka.sev} at pH ${ph}, HCO3 ${hc}, β-OHB ${x.E.bhb}`);
    }
    if (x.E && x.E.hhs && x.E.hhs.state === "met") assert.ok((x.E.effOsm != null && x.E.effOsm > 300) || (x.E.calcOsm != null && x.E.calcOsm > 320), "HHS met without a calculated osmolality");
    if (/HHS biochemical criteria met|DKA biochemical criteria met/.test(m)) assert.ok(x.E.bhb != null || x.E.uket != null);
    assert.ok(!(/DKA biochemical criteria met/.test(m) && /HHS biochemical criteria met/.test(m)));
    if (sp.spo2 === 99) assert.doesNotMatch(m, /wean FiO₂ and recheck/);
  }
  assert.ok(n > 3000);
});
