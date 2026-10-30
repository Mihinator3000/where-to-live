const NOMINATIM = "https://nominatim.openstreetmap.org";
let last = 0;

const OFFLINE = "Нет связи: поиск по OpenStreetMap недоступен";
const BUSY = "OpenStreetMap сейчас не отвечает — попробуйте ещё раз через минуту";
const json = async res => { if (!res.ok) throw new Error(BUSY); try { return await res.json(); } catch (e) { throw new Error(BUSY); } };
const get = url => fetch(url, { headers: { Accept: "application/json" } }).catch(() => { throw new Error(OFFLINE); });

async function throttle() {
  const wait = last + 1100 - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  last = Date.now();
}

function pickName(r) {
  const a = r.address || {};
  return r.name || a.city || a.town || a.village || a.hamlet || a.municipality || a.county || a.state || (r.display_name || "").split(",")[0];
}

function norm(r) {
  const a = r.address || {};
  return {
    name: pickName(r),
    label: r.display_name || "",
    lat: Number(Number(r.lat).toFixed(5)),
    lon: Number(Number(r.lon).toFixed(5)),
    cc2: (a.country_code || "").toUpperCase(),
    country: a.country || "",
    osm: r.osm_type && r.osm_id ? { type: r.osm_type, id: r.osm_id } : null,
    kind: r.addresstype || r.type || "",
  };
}

export async function search(q) {
  await throttle();
  const url = `${NOMINATIM}/search?format=jsonv2&addressdetails=1&limit=6&accept-language=ru&q=${encodeURIComponent(q)}`;
  const list = await json(await get(url));
  if (!Array.isArray(list)) throw new Error(BUSY);
  const out = [];
  list.map(norm).forEach(g => { if (!out.some(o => o.name === g.name && Math.abs(o.lat - g.lat) < 0.02 && Math.abs(o.lon - g.lon) < 0.03)) out.push(g); });
  return out;
}

export async function reverse(lat, lon) {
  await throttle();
  const url = `${NOMINATIM}/reverse?format=jsonv2&addressdetails=1&zoom=10&accept-language=ru&lat=${lat}&lon=${lon}`;
  const r = await json(await get(url));
  if (!r || typeof r !== "object" || r.error) return null;
  const a = r.address || {};
  const g = norm(r);
  g.name = a.city || a.town || a.village || a.hamlet || a.municipality || g.name;
  return g;
}
