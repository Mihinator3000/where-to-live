export const MONEY_STEP = Math.log(1.5);
export const TDS = [[100, 3], [200, 2.5], [300, 2], [400, 1.5], [500, 1]];

export function factValue(p, key) { const f = p && p.facts && p.facts[key]; const v = f && Number(f.v); return Number.isFinite(v) && v > 0 ? v : null; }

export function factRef(F, places) {
  const base = places.find(p => p.status === "база");
  return factValue(base, F.key) || F.ref || null;
}

export function factScore(F, x, ref) {
  if (x == null || !(Number.isFinite(x) && x > 0)) return null;
  if (F.rule === "tds") { const p = TDS; if (x <= p[0][0]) return 3; for (let i = 1; i < p.length; i++) if (x <= p[i][0]) return p[i - 1][1] + (p[i][1] - p[i - 1][1]) * (x - p[i - 1][0]) / (p[i][0] - p[i - 1][0]); return 1; }
  if (!(Number.isFinite(ref) && ref > 0)) return null;
  return Math.max(1, Math.min(5, 3 - Math.log(x / ref) / MONEY_STEP));
}

export function parseAmount(raw) {
  let s = String(raw).replace(/евро|eur/gi, "").replace(/[\s €$₽]/g, "");
  if (/^[1-9]\d{0,2}([.,]\d{3})+$/.test(s)) s = s.replace(/[.,]/g, "");
  else if (s.includes(".") && s.includes(",")) { const i = Math.max(s.lastIndexOf("."), s.lastIndexOf(",")); s = s.slice(0, i).replace(/[.,]/g, "") + "." + s.slice(i + 1); }
  else s = s.replace(",", ".");
  const v = Number(s);
  return Number.isFinite(v) ? v : NaN;
}
