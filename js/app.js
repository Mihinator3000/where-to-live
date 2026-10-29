import { createModel, fmt, normalize, MIN_COVERAGE } from "./calc.js";
import { Data, DEFAULT_REPO } from "./data.js";
import { RateForm } from "./form.js";
import { MapView } from "./map.js";
import { search, reverse } from "./geo.js";
import { Similar, kgName } from "./similar.js";
import { $, esc, local, toast, scoreColor, scoreHex, pal, refreshPalette, uid } from "./util.js";
import { World, CITY_INDICATORS, MONTHS, fmtValue, toScore, CIVIDIS, haversine } from "./world.js";
import { rankHTML, heatHTML, flagsHTML, radarSVG, tripsHTML, subtableHTML, placesListHTML, placeHref, placeScore, yearsLine, SHORT } from "./views.js";

const TRIPS_BUDGET = 20;
const state = {
  schema: null,
  data: new Data(),
  world: new World(),
  sim: null,
  M: null,
  preset: local.get("preset", "Оба"),
  weights: local.get("weights", null),
  route: { name: "map", arg: "" },
  layers: Object.assign({ country: "", mode: "rel", city: "", places: true, visited: true, simTo: null }, local.get("layers", {})),
  mapView: null,
  form: null,
  sheet: null,
  showEmpty: false,
  placeFilter: "",
};

const canWrite = () => state.data.hasToken;
const slugMe = () => ({ "Михаил": "mikhail", "Вика": "vika" })[local.get("me", "")] || "device";
const useData = () => local.get("worldData", true);

function rebuild() {
  const v = state.data.view();
  state.M = createModel(state.schema, v, { autoData: useData() ? (p, k) => state.world.autoData(p, k) : null });
  const P = state.M.presets;
  if (!P[state.preset] && state.preset !== "Своё") state.preset = "Оба";
  if (state.preset !== "Своё" || !state.weights) state.weights = Object.assign({}, P[state.preset] || P["Оба"]);
}

const W = () => normalize(state.schema.groups, state.weights);

/* ---------- sync status ---------- */
function renderSync() {
  const d = state.data;
  const dot = $("syncDot"), t = $("syncText");
  dot.className = "dot" + (d.status === "live" ? " live" : d.status === "sync" || d.status === "pending" ? " sync" : d.status === "error" || d.status === "auth" ? " err" : "");
  const map = {
    notoken: "Нет токена",
    idle: "…",
    sync: "Синхронизация…",
    live: "Сохранено в GitHub",
    pending: `Не отправлено: ${d.pending.length}`,
    offline: d.pending.length ? `Офлайн · не отправлено: ${d.pending.length}` : "Офлайн · данные из кэша",
    auth: "Токен не подходит",
    error: "Ошибка синхронизации",
  };
  t.textContent = map[d.status] || d.status;
  $("syncBtn").title = d.error || "Обновить данные";
}

/* ---------- routing ---------- */
function parseRoute() {
  const h = location.hash.replace(/^#\/?/, "");
  const [name, ...rest] = h.split("/");
  return { name: name || "map", arg: rest.map(decodeURIComponent).join("/") };
}

function go(hash) { if (location.hash !== hash) location.hash = hash; else route(); }

function route() {
  state.route = parseRoute();
  const r = state.route.name;
  const views = { map: "v-map", rank: "v-rank", places: "v-places", place: "v-place", rate: "v-rate", settings: "v-settings" };
  const id = views[r] || "v-map";
  Object.values(views).forEach(v => { $(v).hidden = v !== id; });
  document.querySelectorAll("[data-nav]").forEach(a => {
    const on = a.dataset.nav === r || (r === "place" && a.dataset.nav === "places");
    if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  if (id !== "v-map") window.scrollTo(0, 0);
  render();
}

function render() {
  renderSync();
  const r = state.route.name;
  if (r === "map" || !["rank", "places", "place", "rate", "settings"].includes(r)) renderMap();
  else if (r === "rank") renderRank();
  else if (r === "places") renderPlaces();
  else if (r === "place") renderPlace(state.route.arg);
  else if (r === "rate") renderRate(state.route.arg);
  else if (r === "settings") renderSettings();
}

/* ---------- banner ---------- */
function bannerHTML() {
  const d = state.data;
  if (!d.hasToken) return `<div class="banner"><b>Данные не подключены.</b> Карта и мировые показатели работают, а чтобы видеть и сохранять наши оценки, введите токен в <a href="#/settings">настройках</a>.</div>`;
  if (d.status === "auth") return `<div class="banner err"><b>Токен не подходит.</b> ${esc(d.error)}. Проверьте его в <a href="#/settings">настройках</a>.</div>`;
  if (d.error && d.status !== "live") return `<div class="banner err">${esc(d.error)}</div>`;
  if (d.error) return `<div class="banner">${esc(d.error)}</div>`;
  return "";
}

/* ---------- rank ---------- */
function renderRank() {
  const M = state.M;
  const names = ["Поровну"].concat(M.PEOPLE, ["Оба"]);
  if (state.preset === "Своё") names.push("Своё");
  const norm = W();
  const trips = tripCount();
  const el = $("v-rank");
  el.innerHTML = `
    <header class="stack" style="gap:8px"><h1>Рейтинг</h1>
      <p class="muted small">Михаил и Вика · мест: ${M.places.filter(p => !M.isBase(p)).length} · оценок: ${M.ratings.length} · поездок-разведок: ${trips} из ${TRIPS_BUDGET}</p>
      <div class="legend" aria-label="Обозначения"><span><i class="sw m"></i>Михаил</span><span><i class="sw v"></i>Вика</span><span><i class="sw res"></i>Живущие</span><span><i class="sw data"></i>Данные</span><span><i class="sw base"></i>СПб = 3</span></div>
    </header>
    ${bannerHTML()}
    <section class="block">
      <div class="sec-head"><h2>Места</h2><div class="seg" role="group" aria-label="Чьи веса" id="presets">${names.map(n => `<button type="button" aria-pressed="${n === state.preset}" data-p="${esc(n)}">${esc(n)}</button>`).join("")}</div></div>
      <div class="panel">
        <details class="weights" id="wdetails"${local.get("wopen", false) ? " open" : ""}>
          <summary>Веса групп: ${esc(state.preset)}${!M.hasOwnWeights ? " · своих весов пока нет, у всех поровну" : ""}</summary>
          <div class="wgrid" id="wgrid">${M.GROUPS.map(g => `<label class="wrow" for="w-${g.key}"><span>${esc(g.name)}</span><span class="num muted">${Math.round(norm[g.key])}%</span><input type="range" id="w-${g.key}" data-g="${g.key}" min="0" max="100" step="1" value="${Math.round(state.weights[g.key] || 0)}"></label>`).join("")}</div>
          ${canWrite() ? `<div class="wsave" id="wsave"><span>Сохранить эти веса как веса:</span>${M.PEOPLE.map((w, i) => `<button type="button" class="btn ghost small" data-wsave="${i}">${esc(w)}</button>`).join("")}</div>` : ""}
        </details>
        <div class="rank" id="rank">${rankHTML(M, norm)}</div>
      </div>
      <p class="small muted">Полоса — итог места относительно СПб (3): вправо лучше, влево хуже. Точки — итог по оценкам Михаила и Вики. «Покрытие» — доля веса групп, по которым есть оценки или данные. «Место 2–4» — разброс позиции при сдвиге любого веса на ±20% и при весах каждого из нас.${useData() ? " Колонка «Данные» заполняется мировыми показателями (выключается в настройках)." : ""}</p>
    </section>
    <section class="block">
      <div class="sec-head"><h2>Места × группы</h2><div class="scale-key"><span>хуже СПб</span><i style="background: var(--neg)"></i><i style="background: color-mix(in oklab, var(--neg) 45%, var(--mid))"></i><i style="background: var(--mid)"></i><i style="background: color-mix(in oklab, var(--pos) 45%, var(--mid))"></i><i style="background: var(--pos)"></i><span>лучше</span></div></div>
      <div class="panel scroll"><table class="heat">${heatHTML(M, norm)}</table></div>
    </section>
    <section class="block">
      ${(() => { const f = flagsHTML(M); return `<div class="sec-head"><h2>Флаги</h2><span class="small muted">${f.count ? "всего " + f.count : ""}</span></div><div class="panel"><div class="flags">${f.html}</div></div>`; })()}
    </section>`;
  $("wdetails").addEventListener("toggle", e => local.set("wopen", e.target.open));
  $("presets").addEventListener("click", e => {
    const b = e.target.closest("button[data-p]");
    if (!b || b.dataset.p === "Своё") return;
    state.preset = b.dataset.p;
    state.weights = Object.assign({}, state.M.presets[state.preset]);
    local.set("preset", state.preset); local.set("weights", state.weights);
    renderRank();
  });
  $("wgrid").addEventListener("input", e => {
    const inp = e.target.closest("input[data-g]");
    if (!inp) return;
    state.weights[inp.dataset.g] = Number(inp.value);
    state.preset = "Своё";
    local.set("preset", state.preset); local.set("weights", state.weights);
    const n = W();
    $("rank").innerHTML = rankHTML(state.M, n);
    $("wgrid").querySelectorAll(".wrow").forEach((row, i) => { row.querySelector(".num").textContent = Math.round(n[state.M.GROUPS[i].key]) + "%"; });
    const seg = $("presets");
    if (!seg.querySelector('[data-p="Своё"]')) seg.insertAdjacentHTML("beforeend", `<button type="button" aria-pressed="true" data-p="Своё">Своё</button>`);
    seg.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.p === "Своё")));
  });
  const ws = $("wsave");
  if (ws) ws.addEventListener("click", async e => {
    const b = e.target.closest("button[data-wsave]");
    if (!b) return;
    const who = state.M.PEOPLE[Number(b.dataset.wsave)];
    const n = W();
    const w = Object.fromEntries(state.M.GROUPS.map(g => [g.key, Math.round(n[g.key])]));
    b.disabled = true;
    try {
      const r = await state.data.saveWeights(who, w);
      state.preset = who; local.set("preset", who);
      toast(r === "queued" ? "Нет связи: веса отправятся позже" : `Веса сохранены как веса: ${who}`);
    } catch (err) { toast(err.message); }
    b.disabled = false;
  });
}

function tripCount() {
  const seen = new Set();
  state.M.ratings.forEach(r => seen.add(r.place + "|" + (r.start || r.id)));
  return seen.size;
}

/* ---------- places ---------- */
function renderPlaces() {
  const el = $("v-places");
  el.innerHTML = `<header class="stack" style="gap:8px"><h1>Места</h1><p class="small muted">Где были и куда смотрим. Новое место — через поиск на <a href="#/map">карте</a>.</p></header>
    ${bannerHTML()}
    <input type="search" id="placeFilter" placeholder="Фильтр по названию или стране" value="${esc(state.placeFilter)}" aria-label="Фильтр мест">
    <div class="panel plist" id="plist">${placesListHTML(state.M, W(), state.placeFilter)}</div>`;
  $("placeFilter").addEventListener("input", e => { state.placeFilter = e.target.value; $("plist").innerHTML = placesListHTML(state.M, W(), state.placeFilter); });
}

/* ---------- place dossier ---------- */
function placeCity(p) { return state.world.cities ? state.world.placeCity(p) : null; }

function worldRowsHTML(cc, city) {
  const Wd = state.world;
  let html = "";
  const rows = [];
  if (cc) Wd.indicators.forEach(ind => {
    const r = Wd.raw(cc, ind.key);
    if (!r) return;
    rows.push({ ind, v: r[0], year: r[1], s: Wd.countryScore(cc, ind.key), level: "страна" });
  });
  if (city) CITY_INDICATORS.forEach(ind => {
    const v = Wd.cityValue(city, ind.key);
    if (v == null) return;
    rows.push({ ind, v, s: Wd.cityScore(city, ind.key), level: city.synthetic ? "точка" : "город" });
  });
  const groups = state.schema.groups;
  groups.forEach(g => {
    const rs = rows.filter(r => r.ind.group === g.key);
    if (!rs.length) return;
    html += `<div class="small muted" style="margin-top:8px;font-weight:600">${esc(g.name)}</div>`;
    rs.forEach(r => {
      html += `<div class="world-row"><span>${esc(r.ind.name)}<small>${esc(r.level)}${r.year ? " · " + r.year : ""}${r.ind.source ? " · " + esc(r.ind.source) : ""}</small></span><span class="v">${esc(fmtValue(r.ind, r.v))}</span><span class="s" style="background:${r.s == null ? "transparent" : scoreColor(r.s)};color:${r.s != null && Math.abs(r.s - 3) >= 1.4 ? "var(--on-strong)" : "var(--ink)"}" title="Шкала 1–5, Россия/СПб = 3">${r.s == null ? "" : fmt(r.s)}</span></div>`;
    });
  });
  return html || `<p class="small muted">Мировых данных по этому месту нет.</p>`;
}

function climateSVG(city, ref) {
  if (!city || !Array.isArray(city.t)) return "";
  const Wd = 340, H = 150, padL = 26, padB = 18, padT = 8;
  const all = city.t.concat(ref && Array.isArray(ref.t) ? ref.t : []);
  const tmin = Math.min(-10, Math.floor(Math.min(...all) / 5) * 5), tmax = Math.max(30, Math.ceil(Math.max(...all) / 5) * 5);
  const pmax = Math.max(100, ...(city.p || [0]));
  const x = i => padL + (i + 0.5) * (Wd - padL) / 12;
  const y = t => padT + (tmax - t) / (tmax - tmin) * (H - padT - padB);
  let g = "";
  for (let t = tmin; t <= tmax; t += 10) g += `<line x1="${padL}" x2="${Wd}" y1="${y(t)}" y2="${y(t)}" stroke="var(--line)"/><text x="2" y="${y(t) + 3}">${t}°</text>`;
  if (Array.isArray(city.p)) city.p.forEach((p, i) => { if (p == null) return; const h = p / pmax * (H - padT - padB) * 0.6; g += `<rect x="${x(i) - 7}" y="${H - padB - h}" width="14" height="${h}" fill="var(--pos)" opacity="0.25"><title>${MONTHS[i]}: ${p} мм</title></rect>`; });
  const line = (arr, color, dash) => `<polyline fill="none" stroke="${color}" stroke-width="2" ${dash ? `stroke-dasharray="${dash}"` : ""} points="${arr.map((t, i) => t == null ? "" : `${x(i).toFixed(1)},${y(t).toFixed(1)}`).join(" ")}"/>`;
  if (ref && Array.isArray(ref.t) && ref !== city) g += line(ref.t, "var(--base)", "4 3");
  g += line(city.t, "var(--v)");
  city.t.forEach((t, i) => { if (t != null) g += `<circle cx="${x(i)}" cy="${y(t)}" r="6" fill="transparent" data-tip="${MONTHS[i]}: ${t} °C${city.p ? ", осадки " + city.p[i] + " мм" : ""}"/>`; });
  MONTHS.forEach((m, i) => { g += `<text x="${x(i)}" y="${H - 4}" text-anchor="middle">${m[0]}</text>`; });
  return `<svg viewBox="0 0 ${Wd} ${H}" role="img" aria-label="Климат по месяцам">${g}</svg>`;
}

function similarHTML(list, opts = {}) {
  if (!list || !list.length) return `<p class="small muted">${opts.empty || "Похожих мест не нашлось: мало данных."}</p>`;
  return `<div class="sim">${list.map(x => {
    const c = x.city;
    const why = [x.why.close.length ? "похожи: " + x.why.close.join(", ") : "", x.why.far.length ? "отличаются: " + x.why.far.join(", ") : ""].filter(Boolean).join(" · ");
    return `<div class="sim-row"><button type="button" data-city="${c.id}">${esc(c.n)}<span class="muted" style="font-weight:400"> · ${esc(state.world.nameOf(c.cc))}</span></button><span class="pct">${x.pct}%</span>${why ? `<small>${esc(why)}</small>` : ""}</div>`;
  }).join("")}</div>`;
}

function similarCountriesHTML(list) {
  if (!list || !list.length) return `<p class="small muted">Мало данных для сравнения.</p>`;
  return `<div class="sim">${list.map(x => `<div class="sim-row"><button type="button" data-country="${x.cc}">${esc(state.world.nameOf(x.cc))}</button><span class="pct">${x.pct}%</span>${x.why.close.length || x.why.far.length ? `<small>${esc([x.why.close.length ? "похожи: " + x.why.close.join(", ") : "", x.why.far.length ? "отличаются: " + x.why.far.join(", ") : ""].filter(Boolean).join(" · "))}</small>` : ""}</div>`).join("")}</div>`;
}

function externalLinks(name, en) {
  const q = encodeURIComponent(en || name);
  return `<div class="btns"><a class="btn ghost small" href="https://www.numbeo.com/cost-of-living/in/${encodeURIComponent((en || name).replace(/\s+/g, "-"))}" target="_blank" rel="noopener noreferrer">Numbeo</a><a class="btn ghost small" href="https://weatherspark.com/search?q=${q}" target="_blank" rel="noopener noreferrer">Weather Spark</a><a class="btn ghost small" href="https://nomads.com/search?q=${q}" target="_blank" rel="noopener noreferrer">Nomads</a><a class="btn ghost small" href="https://ru.wikipedia.org/w/index.php?search=${encodeURIComponent(name)}" target="_blank" rel="noopener noreferrer">Википедия</a></div>`;
}

function renderPlace(id) {
  const M = state.M;
  const p = M.PLACE[id];
  const el = $("v-place");
  if (!p) {
    el.innerHTML = `${bannerHTML()}<div class="banner">Место не найдено. <a href="#/places">Все места</a></div>`;
    return;
  }
  const norm = W();
  const t = placeScore(M, p, norm);
  const ranks = M.ranksFor(norm);
  const city = placeCity(p);
  const ref = state.world.spbCity;
  const onlyData = !M.isBase(p) && !M.ratingsOf(p.id).length && t.score != null;
  const statuses = state.schema.statuses;
  el.innerHTML = `
    ${bannerHTML()}
    <header class="place-head">
      <a class="small muted" href="#/places">← Все места</a>
      <h1>${esc(p.name)}</h1>
      <div class="line">
        ${p.country ? `<span class="chip">${esc(p.country)}</span>` : ""}
        <span class="chip${M.isBase(p) ? " solid" : ""}">${esc(p.status || "кандидат")}</span>
        ${p.archetype ? `<span class="chip">${esc(p.archetype)}</span>` : ""}
        ${p.lat != null ? `<a class="btn ghost small" href="#/map" data-focus="${esc(p.id)}">На карте</a>` : ""}
        ${!M.isBase(p) ? `<a class="btn small" href="#/rate/new/${encodeURIComponent(p.id)}">Оценить</a>` : ""}
      </div>
    </header>
    <div class="panel pad stack" style="gap:8px">
      <div class="bigscore"><b>${M.isBase(p) ? "3.0" : fmt(t.score)}</b><span class="muted">${M.isBase(p) ? "база по определению" : `из 5 · покрытие ${Math.round(t.coverage * 100)}%${ranks[p.id] ? ` · #${ranks[p.id]} в рейтинге` : t.score != null && t.coverage < MIN_COVERAGE ? " · мало оценок для рейтинга" : ""}`}</span></div>
      ${onlyData ? `<p class="small muted">Своих оценок нет: итог посчитан только по мировым данным.</p>` : ""}
      <div class="legend"><span><i class="sw m"></i>Михаил</span><span><i class="sw v"></i>Вика</span><span><i class="sw res"></i>Живущие</span><span><i class="sw data"></i>Данные</span><span><i class="sw base"></i>СПб = 3</span></div>
    </div>
    <div class="panel"><div class="dossier"><div class="radar">${radarSVG(M, p)}</div><div class="trips">${tripsHTML(M, p, canWrite())}</div></div></div>
    <section class="block">
      <div class="sec-head"><h2>Подкатегории</h2><label class="toggle"><input type="checkbox" id="showEmpty"${state.showEmpty ? " checked" : ""}> Показать пустые</label></div>
      <div class="panel scroll"><table class="subtable">${subtableHTML(M, p, state.showEmpty)}</table></div>
    </section>
    <section class="block">
      <div class="sec-head"><h2>Мировые данные</h2><span class="small muted">${city && !city.synthetic ? "климат: " + esc(city.n) + (p.lat != null ? ", " + Math.round(haversine(p, city)) + " км" : "") + " · " + esc(kgName(city.kg)) : ""}</span></div>
      <div class="panel pad stack">
        ${city && Array.isArray(city.t) ? `<div class="clim">${climateSVG(city, ref)}</div><div class="legend small"><span><i class="sw v"></i>${esc(p.name)}, °C</span>${ref && ref !== city ? `<span><i class="sw base" style="width:14px;height:0;border-top:2px dashed var(--base)"></i>СПб</span>` : ""}<span><i class="sw" style="background:var(--pos);opacity:.4;border-radius:2px"></i>осадки</span></div>` : ""}
        <div class="world">${worldRowsHTML(p.cc, city)}</div>
        ${externalLinks(p.name, city && city.en)}
      </div>
    </section>
    <section class="block">
      <div class="sec-head"><h2>Похожие места</h2><span class="small muted">по весам «${esc(state.preset)}»</span></div>
      <div class="panel pad" id="simBox"><p class="small muted">Считаю…</p></div>
    </section>
    <section class="block">
      <div class="sec-head"><h2>Карточка места</h2></div>
      <form class="panel pad stack" id="placeForm">
        <div class="frow">
          <label class="field"><span class="lbl">Название</span><input type="text" name="name" value="${esc(p.name)}" ${canWrite() ? "" : "disabled"}></label>
          <label class="field"><span class="lbl">Статус</span><select name="status" ${canWrite() ? "" : "disabled"}>${statuses.map(s => `<option${s === p.status ? " selected" : ""}>${esc(s)}</option>`).join("")}</select></label>
          <label class="field"><span class="lbl">Архетип</span><input type="text" name="archetype" value="${esc(p.archetype || "")}" placeholder="курорт, город у моря, мегаполис, горы…" ${canWrite() ? "" : "disabled"}></label>
        </div>
        <label class="field"><span class="lbl">Причина отсева</span><input type="text" name="reason" value="${esc(p.reason || "")}" ${canWrite() ? "" : "disabled"}></label>
        <label class="field"><span class="lbl">Вопросы к следующей поездке</span><textarea name="questions" rows="3" ${canWrite() ? "" : "disabled"}>${esc(p.questions || "")}</textarea></label>
        ${canWrite() ? `<div class="btns"><button type="submit" class="btn">Сохранить карточку</button><span class="msg" id="placeMsg"></span></div>` : ""}
      </form>
    </section>`;
  $("showEmpty").addEventListener("change", e => { state.showEmpty = e.target.checked; renderPlace(id); });
  const pf = $("placeForm");
  pf.addEventListener("submit", async e => {
    e.preventDefault();
    const f = new FormData(pf);
    const doc = Object.assign({}, p, { name: String(f.get("name") || p.name).trim() || p.name, status: f.get("status"), archetype: String(f.get("archetype") || "").trim(), reason: String(f.get("reason") || "").trim(), questions: String(f.get("questions") || "").trim() });
    try {
      const { r } = await state.data.savePlace(doc, false);
      toast(r === "queued" ? "Нет связи: отправится позже" : "Карточка сохранена");
    } catch (err) { $("placeMsg").textContent = err.message; $("placeMsg").className = "msg err"; }
  });
  el.querySelector("[data-focus]")?.addEventListener("click", e => { e.preventDefault(); focusPlace(p.id); });
  fillSimilar(p);
}

async function fillSimilar(p) {
  const box = $("simBox");
  if (!box) return;
  await state.world.loadCities();
  if (!state.sim) state.sim = new Similar(state.world, state.schema.groups);
  const city = state.world.placeCity(p);
  if (!p.cc && !city) { box.innerHTML = `<p class="small muted">У места нет координат и страны — сравнивать не с чем.</p>`; return; }
  const list = state.sim.similarCities({ cc: p.cc, city: city && !city.synthetic ? city : null, lat: p.lat, lon: p.lon }, W(), { k: 10 });
  if (!$("simBox")) return;
  $("simBox").innerHTML = similarHTML(list) + `<div class="btns" style="margin-top:10px"><button type="button" class="btn ghost small" id="simMap">Показать на карте</button></div>`;
  $("simBox").addEventListener("click", e => {
    const b = e.target.closest("[data-city]");
    if (b) { const c = state.world.cities.find(x => String(x.id) === b.dataset.city); if (c) { go("#/map"); setTimeout(() => openCity(c, true), 50); } }
  });
  $("simMap").addEventListener("click", () => { state.layers.city = "similar"; state.layers.simTo = { type: "place", id: p.id }; saveLayers(); go("#/map"); });
}

/* ---------- rate ---------- */
function renderRate(arg) {
  if (!state.form) {
    state.form = new RateForm($("rateForm"), state.schema, {
      canWrite,
      save: async body => {
        const res = await state.data.saveRating(body);
        return res;
      },
      saved: (res, placeId) => {
        toast(res.r === "queued" ? "Нет связи: оценка сохранена на телефоне и отправится позже" : "Сохранено. Рейтинг обновился.");
        go(placeHref(placeId));
      },
      remove: async rid => {
        const r = state.M.ratings.find(x => x.id === rid) || state.data.view().ratings.find(x => x.id === rid);
        if (!r) throw new Error("Оценка не найдена");
        await state.data.deleteRating(r);
      },
      removed: () => { toast("Оценка удалена."); go("#/places"); },
    });
  }
  state.form.setPlaces(state.M.places);
  if (arg && arg.startsWith("new/")) {
    state.form.startFor(arg.slice(4));
    history.replaceState(null, "", "#/rate");
  } else if (arg) {
    const r = state.data.view().ratings.find(x => x.id === arg);
    if (r) state.form.load(r);
    history.replaceState(null, "", "#/rate");
  }
  state.form.sync();
  if (!$("rateBanner")) $("rateForm").insertAdjacentHTML("afterbegin", `<div id="rateBanner"></div>`);
  $("rateBanner").innerHTML = bannerHTML();
}

/* ---------- settings ---------- */
function renderSettings() {
  const d = state.data;
  const me = local.get("me", "");
  const theme = local.get("theme", "auto");
  const owner = (d.repo.split("/")[0] || "Mihinator3000");
  const device = /iPhone|Android/i.test(navigator.userAgent) ? "phone" : "mac";
  const tokenUrl = `https://github.com/settings/personal-access-tokens/new?name=${encodeURIComponent("where-to-live-" + device + "-" + new Date().toISOString().slice(0, 10))}&description=${encodeURIComponent("Где жить: чтение и запись данных")}&target_name=${encodeURIComponent(owner)}&expires_in=none&contents=write`;
  const ind = state.world.indicators;
  $("v-settings").innerHTML = `
    <header><h1>Настройки</h1></header>
    <section class="block"><h2>Кто я на этом телефоне</h2>
      <div class="panel pad stack"><div class="seg" role="group" id="meSeg">${state.schema.people.map(w => `<button type="button" data-me="${esc(w)}" aria-pressed="${w === me}">${esc(w)}</button>`).join("")}</div><p class="small muted">Подставляется в форму оценки. Оценивает каждый сам, не глядя в оценки другого.</p></div>
    </section>
    <section class="block"><h2>Доступ к данным</h2>
      <form class="panel pad stack" id="tokenForm">
        <p class="small">Оценки хранятся в приватном репозитории GitHub. Сайт читает и пишет туда напрямую с этого устройства по токену. Токен хранится только здесь и уходит только на api.github.com.</p>
        <label class="field"><span class="lbl">Репозиторий с данными</span><input type="text" name="repo" value="${esc(d.repo)}" spellcheck="false" autocapitalize="off"></label>
        <input type="text" name="username" value="where-to-live-${esc(slugMe())}" autocomplete="username" hidden>
        <label class="field"><span class="lbl">Fine-grained токен ${d.hasToken ? "(сохранён, введите новый, чтобы заменить)" : ""}</span><input type="password" name="token" placeholder="github_pat_…" spellcheck="false" autocapitalize="off" autocomplete="current-password"></label>
        <div class="btns"><button type="submit" class="btn">Сохранить и проверить</button>${d.hasToken ? `<button type="button" class="btn danger" id="forget">Забыть токен на этом устройстве</button>` : ""}</div>
        <p class="msg" id="tokenMsg" role="status">${d.hasToken ? esc(statusLine()) : ""}</p>
        <details><summary class="small">Как получить токен</summary><ol class="small help" style="padding-left:18px">
          <li>Откройте <a href="${esc(tokenUrl)}" target="_blank" rel="noopener noreferrer">создание токена на GitHub</a> (войти под аккаунтом Михаила). Имя, срок «без срока» и право Contents: Read and write уже подставлены.</li>
          <li>Repository access → Only select repositories → <b>${esc(d.repo.split("/")[1] || "where-to-live-data")}</b>.</li>
          <li>Generate token, скопируйте и вставьте сюда. Для телефона Вики — отдельный токен с её именем, чтобы отзывать независимо.</li>
          <li>Сохраните токен ещё и в Связке ключей или менеджере паролей: на сайт его можно ввести заново за минуту.</li></ol></details>
      </form>
    </section>
    <section class="block"><h2>Вид</h2>
      <div class="panel pad stack">
        <div class="seg" role="group" id="themeSeg">${[["auto", "Как в системе"], ["light", "Светлая"], ["dark", "Тёмная"]].map(([k, n]) => `<button type="button" data-theme="${k}" aria-pressed="${k === theme}">${n}</button>`).join("")}</div>
        <label class="toggle"><input type="checkbox" id="useData"${useData() ? " checked" : ""}> Мировые показатели в колонке «Данные» и в итоге</label>
        <p class="small muted">Показатели страны и климат города переводятся в шкалу 1–5, где Россия/СПб = 3, и входят в итог подкатегории по правилам методики: где туристу видно мало, у данных больше веса.</p>
      </div>
    </section>
    <section class="block"><h2>На экран «Домой»</h2>
      <div class="panel pad help"><span>iPhone: Safari → Поделиться → «На экран „Домой“». Открывайте с иконки: так данные не стираются через неделю, как во вкладке Safari.</span><span>У приложения с экрана «Домой» своё хранилище, поэтому токен нужно ввести уже в нём.</span></div>
    </section>
    <section class="block"><h2>Копия данных</h2>
      <div class="panel pad stack"><p class="small muted">Всё, что видно сейчас (места, оценки, веса), одним файлом JSON.</p><div class="btns"><button type="button" class="btn ghost" id="exportBtn">Скачать JSON</button><button type="button" class="btn ghost" id="refreshBtn">Обновить из GitHub</button></div></div>
    </section>
    <section class="block"><h2>Источники данных</h2>
      <div class="panel pad small help">
        <span>Карта: © участники OpenStreetMap (ODbL), тайлы OSM. Поиск: Nominatim, данные © OpenStreetMap. Границы: Natural Earth (public domain), показаны de facto.</span>
        <span>Города: GeoNames (CC BY 4.0). Климат: CHELSA V2.1, 1981–2010 (CC0). Световой день — расчёт по формуле NOAA.</span>
        ${ind.length ? `<span>Показатели стран (выгрузка ${esc(state.world.generated)}): ${[...new Set(ind.map(i => `${i.source}${i.license ? " (" + i.license + ")" : ""}`))].map(esc).join("; ")}. Значения переведены в шкалу 1–5 приложением.</span>` : ""}
        <span>Код: <a href="https://github.com/Mihinator3000/where-to-live" target="_blank" rel="noopener noreferrer">github.com/Mihinator3000/where-to-live</a>.</span>
      </div>
    </section>`;
  $("meSeg").addEventListener("click", e => { const b = e.target.closest("[data-me]"); if (!b) return; local.set("me", b.dataset.me); renderSettings(); });
  $("themeSeg").addEventListener("click", e => { const b = e.target.closest("[data-theme]"); if (!b) return; setTheme(b.dataset.theme); renderSettings(); });
  $("useData").addEventListener("change", e => { local.set("worldData", e.target.checked); rebuild(); });
  $("tokenForm").addEventListener("submit", async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const token = String(f.get("token") || "");
    d.setCredentials(String(f.get("repo") || DEFAULT_REPO), token || null);
    e.target.querySelector('[name="token"]').value = "";
    $("tokenMsg").textContent = "Проверяю…";
    await d.refresh();
    $("tokenMsg").textContent = statusLine();
    $("tokenMsg").className = "msg" + (d.status === "live" ? "" : " err");
    if (d.status === "live") toast("Подключено: данные загружены");
  });
  $("forget")?.addEventListener("click", () => { d.forget(); toast("Токен и кэш удалены с этого устройства"); renderSettings(); });
  $("exportBtn").addEventListener("click", () => {
    const v = state.data.view();
    const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), places: v.places, ratings: v.ratings, weights: v.weightDocs }, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `where-to-live-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  $("refreshBtn").addEventListener("click", () => d.refresh());
}

function statusLine() {
  const d = state.data;
  if (d.status === "live") {
    const v = d.view();
    return `Подключено к ${d.repo}: мест ${v.places.length}, оценок ${v.ratings.filter(r => !r.deleted).length}.`;
  }
  return d.error || "";
}

/* ---------- map ---------- */
function saveLayers() { local.set("layers", state.layers); }

function placeMarkers() {
  const M = state.M, norm = W();
  return M.places.map(p => {
    const t = placeScore(M, p, norm);
    const out = p.status === "отсев" || M.vetoed(p);
    return { id: p.id, name: p.name, lat: p.lat, lon: p.lon, base: M.isBase(p), out, color: M.isBase(p) ? "var(--base)" : t.score == null ? "var(--none)" : scoreColor(t.score), text: M.isBase(p) ? "" : t.score == null ? "" : fmt(t.score) };
  });
}

function visitedBy() {
  const M = state.M, out = {};
  M.ratings.forEach(r => {
    const p = M.PLACE[r.place];
    if (!p || !p.cc) return;
    (out[p.cc] = out[p.cc] || new Set()).add(r.who);
  });
  M.places.filter(M.isBase).forEach(p => { if (p.cc) (out[p.cc] = out[p.cc] || new Set()).add("*"); });
  return out;
}

function countryLegend() {
  const L = state.layers, Wd = state.world;
  const ind = Wd.IND[L.country];
  if (!ind) return null;
  if (L.mode === "raw") {
    const vals = Object.keys(Wd.countries).map(iso => { const r = Wd.raw(iso, ind.key); return r ? r[0] : null; });
    const br = Wd.quantiles(vals, 5);
    const flip = ind.dir < 0;
    return { ind, color: v => { if (v == null) return null; let k = br.findIndex(b => v < b); if (k < 0) k = 4; return CIVIDIS[flip ? 4 - k : k]; }, ramp: flip ? CIVIDIS.slice().reverse() : CIVIDIS, lo: fmtValue(ind, Math.min(...vals.filter(v => v != null))), hi: fmtValue(ind, Math.max(...vals.filter(v => v != null))), raw: true };
  }
  return { ind, rel: true };
}

function countryStyle() {
  const L = state.layers, Wd = state.world;
  const visited = L.visited ? visitedBy() : {};
  const leg = countryLegend();
  const M = state.M;
  return iso => {
    let fill = null;
    if (leg) {
      if (leg.raw) { const r = Wd.raw(iso, leg.ind.key); fill = r ? leg.color(r[0]) : null; }
      else { const s = Wd.countryScore(iso, leg.ind.key); fill = s == null ? null : scoreHex(s); }
    }
    const v = visited[iso];
    const P = pal();
    let color = "rgba(80,90,100,0.35)", weight = 0.6, dashArray = null;
    if (v) {
      const m = v.has(M.PEOPLE[0]), w = v.has(M.PEOPLE[1]);
      color = m && w || v.has("*") ? P.ink : m ? P.m : P.v;
      weight = 2.2;
      if (!(m && w) && !v.has("*")) dashArray = "6 4";
    }
    return { fill: true, fillColor: fill || "#000000", fillOpacity: fill ? 0.55 : 0, color, weight, dashArray, opacity: 1 };
  };
}

function cityColorer() {
  const L = state.layers, Wd = state.world;
  if (!L.city) return null;
  if (L.city === "similar") {
    const target = similarTarget();
    if (!target) return null;
    if (!state.sim) state.sim = new Similar(Wd, state.schema.groups);
    const list = state.sim.similarCities(target.x, W(), { k: 60 });
    const pct = new Map(list.map(x => [x.city.id, x.pct]));
    return { list: list.map(x => x.city), fn: c => { const p = pct.get(c.id); return p == null ? null : { fill: scoreHex(1 + (p - 40) / 15) }; }, label: c => `${c.n}: похоже на ${pct.get(c.id)}%`, legend: { title: `Похожие на «${target.name}»`, rel: true, lo: "меньше", hi: "больше" } };
  }
  if (L.city === "predict") {
    const fn = predictor();
    if (!fn) return null;
    const cache = new Map();
    const get = c => { if (!cache.has(c.id)) cache.set(c.id, fn({ cc: c.cc, city: c })); return cache.get(c.id); };
    return { list: Wd.cities, fn: c => { const r = get(c); return r ? { fill: scoreHex(r.score) } : null; }, label: c => { const r = get(c); return r ? `${c.n}: прогноз ${fmt(r.score)} (уверенность ${Math.round(r.conf * 100)}%)` : c.n; }, legend: { title: "Прогноз для нас по похожим местам", rel: true } };
  }
  const ind = Wd.CIND[L.city];
  if (!ind) return null;
  if (ind.scale && ind.dir) return { list: Wd.cities, fn: c => { const s = Wd.cityScore(c, ind.key); return s == null ? null : { fill: scoreHex(s) }; }, label: c => `${c.n}: ${fmtValue(ind, ind.get(c))}`, legend: { title: ind.name, rel: true, ref: "СПб" } };
  const vals = Wd.cities.map(c => ind.get(c));
  const br = Wd.quantiles(vals, 5);
  return { list: Wd.cities, fn: c => { const v = ind.get(c); if (v == null) return null; let k = br.findIndex(b => v < b); if (k < 0) k = 4; return { fill: CIVIDIS[k] }; }, label: c => `${c.n}: ${fmtValue(ind, ind.get(c))}`, legend: { title: ind.name, ramp: CIVIDIS, lo: fmtValue(ind, Math.min(...vals.filter(v => v != null))), hi: fmtValue(ind, Math.max(...vals.filter(v => v != null))) } };
}

function predictor() {
  const M = state.M, norm = W();
  if (!state.world.cities) return null;
  if (!state.sim) state.sim = new Similar(state.world, state.schema.groups);
  const rated = M.candidates().filter(p => M.ratingsOf(p.id).length).map(p => {
    const t = M.total(p, norm, "final");
    const city = state.world.placeCity(p);
    return t.score == null ? null : { cc: p.cc, city: city && !city.synthetic ? city : null, score: t.score };
  }).filter(Boolean);
  return state.sim.predictor(rated, norm);
}

function similarTarget() {
  const t = state.layers.simTo;
  if (!t) return null;
  if (t.type === "place") {
    const p = state.M.PLACE[t.id];
    if (!p) return null;
    const city = state.world.placeCity(p);
    return { name: p.name, x: { cc: p.cc, city: city && !city.synthetic ? city : null, lat: p.lat, lon: p.lon } };
  }
  const c = (state.world.cities || []).find(x => x.id === t.id);
  return c ? { name: c.n, x: { cc: c.cc, city: c, lat: c.lat, lon: c.lon } } : null;
}

function legendHTML() {
  const parts = [];
  const leg = countryLegend();
  const relRamp = [1, 2, 3, 4, 5].map(v => `<i style="background:${scoreHex(v)}"></i>`).join("");
  if (leg) {
    parts.push(`<div><b>${esc(leg.ind.name)}</b></div>`);
    if (leg.raw) parts.push(`<div class="ramp">${leg.ramp.map(c => `<i style="background:${c}"></i>`).join("")}</div><div class="ends"><span>${esc(leg.lo)}</span><span>квантили</span><span>${esc(leg.hi)}</span></div>`);
    else parts.push(`<div class="ramp">${relRamp}</div><div class="ends"><span>хуже</span><span>≈ Россия</span><span>лучше</span></div>`);
    parts.push(`<div class="src">${esc(leg.ind.source || "")} · без заливки — нет данных</div>`);
  }
  const cc = state.cityLegend;
  if (cc) {
    parts.push(`<div style="margin-top:4px"><b>Города: ${esc(cc.title)}</b></div>`);
    if (cc.ramp) parts.push(`<div class="ramp">${cc.ramp.map(c => `<i style="background:${c}"></i>`).join("")}</div><div class="ends"><span>${esc(cc.lo)}</span><span>${esc(cc.hi)}</span></div>`);
    else parts.push(`<div class="ramp">${relRamp}</div><div class="ends"><span>${esc(cc.lo || "хуже")}</span><span>${esc(cc.ref ? "≈ " + cc.ref : "")}</span><span>${esc(cc.hi || "лучше")}</span></div>`);
  }
  return parts.join("");
}

function layersHTML() {
  const L = state.layers, Wd = state.world, G = state.schema.groups;
  const byGroup = G.map(g => ({ g, list: Wd.indicators.filter(i => i.group === g.key) })).filter(x => x.list.length);
  const ratedCount = state.M.candidates().filter(p => state.M.ratingsOf(p.id).length).length;
  return `
    <div class="field"><label class="lbl" for="lyCountry">Раскраска стран</label>
      <select id="lyCountry"><option value="">Без раскраски</option>${byGroup.map(x => `<optgroup label="${esc(x.g.name)}">${x.list.map(i => `<option value="${i.key}"${i.key === L.country ? " selected" : ""}>${esc(i.name)}</option>`).join("")}</optgroup>`).join("")}</select>
      <div class="seg" role="group" id="lyMode"><button type="button" data-mode="rel" aria-pressed="${L.mode !== "raw"}">Относительно России</button><button type="button" data-mode="raw" aria-pressed="${L.mode === "raw"}">Сырые значения</button></div>
    </div>
    <div class="field"><label class="lbl" for="lyCity">Города мира</label>
      <select id="lyCity"><option value="">Не показывать</option>${CITY_INDICATORS.map(i => `<option value="${i.key}"${i.key === L.city ? " selected" : ""}>${esc(i.name)}</option>`).join("")}<option value="similar"${L.city === "similar" ? " selected" : ""}${L.simTo ? "" : " disabled"}>Похожие на выбранное место${L.simTo ? "" : " (выберите место)"}</option><option value="predict"${L.city === "predict" ? " selected" : ""}${ratedCount >= 3 ? "" : " disabled"}>Прогноз для нас${ratedCount >= 3 ? "" : " (нужно ≥ 3 оценённых места)"}</option></select>
      <span class="desc">Климат — CHELSA 1981–2010; цвет относительно СПб, где это осмысленно.</span>
    </div>
    <label class="toggle"><input type="checkbox" id="lyPlaces"${L.places ? " checked" : ""}> Наши места (цвет — итог)</label>
    <label class="toggle"><input type="checkbox" id="lyVisited"${L.visited ? " checked" : ""}> Где были: контур страны</label>
    <span class="desc">Сплошной контур — были оба (или база), пунктир фиолетовый — только Михаил, оранжевый — только Вика.</span>`;
}

function initMap() {
  if (state.mapView) return;
  state.mapView = new MapView($("map"), {
    onPlace: id => openPlace(id),
    onCountry: (iso, latlng) => openCountry(iso, latlng),
    onCity: c => openCity(c),
    onBlank: () => closeSheet(),
  });
  if (state.world.geo) state.mapView.setCountries(state.world.geo, countryStyle());
  $("layersBtn").addEventListener("click", () => {
    const p = $("layersPanel");
    p.hidden = !p.hidden;
    $("layersBtn").setAttribute("aria-expanded", String(!p.hidden));
    if (!p.hidden) p.innerHTML = layersHTML();
  });
  $("layersPanel").addEventListener("change", e => {
    const L = state.layers;
    if (e.target.id === "lyCountry") L.country = e.target.value;
    if (e.target.id === "lyCity") L.city = e.target.value;
    if (e.target.id === "lyPlaces") L.places = e.target.checked;
    if (e.target.id === "lyVisited") L.visited = e.target.checked;
    saveLayers(); renderMap();
  });
  $("layersPanel").addEventListener("click", e => {
    const b = e.target.closest("[data-mode]");
    if (!b) return;
    state.layers.mode = b.dataset.mode; saveLayers();
    $("layersPanel").innerHTML = layersHTML();
    renderMap();
  });
  $("searchForm").addEventListener("submit", e => { e.preventDefault(); runSearch($("searchInput").value.trim(), true); });
  $("searchInput").addEventListener("input", e => runSearch(e.target.value.trim(), false));
  $("searchInput").addEventListener("focus", e => { if (e.target.value.trim()) runSearch(e.target.value.trim(), false); });
  $("searchResults").addEventListener("click", e => {
    const b = e.target.closest("button[data-i]");
    if (!b) return;
    const item = state.searchItems[Number(b.dataset.i)];
    $("searchResults").hidden = true;
    $("searchInput").blur();
    if (item.type === "place") { openPlace(item.id, true); }
    else if (item.type === "city") { openCity(item.city, true); }
    else if (item.type === "geo") { openGeo(item.geo); }
    else if (item.type === "remote") { runSearch($("searchInput").value.trim(), true); }
  });
  document.addEventListener("click", e => { if (!e.target.closest(".search")) $("searchResults").hidden = true; });
  $("sheetClose").addEventListener("click", closeSheet);
  $("sheetGrip").addEventListener("click", () => $("sheet").classList.toggle("full"));
  $("sheetBody").addEventListener("click", onSheetClick);
}

function renderMap() {
  initMap();
  const mv = state.mapView;
  setTimeout(() => mv.invalidate(), 0);
  mv.restyleCountries(countryStyle());
  mv.setPlaces(state.layers.places ? placeMarkers() : []);
  const needCities = !!state.layers.city;
  if (needCities && !state.world.cities) {
    state.world.loadCities().then(() => renderMap());
    mv.setCities(null);
  } else {
    const col = needCities ? cityColorer() : null;
    state.cityLegend = col ? col.legend : null;
    mv.setCities(col ? col.list : null, col ? col.fn : () => null, col ? col.label : () => "");
  }
  const lg = legendHTML();
  $("legendBox").hidden = !lg;
  $("legendBox").innerHTML = lg;
}

/* ---------- search ---------- */
let searchTimer = null;
function runSearch(q, remote) {
  const box = $("searchResults");
  clearTimeout(searchTimer);
  if (!q) { box.hidden = true; return; }
  const ql = q.toLowerCase();
  const items = [];
  state.M.places.filter(p => p.name.toLowerCase().includes(ql)).slice(0, 4).forEach(p => items.push({ type: "place", id: p.id, title: p.name, sub: "наше место" + (p.country ? " · " + p.country : "") }));
  if (state.world.cities) state.world.cities.filter(c => c.n.toLowerCase().startsWith(ql) || (c.en && c.en.toLowerCase().startsWith(ql))).slice(0, 5).forEach(c => items.push({ type: "city", city: c, title: c.n, sub: state.world.nameOf(c.cc) + (c.pop ? " · " + Math.round(c.pop / 1000) + " тыс." : "") }));
  else state.world.loadCities();
  const show = (extra, note) => {
    state.searchItems = items.concat(extra || []);
    box.innerHTML = state.searchItems.map((it, i) => `<button type="button" data-i="${i}">${esc(it.title)}<small>${esc(it.sub)}</small></button>`).join("") + (note ? `<div class="note">${note}</div>` : "");
    box.hidden = !state.searchItems.length && !note;
  };
  if (!remote) {
    show([{ type: "remote", title: `Искать «${q}» везде`, sub: "Enter · поиск по OpenStreetMap" }]);
    return;
  }
  show([], "Ищу в OpenStreetMap…");
  search(q).then(res => {
    show(res.map(g => ({ type: "geo", geo: g, title: g.name, sub: g.label })), res.length ? "Поиск: Nominatim, данные © OpenStreetMap" : "Ничего не нашлось");
  }).catch(err => show([], esc(err.message)));
}

/* ---------- sheet ---------- */
function openSheet(html) {
  $("sheetBody").innerHTML = html;
  $("sheet").hidden = false;
  $("sheet").classList.remove("full");
  $("layersPanel").hidden = true;
  $("layersBtn").setAttribute("aria-expanded", "false");
}

function closeSheet() {
  $("sheet").hidden = true;
  state.sheet = null;
  if (state.mapView) state.mapView.clearTemp();
}

function scoreLine(M, p) {
  const t = placeScore(M, p, W());
  const per = M.PEOPLE.map((w, i) => { const s = M.total(p, W(), w).score; return s == null ? "" : `<span><i class="sw ${i ? "v" : "m"}"></i>${esc(w)} ${fmt(s)}</span>`; }).join("");
  return `<div class="bigscore"><b>${M.isBase(p) ? "3.0" : fmt(t.score)}</b><span class="muted small">${M.isBase(p) ? "база" : t.score == null ? "оценок нет" : `покрытие ${Math.round(t.coverage * 100)}%`}</span></div>${per ? `<div class="legend">${per}</div>` : ""}`;
}

function openPlace(id, fly) {
  const M = state.M, p = M.PLACE[id];
  if (!p) return;
  state.sheet = { type: "place", id };
  const rs = M.ratingsOf(p.id).filter(r => r.review).slice(-3).reverse();
  const years = yearsLine(M, p.id);
  openSheet(`<h3>${esc(p.name)}</h3>
    <div class="chips">${p.country ? `<span class="chip">${esc(p.country)}</span>` : ""}<span class="chip">${esc(p.status || "кандидат")}</span>${years ? `<span class="chip">год: ${esc(years)}</span>` : ""}<span class="chip">оценок: ${M.ratingsOf(p.id).length}</span></div>
    ${scoreLine(M, p)}
    ${rs.map(r => `<div class="review ${r.who === M.PEOPLE[1] ? "v" : "m"}"><b>${esc(r.who)}${r.start ? " · " + esc(r.start.slice(0, 7)) : ""}:</b> ${esc(r.review)}</div>`).join("")}
    <div class="btns"><a class="btn" href="${placeHref(p.id)}">Досье</a>${M.isBase(p) ? "" : `<a class="btn ghost" href="#/rate/new/${encodeURIComponent(p.id)}">Оценить</a>`}<button type="button" class="btn ghost" data-act="simplace" data-id="${esc(p.id)}">Похожие</button></div>`);
  if (fly && p.lat != null) state.mapView.flyTo(p.lat, p.lon, 10);
}

function focusPlace(id) {
  go("#/map");
  setTimeout(() => openPlace(id, true), 60);
}

function openCountry(iso, latlng) {
  const Wd = state.world, M = state.M;
  state.sheet = { type: "country", iso, latlng };
  const ours = M.places.filter(p => p.cc === iso);
  const visited = visitedBy()[iso];
  state.mapView.showTemp(latlng.lat, latlng.lng);
  openSheet(`<h3>${esc(Wd.nameOf(iso))}</h3>
    ${visited ? `<div class="chips"><span class="chip solid">были: ${esc([...visited].filter(x => x !== "*").join(", ") || "база")}</span></div>` : ""}
    ${ours.length ? `<div class="small">Наши места: ${ours.map(p => `<a href="${placeHref(p.id)}">${esc(p.name)}</a>`).join(", ")}</div>` : ""}
    <div class="btns"><button type="button" class="btn" data-act="addhere">Добавить место здесь</button><button type="button" class="btn ghost" data-act="simcountry" data-iso="${iso}">Похожие страны</button></div>
    <div id="simCountryBox"></div>
    <div class="world">${worldRowsHTML(iso, null)}</div>`);
}

function openCity(c, fly) {
  const Wd = state.world;
  state.sheet = { type: "city", city: c };
  const own = state.M.places.find(p => p.lat != null && haversine(p, c) < 5);
  openSheet(`<h3>${esc(c.n)}</h3>
    <div class="chips"><span class="chip">${esc(Wd.nameOf(c.cc))}</span>${c.pop ? `<span class="chip">${Math.round(c.pop / 1000).toLocaleString("ru-RU")} тыс. жителей</span>` : ""}<span class="chip">${esc(kgName(c.kg))}</span></div>
    ${Array.isArray(c.t) ? `<div class="clim">${climateSVG(c, Wd.spbCity)}</div>` : ""}
    <div class="btns">${own ? `<a class="btn" href="${placeHref(own.id)}">Наше место: ${esc(own.name)}</a>` : `<button type="button" class="btn" data-act="addcity">Добавить как место</button>`}<button type="button" class="btn ghost" data-act="simcity">Похожие города</button></div>
    <div id="simCityBox"></div>
    <div class="world">${worldRowsHTML(c.cc, c)}</div>`);
  state.mapView.showTemp(c.lat, c.lon);
  if (fly) state.mapView.flyTo(c.lat, c.lon, 9);
}

function openGeo(g) {
  state.sheet = { type: "geo", geo: g };
  const iso = state.world.iso3of(g.cc2);
  state.mapView.showTemp(g.lat, g.lon);
  openSheet(`<h3>${esc(g.name)}</h3>
    <p class="small muted">${esc(g.label)}</p>
    <div class="btns"><button type="button" class="btn" data-act="addgeo">Добавить место</button>${iso ? `<button type="button" class="btn ghost" data-act="country" data-iso="${iso}">О стране</button>` : ""}</div>
    <p class="small muted">Поиск: Nominatim, данные © OpenStreetMap</p>`);
  state.mapView.flyTo(g.lat, g.lon, 10);
}

async function addPlace(info) {
  if (!canWrite()) { toast("Чтобы добавлять места, введите токен в настройках"); go("#/settings"); return; }
  const existing = state.M.places.find(p => p.lat != null && haversine(p, info) < 3);
  if (existing) { toast("Это место уже есть: " + existing.name); openPlace(existing.id, true); return; }
  const doc = {
    name: info.name, country: info.country || state.world.nameOf(info.cc) || "", cc: info.cc || null,
    lat: info.lat, lon: info.lon, status: "кандидат", archetype: "", reason: "", questions: "", ext: {},
    osm: info.osm || null, geonameid: info.geonameid || null,
  };
  try {
    const { r, doc: saved } = await state.data.savePlace(doc, true);
    toast(r === "queued" ? "Нет связи: место отправится позже" : `Добавлено: ${saved.name}`);
    rebuild();
    renderMap();
    openPlace(saved.id, false);
  } catch (err) { toast(err.message); }
}

async function onSheetClick(e) {
  const b = e.target.closest("[data-act], [data-city], [data-country]");
  if (!b) return;
  const Wd = state.world;
  if (b.dataset.city) { const c = Wd.cities.find(x => String(x.id) === b.dataset.city); if (c) openCity(c, true); return; }
  if (b.dataset.country) { const iso = b.dataset.country; const f = Wd.geo.features.find(x => x.properties.iso3 === iso); const ll = f ? window.L.geoJSON(f).getBounds().getCenter() : { lat: 0, lng: 0 }; openCountry(iso, ll); state.mapView.map.flyToBounds(window.L.geoJSON(f).getBounds(), { maxZoom: 6, duration: 0.8 }); return; }
  const act = b.dataset.act;
  if (act === "addhere") {
    const ll = state.sheet && state.sheet.latlng;
    if (!ll) return;
    b.disabled = true; b.textContent = "Определяю место…";
    try {
      const g = await reverse(ll.lat.toFixed(5), ll.lng.toFixed(5));
      if (!g) { toast("Здесь не нашлось населённого пункта"); b.disabled = false; b.textContent = "Добавить место здесь"; return; }
      openGeo(Object.assign(g, { lat: Number(ll.lat.toFixed(5)), lon: Number(ll.lng.toFixed(5)) }));
    } catch (err) { toast(err.message); b.disabled = false; b.textContent = "Добавить место здесь"; }
  } else if (act === "addgeo") {
    const g = state.sheet.geo;
    addPlace({ name: g.name, country: g.country, cc: Wd.iso3of(g.cc2), lat: g.lat, lon: g.lon, osm: g.osm });
  } else if (act === "addcity") {
    const c = state.sheet.city;
    addPlace({ name: c.n, cc: c.cc, lat: c.lat, lon: c.lon, geonameid: c.id });
  } else if (act === "country") {
    const iso = b.dataset.iso; const g = state.sheet.geo;
    openCountry(iso, { lat: g.lat, lng: g.lon });
  } else if (act === "simcountry") {
    if (!state.sim) state.sim = new Similar(Wd, state.schema.groups);
    $("simCountryBox").innerHTML = `<h2 style="margin:4px 0">Похожие страны · веса «${esc(state.preset)}»</h2>` + similarCountriesHTML(state.sim.similarCountries(b.dataset.iso, W(), 8));
  } else if (act === "simcity" || act === "simplace") {
    await Wd.loadCities();
    if (!state.sim) state.sim = new Similar(Wd, state.schema.groups);
    let x, boxId;
    if (act === "simcity") { const c = state.sheet.city; x = { cc: c.cc, city: c, lat: c.lat, lon: c.lon }; state.layers.simTo = { type: "city", id: c.id }; boxId = "simCityBox"; }
    else { const p = state.M.PLACE[b.dataset.id]; const city = Wd.placeCity(p); x = { cc: p.cc, city: city && !city.synthetic ? city : null, lat: p.lat, lon: p.lon }; state.layers.simTo = { type: "place", id: p.id }; boxId = null; }
    state.layers.city = "similar"; saveLayers();
    renderMap();
    const list = state.sim.similarCities(x, W(), { k: 8 });
    const html = `<h2 style="margin:4px 0">Похожие · веса «${esc(state.preset)}»</h2>` + similarHTML(list);
    if (boxId) $(boxId).innerHTML = html; else $("sheetBody").insertAdjacentHTML("beforeend", html);
  }
}

/* ---------- theme ---------- */
function setTheme(t) {
  local.set("theme", t);
  applyTheme();
}
function applyTheme() {
  const t = local.get("theme", "auto");
  if (t === "auto") document.documentElement.removeAttribute("data-theme"); else document.documentElement.setAttribute("data-theme", t);
  refreshPalette();
  if (state.schema && state.route.name === "map") renderMap();
  const btn = $("themeBtn");
  btn.setAttribute("aria-label", "Тема: " + ({ auto: "как в системе", light: "светлая", dark: "тёмная" })[t]);
  btn.title = btn.getAttribute("aria-label");
}

/* ---------- tooltips ---------- */
function initTips() {
  const tip = $("tip");
  const show = e => {
    const t = e.target.closest && e.target.closest("[data-tip]");
    if (!t) { tip.hidden = true; return; }
    tip.textContent = t.getAttribute("data-tip");
    tip.hidden = false;
    const x = Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8);
    const y = e.clientY + 16 + tip.offsetHeight > innerHeight ? e.clientY - tip.offsetHeight - 10 : e.clientY + 16;
    tip.style.left = Math.max(8, x) + "px"; tip.style.top = y + "px";
  };
  document.addEventListener("pointermove", show);
  document.addEventListener("pointerdown", show);
}

/* ---------- boot ---------- */
async function boot() {
  applyTheme();
  initTips();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
  const [schema] = await Promise.all([fetch("schema.json").then(r => r.json()), state.world.load()]);
  state.schema = schema;
  rebuild();
  state.data.addEventListener("change", () => {
    rebuild();
    if (state.route.name === "rate") { renderSync(); if (state.form) state.form.setPlaces(state.M.places); }
    else render();
  });
  $("themeBtn").addEventListener("click", () => { const order = ["auto", "light", "dark"]; setTheme(order[(order.indexOf(local.get("theme", "auto")) + 1) % 3]); if (state.route.name === "settings") renderSettings(); });
  $("syncBtn").addEventListener("click", () => state.data.refresh());
  addEventListener("hashchange", route);
  route();
  state.world.loadCities().then(() => { rebuild(); if (state.route.name === "place" || state.route.name === "map") render(); });
  if (state.data.hasToken) {
    await state.data.refresh();
    setInterval(() => { if (document.visibilityState === "visible") state.data.poll(); }, 60000);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") state.data.poll(); });
  }
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}

boot().catch(err => {
  document.getElementById("main").insertAdjacentHTML("afterbegin", `<div class="page"><div class="banner err">Не загрузилось: ${esc(err.message)}</div></div>`);
});

export { state, uid, SHORT, toScore };
