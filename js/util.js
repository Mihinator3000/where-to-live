export const $ = id => document.getElementById(id);

export const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch]));

export const local = {
  get(k, d) { try { const v = localStorage.getItem("wtl:" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("wtl:" + k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem("wtl:" + k); } catch (e) {} },
};

const RU = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya" };

export function slug(s) {
  const t = String(s || "").toLowerCase().split("").map(ch => (RU[ch] != null ? RU[ch] : ch)).join("");
  return t.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "place";
}

export function uid(prefix) {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const r = Array.from(crypto.getRandomValues(new Uint8Array(4)), b => (b % 36).toString(36)).join("");
  return (prefix ? prefix + "-" : "") + d + "-" + r;
}

let toastTimer = null;
export function toast(text) {
  const t = $("toast");
  if (!t) return;
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

export function daysBetween(a, b) {
  if (!a || !b) return null;
  const d = Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1;
  return d > 0 && d < 3650 ? d : null;
}

export function scoreColor(v) {
  if (v == null) return "var(--none)";
  const d = Math.max(-1, Math.min(1, (v - 3) / 2));
  const pole = d >= 0 ? "var(--pos)" : "var(--neg)";
  return `color-mix(in oklab, ${pole} ${Math.round(25 + Math.abs(d) * 75)}%, var(--mid))`;
}

export function heatStyle(v) {
  if (v == null) return "";
  const d = Math.max(-1, Math.min(1, (v - 3) / 2));
  const pole = d >= 0 ? "var(--pos)" : "var(--neg)";
  return `background: color-mix(in oklab, ${pole} ${Math.round(Math.abs(d) * 100)}%, var(--mid))`;
}

export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

let palette = null;
const hex2rgb = h => { const s = h.trim().replace("#", ""); const f = s.length === 3 ? s.split("").map(c => c + c).join("") : s; return [0, 2, 4].map(i => parseInt(f.slice(i, i + 2), 16)); };
const rgb2hex = a => "#" + a.map(x => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, "0")).join("");
export function mixHex(a, b, t) { const x = hex2rgb(a), y = hex2rgb(b); return rgb2hex(x.map((v, i) => v + (y[i] - v) * t)); }
export function refreshPalette() {
  const cs = getComputedStyle(document.documentElement);
  palette = Object.fromEntries(["pos", "neg", "mid", "none", "ink", "m", "v", "base", "surface"].map(k => [k, cs.getPropertyValue("--" + k).trim() || "#888888"]));
  return palette;
}
export const pal = () => palette || refreshPalette();
export function scoreHex(v) {
  const p = pal();
  if (v == null) return p.none;
  const d = Math.max(-1, Math.min(1, (v - 3) / 2));
  return mixHex(p.mid, d >= 0 ? p.pos : p.neg, 0.25 + Math.abs(d) * 0.75);
}
