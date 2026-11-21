# TIMPEX ABG

<img src="logo.svg" alt="TIMPEX ABG logo" width="120">

Bedside arterial blood gas reader for when electrolytes aren't back: uses only pH, PaCO₂, PaO₂, HCO₃ (optional), FiO₂ and age.

- **Interpretation** in the form "Severe metabolic acidosis with concomitant respiratory alkalosis", from pH, pCO₂ and HCO₃ only. The traditional label (uncompensated / partially / fully compensated) is shown for reference.
- **Compensation** written out line by line: Winter's formula, metabolic alkalosis formula, acute and chronic respiratory rules.
- **Desired FiO₂** by the a/A ratio method (target pO₂ = 104 − 0.4 × age), with nasal cannula flow, P/F ratio and A-aDO₂.
- **HCO₃ deficit** = 0.5 (or 0.4) × weight × (24 − HCO₃).
- **Message to copy**: values with ⬇️/⬆️, P/F, A-aDO₂, desired FiO₂, HCO₃ deficit, compensation and interpretation.
- Accepts TCO₂, BE and SO₂ from the printout; flags an HCO₃ or TCO₂ that doesn't fit pH and pCO₂.

Works offline once opened; install it from Safari (Share → Add to Home Screen) or Chrome (Install app).

References: Berend K et al. N Engl J Med 2014;371:1434–45 · Shapiro BA et al. Clinical Application of Blood Gases, 5th ed. · Gilbert R, Keighley JF. Am Rev Respir Dis 1974;109:142–5.

Clinical decision aid for trained clinicians. It does not replace clinical judgment or your institution's protocols.
