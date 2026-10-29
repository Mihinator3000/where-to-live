import { createModel, fmt, normalize, MIN_COVERAGE } from "./calc.js";
import { Data, DEFAULT_REPO } from "./data.js";
import { RateForm, datesRu } from "./form.js";
import { GitHubStore } from "./store.js";
import { MapView } from "./map.js";
import { search, reverse } from "./geo.js";
import { Similar, kgName } from "./similar.js";
import { $, esc, local, toast, scoreColor, scoreHex, pal, refreshPalette, uid } from "./util.js";
import { World, CITY_INDICATORS, MONTHS, fmtValue, toScore, CIVIDIS, haversine } from "./world.js";
import { rankHTML, heatHTML, flagsHTML, radarSVG, tripsHTML, subtableHTML, placesListHTML, placeHref, placeScore, yearsLine, hasResidents, hiddenNote, hiddenWho, SHORT } from "./views.js";

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
  revealed: new Set(local.get("revealed", [])),
  lastSaved: "",
  flashTrip: null,
  prevPending: 0,
};

const canWrite = () => state.data.hasToken;
const slugMe = () => ({ "Михаил": "mikhail", "Вика": "vika" })[local.get("me", "")] || "device";
const useData = () => local.get("worldData", true);
const me = () => local.get("me", "");
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isPhone = () => /iPhone|iPad|Android/i.test(navigator.userAgent);

function savedNow(r) {
  if (r !== "sent") return;
  state.lastSaved = new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  renderSync();
}

const MONEY_STEP = Math.log(1.5);
const TDS = [[100, 3], [200, 2.5], [300, 2], [400, 1.5], [500, 1]];

function factValue(p, key) { const f = p && p.facts && p.facts[key]; const v = f && Number(f.v); return v > 0 ? v : null; }

function factRef(F, places) {
  const base = places.find(p => p.status === "база");
  return factValue(base, F.key) || F.ref || null;
}

function factScore(F, x, ref) {
  if (x == null) return null;
  if (F.rule === "tds") { const p = TDS; if (x <= p[0][0]) return 3; for (let i = 1; i < p.length; i++) if (x <= p[i][0]) return p[i - 1][1] + (p[i][1] - p[i - 1][1]) * (x - p[i - 1][0]) / (p[i][0] - p[i - 1][0]); return 1; }
  if (!ref) return null;
  return Math.max(1, Math.min(5, 3 - Math.log(x / ref) / MONEY_STEP));
}

function rebuild() {
  const v = state.data.view();
  const facts = state.schema.facts || [];
  const auto = (p, k) => {
    const F = facts.find(f => f.cat === k);
    const s = F ? factScore(F, factValue(p, F.key), factRef(F, v.places)) : null;
    return s != null ? s : useData() ? state.world.autoData(p, k) : null;
  };
  const full = createModel(state.schema, v, { autoData: auto });
  const m = me(), hid = new Set();
  if (m) full.places.forEach(p => {
    const rs = full.ratingsOf(p.id);
    if (state.revealed.has(p.id) || rs.some(r => r.who === m)) return;
    rs.forEach(r => { if (r.who !== m) hid.add(p.id + "|" + r.who); });
  });
  const M = state.M = hid.size ? createModel(state.schema, Object.assign({}, v, { ratings: v.ratings.filter(r => !hid.has(r.place + "|" + r.who)) }), { autoData: auto }) : full;
  M.hidden = (id, w) => hid.has(id + "|" + w);
  M.full = full;
  const P = M.presets;
  if (!P[state.preset] && state.preset !== "Своё") state.preset = "Оба";
  if (state.preset !== "Своё" || !state.weights) state.weights = Object.assign({}, P[state.preset] || P["Оба"]);
}

const W = () => normalize(state.schema.groups, state.weights);

/* ---------- sync status ---------- */
function renderSync() {
  const d = state.data;
  const dot = $("syncDot"), t = $("syncText");
  dot.className = "dot" + (d.status === "live" ? " live" : d.status === "sync" || d.status === "pending" ? " sync" : d.status === "error" || d.status === "auth" ? " err" : "");
  const n = d.pending.length;
  const map = {
    notoken: "Не подключено",
    idle: "…",
    sync: "Обновляю…",
    live: state.lastSaved ? "Сохранено · " + state.lastSaved : "Подключено",
    pending: `В очереди: ${n}`,
    offline: n ? `Офлайн · в очереди: ${n}` : "Офлайн · показан кэш",
    auth: "Ключ не подходит",
    error: "Ошибка связи",
  };
  t.textContent = map[d.status] || d.status;
  $("syncBtn").title = d.status === "notoken" ? "Подключить данные" : d.error || "Обновить данные";
}

/* ---------- routing ---------- */
function parseRoute() {
  const h = location.hash.replace(/^#\/?/, "");
  const [name, ...rest] = h.split("/");
  return { name: name || "map", arg: rest.map(decodeURIComponent).join("/") };
}

function go(hash) { if (location.hash !== hash) location.hash = hash; else route(); }

const VIEWS = { map: "v-map", rank: "v-rank", places: "v-places", place: "v-place", rate: "v-rate", settings: "v-settings" };

function route() {
  state.route = parseRoute();
  state.dirty = false;
  if (!VIEWS[state.route.name]) { history.replaceState(null, "", "#/map"); state.route = { name: "map", arg: "" }; }
  const r = state.route.name;
  const views = VIEWS;
  const id = views[r];
  if (r !== "map" && state.sheet) closeSheet();
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
  if (r === "map") { renderMap(); refreshSheet(); }
  else if (r === "rank") renderRank();
  else if (r === "places") renderPlaces();
  else if (r === "place") renderPlace(state.route.arg);
  else if (r === "rate") renderRate(state.route.arg);
  else if (r === "settings") renderSettings();
}

/* ---------- banner ---------- */
function bannerHTML() {
  const d = state.data;
  if (!d.hasToken) return `<div class="banner"><b>Данные не подключены.</b> Карта и мировые показатели работают, а чтобы видеть и сохранять наши оценки, вставьте ключ доступа в <a href="#/settings">настройках</a>.</div>`;
  if (d.status === "auth") return `<div class="banner err"><b>Ключ доступа не подходит.</b> ${esc(d.error)}. Проверьте его в <a href="#/settings">настройках</a>.</div>`;
  if (d.error && d.status !== "live") return `<div class="banner err">${esc(d.error)}</div>`;
  if (d.error) return `<div class="banner">${esc(d.error)}</div>`;
  const lost = d.lost;
  let html = "";
  if (!me()) html += `<div class="banner">Кто вы на этом устройстве? <button type="button" class="btn ghost small" data-setme="${esc(state.schema.people[0])}">${esc(state.schema.people[0])}</button> <button type="button" class="btn ghost small" data-setme="${esc(state.schema.people[1])}">${esc(state.schema.people[1])}</button><br><span class="small muted">От этого зависит, чьи оценки скрыты, пока вы не оценили место сами.</span></div>`;
  if (lost.length) html += `<div class="banner err"><b>Не отправлено: это же изменили на другом устройстве.</b> Можно записать свою версию поверх или выбросить её.${lost.map((l, i) => `<div class="lost"><span>${esc(lostLabel(l))}</span><button type="button" class="btn ghost small" data-lostapply="${i}">Записать мою</button><button type="button" class="btn ghost small" data-lostdrop="${i}">Выбросить</button></div>`).join("")}</div>`;
  else if (d.notice) html += `<div class="banner err">${esc(d.notice)} <button type="button" class="linkbtn" data-dismiss-notice>Понятно</button></div>`;
  return html;
}

function lostLabel(l) {
  let doc = null;
  try { doc = l.content == null ? null : JSON.parse(l.content); } catch (e) {}
  const [dir] = l.path.split("/");
  if (dir === "places") return `Карточка «${doc ? doc.name : l.path}»${doc && doc.questions ? ": " + doc.questions.slice(0, 80) : ""}`;
  if (dir === "ratings") return doc ? `Оценка: ${(state.M.PLACE[doc.place] || {}).name || doc.place} · ${doc.who}${doc.deleted ? " (удаление)" : ""}` : "Удаление оценки";
  if (dir === "weights") return `Веса: ${doc ? doc.who : ""}`;
  return l.path;
}

/* ---------- rank ---------- */
function shares(n) {
  const keys = Object.keys(n), floor = Object.fromEntries(keys.map(k => [k, Math.floor(n[k])]));
  let left = 100 - keys.reduce((a, k) => a + floor[k], 0);
  keys.slice().sort((a, b) => (n[b] - floor[b]) - (n[a] - floor[a])).forEach(k => { if (left > 0) { floor[k]++; left--; } });
  return floor;
}

function renderRank() {
  const M = state.M;
  const saved = state.data.view().weights;
  const own = M.PEOPLE.filter(w => saved[w] && Object.keys(saved[w]).length);
  const names = ["Поровну"].concat(own, own.length === M.PEOPLE.length ? ["Оба"] : [], ["Своё"]);
  if (!names.includes(state.preset)) { state.preset = "Поровну"; state.weights = Object.assign({}, M.presets["Поровну"]); }
  const norm = W(), sh = shares(norm);
  const trips = tripCount();
  const who = me();
  const el = $("v-rank");
  el.innerHTML = `
    <header class="stack" style="gap:8px"><h1>Рейтинг</h1>
      <p class="muted small">Мест: ${M.places.filter(p => !M.isBase(p)).length} · оценок: ${M.full.ratings.length} · поездок-разведок: ${trips} из ${TRIPS_BUDGET}</p>
    </header>
    ${bannerHTML()}
    <section class="block">
      <div class="sec-head"><h2>Места</h2><div class="seg" role="group" aria-label="Чьи веса" id="presets">${names.map(n => `<button type="button" aria-pressed="${n === state.preset}" data-p="${esc(n)}">${esc(n)}</button>`).join("")}</div></div>
      <p class="small muted">3 — как в СПб, правее — лучше. Точки: <i class="sw m"></i> ${esc(M.PEOPLE[0])}, <i class="sw v"></i> ${esc(M.PEOPLE[1])}. Кнопки выше — чьи веса групп учитывать.</p>
      <div class="panel">
        <details class="weights" id="wdetails"${local.get("wopen", false) ? " open" : ""}>
          <summary id="wsum">Веса групп: «${esc(state.preset)}»${!own.length ? " · своих весов ещё никто не сохранил" : ""}</summary>
          <p class="small muted">Раздайте 100 очков между группами: чем важнее для вас разница между местами в группе, тем больше очков. Двигаете одну — остальные подстраиваются, сумма остаётся 100.</p>
          <div class="wgrid" id="wgrid">${M.GROUPS.map(g => `<label class="wrow" for="w-${g.key}"><span>${esc(g.name)}</span><span class="num muted">${sh[g.key]}</span><input type="range" id="w-${g.key}" data-g="${g.key}" min="0" max="100" step="1" value="${sh[g.key]}"></label>`).join("")}</div>
          ${canWrite() ? (who ? `<div class="wsave"><button type="button" class="btn ghost small" id="wsaveBtn">Сохранить как мои веса (${esc(who)})</button></div>` : `<p class="small muted">Чтобы сохранить веса как свои, выберите в <a href="#/settings">настройках</a>, кто вы.</p>`) : ""}
        </details>
        <div class="rank" id="rank">${rankHTML(M, norm)}</div>
      </div>
      <details class="small muted rank-help"><summary>Что значат пометки</summary><p>«№1–3 в зависимости от весов» — место может сдвинуться, если поменять любой вес на ±20% или взять веса одного из нас. «Заполнено» — по какой доле групп вообще есть оценки или данные (показываем, только если меньше 70%). «Год здесь» — «прожили бы здесь год?», 0–10. В основной список место попадает, когда отвечено хотя бы на половину главных вопросов ★; остальные ниже, их итог держится в основном на мировых данных.${useData() ? "" : " Мировые данные сейчас выключены в настройках."}</p></details>
    </section>
    <section class="block">
      <div class="sec-head"><h2>Места × группы</h2><div class="scale-key"><span>хуже СПб</span><i style="background: var(--neg)"></i><i style="background: color-mix(in oklab, var(--neg) 45%, var(--mid))"></i><i style="background: var(--mid)"></i><i style="background: color-mix(in oklab, var(--pos) 45%, var(--mid))"></i><i style="background: var(--pos)"></i><span>лучше</span></div></div>
      <div class="panel scroll"><table class="heat">${heatHTML(M, norm)}</table></div>
    </section>
    <section class="block">
      ${(() => { const f = flagsHTML(M); return `<div class="sec-head"><h2>Флаги</h2><span class="small muted">${f.count ? f.count : ""}</span></div><div class="panel"><div class="flags">${f.html}</div></div>`; })()}
    </section>`;
  $("wdetails").addEventListener("toggle", e => local.set("wopen", e.target.open));
  $("presets").addEventListener("click", e => {
    const b = e.target.closest("button[data-p]");
    if (!b) return;
    state.preset = b.dataset.p;
    state.weights = Object.assign({}, b.dataset.p === "Своё" ? local.get("customWeights", null) || W() : state.M.presets[state.preset]);
    local.set("preset", state.preset); local.set("weights", state.weights);
    renderRank();
  });
  $("wgrid").addEventListener("input", e => {
    const inp = e.target.closest("input[data-g]");
    if (!inp) return;
    const keys = state.M.GROUPS.map(g => g.key), cur = W(), k = inp.dataset.g, v = Number(inp.value);
    const others = keys.filter(x => x !== k), rest = others.reduce((a, x) => a + cur[x], 0);
    const next = { [k]: v };
    others.forEach(x => { next[x] = rest > 0 ? cur[x] * (100 - v) / rest : (100 - v) / others.length; });
    state.weights = next;
    state.preset = "Своё";
    local.set("preset", "Своё"); local.set("weights", next); local.set("customWeights", next);
    const n = W(), sh2 = shares(n);
    $("rank").innerHTML = rankHTML(state.M, n);
    $("wgrid").querySelectorAll(".wrow").forEach((row, i) => {
      const g = state.M.GROUPS[i].key;
      row.querySelector(".num").textContent = sh2[g];
      const r = row.querySelector("input");
      if (r !== inp) r.value = sh2[g];
    });
    $("wsum").textContent = "Веса групп: «Своё»";
    $("presets").querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.p === "Своё")));
  });
  $("wsaveBtn")?.addEventListener("click", async e => {
    const b = e.currentTarget;
    const w = shares(W());
    const prev = state.preset;
    b.disabled = true;
    state.preset = who; local.set("preset", who);
    try {
      const r = await state.data.saveWeights(who, w);
      savedNow(r);
      toast(r === "queued" ? "Нет связи: веса отправятся позже" : `Сохранено: это теперь веса «${who}»`);
    } catch (err) { state.preset = prev; local.set("preset", prev); toast(err.message); }
    rebuild();
    renderRank();
  });
}

function tripCount() {
  const seen = new Set();
  state.M.full.ratings.forEach(r => seen.add(r.place + "|" + (r.start || r.id)));
  return seen.size;
}

/* ---------- places ---------- */
function renderPlaces() {
  const el = $("v-places");
  el.innerHTML = `<header class="stack" style="gap:8px"><h1>Места</h1><p class="small muted">Где были и куда смотрим. Новое место — через поиск на <a href="#/map">карте</a>.</p></header>
    ${bannerHTML()}
    <input type="search" id="placeFilter" placeholder="Фильтр по названию или стране" value="${esc(state.placeFilter)}" aria-label="Фильтр мест">
    <div class="panel plist" id="plist">${placesListHTML(state.M, W(), state.placeFilter, state.data.hasToken)}</div>`;
  $("placeFilter").addEventListener("input", e => { state.placeFilter = e.target.value; $("plist").innerHTML = placesListHTML(state.M, W(), state.placeFilter, state.data.hasToken); });
}

/* ---------- place dossier ---------- */
function placeCity(p) { return state.world.cities ? state.world.placeCity(p) : null; }

function worldRowsHTML(cc, city, first) {
  const Wd = state.world;
  let html = `<p class="small muted">Плашка справа — оценка 1–5 для итога: 3 — как в России и СПб, 4–5 — лучше для нас. Строки без плашки — справка, в итог не входят.</p>`;
  const rows = [];
  if (cc) Wd.indicators.forEach(ind => {
    const r = Wd.raw(cc, ind.key);
    if (!r) return;
    rows.push({ ind, v: r[0], year: r[1], s: (ind.cats || []).length ? Wd.countryScore(cc, ind.key) : null, level: "страна" });
  });
  if (city) CITY_INDICATORS.forEach(ind => {
    const v = Wd.cityValue(city, ind.key);
    if (v == null) return;
    rows.push({ ind, v, s: (ind.cats || []).length ? Wd.cityScore(city, ind.key) : null, level: city.synthetic ? "точка" : "город" });
  });
  const row = r => `<div class="world-row"><span>${esc(r.ind.name)}<small>${esc(r.level)}${r.year ? " · " + r.year : ""}${r.ind.source ? " · " + esc(r.ind.source) : ""}${r.ind.note ? " · " + esc(r.ind.note) : ""}</small></span><span class="v">${esc(fmtValue(r.ind, r.v))}</span><span class="s" style="background:${r.s == null ? "transparent" : scoreColor(r.s)};color:${r.s != null && Math.abs(r.s - 3) >= 1.4 ? "var(--on-strong)" : "var(--ink)"}" title="Шкала 1–5, Россия/СПб = 3">${r.s == null ? "" : fmt(r.s)}</span></div>`;
  if (!rows.length) return `<p class="small muted">Мировых данных по этому месту нет.</p>`;
  const top = first && rows.find(r => r.ind.key === first);
  if (top) html += `<div class="small muted wgh">Показатель на карте</div>` + row(top);
  state.schema.groups.forEach(g => {
    const rs = rows.filter(r => r.ind.group === g.key && r !== top);
    if (!rs.length) return;
    html += `<div class="small muted wgh">${esc(g.name)}</div>` + rs.map(row).join("");
  });
  return html;
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
  MONTHS.forEach((m, i) => { g += `<text x="${x(i)}" y="${H - 4}" text-anchor="middle">${m}</text>`; });
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

function similarSplitHTML(sp, cc) {
  const home = cc ? state.world.nameOf(cc) : "";
  return (sp.home.length ? `<h3 class="sim-h">${esc(home ? "В стране: " + home : "Рядом")}</h3>` + similarHTML(sp.home) : "") +
    `<h3 class="sim-h">В других странах</h3>` + similarHTML(sp.abroad);
}

function similarCountriesHTML(list) {
  if (!list || !list.length) return `<p class="small muted">Мало данных для сравнения.</p>`;
  return `<div class="sim">${list.map(x => `<div class="sim-row"><button type="button" data-country="${x.cc}">${esc(state.world.nameOf(x.cc))}</button><span class="pct">${x.pct}%</span>${x.why.close.length || x.why.far.length ? `<small>${esc([x.why.close.length ? "похожи: " + x.why.close.join(", ") : "", x.why.far.length ? "отличаются: " + x.why.far.join(", ") : ""].filter(Boolean).join(" · "))}</small>` : ""}</div>`).join("")}</div>`;
}

function externalLinks(p, city) {
  const en = (city && city.en) || p.name;
  const ascii = en.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D");
  const country = p.cc ? state.world.enNameOf(p.cc) : "";
  const link = (href, label) => `<a class="btn ghost small" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  return `<div class="btns">${link(`https://www.numbeo.com/cost-of-living/city_result.jsp?country=${encodeURIComponent(country)}&city=${encodeURIComponent(ascii)}`, "Numbeo: цены")}${link(`https://weatherspark.com/search?q=${encodeURIComponent(en)}`, "Weather Spark: погода")}${link(`https://ru.wikipedia.org/w/index.php?search=${encodeURIComponent(p.name + " " + state.world.nameOf(p.cc))}&fulltext=1`, "Википедия")}</div><p class="small muted">Numbeo — цены от посетителей, у маленьких городов данных мало или нет.</p>`;
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
  const parts = M.isBase(p) ? [] : M.PEOPLE.filter(w => !M.hidden(p.id, w)).map(w => [w, M.total(p, norm, w).score]).concat([["живущие", M.total(p, norm, "res").score], ["мировые данные", M.total(p, norm, "data").score]]).filter(x => x[1] != null);
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
      <div class="bigscore"><b>${M.isBase(p) ? "3.0" : fmt(t.score)}</b><span class="muted">${M.isBase(p) ? "база по определению" : `из 5, где 3 — как в СПб · заполнено ${Math.round(t.coverage * 100)}%${ranks[p.id] ? ` · №${ranks[p.id]} в рейтинге` : t.score != null && t.coverage < MIN_COVERAGE ? " · мало оценок для рейтинга" : ""}`}</span></div>
      ${onlyData ? `<p class="small muted">${hiddenNote(M, p.id) ? "Ваших оценок нет, " + esc(hiddenNote(M, p.id)) + ": итог пока по мировым данным." : "Мы здесь ещё не были: итог посчитан только по мировым данным."}</p>` : parts.length > 1 ? `<p class="small muted">Из чего итог: ${parts.map(([w, v]) => `${esc(w)} ${fmt(v)}`).join(" · ")}</p>` : ""}
      ${p.questions ? `<div class="small"><b>Вопросы к следующей поездке:</b> ${esc(p.questions)}</div>` : ""}
      ${p.status === "отсев" && p.reason ? `<div class="small"><b>Причина отсева:</b> ${esc(p.reason)}</div>` : ""}
    </div>
    <div class="panel"><div class="dossier"><div class="radar">${radarSVG(M, p)}<div class="legend small"><span><i class="sw m"></i>${esc(M.PEOPLE[0])}</span><span><i class="sw v"></i>${esc(M.PEOPLE[1])}</span>${hasResidents(M) ? `<span><i class="sw res"></i>Живущие</span>` : ""}<span><i class="sw data"></i>Данные</span><span><i class="sw base"></i>СПб = 3</span></div></div><div class="trips">${tripsHTML(M, p, canWrite(), me())}</div></div></div>
    <section class="block">
      <div class="sec-head"><h2>Подкатегории</h2><label class="toggle"><input type="checkbox" id="showEmpty"${state.showEmpty ? " checked" : ""}> Показать пустые</label></div>
      <div class="panel scroll"><table class="subtable">${subtableHTML(M, p, state.showEmpty)}</table></div>
      <p class="small muted">«Итог» сводит наши оценки с данными: чем хуже туристу видно подкатегорию, тем больше вес данных. Буква у балла — откуда знаем: A — в быту, C — со слов живущих, D — по сайтам.</p>
    </section>
    <section class="block">
      <div class="sec-head"><h2>Мировые данные</h2><span class="small muted">${city && !city.synthetic ? "климат: " + esc(city.n) + (p.lat != null ? ", " + Math.round(haversine(p, city)) + " км" : "") + " · " + esc(kgName(city.kg)) : ""}</span></div>
      <div class="panel pad stack">
        ${city && Array.isArray(city.t) ? `<div class="clim">${climateSVG(city, ref)}</div>${climLegend(p.name, ref && ref !== city)}` : ""}
        <div class="world">${worldRowsHTML(p.cc, city)}</div>
        ${externalLinks(p, city)}
      </div>
    </section>
    <section class="block">
      <div class="sec-head"><h2>Похожие места</h2><span class="small muted">по весам «${esc(state.preset)}»</span></div>
      <div class="panel pad" id="simBox"><p class="small muted">Считаю…</p></div>
    </section>
    <section class="block">
      <div class="sec-head"><h2>${M.isBase(p) ? "Цифры СПб — ориентиры для сравнения" : "Цифры места"}</h2></div>
      <form class="panel pad stack" id="factsForm">${factsHTML(p)}
        ${canWrite() ? `<div class="btns"><button type="submit" class="btn">Сохранить цифры</button><span class="msg" id="factsMsg"></span></div>` : ""}
      </form>
    </section>
    <section class="block">
      <div class="sec-head"><h2>Карточка места</h2></div>
      <form class="panel pad stack" id="placeForm">
        <div class="frow">
          <label class="field"><span class="lbl">Название</span><input type="text" name="name" value="${esc(p.name)}" ${canWrite() ? "" : "disabled"}></label>
          ${M.isBase(p) ? "" : `<label class="field"><span class="lbl">Статус</span><select name="status" ${canWrite() ? "" : "disabled"}>${statuses.filter(s => s !== "база").map(s => `<option${s === p.status ? " selected" : ""}>${esc(s)}</option>`).join("")}</select></label>`}
          <label class="field"><span class="lbl">Архетип</span><input type="text" name="archetype" list="archetypes" value="${esc(p.archetype || "")}" placeholder="курорт, город у моря, мегаполис, горы" ${canWrite() ? "" : "disabled"}><datalist id="archetypes">${ARCHETYPES.map(a => `<option value="${esc(a)}">`).join("")}</datalist></label>
        </div>
        <label class="field" id="reasonBox"${p.status === "отсев" ? "" : " hidden"}><span class="lbl">Причина отсева</span><input type="text" name="reason" value="${esc(p.reason || "")}" ${canWrite() ? "" : "disabled"}></label>
        <label class="field"><span class="lbl">Вопросы к следующей поездке</span><textarea name="questions" rows="3" ${canWrite() ? "" : "disabled"}>${esc(p.questions || "")}</textarea></label>
        ${canWrite() ? `<div class="btns"><button type="submit" class="btn">Сохранить карточку</button><span class="msg" id="placeMsg"></span></div>` : ""}
      </form>
    </section>`;
  const dirtyForms = new Set();
  const savePlaceDoc = async (formId, patch, msgId, okText) => {
    const msg = $(msgId);
    try {
      const { r } = await state.data.savePlace(patch(state.M.PLACE[p.id] || p), false, state.data.oidOf("places", p.id));
      savedNow(r);
      dirtyForms.delete(formId);
      state.dirty = dirtyForms.size > 0;
      toast(r === "queued" ? "Нет связи: отправится позже" : okText);
      if (state.dirty) { msg.textContent = okText; msg.className = "msg"; } else render();
    } catch (err) { msg.textContent = err.code === "clash" ? "Карточку только что изменили на другом устройстве. Нажмите «Сохранить» ещё раз: ваши поля запишутся поверх." : err.message; msg.className = "msg err"; }
  };
  [$("placeForm"), $("factsForm")].forEach(f => f.addEventListener("input", () => { dirtyForms.add(f.id); state.dirty = true; }));
  $("placeForm").querySelector('[name="status"]')?.addEventListener("change", e => { $("reasonBox").hidden = e.target.value !== "отсев"; });
  const factIn = F => ({ raw: String(($("factsForm").querySelector(`[name="fact_${F.key}"]`) || {}).value || "").trim(), src: String(($("factsForm").querySelector(`[name="src_${F.key}"]`) || {}).value || "").trim() });
  const factsOrig = Object.fromEntries((state.schema.facts || []).map(F => [F.key, factIn(F)]));
  $("factsForm").addEventListener("submit", e => {
    e.preventDefault();
    const edits = {}, bad = [];
    (state.schema.facts || []).forEach(F => {
      const cur = factIn(F), was = factsOrig[F.key];
      if (cur.raw === was.raw && cur.src === was.src) return;
      if (!cur.raw) { edits[F.key] = null; return; }
      const v = Number(cur.raw.replace(/[\s\u00a0€$₽]/g, "").replace(",", "."));
      if (!(v > 0)) { bad.push(F.name); return; }
      edits[F.key] = { v, src: cur.src, at: new Date().toISOString().slice(0, 10) };
    });
    if (bad.length) { $("factsMsg").textContent = "Не число: " + bad.join(", ") + ". Впишите только цифры, например 640."; $("factsMsg").className = "msg err"; return; }
    if (!Object.keys(edits).length) { $("factsMsg").textContent = "Ничего не изменилось."; $("factsMsg").className = "msg"; return; }
    savePlaceDoc("factsForm", cur => {
      const facts = Object.assign({}, cur.facts);
      Object.entries(edits).forEach(([k, v]) => { if (v) facts[k] = v; else delete facts[k]; });
      return Object.assign({}, cur, { facts });
    }, "factsMsg", "Цифры сохранены");
  });
  $("showEmpty").addEventListener("change", e => { state.showEmpty = e.target.checked; e.target.closest(".block").querySelector(".subtable").innerHTML = subtableHTML(state.M, state.M.PLACE[p.id] || p, state.showEmpty); });
  const pf = $("placeForm");
  const cardIn = () => { const f = new FormData(pf); return { name: String(f.get("name") || "").trim(), status: M.isBase(p) ? p.status : f.get("status"), archetype: String(f.get("archetype") || "").trim(), reason: String(f.get("reason") || "").trim(), questions: String(f.get("questions") || "").trim() }; };
  const cardOrig = cardIn();
  pf.addEventListener("submit", e => {
    e.preventDefault();
    const now = cardIn(), edits = {};
    Object.keys(now).forEach(k => { if (now[k] !== cardOrig[k]) edits[k] = now[k]; });
    if (!edits.name && "name" in edits) delete edits.name;
    if (!Object.keys(edits).length) { $("placeMsg").textContent = "Ничего не изменилось."; $("placeMsg").className = "msg"; return; }
    savePlaceDoc("placeForm", cur => Object.assign({}, cur, edits), "placeMsg", "Карточка сохранена");
  });
  el.querySelector("[data-focus]")?.addEventListener("click", e => { e.preventDefault(); focusPlace(p.id); });
  if (state.flashTrip) {
    const t = el.querySelector(`.trip[data-rid="${CSS.escape(state.flashTrip)}"]`);
    state.flashTrip = null;
    if (t) { t.classList.add("flash"); setTimeout(() => t.scrollIntoView({ block: "center", behavior: "smooth" }), 50); }
  }
  fillSimilar(p);
}

const ARCHETYPES = ["курорт", "малый курорт", "город у моря", "мегаполис", "столица", "горы"];

function factsHTML(p) {
  const base = state.M.isBase(p);
  const F = state.schema.facts || [];
  const dis = canWrite() ? "" : " disabled";
  return `<p class="small muted">${base ? "С этими цифрами сравниваются цифры других мест: в полтора раза дороже СПб — минус балл. Пустое поле — берётся ориентир по умолчанию." : "Цифры вносятся один раз на место, вместо оценки 1–5: приложение само сравнит их с СПб. Можно попросить Claude найти их по объявлениям."}</p>` + F.map(f => {
    const cur = p.facts && p.facts[f.key];
    const ref = factRef(f, state.M.places);
    const sc = base ? null : factScore(f, cur ? Number(cur.v) : null, ref);
    return `<div class="fact">
      <label class="field"><span class="lbl">${esc(f.name)}, ${esc(f.unit)}${sc != null ? ` <span class="badge" style="background:${scoreColor(sc)}">${fmt(sc)}</span>` : ""}</span>
        <input type="text" inputmode="decimal" name="fact_${f.key}" value="${cur ? esc(String(cur.v)) : ""}" placeholder="${base && f.ref ? "по умолчанию " + f.ref : ""}"${dis}></label>
      <label class="field src"><span class="lbl">Откуда</span><input type="text" name="src_${f.key}" value="${cur ? esc(cur.src || "") : ""}" placeholder="сайт, число объявлений"${dis}></label>
      <span class="small muted">${esc(f.hint)}${!base && f.rule === "money" && ref ? ` СПб: €${ref}.` : ""}${cur && cur.at ? ` Вписано ${esc(cur.at)}.` : ""}</span>
    </div>`;
  }).join("");
}

function climLegend(name, withRef) {
  return `<div class="legend small"><span><i class="sw v"></i>${esc(name)}, средняя °C</span>${withRef ? `<span><i class="sw base" style="width:14px;height:0;border-top:2px dashed var(--base)"></i>СПб, °C</span>` : ""}<span><i class="sw" style="background:var(--pos);opacity:.4;border-radius:2px"></i>осадки, мм — модель, у моря и в горах бывает завышено</span></div>`;
}

async function fillSimilar(p) {
  const box = $("simBox");
  if (!box) return;
  await state.world.loadCities();
  if (!state.sim) state.sim = new Similar(state.world, state.schema.groups);
  const city = state.world.placeCity(p);
  if (!p.cc && !city) { box.innerHTML = `<p class="small muted">У места нет координат и страны — сравнивать не с чем.</p>`; return; }
  const sp = state.sim.similarSplit({ cc: p.cc, city: city && !city.synthetic ? city : null, lat: p.lat, lon: p.lon }, W());
  if ($("simBox") !== box) return;
  box.innerHTML = similarSplitHTML(sp, p.cc) + `<div class="btns" style="margin-top:10px"><button type="button" class="btn ghost small" id="simMap">Показать на карте</button></div>`;
  box.addEventListener("click", e => {
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
      save: (body, { isNew, baseOid, questions } = {}) => {
        const p = state.M.PLACE[body.place];
        const extra = questions && p ? [state.data.placeChange(Object.assign({}, p, { questions: p.questions ? p.questions.trim() + "\n" + questions : questions }))] : [];
        return state.data.saveRating(body, { isNew, baseOid, extra });
      },
      saved: (res, placeId) => {
        savedNow(res.r);
        toast(res.r === "queued" ? "Нет связи: оценка сохранена на телефоне и отправится позже" : "Сохранено. Рейтинг обновился.");
        state.flashTrip = res.doc && res.doc.id;
        go(placeHref(placeId));
      },
      remove: (rid, oid) => {
        const r = state.data.view().ratings.find(x => x.id === rid);
        if (!r) return Promise.reject(new Error("Оценка не найдена"));
        return state.data.deleteRating(r, oid || undefined);
      },
      removed: (placeId, r) => { savedNow(r); toast(r === "queued" ? "Нет связи: удаление отправится позже" : "Оценка удалена."); go(placeId && state.M.PLACE[placeId] ? placeHref(placeId) : "#/places"); },
      placeName: id => (state.M.PLACE[id] || {}).name || "",
      myRating: (placeId, who) => state.M.ratingsOf(placeId).filter(r => r.who === who).sort((a, b) => String(b.start || b.updatedAt || "").localeCompare(String(a.start || a.updatedAt || "")))[0] || null,
      edit: rid => go("#/rate/" + encodeURIComponent(rid)),
    });
  }
  state.form.setPlaces(state.M.places);
  if (arg && arg.startsWith("new/")) {
    state.form.startFor(arg.slice(4));
    history.replaceState(null, "", "#/rate");
  } else if (arg) {
    const r = state.data.view().ratings.find(x => x.id === arg && !x.deleted);
    if (r) state.form.load(r, state.data.oidOf("ratings", r.id)); else toast("Оценка не найдена");
    history.replaceState(null, "", "#/rate");
  } else state.form.startNew();
  if (!$("rateBanner")) $("rateForm").insertAdjacentHTML("afterbegin", `<div id="rateBanner"></div>`);
  $("rateBanner").innerHTML = bannerHTML();
}

/* ---------- settings ---------- */
function renderSettings() {
  const d = state.data;
  const who = me();
  const theme = local.get("theme", "auto");
  const owner = (d.repo.split("/")[0] || "Mihinator3000");
  const device = /iPhone|Android/i.test(navigator.userAgent) ? "phone" : "mac";
  const tokenUrl = `https://github.com/settings/personal-access-tokens/new?name=${encodeURIComponent("where-to-live-" + device + "-" + new Date().toISOString().slice(0, 10))}&description=${encodeURIComponent("Где жить: чтение и запись данных")}&target_name=${encodeURIComponent(owner)}&expires_in=none&contents=write`;
  const ind = state.world.indicators;
  const installFirst = isPhone() && !isStandalone();
  const install = `<section class="block"><h2>${installFirst ? "Сначала: установите на экран «Домой»" : "На экран «Домой»"}</h2>
      <div class="panel pad help"><span>iPhone: Safari → Поделиться → «На экран „Домой“». Дальше открывайте с иконки: так данные не стираются через неделю, как во вкладке Safari.</span><span>У приложения с экрана «Домой» своё хранилище, поэтому ключ доступа вставляется уже в нём.</span></div>
    </section>`;
  $("v-settings").innerHTML = `
    <header><h1>Настройки</h1></header>
    ${installFirst ? install : ""}
    <section class="block"><h2>Кто я на этом устройстве</h2>
      <div class="panel pad stack"><div class="seg" role="group" id="meSeg">${state.schema.people.map(w => `<button type="button" data-me="${esc(w)}" aria-pressed="${w === who}">${esc(w)}</button>`).join("")}</div><p class="small muted">Подставляется в форму оценки. Оценки другого скрыты, пока вы не оцените место сами, чтобы не подглядывать.</p></div>
    </section>
    <section class="block"><h2>Подключение к данным</h2>
      <form class="panel pad stack" id="tokenForm">
        <p class="small">Наши оценки лежат в закрытом хранилище на GitHub. Чтобы видеть и сохранять их с этого устройства, нужен ключ доступа: его делают один раз, на каждое устройство свой.</p>
        <input type="text" name="username" value="where-to-live-${esc(slugMe())}" autocomplete="username" hidden>
        <label class="field"><span class="lbl">Ключ доступа ${d.hasToken ? "(уже сохранён; вставьте новый, чтобы заменить)" : ""}</span><input type="password" name="token" placeholder="github_pat_…" spellcheck="false" autocapitalize="off" autocomplete="current-password"></label>
        <div class="btns"><button type="submit" class="btn">Сохранить и проверить</button>${d.hasToken ? `<button type="button" class="btn danger" id="forget">Забыть ключ на этом устройстве</button>` : ""}</div>
        <p class="msg" id="tokenMsg" role="status">${d.hasToken ? esc(statusLine()) : ""}</p>
        <details><summary class="small">Как получить ключ</summary><ol class="small help" style="padding-left:18px">
          <li>Откройте <a href="${esc(tokenUrl)}" target="_blank" rel="noopener noreferrer">создание ключа на GitHub</a> (войти под аккаунтом Михаила). Имя, срок «без срока» и право Contents: Read and write уже подставлены.</li>
          <li>Repository access → Only select repositories → <b>${esc(d.repo.split("/")[1] || "where-to-live-data")}</b>.</li>
          <li>Generate token, скопируйте и вставьте сюда. Для телефона Вики — отдельный ключ с её именем, чтобы отзывать независимо.</li>
          <li>Сохраните ключ ещё и в Связке ключей или менеджере паролей: на сайт его можно ввести заново за минуту.</li></ol></details>
        <details><summary class="small">Технические подробности</summary><div class="stack" style="margin-top:8px">
          <p class="small muted">Это fine-grained токен GitHub с доступом только к одному репозиторию. Он хранится в памяти браузера на этом устройстве и уходит только на api.github.com.</p>
          <label class="field"><span class="lbl">Репозиторий с данными</span><input type="text" name="repo" value="${esc(d.repo)}" spellcheck="false" autocapitalize="off"></label>
        </div></details>
      </form>
    </section>
    <section class="block"><h2>Вид</h2>
      <div class="panel pad stack">
        <div class="seg" role="group" id="themeSeg">${[["auto", "Как в системе"], ["light", "Светлая"], ["dark", "Тёмная"]].map(([k, n]) => `<button type="button" data-theme="${k}" aria-pressed="${k === theme}">${n}</button>`).join("")}</div>
        <label class="toggle"><input type="checkbox" id="useData"${useData() ? " checked" : ""}> Учитывать мировые показатели в итоге (колонка «Данные»)</label>
        <p class="small muted">Показатели страны и климат города переводятся в шкалу 1–5, где Россия/СПб = 3, и входят в итог подкатегории по правилам методики: где туристу видно мало, у данных больше веса.</p>
      </div>
    </section>
    ${installFirst || isStandalone() ? "" : install}
    <section class="block"><h2>Копия данных</h2>
      <div class="panel pad stack"><p class="small muted">Всё, что видно сейчас (места, оценки, веса), одним файлом JSON.</p><div class="btns"><button type="button" class="btn ghost" id="exportBtn">Скачать JSON</button><button type="button" class="btn ghost" id="refreshBtn">Обновить из GitHub</button></div></div>
    </section>
    <section class="block"><h2>Источники данных</h2>
      <div class="panel pad small help">
        <span>Карта: © участники OpenStreetMap (ODbL), тайлы OSM. Поиск: Nominatim, данные © OpenStreetMap. Границы: Natural Earth (public domain), показаны de facto.</span>
        <span>Города: GeoNames (CC BY 4.0). Климат: CHELSA V2.1, 1981–2010 (CC0). Световой день — расчёт по формуле NOAA. Аэропорты с регулярными рейсами: OurAirports (public domain), аэропорты стран, куда с паспортом РФ нужна виза, не учитываются.</span>
        ${ind.length ? `<span>Показатели стран (выгрузка ${esc(state.world.generated)}): ${[...new Set(ind.map(i => `${i.source}${i.license ? " (" + i.license + ")" : ""}`))].map(esc).join("; ")}. Значения переведены в шкалу 1–5 приложением.</span>` : ""}
        <span>Код: <a href="https://github.com/Mihinator3000/where-to-live" target="_blank" rel="noopener noreferrer">github.com/Mihinator3000/where-to-live</a>.</span>
      </div>
    </section>`;
  $("meSeg").addEventListener("click", e => { const b = e.target.closest("[data-me]"); if (!b) return; local.set("me", b.dataset.me); rebuild(); renderSettings(); });
  $("themeSeg").addEventListener("click", e => { const b = e.target.closest("[data-theme]"); if (!b) return; setTheme(b.dataset.theme); renderSettings(); });
  $("useData").addEventListener("change", e => { local.set("worldData", e.target.checked); rebuild(); });
  $("tokenForm").addEventListener("input", () => { state.dirty = true; });
  $("tokenForm").addEventListener("submit", async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const token = String(f.get("token") || "").trim();
    const repo = String(f.get("repo") || DEFAULT_REPO).trim() || DEFAULT_REPO;
    const msg = $("tokenMsg");
    msg.className = "msg";
    if (token) {
      msg.textContent = "Проверяю ключ…";
      const [owner, name] = repo.split("/");
      try {
        await new GitHubStore({ owner, repo: name, token }).load();
      } catch (err) {
        msg.textContent = (err.code === "offline" ? "Нет связи, ключ не проверен и не сохранён." : "Ключ не подошёл, он не сохранён.") + (d.hasToken ? " Остался прежний ключ." : "") + (err.message && err.code !== "auth" ? " " + err.message : "");
        msg.className = "msg err";
        return;
      }
      e.target.querySelector('[name="token"]').value = "";
    }
    d.setCredentials(repo, token || null);
    msg.textContent = "Загружаю данные…";
    await d.refresh();
    msg.textContent = statusLine();
    msg.className = "msg" + (d.status === "live" ? "" : " err");
    if (d.status === "live") { toast("Подключено: данные загружены"); renderSettings(); }
  });
  $("forget")?.addEventListener("click", e => {
    const b = e.currentTarget;
    if (!b.dataset.armed) {
      b.dataset.armed = "1"; b.textContent = "Точно забыть? Нажмите ещё раз";
      setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = "Забыть ключ на этом устройстве"; } }, 5000);
      return;
    }
    d.forget();
    toast(d.pending.length ? `Ключ и кэш удалены. Неотправленные правки (${d.pending.length}) уйдут после нового ключа` : "Ключ и кэш удалены с этого устройства");
    renderSettings();
  });
  $("exportBtn").addEventListener("click", () => {
    const v = state.data.view();
    const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), places: v.places, ratings: v.ratings, weights: v.weightDocs, notSent: local.get("lost", []) }, null, 1)], { type: "application/json" });
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
    return `Подключено: мест ${v.places.length}, оценок ${v.ratings.filter(r => !r.deleted).length}.`;
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
    const thin = !M.isBase(p) && !M.ownEnough(p.id);
    return { id: p.id, name: p.name, lat: p.lat, lon: p.lon, base: M.isBase(p), out, thin, dark: t.score != null && Math.abs(t.score - 3) < 1, color: M.isBase(p) ? "var(--base)" : t.score == null ? "var(--none)" : scoreColor(t.score), text: M.isBase(p) ? "" : t.score == null ? "" : fmt(t.score) };
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

const zoomedIn = () => !!state.mapView && state.mapView.map.getZoom() >= 7;

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
    return { fill: true, fillColor: fill || "#000000", fillOpacity: fill ? (zoomedIn() ? 0.2 : 0.55) : 0, color, weight, dashArray, opacity: 1 };
  };
}

function cityColorer() {
  const L = state.layers, Wd = state.world;
  if (!L.city) return null;
  if (L.city === "similar") {
    const target = similarTarget();
    if (!target) return null;
    if (!state.sim) state.sim = new Similar(Wd, state.schema.groups);
    const list = state.sim.similarCities(target.x, W(), { k: 60, perCountry: 8 });
    const pct = new Map(list.map(x => [x.city.id, x.pct]));
    const rank = new Map(list.map((x, i) => [x.city.id, list.length > 1 ? i / (list.length - 1) : 0]));
    return { list: list.map(x => x.city), fn: c => { const q = rank.get(c.id); return q == null ? null : { fill: scoreHex(5 - 2 * q), r: 7 - 3 * q }; }, label: c => `${c.n}: похоже на ${pct.get(c.id)}%`, legend: { title: `Похожие на «${target.name}», топ-${list.length}`, ramp: [3, 3.5, 4, 4.5, 5].map(scoreHex), lo: "меньше", hi: "больше" } };
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
      <span class="desc">Точки городов от 15 тыс. жителей. Климат — средние 1981–2010 (CHELSA), синее — лучше СПб, красное — хуже. «Похожие» и «Прогноз» строятся по вашим весам.</span>
      ${L.city === "predict" ? predictTopHTML() : ""}
    </div>
    <label class="toggle"><input type="checkbox" id="lyPlaces"${L.places ? " checked" : ""}> Наши места: цвет и число — итог 1–5; полый кружок — своих оценок мало</label>
    <label class="toggle"><input type="checkbox" id="lyVisited"${L.visited ? " checked" : ""}> Страны, где были: обведены контуром</label>
    <span class="desc">Сплошной — были оба, пунктир фиолетовый — только ${esc(state.schema.people[0])}, оранжевый — только ${esc(state.schema.people[1])}.</span>
    <div class="btns"><button type="button" class="btn ghost small" id="lyClose">Готово</button></div>`;
}

function predictTopHTML() {
  const fn = predictor();
  if (!fn) return "";
  const ours = state.M.places.filter(p => p.lat != null);
  const list = state.world.cities.filter(c => !ours.some(p => haversine(p, c) < 15)).map(c => ({ c, r: fn({ cc: c.cc, city: c }) })).filter(x => x.r).sort((a, b) => b.r.score - a.r.score).slice(0, 10);
  if (!list.length) return "";
  return `<div class="ptop"><span class="lbl">Лучшие по прогнозу</span>${list.map(x => `<button type="button" data-pcity="${x.c.id}"><span>${esc(x.c.n)}<span class="muted"> · ${esc(state.world.nameOf(x.c.cc))}</span></span><span class="num">${fmt(x.r.score)}</span></button>`).join("")}<span class="desc">Прогноз — как нам понравилось бы, судя по оценённым местам, похожим на этот город.</span></div>`;
}

function initMap() {
  if (state.mapView) return;
  state.mapView = new MapView($("map"), {
    onPlace: id => openPlace(id),
    onCountry: (iso, latlng) => openCountry(iso, latlng),
    onCity: c => openCity(c),
    onBlank: () => { closeSheet(); closeLayers(); },
    onZoom: () => { if (!state.mapView) return; const z = zoomedIn(); if (z !== state.zoomedIn) { state.zoomedIn = z; state.mapView.restyleCountries(countryStyle()); } },
  });
  state.zoomedIn = zoomedIn();
  if (state.world.geo) state.mapView.setCountries(state.world.geo, countryStyle());
  $("layersBtn").addEventListener("click", () => {
    const p = $("layersPanel");
    p.hidden = !p.hidden;
    $("layersBtn").setAttribute("aria-expanded", String(!p.hidden));
    if (!p.hidden) p.innerHTML = layersHTML();
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && state.route.name === "map") { if (!$("layersPanel").hidden) closeLayers(); else if (state.sheet) closeSheet(); } });
  $("layersPanel").addEventListener("change", e => {
    const L = state.layers;
    if (e.target.id === "lyCountry") L.country = e.target.value;
    if (e.target.id === "lyCity") L.city = e.target.value;
    if (e.target.id === "lyPlaces") L.places = e.target.checked;
    if (e.target.id === "lyVisited") L.visited = e.target.checked;
    saveLayers(); renderMap();
    if (e.target.id === "lyCity") $("layersPanel").innerHTML = layersHTML();
  });
  $("layersPanel").addEventListener("click", e => {
    if (e.target.closest("#lyClose")) { closeLayers(); return; }
    const pc = e.target.closest("[data-pcity]");
    if (pc) { const c = state.world.cities.find(x => String(x.id) === pc.dataset.pcity); if (c) openCity(c, true); return; }
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
    searchSeq++;
    $("searchResults").hidden = true;
    $("searchInput").blur();
    if (item.type !== "remote") $("searchInput").value = "";
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
  if (!local.get("introSeen", false) && $("sheet").hidden) openIntro();
}

function openIntro() {
  state.sheet = { type: "intro" };
  openSheet(`<h3>Как пользоваться картой</h3>
    <div class="help small"><span>Кружки — наши места: цвет и число — итог 1–5, где 3 — как в СПб. Квадрат — сам СПб. Несколько мест рядом собираются в кружок с числом — нажмите, чтобы приблизить.</span><span>Нажмите на страну или город — увидите мировые данные и похожие места. Найти или добавить место — поиск сверху. «Слои» — раскраска стран и городов по показателям.</span><span>После поездки — вкладка «Оценить».</span>${state.data.hasToken ? "" : `<span>Чтобы видеть и сохранять наши оценки, вставьте ключ доступа в <a href="#/settings">настройках</a>.</span>`}</div>
    <div class="btns"><button type="button" class="btn" data-act="introok">Понятно</button></div>`);
}

function refreshSheet() {
  const s = state.sheet;
  if (!s || $("sheet").hidden) return;
  const body = $("sheetBody"), top = body.scrollTop, full = $("sheet").classList.contains("full");
  if (s.type === "place") { if (!state.M.PLACE[s.id]) { closeSheet(); return; } openPlace(s.id); }
  else if (s.type === "country") openCountry(s.iso, s.latlng);
  else return;
  body.scrollTop = top;
  $("sheet").classList.toggle("full", full);
}

/* ---------- search ---------- */
let searchTimer = null, searchSeq = 0;
function runSearch(q, remote) {
  const box = $("searchResults");
  const seq = ++searchSeq;
  clearTimeout(searchTimer);
  if (!q) { box.hidden = true; return; }
  const ql = q.toLowerCase();
  const items = [];
  const ours = state.M.places.filter(p => p.lat != null);
  const near = (x, km) => ours.some(p => haversine(p, x) < km);
  state.M.places.filter(p => p.name.toLowerCase().includes(ql)).slice(0, 4).forEach(p => items.push({ type: "place", id: p.id, title: p.name, sub: p.country || "" }));
  if (state.world.cities) state.world.cities.filter(c => (c.n.toLowerCase().startsWith(ql) || (c.en && c.en.toLowerCase().startsWith(ql))) && !near(c, 5)).slice(0, 5).forEach(c => items.push({ type: "city", city: c, title: c.n, sub: state.world.nameOf(c.cc) + (c.pop ? " · " + Math.round(c.pop / 1000).toLocaleString("ru-RU") + " тыс. жителей" : "") }));
  else state.world.loadCities();
  const GROUP = { place: "Наши места", city: "Города мира", geo: "OpenStreetMap", remote: "" };
  const show = (extra, note) => {
    state.searchItems = items.concat(extra || []);
    let last = "";
    box.innerHTML = state.searchItems.map((it, i) => {
      const g = GROUP[it.type];
      const head = g && g !== last ? `<div class="grp">${g}</div>` : "";
      last = g;
      return `${head}<button type="button" data-i="${i}">${esc(it.title)}${it.sub ? `<small>${esc(it.sub)}</small>` : ""}</button>`;
    }).join("") + (note ? `<div class="note">${note}</div>` : "");
    box.hidden = !state.searchItems.length && !note;
  };
  if (!remote) {
    show([{ type: "remote", title: `Искать «${q}» везде`, sub: "Enter · поиск по OpenStreetMap" }]);
    return;
  }
  show([], "Ищу в OpenStreetMap…");
  search(q).then(res => {
    if (seq !== searchSeq) return;
    const fresh = res.filter(g => !near(g, 3));
    show(fresh.map(g => ({ type: "geo", geo: g, title: g.name, sub: g.label })), fresh.length ? "Поиск: Nominatim, данные © OpenStreetMap" : res.length ? "Всё найденное уже есть среди наших мест" : "Ничего не нашлось");
  }).catch(err => { if (seq === searchSeq) show([], esc(err.message)); });
}

/* ---------- sheet ---------- */
function openSheet(html) {
  $("sheetBody").innerHTML = html;
  $("sheet").hidden = false;
  $("sheet").classList.remove("full");
  $("layersPanel").hidden = true;
  $("layersBtn").setAttribute("aria-expanded", "false");
}

function closeLayers() {
  if ($("layersPanel").hidden) return;
  $("layersPanel").hidden = true;
  $("layersBtn").setAttribute("aria-expanded", "false");
}

function closeSheet() {
  if (state.sheet && state.sheet.type === "intro") local.set("introSeen", true);
  $("sheet").hidden = true;
  state.sheet = null;
  if (state.mapView) state.mapView.clearTemp();
}

function scoreLine(M, p) {
  const t = placeScore(M, p, W());
  const per = M.PEOPLE.map((w, i) => { const s = M.hidden(p.id, w) ? null : M.total(p, W(), w).score; return s == null ? "" : `<span><i class="sw ${i ? "v" : "m"}"></i>${esc(w)} ${fmt(s)}</span>`; }).join("");
  const own = M.ratingsOf(p.id).length;
  return `<div class="bigscore"><b>${M.isBase(p) ? "3.0" : fmt(t.score)}</b><span class="muted small">${M.isBase(p) ? "база" : t.score == null ? "оценок нет" : `из 5, где 3 — как в СПб${own ? "" : " · только мировые данные"}`}</span></div>${per ? `<div class="legend">${per}</div>` : ""}`;
}

function openPlace(id, fly) {
  const M = state.M, p = M.PLACE[id];
  if (!p) return;
  state.sheet = { type: "place", id };
  const rs = M.ratingsOf(p.id).filter(r => r.review && !M.hidden(p.id, r.who)).slice(-3).reverse();
  const hid = hiddenWho(M, p.id);
  const years = yearsLine(M, p.id);
  openSheet(`<h3>${esc(p.name)}</h3>
    <div class="chips">${p.country ? `<span class="chip">${esc(p.country)}</span>` : ""}<span class="chip">${esc(p.status || "кандидат")}</span>${years ? `<span class="chip" title="Прожили бы здесь год? 0–10">год здесь: ${esc(years)}</span>` : ""}<span class="chip">оценок: ${M.ratingsOf(p.id).length}</span></div>
    ${scoreLine(M, p)}
    ${rs.map(r => `<div class="review ${r.who === M.PEOPLE[1] ? "v" : "m"}"><b>${esc(r.who)}${r.start ? " · " + esc(datesRu(r.start, r.end)) : ""}:</b> ${esc(r.review)}</div>`).join("")}
    ${hid.length ? `<p class="small muted">Оценки: ${esc(hid.join(", "))} скрыты, пока вы не оцените место сами. <button type="button" class="linkbtn" data-reveal="${esc(p.id)}">Показать всё равно</button></p>` : ""}
    <div class="btns"><a class="btn" href="${placeHref(p.id)}">Досье</a>${M.isBase(p) ? "" : `<a class="btn ghost" href="#/rate/new/${encodeURIComponent(p.id)}">Оценить</a>`}<button type="button" class="btn ghost" data-act="simplace" data-id="${esc(p.id)}">Похожие</button></div><div id="simPlaceBox"></div>`);
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
    <div class="btns"><button type="button" class="btn" data-act="simcountry" data-iso="${iso}">Похожие страны</button><button type="button" class="btn ghost" data-act="addhere">Добавить город в этой точке</button></div>
    <div id="simCountryBox"></div>
    <div class="world">${worldRowsHTML(iso, null, state.layers.country)}</div>`);
}

function openCity(c, fly) {
  const Wd = state.world;
  state.sheet = { type: "city", city: c };
  const own = state.M.places.find(p => p.lat != null && haversine(p, c) < 5);
  const pf = Wd.cities ? predictor() : null, pr = pf && pf({ cc: c.cc, city: c });
  openSheet(`<h3>${esc(c.n)}</h3>
    <div class="chips"><span class="chip">${esc(Wd.nameOf(c.cc))}</span>${c.pop ? `<span class="chip">${Math.round(c.pop / 1000).toLocaleString("ru-RU")} тыс. жителей</span>` : ""}<span class="chip">${esc(kgName(c.kg))}</span></div>
    ${pr ? `<div class="bigscore"><b>${fmt(pr.score)}</b><span class="muted small">прогноз для нас по похожим оценённым местам · уверенность ${Math.round(pr.conf * 100)}%</span></div>` : ""}
    ${Array.isArray(c.t) ? `<div class="clim">${climateSVG(c, Wd.spbCity)}</div>${climLegend(c.n, Wd.spbCity && Wd.spbCity !== c)}` : ""}
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
  if (!canWrite()) { toast("Чтобы добавлять места, вставьте ключ доступа в настройках"); go("#/settings"); return; }
  const existing = state.M.places.find(p => p.lat != null && haversine(p, info) < 3);
  if (existing) { toast("Это место уже есть: " + existing.name); openPlace(existing.id, true); return; }
  const doc = {
    name: info.name, country: info.country || state.world.nameOf(info.cc) || "", cc: info.cc || null,
    lat: info.lat, lon: info.lon, status: "кандидат", archetype: "", reason: "", questions: "", ext: {},
    osm: info.osm || null, geonameid: info.geonameid || null,
  };
  try {
    const { r, doc: saved } = await state.data.savePlace(doc, true);
    savedNow(r);
    toast(r === "queued" ? "Нет связи: место отправится позже" : `Добавлено: ${saved.name}`);
    rebuild();
    renderMap();
    openPlace(saved.id, false);
  } catch (err) { toast(err.message); }
}

async function onSheetClick(e) {
  const b = e.target.closest("[data-act], [data-city], [data-country]");
  if (e.target.closest("[data-reveal]")) return;
  if (!b) return;
  const Wd = state.world;
  if (b.dataset.city) { const c = Wd.cities.find(x => String(x.id) === b.dataset.city); if (c) openCity(c, true); return; }
  if (b.dataset.country) { const iso = b.dataset.country; const f = Wd.geo.features.find(x => x.properties.iso3 === iso); const ll = f ? window.L.geoJSON(f).getBounds().getCenter() : { lat: 0, lng: 0 }; openCountry(iso, ll); state.mapView.map.flyToBounds(window.L.geoJSON(f).getBounds(), { maxZoom: 6, duration: 0.8 }); return; }
  const act = b.dataset.act;
  if (act === "introok") { closeSheet(); return; }
  if (act === "addhere") {
    const ll = state.sheet && state.sheet.latlng;
    if (!ll) return;
    b.disabled = true; b.textContent = "Определяю место…";
    try {
      const g = await reverse(ll.lat.toFixed(5), ll.lng.toFixed(5));
      if (!g) { toast("Здесь не нашлось населённого пункта"); b.disabled = false; b.textContent = "Добавить город в этой точке"; return; }
      openGeo(Object.assign(g, { lat: Number(ll.lat.toFixed(5)), lon: Number(ll.lng.toFixed(5)) }));
    } catch (err) { toast(err.message); b.disabled = false; b.textContent = "Добавить город в этой точке"; }
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
    let to;
    if (act === "simcity") { const c = state.sheet.city; x = { cc: c.cc, city: c, lat: c.lat, lon: c.lon }; to = { type: "city", id: c.id }; boxId = "simCityBox"; }
    else { const p = state.M.PLACE[b.dataset.id]; const city = Wd.placeCity(p); x = { cc: p.cc, city: city && !city.synthetic ? city : null, lat: p.lat, lon: p.lon }; to = { type: "place", id: p.id }; boxId = "simPlaceBox"; }
    state.simCandidate = to;
    const sp = state.sim.similarSplit(x, W(), { home: 3, abroad: 6 });
    const html = `<h2 style="margin:4px 0">Похожие · веса «${esc(state.preset)}»</h2>` + similarSplitHTML(sp, x.cc) + `<div class="btns" style="margin-top:8px"><button type="button" class="btn ghost small" data-act="simshow">Показать все на карте</button></div>`;
    if ($(boxId)) $(boxId).innerHTML = html;
  } else if (act === "simshow" && state.simCandidate) {
    state.layers.simTo = state.simCandidate; state.layers.city = "similar"; saveLayers();
    renderMap();
    toast("На карте: похожие города, ярче — похожее");
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
    const d = state.data;
    if (d.flushed) { toast("Отправлено из очереди: " + d.flushed); savedNow("sent"); d.flushed = 0; }
    rebuild();
    if (state.route.name === "rate") { renderSync(); if (state.form) state.form.setPlaces(state.M.places); if ($("rateBanner")) $("rateBanner").innerHTML = bannerHTML(); }
    else if (state.dirty && (state.route.name === "place" || state.route.name === "settings")) renderSync();
    else render();
  });
  $("themeBtn").addEventListener("click", () => {
    const order = ["auto", "light", "dark"], t = order[(order.indexOf(local.get("theme", "auto")) + 1) % 3];
    setTheme(t);
    toast("Тема: " + ({ auto: "как в системе", light: "светлая", dark: "тёмная" })[t]);
    if (state.route.name === "settings") renderSettings();
  });
  $("syncBtn").addEventListener("click", () => { if (!state.data.hasToken) go("#/settings"); else state.data.refresh(); });
  document.addEventListener("click", e => {
    if (e.target.closest("[data-dismiss-notice]")) { state.data.notice = ""; state.data.emit(); return; }
    const rv = e.target.closest("[data-reveal]");
    if (rv) { state.revealed.add(rv.dataset.reveal); local.set("revealed", [...state.revealed]); rebuild(); render(); return; }
    const sm = e.target.closest("[data-setme]");
    if (sm) { local.set("me", sm.dataset.setme); rebuild(); render(); toast("Это устройство: " + sm.dataset.setme); return; }
    const la = e.target.closest("[data-lostapply]");
    if (la) {
      la.closest(".lost").querySelectorAll("button").forEach(b => { b.disabled = true; });
      state.data.applyLost(Number(la.dataset.lostapply)).then(r => { if (!r) return; savedNow(r); toast(r === "queued" ? "Нет связи: отправится позже" : "Записано поверх"); }).catch(err => { toast(err.code === "clash" ? "Снова изменили на другом устройстве — нажмите «Обновить» и попробуйте ещё раз" : err.message); state.data.emit(); });
      return;
    }
    const ld = e.target.closest("[data-lostdrop]");
    if (ld) { state.data.dropLost(Number(ld.dataset.lostdrop)); }
  });
  addEventListener("hashchange", route);
  document.addEventListener("click", e => { const a = e.target.closest("a[data-nav]"); if (a && a.getAttribute("href") === location.hash) { e.preventDefault(); route(); } });
  route();
  state.world.loadCities().then(() => { state.sim = null; rebuild(); if (state.route.name !== "rate" && !state.dirty) render(); });
  setInterval(() => { if (document.visibilityState === "visible") state.data.poll(); }, 60000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") state.data.poll(); });
  if (state.data.hasToken) await state.data.refresh();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}

boot().catch(err => {
  document.getElementById("main").insertAdjacentHTML("afterbegin", `<div class="page"><div class="banner err">Не загрузилось: ${esc(err.message)}</div></div>`);
});

export { state, uid, SHORT, toScore };
