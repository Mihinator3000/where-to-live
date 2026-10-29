const NOMINATIM = "https://nominatim.openstreetmap.org";
let last = 0;

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
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error("Поиск недоступен (" + res.status + ")");
  return (await res.json()).map(norm);
}

export async function reverse(lat, lon) {
  await throttle();
  const url = `${NOMINATIM}/reverse?format=jsonv2&addressdetails=1&zoom=10&accept-language=ru&lat=${lat}&lon=${lon}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error("Поиск недоступен (" + res.status + ")");
  const r = await res.json();
  if (r.error) return null;
  return norm(r);
}
