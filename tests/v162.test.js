// v16.2 safety-validation tests. They check the clinician-facing text (both copied messages and the suggestions), not only
// internal numbers. Passing them shows the code follows the stated rules; it does not establish bedside clinical safety.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { ABG, pipeline, ventTab, hh } = require("./helpers.js");

const MV = (e) => Object.assign({ mode: "mv", vmode: "acvc", fio2Pct: 40, vt: 400, vte: 400, peep: 5, rr: 14, height: 170, sex: "m" }, e || {});
const checks = (msg) => (msg.split("⚠️ Input checks (resolve before acting):\n")[1] || "").split("\n\n")[0];
const both = (r) => [r.x.msg, r.vmsg];   // ABG-tab message (support MV) and Ventilator-tab message

/* ---------- Issue A: an invalid PaO2 must not enter any ventilator calculation ---------- */
const A_IN = { ph: 7.40, paco2: 40, hco3: 24, pao2: 800, sp: MV({ ftot: 20, pplat: 22, ppeak: 28, mawp: 12 }) };

test("A1. PaO₂ 800 (spec reproduction): warning, no P/F 2000, no OI 0.6, oxygenation not passed, no SBT pass", () => {
  const r = ventTab(A_IN);
  assert.equal(r.vv.pf, null); assert.equal(r.vv.oi, undefined); assert.equal(r.vv.pao2Bad, 800);
  const ox = r.vv.wean.items.find((c) => c.k === "ox");
  assert.equal(ox.ok, null, "oxygenation is 'not assessed', never passed or failed");
  assert.equal(r.vv.wean.allMet, false); assert.equal(r.vv.wean.relevant, false);
  for (const m of both(r)) {
    assert.match(checks(m), /pO₂ 800 on FiO₂ 40% is outside the accepted range .* P\/F, the oxygenation index, ARDS grading and the weaning oxygenation check are not assessed/);
    assert.doesNotMatch(m, /P\/F (Ratio: )?2000|Oxygenation index: 0\.6|✓ Oxygenation|Meets the numeric criteria/);
    assert.match(m, /P\/F and oxygenation index: not assessed \(pO₂ 800 is invalid; recheck\)/);
    assert.match(m, /– Oxygenation \(not assessed: pO₂ 800 is invalid and there is no valid SpO₂\)/);
    assert.match(m, /Screen incomplete: oxygenation is not assessed, so this is not a pass/);
  }
  assert.match(r.x.msg, /pO₂ 800 mmHg \(invalid: outside 10–700; not used\)/);
  assert.match(r.vmsg, /ABG: pH 7\.40, pCO₂ 40, pO₂ 800 \(invalid\) on FiO₂ 40%(?! \(P\/F)/);
  assert.ok(!r.vsug.some((s) => s.key === "wean" || s.key === "extub"), "no SBT or extubation suggestion");
  assert.ok(!r.x.keys.includes("wean"));
  // the Ventilator tab's input-check card lists the same problem in the same words as the ABG tab
  assert.ok(r.vchk.some((i) => /^pO₂ 800 on FiO₂ 40% is outside the accepted range/.test(i.text)));
});

test("A2. missing PaO₂, valid PaO₂, invalid FiO₂", () => {
  const miss = ventTab(Object.assign({}, A_IN, { pao2: null }));
  assert.equal(miss.vv.pf, null); assert.equal(miss.vv.pao2St, "missing");
  assert.ok(!miss.vv.wean.items.some((c) => c.k === "ox" && c.ok), "missing data is never a pass");
  assert.equal(miss.vv.wean.relevant, false);
  for (const m of both(miss)) assert.doesNotMatch(m, /✓ Oxygenation|Meets the numeric criteria|P\/F and oxygenation index: not assessed/);
  const ok = ventTab(Object.assign({}, A_IN, { pao2: 90 }));
  assert.equal(ok.vv.pf, 225); assert.ok(Math.abs(ok.vv.oi - 5.33) < 0.01);
  assert.match(ok.vmsg, /ABG: pH 7\.40, pCO₂ 40, pO₂ 90 on FiO₂ 40% \(P\/F 225\)/);
  assert.match(ok.vmsg, /Oxygenation index: 5\.3/);
  assert.equal(ok.vv.wean.items.find((c) => c.k === "ox").ok, true);
  const fi = ABG.ventCalc(MV({ fio2Pct: 150, mawp: 12, spo2: 95 }), null, 40, 90, 150, false);
  assert.equal(fi.pf, null); assert.equal(fi.oi, undefined); assert.equal(fi.sf, undefined); assert.equal(fi.fio2Bad, 150);
  assert.equal(fi.wean.items.find((c) => c.k === "fio2").ok, null);
  assert.match(ABG.collectIssues({ vent: fi }).map((i) => i.text).join(" "), /FiO₂ 150% is outside 21–100%: .* not assessed/);
});

test("A3. boundaries share one status in every module (ABG tab, gas exchange, ventilator)", () => {
  for (const [pao2, st] of [[10, "valid"], [700, "valid"], [9.9, "invalid"], [700.1, "invalid"]]) {
    assert.equal(ABG.vStat("pao2", pao2), st, String(pao2));
    const ox = ABG.oxygenation({ pao2, fio2Pct: 40, age: 50 });
    const g = ABG.gasExchange({ pao2, paco2: 40, fio2Pct: 40, age: 50, support: { mode: "mv" } });
    const v = ABG.ventCalc(MV(), null, null, pao2, 40, false);   // no pCO₂: the range rule alone (the alveolar rule is tested in A6)
    assert.equal(ox == null, st === "invalid", "oxygenation " + pao2);
    assert.equal(v.pf == null, st === "invalid", "ventilator P/F " + pao2);
    if (st === "invalid") assert.equal(g, null);
    assert.equal(ABG.oxOutOfRange(pao2, 40), st === "invalid");
  }
  for (const [fi, st] of [[21, "valid"], [100, "valid"], [20.9, "invalid"], [100.1, "invalid"]]) {
    assert.equal(ABG.vStat("fio2Pct", fi), st);
    assert.equal(ABG.ventCalc(MV({ fio2Pct: fi }), null, 40, 90, fi, false).pf == null, st === "invalid", "FiO2 " + fi);
  }
});

test("A4. invalid PaO₂ with a valid SpO₂: SpO₂-based oxygenation, its source named", () => {
  const r = ventTab(Object.assign({}, A_IN, { sp: MV({ vmode: "psv", psupp: 6, peep: 5, ftot: 18, spo2: 96 }) }));
  const ox = r.vv.wean.items.find((c) => c.k === "ox");
  assert.equal(ox.ok, true); assert.match(ox.label, /from SpO₂ because pO₂ 800 is invalid; pulse oximetry only/);
  assert.equal(r.vv.pf, null);
  for (const m of both(r)) assert.doesNotMatch(m, /P\/F (Ratio: )?2000|✓ Oxygenation: P\/F/);
  if (r.vsug.some((s) => s.key === "wean")) assert.match(r.vtext("wean"), /oxygenation judged from SpO₂ only, because the pO₂ entry is invalid/);
});

test("A5. randomized: the same PaO₂ has the same status in every module, and an invalid one never reaches a result", () => {
  let seed = 11; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 1500; i++) {
    const pao2 = [5, 9.9, 10, 60, 95, 300, 700, 700.1, 800, 1200][Math.floor(rnd() * 10)];
    const fio2 = [21, 40, 60, 100][Math.floor(rnd() * 4)];
    const r = ventTab({ ph: 7.40, paco2: 40, hco3: 24, pao2, sp: MV({ fio2Pct: fio2, ftot: 14 + Math.floor(rnd() * 8), mawp: 12, ppeak: 28, pplat: rnd() < 0.5 ? 22 : undefined }) });
    // v16.3: out-of-range pO₂ is rejected everywhere; a pO₂ above the alveolar value is still read for oxygenation (with a
    // note) but never turned into P/F, OI or a weaning pass, and it is not a red input check
    const bad = ABG.vStat("pao2", pao2) === "invalid", alv = !bad && ABG.pao2AboveAlv(pao2, 40, fio2) != null;
    assert.equal(r.x.ox == null, bad); assert.equal(r.x.g == null, bad || alv); assert.equal(r.vv.pf == null, bad || alv); assert.equal(r.vv.oi == null, bad || alv);
    if (alv) assert.ok(r.x.ox.aboveAlv);
    const listed = r.vchk.some((c) => /^pO₂ .* is outside the accepted range/.test(c.text));
    assert.equal(listed, bad, "Ventilator tab input checks for pO₂ " + pao2);
    if (bad) for (const m of both(r)) assert.doesNotMatch(m, /P\/F Ratio: |\(P\/F \d|Oxygenation index: \d|✓ Oxygenation: P\/F|Meets the numeric criteria|No acid–base or oxygenation problem/);
    if (alv) for (const m of both(r)) { assert.doesNotMatch(m, /P\/F Ratio: |\(P\/F \d|Oxygenation index: \d|✓ Oxygenation: P\/F|Meets the numeric criteria/); assert.ok(!/pO₂/.test(checks(m)), "no pO₂ input check"); }
  }
});

// Expectation changed in v16.3 at the user's request: such a pO₂ is read for oxygenation (with a note to set the oxygen
// support) instead of a red "resolve before acting" check; P/F, OI and the weaning check are still not calculated from it.
test("A6 (expectations updated in v16.3). pO₂ above the alveolar pO₂: oxygenation read with a note, no derived indices", () => {
  // FiO2 40%, pCO2 40: alveolar pO2 = 0.40 × 713 − 40 / 0.8 ≈ 235
  const r = ventTab({ ph: 7.40, paco2: 40, hco3: 24, pao2: 300, sp: MV({ ftot: 20, mawp: 12, pplat: 22, ppeak: 28 }) });
  assert.ok(Math.abs(ABG.pao2AboveAlv(300, 40, 40) - 235.2) < 0.1);
  assert.ok(r.x.ox); assert.match(r.x.ox.detail, /above what FiO₂ 40% can give \(alveolar ≈ 235 at pCO₂ 40\): the patient is probably on more oxygen than entered/);
  assert.equal(r.x.g, null); assert.equal(r.vv.pf, null); assert.equal(r.vv.oi, undefined);
  assert.equal(r.vv.wean.items.find((c) => c.k === "ox").ok, null);
  for (const m of both(r)) {
    assert.equal(checks(m).includes("pO₂ 300"), false, "not a red input check");
    assert.doesNotMatch(m, /P\/F (Ratio: )?750|✓ Oxygenation: P\/F|Meets the numeric criteria/);
  }
  assert.match(r.vmsg, /P\/F and oxygenation index: not calculated \(pO₂ 300 is above what FiO₂ 40% can give; check FiO₂\)/);
  const ok = ventTab({ ph: 7.40, paco2: 40, hco3: 24, pao2: 230, sp: MV({ ftot: 14 }) });
  assert.equal(ok.vv.pf, 575, "just below the alveolar value is used normally");
});

/* ---------- v16.3: the user's case (screenshot, 27 Nov 2026) ---------- */
test("U1. pH 7.40, pCO₂ 24, HCO₃ 18, pO₂ 184 on room air: interpreted as entered, no input-check card", () => {
  const x = pipeline({ ph: 7.40, paco2: 24, hco3: 18, pao2: 184, age: 50 });
  assert.ok(x.ab); assert.equal(x.ab.hco3, 18);
  assert.equal(ABG.collectIssues({ abRaw: x.abRaw, el: x.E, ox: x.ox, pao2: 184, paco2: 24, fio2Pct: 21, support: { mode: "ra" } }).length, 0);
  assert.doesNotMatch(x.msg, /Input checks|paused|not interpreted|not assessed/);
  assert.match(x.msg, /ABG Interpretation:\nChronic respiratory alkalosis, with normal oxygenation/);
  assert.match(x.msg, /Actual HCO₃: 18 mmol\/L/);
  assert.ok(x.ab.notes.some((n) => /HCO₃ 18 as entered; pH and pCO₂ give 14\.5/.test(n.text)));
  assert.match(x.ox.detail, /above what FiO₂ 21% can give \(alveolar ≈ 120 at pCO₂ 24\)/);
});

/* ---------- Issue B: no contradictory or unconditional rate instructions ---------- */
const B_GAS = { ph: 7.10, paco2: 20, hco3: hh(7.10, 20), pao2: 100 };

test("B1. set RR 14 / total 40 in severe metabolic acidosis (spec reproduction): drive identified, warning kept, no 'set RR 40'", () => {
  const r = ventTab(Object.assign({}, B_GAS, { sp: MV({ ftot: 40, pplat: 22, ppeak: 28 }) }));
  const vd = r.vtext("vdrive"), rr = r.vtext("rr");
  assert.match(vd, /Patient is breathing 26\/min above the set rate \(total 40 vs set 14; minute ventilation 16 L\/min\)/);
  assert.match(vd, /Sedation, paralysis or a switch to a controlled mode can abruptly remove this ventilation and worsen the acidemia/);
  assert.match(vd, /the set rate cannot be inferred from the total rate alone/);
  assert.equal(r.vsug.find((s) => s.key === "vdrive").tone, "crit");
  for (const m of both(r)) {
    assert.doesNotMatch(m, /raise the set rate to at least|set (the )?RR (to|at) 40|Raise the set RR/i);
    assert.match(m, /No new set rate is calculated/);
    assert.match(m, /Sedation, paralysis or a switch to a controlled mode/);
  }
  assert.match(rr, /No new set rate is calculated: the patient is triggering 26 breaths\/min/);
  assert.match(r.vsug.find((s) => s.key === "vdrive").more, /ARDSNet, for ARDS\): set the initial rate to approximate the baseline minute ventilation, not above 35\/min; that ceiling belongs to the ARDSNet protocol, not to every patient or mode/);
});

test("B2. rate matrix: 14/14, 14/28, 14/40, Ftotal missing, Ftotal below set", () => {
  const resp = { ph: 7.25, paco2: 60, hco3: hh(7.25, 60), pao2: 95 };
  const r1414 = ventTab(Object.assign({}, resp, { sp: MV({ ftot: 14, pplat: 22, pco2Target: 40 }) }));
  assert.match(r1414.vtext("rr"), /Raise the set RR to ≈ \d+\/min/);
  assert.equal(r1414.vtext("vdrive"), "", "no compensation warning without triggering");
  const r1428 = ventTab(Object.assign({}, resp, { sp: MV({ ftot: 28, pplat: 22, pco2Target: 40 }) }));
  assert.match(r1428.vtext("rr"), /No new set rate is calculated/); assert.doesNotMatch(r1428.vtext("rr"), /Raise the set RR/);
  const met28 = ventTab(Object.assign({}, B_GAS, { sp: MV({ ftot: 28 }) }));
  assert.match(met28.vtext("vdrive"), /14\/min above the set rate/); assert.doesNotMatch(met28.vtext("vdrive"), /at least 28/);
  const miss = ventTab(Object.assign({}, resp, { sp: MV({ pplat: 22, pco2Target: 40 }) }));
  assert.match(miss.vtext("rr"), /Ftotal not entered, so this assumes no patient-triggered breaths/);
  const low = ventTab(Object.assign({}, B_GAS, { sp: MV({ rr: 20, ftot: 16 }) }));
  assert.equal(low.vv.fLow, true); assert.equal(low.vv.rrNeed, undefined);
  assert.doesNotMatch(low.vmsg, /Raise the set RR|raise the set rate to at least/);
  assert.match(checks(low.vmsg), /Ftotal 16 is below the set rate 20/);
});

test("B3. PSV and SIMV with spontaneous breaths in severe metabolic acidosis: warning without a set-rate number", () => {
  const psv = ventTab(Object.assign({}, B_GAS, { sp: MV({ vmode: "psv", psupp: 10, ftot: 36 }) }));
  assert.match(psv.vtext("vdrive"), /On pressure support the patient generates all of the ventilation \(total 36\/min/);
  assert.match(psv.vtext("vdrive"), /Sedation, paralysis or a switch to a controlled mode/);
  const simv = ventTab(Object.assign({}, B_GAS, { sp: MV({ vmode: "simv", rr: 12, fmand: 12, fspn: 20, ftot: 32, psupp: 10 }) }));
  assert.match(simv.vtext("vdrive"), /20\/min above the set rate \(total 32 vs set 12/);
  for (const m of [psv.vmsg, simv.vmsg]) assert.doesNotMatch(m, /Raise the set RR|raise the set rate to at least/);
});

test("B4. air trapping / auto-PEEP and high plateau with severe acidosis: no rate increase, warning stays", () => {
  const trap = ventTab(Object.assign({}, B_GAS, { sp: MV({ ftot: 34, peeptot: 12, pplat: 26, ppeak: 30 }) }));
  assert.match(trap.vtext("rr"), /Obstructive pattern.*no rate change|Air trapping \(auto-PEEP 7\): do not raise the rate/);
  assert.match(trap.vtext("vdrive"), /abruptly remove this ventilation/);
  assert.doesNotMatch(trap.vmsg, /Raise the set RR/);
  const hiP = ventTab(Object.assign({}, B_GAS, { sp: MV({ ftot: 34, pplat: 34, ppeak: 38 }) }));
  assert.ok(hiP.vsug.some((s) => s.key === "pplat"));
  assert.match(hiP.vtext("vdrive"), /abruptly remove this ventilation/);
  assert.doesNotMatch(hiP.vmsg, /Raise the set RR|raise the set rate to at least/);
});

test("B5. critical warnings never fall off the suggestion limit", () => {
  const L = Array.from({ length: 14 }, (_, i) => ({ key: "k" + i, text: "t" + i, tone: i === 12 ? "crit" : "" }));
  const c = ABG.capSugg(L, 10);
  assert.equal(c.length, 10); assert.ok(c.some((x) => x.key === "k12")); assert.ok(!c.some((x) => x.key === "k9"));
  assert.deepEqual(ABG.capSugg(L.slice(0, 5), 10).map((x) => x.key), ["k0", "k1", "k2", "k3", "k4"]);
  const many = ventTab(Object.assign({}, B_GAS, { el: { na: 128, k: 6.2, cl: 100, glu: 520, gluUnit: "mgdl", bhb: 6 }, sp: MV({ ftot: 40, pplat: 33, ppeak: 38, vt: 600, vte: 600, peeptot: 9 }) }));
  assert.match(many.x.msg, /Sedation, paralysis or a switch to a controlled mode/, "vdrive kept in the ABG-tab message");
  assert.match(many.vmsg, /Sedation, paralysis or a switch to a controlled mode/, "vdrive kept in the Ventilator-tab message");
});

test("B6. randomized: never an unconditional set-rate order, never incompatible rate changes", () => {
  let seed = 5; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  for (let i = 0; i < 2500; i++) {
    const ph = +(6.95 + rnd() * 0.6).toFixed(2), paco2 = Math.round(15 + rnd() * 70), rr = pick([10, 14, 18, 22]), vmode = pick(["acvc", "acpc", "simv", "psv", "prvc"]);
    const sp = MV({ vmode, rr: vmode === "psv" ? undefined : rr, ftot: rnd() < 0.8 ? rr + pick([0, 1, 4, 14, 26, -4]) : undefined, pplat: rnd() < 0.6 ? pick([18, 26, 33]) : undefined, ppeak: pick([22, 30, 40]),
      peeptot: rnd() < 0.3 ? pick([5, 9, 14]) : undefined, fspn: vmode === "simv" ? pick([0, 8]) : undefined, psupp: vmode === "psv" || vmode === "simv" ? 8 : undefined, pco2Target: rnd() < 0.2 ? pick([30, 40]) : undefined });
    const r = ventTab({ ph, paco2, hco3: hh(ph, paco2), pao2: 90, sp });
    for (const m of both(r)) {
      assert.doesNotMatch(m, /raise the set rate to at least/i);
      assert.ok(!(/No new set rate is calculated/.test(m) && /Raise the set RR/.test(m)), "no-set-rate and raise-set-rate together");
      assert.ok(!(/Raise the set RR/.test(m) && /Lower the set RR|[Dd]o not raise the rate/.test(m)), "incompatible rate changes");
    }
  }
});

/* ---------- Issue C: a disputed PEEP must not produce a reassuring driving pressure ---------- */
const C_IN = { ph: 7.40, paco2: 40, hco3: 24, pao2: 90, sp: MV({ peepm: 20, pplat: 28, ppeak: 32, ftot: 14 }) };

test("C1. set PEEP 5 vs measured 20, no hold (spec reproduction): flagged, no DP 8, dependents withheld, recheck explained", () => {
  const r = ventTab(C_IN);
  assert.equal(r.vv.dp, undefined); assert.equal(r.vv.cstat, undefined); assert.equal(r.vv.mp, undefined); assert.equal(r.vv.cdyn, undefined);
  assert.ok(r.vv.peepUnres);
  for (const m of both(r)) {
    assert.match(checks(m), /Measured PEEP 20 differs from set PEEP 5 by more than 2 and no expiratory-hold total PEEP was entered: auto-PEEP .* The app does not assume which value is right: driving pressure, compliance and mechanical power are not assessed until an expiratory hold/);
    assert.doesNotMatch(m, /Driving pressure: 8|goal ≤ 15\)|Compliance and airway resistance are within normal limits|Static compliance: 50|Mechanical power: 11/);
    assert.match(m, /Driving pressure: not assessed \(end-expiratory pressure unresolved: set PEEP 5, measured 20, no expiratory hold; do an expiratory hold\)/);
    assert.match(m, /Static compliance: not assessed \(end-expiratory pressure unresolved\)/);
    assert.match(m, /Mechanical power: not assessed \(end-expiratory pressure unresolved\)/);
    assert.match(m, /PEEP \(measured\): 20 cmH₂O \(unverified: disagrees with set PEEP; see the input checks\)/);
  }
  const lines = ABG.ventInterp(r.vv, C_IN.sp, r.x.ab).map((l) => l.text).join(" ");
  assert.doesNotMatch(lines, /within 15|Compliance and airway resistance are within normal limits/);
});

test("C2. a valid expiratory-hold total PEEP settles it: driving pressure with its basis named", () => {
  const conf = ventTab(Object.assign({}, C_IN, { sp: MV({ peepm: 20, peeptot: 21, pplat: 28, ppeak: 32, ftot: 14 }) }));
  assert.equal(conf.vv.dp, 7); assert.equal(conf.vv.autoPeep, 16); assert.equal(conf.vv.peepSrc, "total PEEP");
  assert.ok(!conf.vv.issues.some((i) => i.key === "peepm"));
  assert.match(conf.vmsg, /Driving pressure: 7 cmH₂O \(plateau − total PEEP 21 from the expiratory hold; goal ≤ 15\)/);
  assert.match(conf.vmsg, /Total PEEP: 21 cmH₂O \(expiratory hold; auto-PEEP 16\)/);
  const auto = ventTab(Object.assign({}, C_IN, { sp: MV({ peeptot: 10, pplat: 28, ppeak: 32, ftot: 14 }) }));
  assert.equal(auto.vv.dp, 18); assert.equal(auto.vv.autoPeep, 5);
  assert.match(auto.vmsg, /Driving pressure: 18 cmH₂O ⬆️ \(plateau − total PEEP 10 from the expiratory hold; goal ≤ 15\)/);
  const plain = ventTab(Object.assign({}, C_IN, { sp: MV({ pplat: 20, ppeak: 25, ftot: 14 }) }));
  assert.match(plain.vmsg, /Driving pressure: 15 cmH₂O \(plateau − PEEP; goal ≤ 15\)/);
});

test("C3. absent plateau, plateau above peak, plateau below end-expiratory pressure, leak, measured above hold", () => {
  const none = ventTab(Object.assign({}, C_IN, { sp: MV({ ppeak: 30 }) }));
  assert.match(none.vmsg, /Driving pressure: needs plateau pressure \(inspiratory hold\)/);
  const above = ventTab(Object.assign({}, C_IN, { sp: MV({ pplat: 40, ppeak: 25 }) }));
  assert.match(above.vmsg, /Driving pressure: not assessed \(plateau above peak; recheck\)/);
  const below = ventTab(Object.assign({}, C_IN, { sp: MV({ peep: 7, peepm: 8, pplat: 7.5, ppeak: 20 }) }));
  assert.equal(below.vv.badPlat, true); assert.match(below.vmsg, /Driving pressure: not assessed \(plateau below PEEP; recheck\)/);
  const leak = ventTab(Object.assign({}, C_IN, { sp: MV({ peep: 8, peepm: 4, pplat: 20, ppeak: 24 }) }));
  assert.equal(leak.vv.dp, undefined); assert.match(checks(leak.vmsg), /Measured PEEP 4 differs from set PEEP 8 .*: a leak \(cuff, circuit\)/);
  const hold = ventTab(Object.assign({}, C_IN, { sp: MV({ peepm: 20, peeptot: 6, pplat: 28, ppeak: 32 }) }));
  assert.equal(hold.vv.dp, undefined);
  assert.match(checks(hold.vmsg), /Measured PEEP 20 is above the expiratory-hold total PEEP 6: both cannot be right/);
});

test("C4. pressure hold during patient effort: driving pressure unverified, never compared with the goal", () => {
  const r = ventTab(Object.assign({}, C_IN, { sp: MV({ rr: 14, ftot: 26, pplat: 14, ppeak: 20 }) }));
  assert.equal(r.vv.dp, 9); assert.equal(r.vv.dpUnverified, true);
  for (const m of both(r)) {
    assert.match(m, /Driving pressure: 9 cmH₂O \(unverified: plateau taken while the patient was triggering; plateau − PEEP\)/);
    assert.doesNotMatch(m, /Driving pressure: 9 cmH₂O[^\n]*goal ≤ 15|Compliance and airway resistance are within normal limits|Compliance is normal/);
    assert.match(m, /Compliance and resistance are not interpreted: the plateau was taken while the patient was triggering breaths/);
  }
  const stiff = ventTab(Object.assign({}, C_IN, { sp: MV({ rr: 14, ftot: 26, pplat: 18, ppeak: 24 }) }));
  assert.match(stiff.vmsg, /Low compliance \(Cstat 31 mL\/cmH₂O\) \(unverified: plateau taken while the patient was triggering\):/);
  assert.doesNotMatch(stiff.vmsg, /with normal airway resistance/);
  const hi = ventTab(Object.assign({}, C_IN, { sp: MV({ rr: 14, ftot: 26, pplat: 30, ppeak: 34 }) }));
  assert.match(hi.vtext("dp"), /Driving pressure 25 cmH₂O is high \(unverified: the plateau was taken while the patient was triggering/);
});

test("C5. randomized: an unresolved pressure disagreement never becomes a normal pressure-based result", () => {
  let seed = 3; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  for (let i = 0; i < 2500; i++) {
    const peep = pick([0, 5, 8, 10]);
    const sp = MV({ vmode: pick(["acvc", "acpc", "prvc"]), peep, ftot: pick([14, 14, 20]), pplat: pick([undefined, 12, 20, 28, 35]), ppeak: pick([undefined, 3, 25, 32, 40]),
      peepm: rnd() < 0.5 ? peep + pick([0, 2, 3, 6, 15, -4]) : undefined, peeptot: rnd() < 0.4 ? peep + pick([-3, 0, 2, 9, 16]) : undefined, flow: pick([undefined, 60]) });
    const r = ventTab({ ph: 7.40, paco2: 40, hco3: 24, pao2: 90, sp });
    const v = r.vv;
    if (v.peepUnres || v.badPeepTot) {
      assert.equal(v.dp, undefined); assert.ok(v.cstat == null || v.cstatSrc === "ventilator"); assert.ok(v.mp == null || !/acvc/.test(v.vmode));
      for (const m of both(r)) assert.doesNotMatch(m, /Driving pressure: \d+ cmH₂O|Compliance and airway resistance are within normal limits/);
    }
    if (v.dp != null && !v.dpUnverified) for (const m of both(r)) assert.match(m, new RegExp("Driving pressure: " + Math.round(v.dp) + " cmH₂O( ⬆️)? \\((plateau − (total |measured )?PEEP)"));
  }
});

/* ---------- Related routes found by the v16.2 investigation ---------- */
test("X1 (updated in v16.3). rejected pCO₂ never drives the ventilatory ratio or a rate target", () => {
  const bad = ventTab({ ph: 7.40, paco2: 300, hco3: 24, pao2: 90, sp: MV({ pco2Target: 40 }) });
  assert.equal(bad.vv.vr, undefined); assert.equal(bad.vv.rrNeed, undefined); assert.equal(bad.vv.veNeed, undefined);
  assert.doesNotMatch(bad.vmsg, /Ventilatory ratio: 6\.8|high dead space/);
  // v16.3 (user decision): a HCO₃ that does not fit no longer pauses the gas, so pCO₂ is used as measured
  const entered = ventTab({ ph: 7.40, paco2: 60, hco3: 24, pao2: 90, sp: MV({ pco2Target: 40 }) });
  assert.ok(entered.x.ab); assert.ok(entered.vv.rrNeed > 0); assert.ok(!entered.vv.vrUnverified);
  assert.match(entered.vmsg, /Ventilatory ratio: 1\.4 \(normal ≈ 1\)/);
});

test("X2. measured minute ventilation: implausible, disputed and extreme values", () => {
  const G = { ph: 7.30, paco2: 50, hco3: hh(7.30, 50), pao2: 90 };
  const tiny = ventTab(Object.assign({}, G, { sp: MV({ ftot: 14, mv: 0.3 }) }));
  assert.equal(tiny.vv.mvBad, 0.3); assert.equal(tiny.vv.veSrc, undefined);
  assert.match(checks(tiny.vmsg), /Measured minute ventilation 0\.3 L\/min is outside 0\.5–60 L\/min: it is not used/);
  const disp = ventTab(Object.assign({}, G, { sp: MV({ ftot: 14, mv: 30 }) }));
  assert.equal(disp.vv.ve, null); assert.equal(disp.vv.vr, undefined); assert.equal(disp.vv.veNeed, undefined);
  assert.match(disp.vmsg, /Minute ventilation: not assessed \(measured 30 vs VT × rate 5\.6 L\/min; recheck\)/);
  const simv = ventTab(Object.assign({}, G, { sp: MV({ vmode: "simv", rr: 12, fmand: 12, fspn: 10, ftot: 22, psupp: 8, mv: 12 }) }));
  assert.equal(simv.vv.ve, 12, "SIMV breaths differ: measured MV is used without the VT × rate comparison");
  const ext = ventTab(Object.assign({}, G, { sp: MV({ vmode: "acpc", pinsp: 14, vt: undefined, vte: undefined, ftot: 30, mv: 45, pco2Target: 40 }) }));
  assert.equal(ext.vv.mvExtreme, true); assert.equal(ext.vv.veNeed, undefined);
  assert.match(checks(ext.vmsg), /Measured minute ventilation 45 L\/min is extreme: confirm it on the ventilator/);
});

test("X3. impossible mean airway pressure or peak pressure, and unusable SpO₂, are reported and not used", () => {
  for (const [sp, why] of [[MV({ mawp: 3, ppeak: 25 }), /below PEEP 5/], [MV({ mawp: 40, ppeak: 25 }), /above the peak pressure 25/], [MV({ mawp: 90 }), /outside 1–60/]]) {
    const v = ABG.ventCalc(sp, null, 40, 90, 40, false);
    assert.equal(v.oi, undefined); assert.ok(v.issues.some((i) => i.key === "mawp" && why.test(i.text)));
  }
  const pk = ventTab({ ph: 7.40, paco2: 40, hco3: 24, pao2: 90, sp: MV({ ppeak: 3, ftot: 14 }) });
  assert.equal(pk.vv.badPpk, true); assert.equal(pk.vv.mp, undefined); assert.equal(pk.vv.cdyn, undefined);
  assert.match(pk.vmsg, /Peak pressure: 3 cmH₂O \(invalid: below PEEP; recheck\)/);
  const low = ABG.ventCalc(MV({ spo2: 45 }), null, 40, null, 40, false);
  assert.equal(low.sf, undefined); assert.ok(low.issues.some((i) => /SpO₂ 45% is below the range used here/.test(i.text) && i.level === "crit"));
  const hi = ABG.ventCalc(MV({ spo2: 120 }), null, 40, null, 40, false);
  assert.equal(hi.sf, undefined); assert.ok(hi.issues.some((i) => /SpO₂ 120% is not possible/.test(i.text)));
});

test("X4. AI-filled values not yet checked: no interpretation or weaning verdict in either message", () => {
  const sp = MV({ vmode: "psv", psupp: 6, peep: 5, ftot: 18, spo2: 96, pplat: undefined });
  const r = ventTab({ ph: 7.40, paco2: 40, hco3: 24, pao2: 90, sp }, { aiPending: true });
  assert.doesNotMatch(r.vmsg, /Meets the numeric criteria|✓ |Ventilator interpretation:/);
  assert.match(r.vmsg, /Ventilator interpretation and weaning screen: not assessed until the AI-filled values are checked/);
  const held = ABG.message(Object.assign({ ab: r.x.ab, ox: r.x.ox, fio2Pct: 40, support: sp, vent: r.vv, aiPending: true }, { ph: 7.40, paco2: 40, pao2: 90, hco3: 24 }));
  assert.doesNotMatch(held, /Meets the numeric criteria|Ventilator interpretation:/);
  const after = ventTab({ ph: 7.40, paco2: 40, hco3: 24, pao2: 90, sp });
  assert.match(after.vmsg, /Weaning screen \(numbers only\)/, "the screen returns once the values are confirmed");
});

test("X5. ARDSNet oxygen goal is tied to confirmed ARDS, not to P/F alone", () => {
  const r = ventTab({ ph: 7.40, paco2: 40, hco3: 24, pao2: 100, sp: MV({ ftot: 14 }) });
  assert.match(r.vtext("o2"), /above the ARDSNet goal \(55–80\).*The ARDSNet goal applies once ARDS is confirmed; otherwise use your unit's usual target/);
  assert.match(r.vtext("ards"), /This grades oxygenation only/);
});

test("X6. randomized: the copied report never pairs a critical input check with a reassuring statement it contradicts", () => {
  let seed = 19; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  for (let i = 0; i < 2500; i++) {
    const ph = +(7.0 + rnd() * 0.55).toFixed(2), paco2 = Math.round(20 + rnd() * 60), pao2 = pick([5, 60, 95, 250, 800]);
    const sp = MV({ vmode: pick(["acvc", "psv", "acpc"]), ftot: pick([14, 20, 30]), psupp: 6, pplat: pick([undefined, 20, 30]), ppeak: pick([undefined, 25, 35]), peepm: pick([undefined, 5, 15]),
      peeptot: pick([undefined, 3, 9]), mawp: pick([undefined, 3, 12]), spo2: pick([undefined, 45, 95, 99]), mv: pick([undefined, 0.3, 7, 30]) });
    const r = ventTab({ ph, paco2, hco3: hh(ph, paco2), pao2, sp });
    for (const m of both(r)) {
      const c = checks(m);
      if (/pO₂ \d+.* is outside the accepted range/.test(c)) assert.doesNotMatch(m, /No acid–base or oxygenation problem|✓ Oxygenation: P\/F|normal oxygenation|P\/F Ratio: /);
      if (/Measured PEEP \d+ (differs|is above)|Total PEEP \d+ is below set PEEP/.test(c)) assert.doesNotMatch(m, /goal ≤ 15\)|Compliance and airway resistance are within normal limits/);
      assert.doesNotMatch(m, /NaN|undefined|Infinity/);
    }
  }
});

/* ---------- v16.4: oxygenation is always part of the interpretation ---------- */
test("O3. the copied message states the oxygenation reading in words (room air, oxygen, above alveolar)", () => {
  const ra = pipeline({ ph: 7.40, paco2: 40, hco3: 24, pao2: 62, age: 50 });
  assert.match(ra.msg, /ABG Interpretation:\nNormal acid–base status, with mild hypoxemia\n(.*\n)*Oxygenation: pO₂ 62 on room air: 60–79\./);
  const o2 = pipeline({ ph: 7.40, paco2: 40, hco3: 24, pao2: 70, age: 50, sp: { mode: "mask", dev: "venturi", fio2Pct: 40 } });
  assert.match(o2.msg, /Oxygenation: pO₂ 70 on FiO₂ 40% is still below 80 \(mild hypoxemia range\)\./);
  const user = pipeline({ ph: 7.40, paco2: 24, hco3: 18, pao2: 184, age: 50 });
  assert.match(user.msg, /Oxygenation: pO₂ 184 on room air is at or above 80\. This pO₂ is above what FiO₂ 21% can give/);
});
test("O4. no oxygen support entered: the pO₂ is still graded, and what is missing is said", () => {
  const noFi = { ph: 7.40, paco2: 40, hco3: 24, pao2: 55, age: 50, sp: { mode: "nc" } };   // the app's default: NC with no flow
  const x = pipeline(noFi);
  assert.equal(x.fio2, null); assert.ok(x.ox); assert.equal(x.ox.noFio2, true); assert.equal(x.ox.grade, "moderate");
  assert.match(x.msg, /ABG Interpretation:\nNormal acid–base status, with moderate hypoxemia \(oxygen support not entered\)/);
  assert.match(x.msg, /Oxygenation: pO₂ 55 is in the moderate hypoxemia range \(40–59\)\. The oxygen support is not entered, so the app cannot tell room air from oxygen/);
  assert.match(x.text("o2"), /Titrate O₂ to SpO₂/);
  const ok = pipeline(Object.assign({}, noFi, { pao2: 95 }));
  assert.match(ok.msg, /with no hypoxemia \(oxygen support not entered\)/);
  assert.doesNotMatch(ok.msg, /NaN|undefined|P\/F Ratio/);
  const old = pipeline(Object.assign({}, noFi, { pao2: 70, age: 80 }));   // age 80: the hypoxemia limit is 80 − 20 = 60
  assert.equal(old.ox.mildLimit, 60); assert.equal(old.ox.grade, "none");
});

test("O5. the copied message writes out the desired-FiO₂ computation and the O₂ requirement", () => {
  const block = (x) => x.msg.split("\n\n").find((b) => /Desired FiO2/.test(b)) || "";
  const ra = block(pipeline({ ph: 7.40, paco2: 40, hco3: 24, pao2: 62, age: 50 }));
  assert.match(ra, /^Desired FiO2: 26% \(NC 1\.5 L\/min\) · estimate; titrate to SpO₂\nComputation \(target pO₂ 84, 104 − 0\.4 × age 50\):/);
  assert.match(ra, /PAO₂ = 713 × FiO₂ − pCO₂ ÷ 0\.8 = 713 × 0\.21 − 40 ÷ 0\.8 = 99\.7 mmHg/);
  assert.match(ra, /a\/A = pO₂ ÷ PAO₂ = 62 ÷ 99\.7 = 0\.622/);
  assert.match(ra, /FiO₂ needed = \(target ÷ a\/A \+ pCO₂ ÷ 0\.8\) ÷ 713 = \(84 ÷ 0\.622 \+ 50\) ÷ 713 = 26%/);
  assert.match(ra, /O₂ requirement: nasal cannula ≈ 1\.5 L\/min, from L\/min = \(FiO₂ − 20\) ÷ 4 = \(26 − 20\) ÷ 4/);
  const mask = block(pipeline({ ph: 7.40, paco2: 40, hco3: 24, pao2: 50, age: 50, sp: { mode: "mask", dev: "venturi", fio2Pct: 40 } }));
  assert.match(mask, /O₂ requirement: 62% is more than a nasal cannula gives \(44% at 6 L\/min\): HFNC or a non-rebreather mask/);
  const mv = block(pipeline({ ph: 7.40, paco2: 40, hco3: 24, pao2: 50, age: 50, sp: { mode: "mv", vmode: "acvc", fio2Pct: 40, vt: 400, peep: 8, rr: 14, height: 170, sex: "m" } }));
  assert.match(mv, /O₂ requirement: set FiO₂ ≈ \d+% on the ventilator/);
  const over = block(pipeline({ ph: 7.40, paco2: 40, hco3: 24, pao2: 45, age: 50, sp: { mode: "mask", dev: "nrm", fio2Pct: 100 } }));
  assert.match(over, /O₂ requirement: more than 100%: oxygen alone cannot reach the target \(shunt physiology\)/);
  const keep = block(pipeline({ ph: 7.40, paco2: 40, hco3: 24, pao2: 82, age: 50, sp: { mode: "nc", ncFlow: 2 } }));   // just below target 84, but ≥ 80
  assert.match(keep, /O₂ requirement: no increase: pO₂ 82 is already adequate \(≥ 80\)/);
  const wean = block(pipeline({ ph: 7.40, paco2: 40, hco3: 24, pao2: 95, age: 50, sp: { mode: "nc", ncFlow: 2 } }));   // above target: lower flow
  assert.match(wean, /O₂ requirement: nasal cannula ≈ 1\.4 L\/min/);
  const noFi = block(pipeline({ ph: 7.40, paco2: 40, hco3: 24, pao2: 62, age: 50, sp: { mode: "nc" } }));
  assert.equal(noFi, "Desired FiO2 and O₂ requirement: need the current oxygen (room air, nasal cannula flow or FiO₂).");
  const alv = block(pipeline({ ph: 7.40, paco2: 24, hco3: 18, pao2: 184, age: 50 }));
  assert.match(alv, /^Desired FiO2 and O₂ requirement: not calculated, because pO₂ 184 is above what FiO₂ 21% can give \(alveolar ≈ 120\)/);
});
