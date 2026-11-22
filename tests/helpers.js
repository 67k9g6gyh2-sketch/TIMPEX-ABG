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
  const ox = ABG.oxygenation({ pao2: o.pao2, fio2Pct: fio2, age });
  const hyperc = !!(abOk && o.paco2 > 45 && (abOk.primary === "resp-acid" || abOk.primary === "mixed-acid" || (abOk.check && abOk.check.extra === "resp-acid")));
  const pf = o.pao2 != null && fio2 ? o.pao2 / (fio2 / 100) : null;
  const tgt = ABG.effectiveTarget({ custom: null, age, retainer: !!o.retainer, hypercap: hyperc, mode: sp.mode, pf });
  let r = o.pao2 != null && fio2 != null ? ABG.calc({ pao2: o.pao2, paco2: o.paco2, fio2Pct: fio2, age, target: tgt && tgt.kind !== "age" ? tgt.value : null }) : null;
  if (r && !r.errors.length) { r.tgt = tgt; ABG.applyAdequacy(r, ox, tgt, o.pao2); } else r = null;
  const hUse = o.hco3 != null && abOk ? o.hco3 : abOk ? abOk.hco3 : null;
  const def = o.wt && hUse != null ? ABG.bicarbDeficit(o.wt, hUse, 0.5) : null;
  const g = ABG.gasExchange({ pao2: o.pao2, paco2: o.paco2, fio2Pct: fio2, age, ox, support: sp });
  const vent = ABG.ventCalc(sp, abOk, o.paco2, o.pao2, fio2, !!o.retainer);
  const rf = ABG.respFailure(abOk, o.pao2, o.paco2);
  const E = o.el ? ABG.electrolytes(o.el, abOk, o.lactate == null ? null : o.lactate) : null;
  const mismatch = !!(abRaw && abRaw.mismatch);
  const sg = ABG.suggestions({ ab: abOk, ox, r, g, rf, lactate: o.lactate == null ? null : o.lactate, def, retainer: !!o.retainer, mismatch,
    paco2: o.paco2, pao2: o.pao2, fio2Pct: fio2, support: sp, vent, tgt, el: E });
  const msg = ABG.message({ ph: o.ph, paco2: o.paco2, pao2: o.pao2, hco3: o.hco3 == null ? null : o.hco3, lactate: o.lactate == null ? null : o.lactate,
    ab: abOk, ox, r, fio2Pct: fio2, def, age, retainer: !!o.retainer, mismatch, support: sp, vent, tgt, el: E, abPaused: abRaw && abRaw.mismatch ? abRaw : null });
  const keys = sg.map((s) => s.key), text = (k) => (sg.find((s) => s.key === k) || {}).text || "";
  return { abRaw, ab: abOk, ox, r, g, rf, vent, E, sg, keys, text, msg, def, fio2 };
}
// Henderson–Hasselbalch HCO3 for a pH and pCO2, so test gases are internally consistent
const hh = (ph, paco2) => +ABG.hco3FromPh(ph, paco2).toFixed(1);
module.exports = { ABG, pipeline, hh };
