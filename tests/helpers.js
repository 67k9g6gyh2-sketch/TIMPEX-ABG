// Shared helpers: load the calculation engine and run a gas through the same steps as the app's render().
"use strict";
const path = require("node:path");
const ABG = require(path.join(__dirname, "..", "src", "logic.js"));

function pipeline(o) {
  const sp = Object.assign({ mode: "ra" }, o.sp || {});
  const age = o.age === undefined ? 50 : o.age;
  const fio2 = ABG.supportFio2(sp);
  const abRaw = ABG.acidBase({ ph: o.ph, paco2: o.paco2, hco3: o.hco3 == null ? null : o.hco3 });
  const abOk = abRaw && !abRaw.errors.length ? abRaw : null;
  const ox = ABG.oxygenation({ pao2: o.pao2, fio2Pct: fio2, age, paco2: o.paco2 });
  const hyperc = !!(abOk && o.paco2 > 45 && (abOk.primary === "resp-acid" || abOk.primary === "mixed-acid" || (abOk.check && abOk.check.extra === "resp-acid")));
  const pf = o.pao2 != null && fio2 ? o.pao2 / (fio2 / 100) : null;
  const tgt = ABG.effectiveTarget({ custom: null, age, retainer: !!o.retainer, hypercap: hyperc, mode: sp.mode, pf });
  let r = o.pao2 != null && fio2 != null ? ABG.calc({ pao2: o.pao2, paco2: o.paco2, fio2Pct: fio2, age, target: tgt && tgt.kind !== "age" ? tgt.value : null }) : null;
  if (r && !r.errors.length) { r.tgt = tgt; ABG.applyAdequacy(r, ox, tgt, o.pao2); } else r = null;
  const hUse = o.hco3 != null && abOk ? o.hco3 : abOk ? abOk.hco3 : null;
  const def = o.wt && hUse != null ? ABG.bicarbDeficit(o.wt, hUse, 0.5) : null;
  const g = ABG.gasExchange({ pao2: o.pao2, paco2: o.paco2, fio2Pct: fio2, age, ox, support: sp });
  const vent = ABG.ventCalc(sp, abOk, o.paco2, o.pao2, fio2, !!o.retainer, { paused: !!(abRaw && abRaw.mismatch) });
  const rf = ABG.respFailure(abOk, o.pao2, o.paco2);
  const E = o.el ? ABG.electrolytes(o.el, abOk, o.lactate == null ? null : o.lactate) : null;
  const mismatch = !!(abRaw && abRaw.mismatch);
  const sg = ABG.suggestions({ ab: abOk, ox, r, g, rf, lactate: o.lactate == null ? null : o.lactate, def, retainer: !!o.retainer, mismatch,
    paco2: o.paco2, pao2: o.pao2, fio2Pct: fio2, support: sp, vent, tgt, el: E });
  const msg = ABG.message({ ph: o.ph, paco2: o.paco2, pao2: o.pao2, hco3: o.hco3 == null ? null : o.hco3, lactate: o.lactate == null ? null : o.lactate,
    ab: abOk, ox, r, fio2Pct: fio2, def, age, retainer: !!o.retainer, mismatch, support: sp, vent, tgt, el: E, abPaused: abRaw && abRaw.mismatch ? abRaw : null, abRaw });
  const keys = sg.map((s) => s.key), text = (k) => (sg.find((s) => s.key === k) || {}).text || "";
  return { abRaw, ab: abOk, ox, r, g, rf, vent, E, sg, keys, text, msg, def, fio2 };
}
// The Ventilator tab as the app builds it when the ABG tab support is MV (linked): same calls as template.html render()
function ventTab(o, opts) {
  const x = pipeline(o); opts = opts || {};
  const vsp = Object.assign({}, o.sp, { mode: "mv" }), vFi = o.sp.fio2Pct;
  const lab = x.ab, paused = !!(x.abRaw && x.abRaw.mismatch);
  const vv = ABG.ventCalc(vsp, lab, o.paco2, o.pao2, vFi, false, { paused });
  const sgAll = ABG.suggestions({ ab: lab, ox: x.ox, r: x.r, g: x.g, rf: x.rf, retainer: false, paco2: o.paco2, pao2: o.pao2, fio2Pct: vFi, support: vsp, vent: vv, tgt: null });
  const vsug = sgAll.filter((s) => ABG.isVentKey(s.key));
  const extra = opts.aiPending ? [{ text: "Ventilator values were filled from a photo by AI and are not yet checked against the screen: ventilator suggestions are withheld until you confirm them.", level: "crit" }] : [];
  const vmsg = ABG.ventMessage({ support: vsp, vent: vv, fio2Pct: vFi, linked: true, ph: o.ph, paco2: o.paco2, pao2: o.pao2, ab: lab, ox: x.ox, g: x.g, rf: x.rf, r: x.r, tgt: null, retainer: false, aiPending: !!opts.aiPending, extraIssues: extra });
  const vchk = ABG.collectIssues({ abRaw: x.abRaw, vent: vv, pao2: o.pao2, fio2Pct: vFi, extra });
  return { x, vv, vsug, vmsg, vchk, vtext: (k) => (vsug.find((s) => s.key === k) || {}).text || "" };
}
// Henderson–Hasselbalch HCO3 for a pH and pCO2, so test gases are internally consistent
const hh = (ph, paco2) => +ABG.hco3FromPh(ph, paco2).toFixed(1);
module.exports = { ABG, pipeline, ventTab, hh };
