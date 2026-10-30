export const $ = id => document.getElementById(id);

export const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch]));

export const local = {
  get(k, d) { try { const v = localStorage.getItem("wtl:" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("wtl:" + k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem("wtl:" + k); } catch (e) {} },
};

const RU = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya", ђ: "dj", ј: "j", љ: "lj", њ: "nj", ћ: "c", џ: "dz", ѓ: "g", ќ: "k", і: "i", ї: "i", є: "e", ґ: "g", đ: "dj", ı: "i", ł: "l", ø: "o", ß: "ss", æ: "ae", œ: "oe" };

export function slug(s) {
  const t = String(s || "").toLowerCase().split("").map(ch => (RU[ch] != null ? RU[ch] : ch)).join("");
  return t.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 40).replace(/-+$/, "") || "place";
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
  toastTimer = setTimeout(() => { t.hidden = true; }, Math.max(3500, Math.min(9000, String(text).length * 60)));
}

export const todayISO = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const plural = (n, one, few, many) => n % 10 === 1 && n % 100 !== 11 ? one : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? few : many;

export function daysBetween(a, b) {
  if (!a || !b) return null;
  const d = Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1;
  return d > 0 && d < 3650 ? d : null;
}

export function scoreColor(v) {
  if (!Number.isFinite(v)) return "var(--none)";
  const d = Math.max(-1, Math.min(1, (v - 3) / 2));
  const pole = d >= 0 ? "var(--pos)" : "var(--neg)";
  return `color-mix(in oklab, ${pole} ${Math.round(25 + Math.abs(d) * 75)}%, var(--mid))`;
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
  if (!Number.isFinite(v)) return p.none;
  const d = Math.max(-1, Math.min(1, (v - 3) / 2));
  return mixHex(p.mid, d >= 0 ? p.pos : p.neg, 0.25 + Math.abs(d) * 0.75);
}

const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const lumHex = h => { const [r, g, b] = hex2rgb(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const inkOn = h => { const l = lumHex(h) + 0.05; return 1.05 / l >= l / 0.05 ? "#ffffff" : "#000000"; };
export function heatHex(v) {
  const p = pal();
  if (!Number.isFinite(v)) return p.none;
  const d = Math.max(-1, Math.min(1, (v - 3) / 2));
  return mixHex(p.mid, d >= 0 ? p.pos : p.neg, Math.abs(d));
}
