const T = "2026-10-01T00:00:00.000Z";
const place = (id, name, country, cc, lat, lon, extra = {}) => Object.assign({ id, name, country, cc, lat, lon, status: "кандидат", archetype: "", reason: "", questions: "", ext: {}, osm: null, geonameid: null, createdAt: T, updatedAt: T }, extra);

export const PLACES = [
  place("sankt-peterburg", "Санкт-Петербург", "Россия", "RUS", 59.93863, 30.31413, { status: "база", archetype: "мегаполис" }),
  place("porto", "Порту", "Португалия", "PRT", 41.14961, -8.61099, { archetype: "город у моря", questions: "Проверить сырость зимой" }),
  place("valensiya", "Валенсия", "Испания", "ESP", 39.46975, -0.37739, { archetype: "город у моря" }),
  place("tbilisi", "Тбилиси", "Грузия", "GEO", 41.69411, 44.83368, { archetype: "мегаполис" }),
  place("batumi", "Батуми", "Грузия", "GEO", 41.64228, 41.63392, { archetype: "город у моря" }),
  place("belgrad", "Белград", "Сербия", "SRB", 44.80401, 20.46513, { archetype: "мегаполис" }),
];

const rating = (id, placeId, who, scores, extra = {}) => Object.assign({
  id, place: placeId, who, start: "2026-08-01", end: "2026-08-20", days: 20, season: "пик", mode: "удалёнка", housing: "жилой район",
  retro: true, year: 6, veto: "", review: "", scores, conf: {}, notes: {}, surprises: "", deleted: false, createdAt: T, updatedAt: T,
}, extra);

export const RATINGS = [
  rating("r1", "porto", "Михаил", { "продукты": 3.5, "интернет": 4, "улица": 4, "эстетика": 5, "пешком": 4.5 }, { year: 7, review: "Красиво, но сыро." }),
  rating("r2", "porto", "Вика", { "продукты": 3, "интернет": 4, "улица": 4.5, "эстетика": 4.5, "пешком": 4 }, { year: 6, review: "Много холмов." }),
  rating("r3", "valensiya", "Михаил", { "продукты": 3, "интернет": 4.5, "улица": 4, "эстетика": 4, "море": 5 }, { year: 8 }),
  rating("r4", "tbilisi", "Вика", { "продукты": 4, "интернет": 3.5, "улица": 3.5, "эстетика": 3, "пешком": 3 }, { year: 4, review: "Пыльно и шумно." }),
];

export function repo({ places = PLACES, ratings = RATINGS, weights = [] } = {}) {
  const files = {};
  places.forEach(p => { files[`places/${p.id}.json`] = JSON.stringify(p, null, 1) + "\n"; });
  ratings.forEach(r => { files[`ratings/${r.id}.json`] = JSON.stringify(r, null, 1) + "\n"; });
  weights.forEach(w => { files[`weights/${w.id}.json`] = JSON.stringify(w, null, 1) + "\n"; });
  return files;
}

export async function openApp(page, base, { files = repo(), token = true, me = "Михаил", intro = false, hash = "#/map", offline = false, local = {} } = {}) {
  await page.goto(base + "manifest.webmanifest", 50);
  await page.eval(`(async () => {
    localStorage.clear(); sessionStorage.clear();
    for (const k of await caches.keys()) await caches.delete(k);
    for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
    ${files ? `localStorage.setItem("mock:files", ${JSON.stringify(JSON.stringify(files))});` : ""}
    ${token ? `localStorage.setItem("wtl:token", JSON.stringify("github_pat_TEST_e2e"));` : ""}
    ${me ? `localStorage.setItem("wtl:me", JSON.stringify(${JSON.stringify(me)}));` : ""}
    ${intro ? "" : `localStorage.setItem("wtl:introSeen", "true");`}
    ${offline ? `localStorage.setItem("mock:offline", "1");` : ""}
    ${Object.entries(local).map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(JSON.stringify(v))});`).join("\n")}
  })()`);
  await page.goto(base + hash, 200);
  await page.waitFor(`document.getElementById("syncText") && document.getElementById("syncText").innerText !== "…" && document.getElementById("syncText").innerText !== "Обновляю…"`, 8000, "app booted");
  return page;
}

export const mockFiles = page => page.eval(`JSON.parse(localStorage.getItem("mock:files") || "{}")`);
export const mockLog = page => page.eval(`JSON.parse(localStorage.getItem("mock:log") || "[]")`);
