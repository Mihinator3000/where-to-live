import { createModel, fmt, normalize, MIN_COVERAGE, MIN_OWN, gen } from "./calc.js";
import { Data, DEFAULT_REPO, getK } from "./data.js";
import { RateForm, datesRu, ratingField } from "./form.js";
import { factValue, factRef, factScore, parseAmount } from "./facts.js";
import { GitHubStore } from "./store.js";
import { MapView } from "./map.js";
import { search, reverse } from "./geo.js";
import { Similar, kgName } from "./similar.js";
import { $, esc, local, toast, scoreHex, inkOn, pal, refreshPalette, uid, plural, todayISO, reducedMotion } from "./util.js";
import { World, CITY_INDICATORS, MONTHS, fmtValue, toScore, CIVIDIS, haversine } from "./world.js";
import { rankHTML, heatHTML, flagsHTML, radarSVG, radarLegend, radarTable, tripsHTML, subtableHTML, placesListHTML, placeHref, placeScore, yearsLine, hasResidents, hiddenWho, hiddenNote, SHORT } from "./views.js";

const TRIPS_BUDGET = 20;
const NOKEY = `Места и оценки появятся после подключения данных: вставьте ключ в <a href="#/settings">настройках</a>.`;
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
  simCandidate: null,
  introShown: false,
  fitSimilar: false,
  pendingEdit: null,
  histId: null,
  backOf: {},
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
  full.places.forEach(p => {
    const rs = full.ratingsOf(p.id);
    if (state.revealed.has(p.id) || (m ? rs.some(r => r.who === m) : full.PEOPLE.every(w => rs.some(r => r.who === w)))) return;
    rs.forEach(r => { if (r.who !== m) hid.add(p.id + "|" + r.who); });
  });
  const M = state.M = hid.size ? createModel(state.schema, Object.assign({}, v, { ratings: v.ratings.filter(r => !hid.has(r.place + "|" + r.who)) }), { autoData: auto }) : full;
  M.hidden = (id, w) => hid.has(id + "|" + w);
  M.full = full;
  M.me = full.me = m;
  const P = M.presets;
  if (!P[state.preset] && state.preset !== "Своё") state.preset = "Оба";
  const use = state.preset === "Своё" || presetNames(M).includes(state.preset) ? state.preset : "Поровну";
  if (state.preset !== "Своё" || !state.weights) state.weights = Object.assign({}, P[use] || P["Поровну"]);
  (globalThis.requestIdleCallback || setTimeout)(() => { if (state.M !== M) return; try { M.ranking(W()); M.allFlags(); full.allFlags(); } catch (e) {} });
}

function presetNames(M) {
  const saved = state.data.view().weights;
  const own = M.PEOPLE.filter(w => saved[w] && Object.keys(saved[w]).length);
  return ["Поровну"].concat(own, own.length === M.PEOPLE.length ? ["Оба"] : [], ["Своё"]);
}

const whenRu = iso => {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const t = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }), now = new Date(), y = new Date(now); y.setDate(now.getDate() - 1);
  return d.toDateString() === now.toDateString() ? "сегодня в " + t : d.toDateString() === y.toDateString() ? "вчера в " + t : d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" }) + " в " + t;
};
const dayRu = iso => { const d = new Date(String(iso).length === 10 ? iso + "T12:00:00" : iso); return isNaN(d) ? String(iso) : d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" }); };
const popRu = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, "")} млн жителей` : `${Math.round(n / 1000).toLocaleString("ru-RU")} тыс. жителей`);
const onDevice = () => (isPhone() ? "на телефоне" : "на этом устройстве");
const failWhy = err => err.code === "forbidden" ? "у ключа нет прав на запись — замените ключ в настройках" : err.code === "storage" ? "нет связи, а память браузера переполнена" : String(err.message || "неизвестная ошибка").replace(/\.$/, "");
const failWhen = err => err.code === "limit" ? "после этого времени" : err.code === "forbidden" ? "с новым ключом" : err.code === "rejected" ? "позже; если GitHub откажет снова, причину нужно исправить в хранилище на GitHub — или попросите Claude" : "через минуту";

const W = () => normalize(state.schema.groups, state.weights);
const hiddenPairs = M => M.places.reduce((n, p) => n + hiddenWho(M, p.id).length, 0);
const ratingCount = M => M.ratings.length + hiddenPairs(M);
const textLine = v => String(v).split("\n").map(x => x.trim()).filter(Boolean).join(" / ");
const ghDown = () => state.data.status === "error" && state.data.errorCode === "limit" ? `${String(state.data.error || "GitHub временно ограничил запросы").replace(/\.$/, "")}` : state.data.stuck ? "GitHub давно не принимает правки" : "GitHub сейчас не отвечает";
const hhmmOf = t => new Date(t).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
const waitMsg = (what, done) => { const d = state.data, kept = `${what} ${done} ${onDevice()}`, send = /ы$/.test(done) ? "отправятся" : "отправится"; if (d.status === "auth" && d.errorCode === "access") return `Хранилище данных недоступно: ${kept} и ${send}, когда доступ вернётся`; if (d.status === "auth") return `Ключ не подходит: ${kept} и ${send}, когда вы замените ключ в настройках`; if (d.status === "error") return `${ghDown()} — ${kept}, отправлю сам${d.errorCode === "limit" ? " после этого времени" : ", когда GitHub ответит"}`; return `Нет связи: ${kept} и ${send}, когда появится связь`; };

/* ---------- sync status ---------- */
function renderSync() {
  const d = state.data;
  const dot = $("syncDot"), t = $("syncText");
  const lost = ["live", "offline", "auth", "error", "pending"].includes(d.status) ? d.lost.length : 0;
  dot.className = "dot" + (d.status === "error" || d.status === "auth" || lost ? " err" : d.status === "live" ? " live" : d.status === "sync" || d.status === "pending" ? " sync" : "");
  const n = d.queued;
  const map = {
    notoken: "Не подключено",
    idle: "…",
    sync: "Обновляю…",
    live: lost ? "Не отправлено: " + lost : state.lastSaved ? "Сохранено · " + state.lastSaved : "Подключено",
    pending: `В очереди: ${n}`,
    offline: n ? `Нет связи · в очереди: ${n}` : d.loadedAt ? "Нет связи" : "Нет связи · данных нет",
    auth: d.errorCode === "access" ? "Нет доступа к данным" : d.errorCode === "forbidden" ? "Нет прав на запись" : "Ключ не подходит",
    error: n ? `${d.errorCode === "limit" ? "Лимит GitHub · ждут" : d.stuck ? "Давно ждут GitHub" : "Ждут GitHub"}: ${n}` : "Ошибка связи",
  };
  t.textContent = map[d.status] || d.status;
  const live = $("syncLive");
  if (live && !["sync", "idle"].includes(d.status) && live.dataset.last !== t.textContent) { live.dataset.last = t.textContent; live.textContent = routed ? t.textContent : ""; }
  $("syncAction").textContent = d.status === "notoken" ? "Подключить данные:" : d.status === "auth" ? "Заменить ключ:" : lost && d.status === "live" && state.route.name === "map" ? "Показать неотправленное:" : d.limited ? "Ждём GitHub:" : "Обновить данные:";
  $("syncBtn").title = d.status === "notoken" ? "Подключить данные" : d.error || "Обновить данные";
}

/* ---------- routing ---------- */
function parseRoute() {
  const h = location.hash.replace(/^#\/?/, "");
  const [name, ...rest] = h.split("/");
  const dec = x => { try { return decodeURIComponent(x); } catch (e) { return x; } };
  return { name: name || "map", arg: rest.map(dec).join("/") };
}

function go(hash) { if (location.hash !== hash) location.hash = hash; else route(); }

const VIEWS = { map: "v-map", rank: "v-rank", places: "v-places", place: "v-place", rate: "v-rate", settings: "v-settings" };

const scrolls = {};
let histSeq = 0;
const TITLES = { rank: "Рейтинг", places: "Места", rate: "Оценить", settings: "Настройки" };

function route(top) {
  if (state.histId) scrolls[state.histId] = scrollY;
  const known = !!(history.state && history.state.wtl);
  if (!known) history.replaceState({ wtl: Date.now().toString(36) + "-" + histSeq++ }, "");
  state.histId = history.state.wtl;
  const prev = state.route && state.route.name, sheetId = state.sheet && state.sheet.type === "place" ? state.sheet.id : null;
  state.route = parseRoute();
  state.dirty = false;
  if (!VIEWS[state.route.name]) { history.replaceState(null, "", "#/map"); state.route = { name: "map", arg: "" }; }
  const r = state.route.name;
  if (r === "place") {
    if (routed && !known && ["rank", "map", "places"].includes(prev)) state.backOf[state.histId] = { to: prev, sheet: prev === "map" ? sheetId : null };
    const b = state.backOf[state.histId];
    Object.assign(state, { backTo: b ? b.to : null, backSheet: b ? b.sheet : null, backHist: b ? state.histId : null });
  }
  const reopen = r === "map" && known && prev === "place" && state.backSheet;
  if (r === "map") state.backSheet = null;
  const views = VIEWS;
  const id = views[r];
  if (r !== "map" && state.sheet) closeSheet();
  Object.values(views).forEach(v => { $(v).hidden = v !== id; });
  document.querySelectorAll("[data-nav]").forEach(a => {
    const on = a.dataset.nav === r || (r === "place" && a.dataset.nav === "places");
    if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  const boot = $("bootNote");
  if (boot) boot.remove();
  render();
  if (reopen && state.M.PLACE[reopen]) openPlace(reopen);
  if (id !== "v-map") window.scrollTo(0, known && top !== true ? scrolls[state.histId] || 0 : 0);
  const a = document.activeElement;
  if (routed && (!a || a === document.body || !a.isConnected || a.closest(".appbar, .bottomnav, [hidden]"))) focusView();
  routed = true;
}

let routed = false;
function focusView() {
  const h = document.querySelector(".view:not([hidden]) h1");
  if (!h) return;
  h.tabIndex = -1;
  h.focus({ preventScroll: true });
}

function render() {
  renderSync();
  const r = state.route.name;
  const p = r === "place" && state.M.PLACE[state.route.arg];
  document.title = p ? p.name + " — Где жить" : TITLES[r] ? TITLES[r] + " — Где жить" : "Где жить";
  if (r === "map") { renderMap(); refreshSheet(); }
  else if (r === "rank") renderRank();
  else if (r === "places") renderPlaces();
  else if (r === "place") renderPlace(state.route.arg);
  else if (r === "rate") renderRate(state.route.arg);
  else if (r === "settings") renderSettings();
}

/* ---------- banner ---------- */
function brokenNote(bad) {
  const one = path => (path.startsWith("ratings/") ? "одна оценка не учтена в итогах" : path.startsWith("places/") ? "одно место не показано" : "часть данных не учтена");
  return `<b>Не удалось прочитать ${bad.length > 1 ? "файлы" : "файл"} ${bad.map(esc).join(", ")}:</b> в ${bad.length > 1 ? "них" : "нём"} ошибка, поэтому ${bad.length > 1 ? "часть данных не учтена" : one(bad[0])}. Остальные данные загружены. Исправьте файл в хранилище на GitHub или попросите Claude.`;
}

function bannerHTML() {
  const d = state.data;
  if (!d.hasToken) return `<div class="banner"><b>Данные не подключены.</b> Карта и мировые данные работают, а чтобы видеть и сохранять наши оценки, вставьте ключ доступа в <a href="#/settings">настройках</a>.</div>`;
  const n = d.queued, lost = d.lost, blocked = ["offline", "auth"].includes(d.status) || (d.status === "error" && !d.loadedAt);
  const queue = tail => (n ? ` В очереди ${onDevice()}: ${n} — не потеряются и ${tail}.` : "");
  let html = "";
  if (d.status === "auth" && d.errorCode === "access") html += `<div class="banner err"><b>Хранилище ${esc(d.repo)} не найдено.</b> Его переименовали или удалили, либо у ключа нет к нему доступа. Проверьте название и ключ в <a href="#/settings">настройках</a>.${queue("отправятся, когда доступ вернётся")}</div>`;
  else if (d.status === "auth" && d.errorCode === "forbidden") html += `<div class="banner err"><b>У ключа нет прав на запись.</b> Читать данные можно, а сохранять — нет. Замените ключ в <a href="#/settings">настройках</a>: нужен доступ на чтение и запись.${queue("отправятся с новым ключом")}</div>`;
  else if (d.status === "auth") html += `<div class="banner err"><b>Ключ доступа не подходит.</b> ${d.error && !/не подходит/.test(d.error) ? esc(d.error) + ". " : ""}Проверьте его в <a href="#/settings">настройках</a>.${queue("отправятся, когда ключ заработает")}</div>`;
  else if (d.status === "offline") html += `<div class="banner"><b>Нет связи.</b> ${d.loadedAt ? `Показаны данные на ${whenRu(d.loadedAt)}. ` : ""}Оценки и правки можно сохранять — они отправятся, когда появится связь.${queue("отправятся сами")}</div>`;
  else if (d.status === "error" && d.error && n && d.stuck) html += `<div class="banner err"><b>${esc(ghDown())}.</b> Первая неудачная попытка — ${esc(whenRu(new Date(d.failSince).toISOString()))}. ${d.loadedAt ? "Показаны последние загруженные данные. " : ""}Ждут ${onDevice()}: ${n} ${plural(n, "правка", "правки", "правок")} — они сохранены здесь, и я продолжаю отправлять их сам. На всякий случай скачайте копию в <a href="#/settings">настройках</a> («Скачать копию данных»).</div>`;
  else if (d.status === "error" && d.error && n) html += `<div class="banner err"><b>${esc(ghDown())}.</b> ${d.loadedAt ? "Показаны последние загруженные данные. " : ""}Ждут ${onDevice()}: ${n} ${plural(n, "правка", "правки", "правок")} — отправлю сам, ${d.errorCode === "limit" ? "после этого времени" : "как только GitHub ответит"}.</div>`;
  else if (d.status === "error" && d.error) html += `<div class="banner err"><b>${esc(d.error.replace(/\.$/, ""))}.</b> ${d.loadedAt ? "Показаны последние загруженные данные. " : ""}${d.errorCode === "limit" ? "Попробую снова сам после этого времени." : "Нажмите на статус вверху, чтобы попробовать ещё раз, или подождите — проверю сам через минуту."}</div>`;
  if ((d.broken || []).length) html += `<div class="banner">${brokenNote(d.broken)}</div>`;
  const cut = cutNote();
  if (cut) html += `<div class="banner err">${cut}</div>`;
  if (!me()) html += `<div class="banner">Кто вы на этом устройстве? <button type="button" class="btn ghost small" data-setme="${esc(state.schema.people[0])}">${esc(state.schema.people[0])}</button> <button type="button" class="btn ghost small" data-setme="${esc(state.schema.people[1])}">${esc(state.schema.people[1])}</button><br><span class="small muted">От этого зависит, чьи оценки скрыты, пока вы не оценили место сами.</span></div>`;
  const row = (l, i, apply) => `<div class="lost"><span id="lost-${i}">${esc(lostLabel(l))}</span><button type="button" class="btn ghost small" data-lostapply="${i}" aria-describedby="lost-${i}"${blocked ? " disabled" : ""}>${apply}</button><button type="button" class="btn ghost small" data-lostdrop="${i}" aria-describedby="lost-${i}"${blocked ? " disabled" : ""}>Выбросить</button></div>`;
  const wait = blocked ? `<p class="small">Кнопки заработают, когда появится связь.</p>` : "";
  const refused = lost.map((l, i) => [l, i]).filter(([l]) => l.why === "rejected"), clashed = lost.map((l, i) => [l, i]).filter(([l]) => l.why !== "rejected");
  if (refused.length) {
    const why = [...new Set(refused.map(([l]) => String(l.reason || "").replace(/^GitHub не принял правку:?\s*/, "")).filter(Boolean))].join("; ");
    html += `<div class="banner err"><b>GitHub не принял ${refused.length > 1 ? "правки" : "правку"}${why ? ": " + esc(why) : ""}.</b> ${refused.length > 1 ? "Они сохранены" : "Она сохранена"} ${onDevice()}, копия — в <a href="#/settings">настройках</a> («Скачать копию данных»). «Отправить снова» — попробовать ещё раз, «Выбросить» — правка пропадёт. Если GitHub откажет снова, причину нужно исправить в хранилище на GitHub — или попросите Claude.${refused.map(([l, i]) => row(l, i, "Отправить снова")).join("")}${wait}</div>`;
  }
  if (clashed.length) html += `<div class="banner err"><b>Не отправлено: это же изменили на другом устройстве.</b> «Записать мою» — ваша версия заменит ту. «Выбросить» — останется версия с другого устройства, ваша пропадёт.${clashed.map(([l, i]) => row(l, i, "Записать мою")).join("")}${wait}</div>`;
  else if (d.notice && !refused.length) html += `<div class="banner err">${esc(d.notice)} <button type="button" class="linkbtn" data-dismiss-notice>Понятно</button></div>`;
  return html;
}

function cutNote() {
  const cut = state.interrupted;
  if (!cut) return "";
  const r = state.data.view().ratings.find(x => x.id === cut.id);
  if (r && (!cut.stamp || String(r.updatedAt || "") >= cut.stamp)) { state.interrupted = null; return ""; }
  if (state.route.name === "rate") return "";
  const name = esc((state.M.PLACE[cut.place] || {}).name || "место");
  return `<b>${cut.edit ? `Правка оценки «${name}»` : `Оценка «${name}»`} не успела сохраниться</b> — приложение закрылось раньше. Ответы остались в черновике: <a href="${cut.edit ? `#/rate/${encodeURIComponent(cut.id)}` : `#/rate/new/${encodeURIComponent(cut.place)}`}">открыть и сохранить</a>.`;
}

function lostLabel(l) {
  let doc = null;
  try { doc = l.content == null ? null : JSON.parse(l.content); } catch (e) {}
  const [dir] = l.path.split("/");
  if (dir === "places") {
    const F = state.schema.facts || [], remote = state.data.docOf(l.path);
    const fact = k => k.startsWith("facts.") && F.find(x => x.key === k.slice(6));
    const NAMES = { name: "Название", status: "Статус", archetype: "Тип места", reason: "Причина отсева", questions: "Вопросы" };
    const val = (k, v) => { if (v == null || v === "") return "пусто"; const f = fact(k), n = v && typeof v === "object" ? v.v : v; return f ? (f.rule === "money" ? `${n}\u00a0€` : `${n}\u00a0${f.unit}`) : `«${textLine(n).slice(0, 80)}»`; };
    const items = Object.keys(l.patch || {}).map(k => { const mine = val(k, l.patch[k]), now = remote ? val(k, getK(remote, k)) : null; return `${(fact(k) || {}).name || NAMES[k] || k}: ${mine}${now && now !== mine ? ` (сейчас ${now})` : ""}`; });
    if (l.add && l.add.questions) items.push("Вопросы: + " + textLine(l.add.questions).slice(0, 80));
    return `${(state.M.PLACE[l.path.slice(7, -5)] || {}).name || (remote && remote.name) || (doc && doc.name) || l.path} · ${items.length ? items.join("; ") : doc && doc.questions ? "Вопросы: " + textLine(doc.questions).slice(0, 80) : "карточка"}`;
  }
  if (dir === "ratings") {
    if (!doc) return "Удаление оценки";
    const remote = state.data.docOf(l.path), fld = (k, v) => ratingField(state.schema, k, v);
    const items = remote && !remote.deleted ? Object.keys(l.patch || {}).filter(k => k !== "deleted" && fld(k, null) && JSON.stringify(getK(remote, k) ?? null) !== JSON.stringify(l.patch[k] ?? null)).slice(0, 3).map(k => `${fld(k, l.patch[k]).name}: ${fld(k, l.patch[k]).value} (сейчас ${fld(k, getK(remote, k)).value})`) : [];
    const gone = remote && remote.deleted && !doc.deleted ? " — удалена на другом устройстве" : "";
    return `Оценка: ${(state.M.PLACE[doc.place] || {}).name || doc.place} · ${doc.who}${doc.start ? " · " + datesRu(doc.start, doc.end) : ""}${doc.deleted ? (l.why === "rejected" ? " (удаление)" : " (удаление) — «Записать мою» удалит оценку вместе с правкой с другого устройства, «Выбросить» оставит её") : ""}${gone}${items.length ? " · " + items.join("; ") : ""}`;
  }
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

function renderRank(moves = {}) {
  const M = state.M;
  const saved = state.data.view().weights;
  const own = M.PEOPLE.filter(w => saved[w] && Object.keys(saved[w]).length);
  const names = presetNames(M);
  const cur = names.includes(state.preset) ? state.preset : "Поровну";
  const d = state.data, waiting = d.hasToken && !d.loadedAt;
  const saveLabel = (cur, who) => cur === who ? "Это ваши сохранённые веса" : M.PEOPLE.includes(cur) ? `Сохранить веса «${cur}» как мои (${who})` : `Сохранить как мои веса (${who})`;
  if (cur !== state.preset) state.weights = Object.assign({}, M.presets["Поровну"]);
  const norm = W(), sh = shares(norm);
  const trips = tripCount();
  const who = me();
  const el = $("v-rank");
  el.innerHTML = `
    <header class="stack" style="gap:8px"><h1>Рейтинг</h1>
      <p class="muted small">${!d.hasToken ? "Данные не подключены" : waiting ? "Данные ещё не загружены" : `Мест: ${M.places.filter(p => !M.isBase(p)).length} · оценок: ${ratingCount(M)} · <span title="Всего запланировали ${TRIPS_BUDGET} поездок-разведок">поездок-разведок: ${trips <= TRIPS_BUDGET ? `${trips} из ${TRIPS_BUDGET}` : `${trips}, план был ${TRIPS_BUDGET}`}</span>`}</p>
    </header>
    ${bannerHTML()}
    <section class="block">
      <div class="sec-head"><h2>Порядок мест</h2><div class="seg" role="group" aria-label="Чьи веса" id="presets">${names.map(n => `<button type="button" aria-pressed="${n === cur}" data-p="${esc(n)}">${esc(n)}</button>`).join("")}</div></div>
      <p class="small muted">Сверху — места, которые подходят нам больше. Полоса — итог (3 — как в СПб, правее — лучше), точки — оценки <i class="sw m"></i> ${esc(gen(M.PEOPLE[0]))} и <i class="sw v"></i> ${esc(gen(M.PEOPLE[1]))} без данных.</p>
      <div class="panel">
        <details class="weights" id="wdetails"${local.get("wopen", false) ? " open" : ""}>
          <summary id="wsum">Веса групп: «${esc(cur)}»${!own.length ? " · своих весов ещё никто не сохранил" : ""}</summary>
          <p class="small muted">Кнопки над списком — чьи веса групп учитывать. «Поровну» — все группы весят одинаково. ${M.PEOPLE.map(w => `«${esc(w)}» — сохранённые веса ${esc(gen(w))}`).join(", ")}. «Оба» — среднее наших сохранённых весов. «Своё» — ползунки, которые вы двигаете сами.</p>
          <p class="small muted">Раздайте 100 очков между группами: чем важнее для вас разница между местами в группе, тем больше очков. Двигаете одну — остальные подстраиваются, сумма остаётся 100.</p>
          <div class="wgrid" id="wgrid">${M.GROUPS.map(g => `<label class="wrow" for="w-${g.key}"><span>${esc(g.name)}</span><span class="num muted" aria-hidden="true">${sh[g.key]}</span><input type="range" id="w-${g.key}" data-g="${g.key}" min="0" max="100" step="1" value="${sh[g.key]}" aria-label="${esc(g.name)}" aria-valuetext="${sh[g.key]} из 100"></label>`).join("")}</div>
          ${canWrite() ? (who ? `<div class="wsave"><button type="button" class="btn ghost small" id="wsaveBtn"${cur === who ? " disabled" : ""}>${esc(saveLabel(cur, who))}</button></div>` : `<p class="small muted">Чтобы сохранить веса как свои, выберите в <a href="#/settings">настройках</a>, кто вы.</p>`) : ""}
        </details>
        <div class="rank" id="rank">${!d.hasToken ? `<p class="pad small muted">${NOKEY}</p>` : waiting ? `<p class="pad small muted">${esc(emptyNote())}</p>` : rankHTML(M, norm, moves)}</div>
      </div>
      <details class="small muted rank-help"><summary>Что значат пометки</summary><ul>
        <li>«База» — СПб, точка отсчёта: все оценки — относительно него, у него всегда 3.</li>
        <li>«Мировые данные» — показатели стран и климат городов; их можно выключить в настройках.${useData() ? "" : " Мировые данные сейчас выключены в настройках."}</li>
        <li>«№1–3 в зависимости от весов» — место может сдвинуться при других весах.</li>
        <li>«Заполнено» — доля групп, по которым есть оценки или данные (показываем, если меньше 70%).</li>
        <li>«Год здесь» — «прожили бы здесь год?», 0–10.</li>
        <li>В основной список место попадает, когда отвечено хотя бы на половину главных вопросов ★.</li>
        <li>Оценка партнёра скрыта, пока вы не оцените место сами; открыть её можно в досье кнопкой «Показать всё равно».</li>
        <li>«Отсев» — места, от которых отказались или где у кого-то вето: в рейтинг не входят.</li>
        <li>«Из ${TRIPS_BUDGET}» — сколько поездок-разведок мы запланировали всего.</li>
      </ul></details>
    </section>
    <section class="block">
      <div class="sec-head"><h2>Места × группы</h2><div class="scale-key"><span>хуже СПб</span><i style="background: var(--neg)"></i><i style="background: color-mix(in oklab, var(--neg) 45%, var(--mid))"></i><i style="background: var(--mid)"></i><i style="background: color-mix(in oklab, var(--pos) 45%, var(--mid))"></i><i style="background: var(--pos)"></i><span>лучше</span></div></div>
      ${M.places.length ? `<p class="small muted">Клетка — оценка группы 1–5, 3 — как в СПб; «—» — нет оценок и данных. Серая подпись — почему итог по мировым данным: оценок нет или они скрыты, пока вы не оцените место.</p>` : ""}
      <div class="panel scroll">${M.places.length ? `<table class="heat" id="heat">${heatHTML(M, norm)}</table>` : `<p class="pad small muted">${!d.hasToken ? `Сравнивать пока нечего: места появятся после подключения данных в <a href="#/settings">настройках</a>.` : waiting ? esc(emptyNote()) : `Сравнивать пока нечего: добавьте место через поиск на <a href="#/map">карте</a>.`}</p>`}</div>
    </section>
    <section class="block">
      ${(() => { const f = flagsHTML(M, state.flagsAll); return `<div class="sec-head"><h2>Флаги</h2><span class="small muted">${f.count ? `${f.count} ${plural(f.count, "флаг", "флага", "флагов")}` : ""}</span></div><div class="panel"><div class="flags">${!d.hasToken ? `<p class="small muted">Флаги появятся после подключения данных.</p>` : waiting ? `<p class="small muted">Флаги появятся, когда загрузятся данные.</p>` : f.html}</div></div>`; })()}
    </section>`;
  $("wdetails").addEventListener("toggle", e => local.set("wopen", e.target.open));
  $("flagsAll")?.addEventListener("click", e => { const box = e.currentTarget.closest(".flags"), k = box.querySelectorAll(".flag").length, y = scrollY; state.flagsAll = true; box.innerHTML = flagsHTML(state.M, true).html; scrollTo(0, y); box.querySelectorAll(".flag a")[k]?.focus({ preventScroll: true }); });
  const movesSince = before => {
    const after = state.M.ranksFor(W()), moves = {};
    Object.keys(after).forEach(id => { if (before[id] && before[id] !== after[id]) moves[id] = before[id] - after[id]; });
    return moves;
  };
  const risen = moves => Object.keys(moves).filter(id => moves[id] > 0).map(id => state.M.PLACE[id].name);
  let dragBefore = null;
  $("presets").addEventListener("click", e => {
    const b = e.target.closest("button[data-p]");
    if (!b) return;
    const before = state.M.ranksFor(W());
    state.preset = b.dataset.p;
    state.weights = Object.assign({}, b.dataset.p === "Своё" ? local.get("customWeights", null) || W() : state.M.presets[state.preset]);
    local.set("preset", state.preset); local.set("weights", state.weights);
    const moves = movesSince(before);
    rerender(() => renderRank(moves));
    const up = risen(moves);
    if (up.length) toast(`С весами «${state.preset}» поднялись: ${up.join(", ")}`);
  });
  let frame = 0;
  $("wgrid").addEventListener("change", () => {
    if (frame) { cancelAnimationFrame(frame); frame = 0; if ($("heat")) $("heat").innerHTML = heatHTML(state.M, W()); }
    if (!dragBefore) return;
    const moves = movesSince(dragBefore);
    dragBefore = null;
    $("rank").innerHTML = d.hasToken ? rankHTML(state.M, W(), moves) : `<p class="pad small muted">${NOKEY}</p>`;
    const up = risen(moves);
    if (up.length) toast(`С вашими весами поднялись: ${up.join(", ")}`);
  });
  $("wgrid").addEventListener("input", e => {
    const inp = e.target.closest("input[data-g]");
    if (!inp) return;
    dragBefore ||= state.M.ranksFor(W());
    const keys = state.M.GROUPS.map(g => g.key), cur = W(), k = inp.dataset.g, v = Number(inp.value);
    const others = keys.filter(x => x !== k), rest = others.reduce((a, x) => a + cur[x], 0);
    const next = { [k]: v };
    others.forEach(x => { next[x] = rest > 0 ? cur[x] * (100 - v) / rest : (100 - v) / others.length; });
    state.weights = next;
    state.preset = "Своё";
    local.set("preset", "Своё"); local.set("weights", next); local.set("customWeights", next);
    const n = W(), sh2 = shares(n);
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; const w = W(); if ($("rank") && d.hasToken) $("rank").innerHTML = rankHTML(state.M, w, {}, true); if ($("heat")) $("heat").innerHTML = heatHTML(state.M, w); });
    $("wgrid").querySelectorAll(".wrow").forEach((row, i) => {
      const g = state.M.GROUPS[i].key;
      row.querySelector(".num").textContent = sh2[g];
      const r = row.querySelector("input");
      if (r !== inp) r.value = sh2[g];
      r.setAttribute("aria-valuetext", sh2[g] + " из 100");
    });
    $("wsum").textContent = "Веса групп: «Своё»";
    const sb = $("wsaveBtn");
    if (sb) { sb.disabled = false; sb.textContent = saveLabel("Своё", who); }
    $("presets").querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.p === "Своё")));
  });
  $("wsaveBtn")?.addEventListener("click", async e => {
    const b = e.currentTarget, label = b.textContent;
    const w = shares(W());
    const prev = state.preset;
    b.disabled = true;
    state.preset = who; local.set("preset", who);
    try {
      const r = await state.data.saveWeights(who, w);
      savedNow(r);
      toast(r === "queued" ? waitMsg("веса", "сохранены") : `Сохранено: это теперь веса «${who}»`);
    } catch (err) { state.preset = prev; local.set("preset", prev); toast(err.code === "clash" ? `Веса не сохранены: на другом устройстве только что сохранили другие веса «${who}». Нажмите «${label}» ещё раз — запишутся эти.` : `Веса не сохранены: ${failWhy(err)}. Попробуйте ещё раз ${failWhen(err)}.`); }
    rebuild();
    rerender(renderRank);
    const a = document.activeElement;
    if (!a || a === document.body || a.disabled) (document.querySelector(`#presets [data-p="${CSS.escape(state.preset)}"]`) || $("wsum")).focus({ preventScroll: true });
  });
}

function tripCount() {
  const by = {}, day = s => Date.parse(s) / 864e5;
  state.M.ratings.forEach(r => (by[r.place] = by[r.place] || []).push(r));
  let n = state.M.places.filter(p => hiddenWho(state.M, p.id).length).length;
  Object.values(by).forEach(rs => {
    const dated = rs.filter(r => r.start && !isNaN(day(r.start))).map(r => [day(r.start), Math.max(day(r.start), day(r.end) || 0)]).sort((a, b) => a[0] - b[0]);
    n += rs.length - dated.length;
    let first = -Infinity, end = -Infinity;
    dated.forEach(([s, e]) => { if (s > end && s - first > 3) { n++; first = s; end = e; } else end = Math.max(end, e); });
  });
  return n;
}

/* ---------- places ---------- */
function renderPlaces() {
  const el = $("v-places");
  const preset = presetNames(state.M).includes(state.preset) ? state.preset : "Поровну";
  const what = { "Поровну": "все группы весят одинаково", "Оба": "среднее наших весов", "Своё": "ваши ползунки" }[preset] || `сохранённые веса ${gen(preset)}`;
  el.innerHTML = `<header class="stack" style="gap:8px"><h1>Места</h1><p class="small muted">Где были и куда смотрим. Число справа — итог из 5 по весам «${esc(preset)}» (${esc(what)}; веса меняются в «Рейтинге»); 3 — как в СПб. Новое место — через поиск на <a href="#/map">карте</a>.</p><p class="small muted">Статусы: кандидат — смотрим и ездим на разведку, финалист — главный претендент, отсев — отказались, вето — кто-то из нас против; такие места не в рейтинге.</p></header>
    ${state.data.hasToken ? bannerHTML() : ""}
    ${state.M.places.length ? `<input type="search" id="placeFilter" placeholder="Фильтр по названию или стране" value="${esc(state.placeFilter)}" aria-label="Фильтр мест" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="search">` : ""}
    <div class="panel plist" id="plist">${placesListHTML(state.M, W(), state.placeFilter, emptyNote())}</div>`;
  $("placeFilter")?.addEventListener("input", e => { state.placeFilter = e.target.value; $("plist").innerHTML = placesListHTML(state.M, W(), state.placeFilter, emptyNote()); });
  $("placeFilter")?.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } });
}

function emptyNote() {
  const d = state.data;
  if (!d.hasToken) return false;
  if (d.loadedAt) return true;
  return d.status === "sync" || d.status === "idle" ? "Загружаю данные…" : d.status === "offline" ? "Нет связи: места загрузятся, когда появится интернет." : d.status === "auth" ? "Места не загружены: ключ не подходит. Проверьте его в настройках." : "Места ещё не загружены: GitHub не ответил. Появятся, когда данные загрузятся.";
}

/* ---------- place dossier ---------- */
function placeCity(p) { return state.world.cities ? state.world.placeCity(p) : null; }

const VISA = { "visa free": "без визы", "visa on arrival": "виза по прилёте", "e-visa": "нужна электронная виза", "visa required": "нужна виза", eta: "нужно электронное разрешение (ETA)", home: "своя страна" };

function worldRowsHTML(cc, city, first, place) {
  const Wd = state.world, M = state.M;
  let html = `<p class="small muted">Плашка — оценка 1–5 для итога: 3 — как в России, больше — лучше. С пометкой «абсолютная шкала» 3 — фиксированный порог. Без плашки — справка, в итог не входит.</p>`;
  const rows = [], facts = state.schema.facts || [];
  const over = cats => place && (cats || []).map(c => facts.find(F => F.cat === c && factScore(F, factValue(place, F.key), factRef(F, M.places)) != null)).find(Boolean);
  if (cc) Wd.indicators.forEach(ind => {
    const r = Wd.raw(cc, ind.key);
    if (!r) return;
    const mode = ind.key === "ru_visa" && r[2] ? VISA[r[2]] || r[2] : "";
    rows.push({ ind, v: r[0], year: r[1], s: (ind.cats || []).length ? Wd.countryScore(cc, ind.key) : null, level: "страна", text: mode ? (r[0] > 0 && !/^нужна|своя/.test(mode) ? `${r[0]} дн., ${mode}` : mode) : "", fact: over(ind.cats) });
  });
  if (city) CITY_INDICATORS.forEach(ind => {
    const v = Wd.cityValue(city, ind.key);
    if (v == null) return;
    rows.push({ ind, v, s: (ind.cats || []).length ? Wd.cityScore(city, ind.key) : null, level: city.synthetic ? "точка" : "город", fact: over(ind.cats) });
  });
  const abs = r => r.s != null && r.ind.scale && r.ind.scale.type === "abs";
  const row = r => `<div class="world-row${r.fact ? " off" : ""}"><span>${esc(r.ind.name)}<small>${esc(r.level)}${r.year ? " · " + r.year : ""}${abs(r) ? " · абсолютная шкала" : ""}${r.ind.source ? " · " + esc(r.ind.source) : ""}${r.ind.note ? " · " + esc(r.ind.note) : ""}${r.fact ? ` · в итог не входит: вместо него «${esc(r.fact.name)}» из «Цифр места»` : ""}</small></span><span class="v">${esc(r.text || fmtValue(r.ind, r.v))}</span><span class="s" style="background:${r.s == null ? "transparent" : scoreHex(r.s)};color:${r.s == null ? "var(--ink)" : inkOn(scoreHex(r.s))}${r.fact ? ";opacity:.45" : ""}" title="${r.fact ? "Не входит в итог: вместо него цифры места" : abs(r) ? "Шкала 1–5 с фиксированными порогами" : "Шкала 1–5, Россия/СПб = 3"}">${r.s == null ? "" : fmt(r.s)}</span></div>`;
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
  const tip = i => `${MONTHS[i]}: ${city.t[i] == null ? "—" : city.t[i] + " °C"}${city.p && city.p[i] != null ? ", осадки " + city.p[i] + " мм" : ""}`;
  if (Array.isArray(city.p)) city.p.forEach((p, i) => { if (p == null) return; const h = p / pmax * (H - padT - padB) * 0.6; g += `<rect x="${x(i) - 7}" y="${H - padB - h}" width="14" height="${h}" fill="var(--pos)" opacity="0.25" data-tip="${tip(i)}"></rect>`; });
  const line = (arr, color, dash) => `<polyline fill="none" stroke="${color}" stroke-width="2" ${dash ? `stroke-dasharray="${dash}"` : ""} points="${arr.map((t, i) => t == null ? "" : `${x(i).toFixed(1)},${y(t).toFixed(1)}`).join(" ")}"/>`;
  if (ref && Array.isArray(ref.t) && ref !== city) g += line(ref.t, "var(--muted)", "4 3");
  g += line(city.t, "var(--v)");
  city.t.forEach((t, i) => { const w = (Wd - padL) / 12; g += `<rect x="${(x(i) - w / 2).toFixed(1)}" y="${padT}" width="${w.toFixed(1)}" height="${H - padT - padB}" fill="transparent" data-tip="${tip(i)}"/>`; if (t != null) g += `<circle cx="${x(i)}" cy="${y(t)}" r="6" fill="transparent" data-tip="${tip(i)}"/>`; });
  MONTHS.forEach((m, i) => { g += `<text x="${x(i)}" y="${H - 4}" text-anchor="middle">${m}</text>`; });
  const desc = MONTHS.map((m, i) => `${m} ${city.t[i] == null ? "нет данных" : city.t[i] + " °C"}${ref && ref !== city && Array.isArray(ref.t) && ref.t[i] != null ? ` (СПб ${ref.t[i]} °C)` : ""}${city.p && city.p[i] != null ? ", осадки " + city.p[i] + " мм" : ""}`).join("; ");
  return `<svg viewBox="0 0 ${Wd} ${H}" role="img" aria-label="Климат по месяцам"><desc>${esc(desc)}</desc>${g}</svg>`;
}

function similarHTML(list, opts = {}) {
  if (!list || !list.length) return `<p class="small muted">${opts.empty || "Похожих мест не нашлось: мало данных."}</p>`;
  return `<div class="sim">${list.map(x => {
    const c = x.city;
    const why = [x.why.close.length ? "похожи: " + x.why.close.join(", ") : "", x.why.far.length ? "отличаются: " + x.why.far.join(", ") : ""].filter(Boolean).join(" · ");
    return `<div class="sim-row"><button type="button" data-city="${c.id}">${esc(c.n)}<span class="muted" style="font-weight:400"> · ${esc(state.world.nameOf(c.cc))}</span></button><span class="pct">${x.pct}%</span>${why ? `<small>${esc(why)}</small>` : ""}</div>`;
  }).join("")}</div>`;
}

function similarSplitHTML(sp, cc, h = "h3") {
  const home = cc ? state.world.nameOf(cc) : "";
  return (sp.home.length ? `<${h} class="sim-h">${esc(home ? "В стране: " + home : "Рядом")}</${h}>` + similarHTML(sp.home) : "") +
    `<${h} class="sim-h">В других странах</${h}>` + similarHTML(sp.abroad);
}

function similarCountriesHTML(list) {
  if (!list || !list.length) return `<p class="small muted">Мало данных для сравнения.</p>`;
  return `<div class="sim">${list.map(x => `<div class="sim-row"><button type="button" data-country="${x.cc}">${esc(state.world.nameOf(x.cc))}</button><span class="pct">${x.pct}%</span>${x.why.close.length || x.why.far.length ? `<small>${esc([x.why.close.length ? "похожи: " + x.why.close.join(", ") : "", x.why.far.length ? "отличаются: " + x.why.far.join(", ") : ""].filter(Boolean).join(" · "))}</small>` : ""}</div>`).join("")}</div>`;
}

function externalLinks(p, city) {
  const en = String((city && city.en) || p.name || "");
  const ascii = en.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D");
  const country = state.world.enNameOf(p.cc || (city && city.cc));
  const link = (href, label) => `<a class="btn ghost small" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  const numbeo = city && !city.synthetic && city.en && country ? link(`https://www.numbeo.com/cost-of-living/city_result.jsp?country=${encodeURIComponent(country)}&city=${encodeURIComponent(ascii)}`, "Numbeo: цены") : "";
  return `<div class="btns">${numbeo}${link(`https://weatherspark.com/search?q=${encodeURIComponent(en)}`, "Weather Spark: погода")}${link(`https://ru.wikipedia.org/w/index.php?search=${encodeURIComponent(p.name + " " + state.world.nameOf(p.cc))}&fulltext=1`, "Википедия")}</div>${numbeo ? `<p class="small muted">Numbeo — цены от посетителей, у маленьких городов данных мало или нет.</p>` : ""}`;
}

function renderPlace(id) {
  const M = state.M;
  const p = M.PLACE[id];
  const el = $("v-place");
  if (!p) {
    const d = state.data;
    const why = !d.hasToken ? "Место откроется после подключения данных." : d.loadedAt ? `Место не найдено. <a href="#/places">Все места</a>` : d.status === "sync" || d.status === "idle" ? "Загружаю данные…" : "Место откроется, когда загрузятся данные: сейчас нет связи или ключ не подходит.";
    el.innerHTML = `<h1>${d.hasToken && d.loadedAt ? "Место не найдено" : d.hasToken && ["sync", "idle"].includes(d.status) ? "Загружаю место…" : "Место пока не открыть"}</h1>${bannerHTML()}<div class="banner">${why}</div>`;
    return;
  }
  const norm = W();
  const t = placeScore(M, p, norm);
  const ranks = M.ranksFor(norm);
  const city = placeCity(p);
  const ref = state.world.spbCity;
  const onlyData = !M.isBase(p) && !M.ratingsOf(p.id).length && t.score != null;
  const statuses = state.schema.statuses;
  const typed = {};
  if (!M.isBase(p)) (state.schema.facts || []).forEach(F => { const v = factValue(p, F.key), ref = factRef(F, M.places); if (v != null && factScore(F, v, ref) != null) typed[F.cat] = `Из «Цифр места»: ${F.rule === "money" ? v + "\u00a0€" : v + "\u00a0" + F.unit}${F.rule === "money" && ref ? `, в СПб ${ref}\u00a0€` : ""}`; });
  const hasFacts = Object.keys(typed).length > 0;
  const parts = M.isBase(p) ? [] : M.PEOPLE.filter(w => !M.hidden(p.id, w)).map(w => [w, M.total(p, norm, w).score]).concat([["живущие", M.total(p, norm, "res").score], [hasFacts ? "мировые данные и цифры места" : "мировые данные", M.total(p, norm, "data").score]]).filter(x => x[1] != null);
  const mine = parts.filter(x => M.PEOPLE.includes(x[0])).map(x => x[1]);
  const extra = [parts.some(x => x[0].startsWith("мировые")) ? "мировые данные" : "", parts.some(x => x[0] === "живущие") ? "слова живущих" : ""].filter(Boolean);
  const lower = mine.length && extra.length && t.score != null && Math.round(Math.min(...mine) * 10) - Math.round(t.score * 10) >= 2;
  const vetoR = !M.isBase(p) && M.vetoes().find(r => r.place === p.id);
  const out = M.isBase(p) ? "" : p.status === "отсев" ? "отсев" : vetoR ? "вето" : "";
  const preset = presetNames(M).includes(state.preset) ? state.preset : "Поровну";
  const rr = (M.rankRange(norm) || {})[p.id], rankText = ranks[p.id] ? `№${ranks[p.id]} в рейтинге по весам «${esc(preset)}»${rr && rr.min !== rr.max ? `, №${rr.min}–${rr.max} в зависимости от весов` : ""}` : "";
  const hidW = M.isBase(p) ? [] : hiddenWho(M, p.id);
  const back = { rank: ["#/rank", "Рейтинг"], map: ["#/map", "Карта"] }[state.backTo] || ["#/places", "Все места"];
  const shownEarly = M.isBase(p) || !state.revealed.has(p.id) || !me() ? [] : [...new Set(M.full.ratingsOf(p.id).map(r => r.who))].filter(w => w !== me() && !M.full.ratingsOf(p.id).some(r => r.who === me()));
  const gs = M.isBase(p) || t.score == null ? [] : M.GROUPS.map(g => [g.name.toLowerCase(), M.groupScore(p, g.key, "final")]).filter(x => x[1] != null);
  const byScore = gs.slice().sort((a, b) => b[1] - a[1]), top = byScore[0], low = byScore[byScore.length - 1];
  const best = byScore.filter(x => x[1] >= 3.25).slice(0, 3).map(x => x[0]), worst = byScore.filter(x => x[1] <= 2.75).reverse().slice(0, 3).map(x => x[0]);
  const sides = gs.length < 2 ? "" : `${best.length ? `<b>Лучше СПб:</b> ${esc(best.join(", "))}.` : `<b>Сильнее всего:</b> ${esc(top[0])} (${fmt(top[1])}).`} ${worst.length ? `<b>Хуже СПб:</b> ${esc(worst.join(", "))}.` : `<b>Слабее всего:</b> ${esc(low[0])} (${fmt(low[1])}).`}`;
  const scoreTail = M.isBase(p) ? "база по определению: точка отсчёта, с ним сравниваем все места" : t.score == null ? (hidW.length ? `Итога пока нет: ${hiddenNote(M, p.id)}, а мировых данных по месту нет.` : "Итога пока нет: нет ни наших оценок, ни мировых данных по этому месту.") : `из 5, где 3 — как в СПб · заполнено ${Math.round(t.coverage * 100)}% групп (есть оценки или данные)${out ? ` · в рейтинг не входит: ${out}` : rankText ? " · " + rankText : t.coverage < MIN_COVERAGE ? " · мало оценок для рейтинга" : !M.ownEnough(p.id) && !onlyData ? ` · своих ответов на главные вопросы ★: ${Math.round(M.ownShare(p.id) * M.STAR_KEYS.length)} из ${M.STAR_KEYS.length}, нужно хотя бы ${Math.ceil(MIN_OWN * M.STAR_KEYS.length)} — пока не в рейтинге` : ""}`;
  el.innerHTML = `
    <div id="placeBanner">${bannerHTML()}</div>
    <header class="place-head">
      <a class="small muted" href="${back[0]}" data-back>← ${back[1]}</a>
      <h1>${esc(p.name)}</h1>
      <div class="line">
        ${p.country ? `<span class="chip">${esc(p.country)}</span>` : ""}
        <span class="chip${M.isBase(p) ? " solid" : ""}">${esc(p.status || "кандидат")}</span>${vetoR ? `<span class="chip warn">вето</span>` : ""}
        ${p.archetype ? `<span class="chip">${esc(p.archetype)}</span>` : ""}
        ${p.lat != null ? `<a class="btn ghost small" href="#/map" data-focus="${esc(p.id)}">На карте</a>` : ""}
        ${!M.isBase(p) ? `<a class="btn small" href="#/rate/new/${encodeURIComponent(p.id)}">Оценить</a>` : ""}
      </div>
    </header>
    <div class="panel pad stack" style="gap:8px">
      <div class="bigscore"><b>${M.isBase(p) ? "3.0" : fmt(t.score)}</b><span class="muted">${scoreTail}</span></div>
      ${vetoR ? `<p class="small"><b>Не в рейтинге: вето ${esc(gen(vetoR.who))}</b> — ${esc(vetoR.veto)}</p>` : ""}
      ${hidW.length ? hidLine(M, p.id, hidW) : shownEarly.length ? `<p class="small muted">${shownEarly.length > 1 ? "Оценки" : "Оценка"} ${esc(shownEarly.map(gen).join(" и "))} ${shownEarly.length > 1 ? "показаны" : "показана"} до вашей оценки. <button type="button" class="linkbtn" data-unreveal="${esc(p.id)}">Скрыть снова</button></p>` : ""}
      ${onlyData ? `<p class="small muted">${hidW.length ? "Итог пока только по мировым данным." : `Мы здесь ещё не были: итог посчитан только по ${hasFacts ? "мировым данным и цифрам места" : "мировым данным"}.`}</p>` : parts.length > 1 ? `<p class="small muted">Из чего итог: ${parts.map(([w, v]) => `${esc(w)} ${fmt(v)}`).join(" · ")}${lower ? `. Итог ниже наших оценок, потому что в нём учтены ещё ${extra.join(" и ")}: где туристу плохо видно, они весят больше.` : ""}</p>` : ""}
      ${sides ? `<p class="small">${sides}</p>` : ""}
      ${p.questions ? `<div class="small"><b>Вопросы к следующей поездке:</b> ${esc(textLine(p.questions))}</div>` : ""}
      ${p.status === "отсев" && p.reason ? `<div class="small"><b>Причина отсева:</b> ${esc(p.reason)}</div>` : ""}
    </div>
    <div class="panel"><div class="dossier"><div class="radar">${radarSVG(M, p)}<div class="legend small">${radarLegend(M, p, hasFacts ? "Мировые данные и цифры места" : "Мировые данные")}</div>${M.isBase(p) ? "" : radarTable(M, p)}</div><div class="trips">${draftNote(p)}${tripsHTML(M, p, canWrite(), me(), new Set(state.data.pending.filter(c => c.path.startsWith("ratings/")).map(c => c.path.slice(8, -5))))}</div></div></div>
    <section class="block">
      <div class="sec-head"><h2>Подкатегории</h2><label class="toggle"><input type="checkbox" id="showEmpty"${state.showEmpty ? " checked" : ""}> Показать пустые</label></div>
      <div class="panel scroll"><table class="subtable">${subtableHTML(M, p, state.showEmpty, typed)}</table></div>
      <p class="small muted">«Итог» — наши оценки вместе с данными. «Данные» — мировые данные и цифры места. Буква у оценки — откуда знаем: A — в быту, C — со слов живущих, D — по сайтам; «ц» — посчитано из «Цифр места».</p>${hidW.length ? `<p class="small muted">${hidW.map(w => `«·» в столбце «${esc(w)}»`).join(", ")} — оценка скрыта, пока вы не оцените место сами.</p>` : ""}
    </section>
    <section class="block">
      <div class="sec-head"><h2>Мировые данные</h2><span class="small muted">${city && !city.synthetic ? (p.lat != null && haversine(p, city) >= 5 ? `климат по городу ${esc(city.n)}, ${Math.round(haversine(p, city))} км` : "климат: " + esc(city.n)) + " · " + esc(kgName(city.kg)) : ""}</span></div>
      <div class="panel pad stack">
        ${city && Array.isArray(city.t) ? `<div class="clim">${climateSVG(city, ref)}</div>${climLegend(p.name, ref && ref !== city)}` : ""}
        ${state.world.missing.includes("indicators") ? `<p class="small muted">Данные стран не загрузились: показатели страны не показаны и не учтены в итоге. Обновите страницу позже.</p>` : ""}
        <div class="world">${worldRowsHTML(p.cc, city, null, M.isBase(p) ? null : p)}</div>
        ${externalLinks(p, city)}
      </div>
    </section>
    <section class="block">
      <div class="sec-head"><h2>Похожие места</h2><span class="small muted">по весам «${esc(presetNames(M).includes(state.preset) ? state.preset : "Поровну")}» из «Рейтинга»</span></div>
      <div class="panel pad" id="simBox"><p class="small muted">Считаю…</p></div>
    </section>
    <section class="block">
      <div class="sec-head"><h2>${M.isBase(p) ? "Цифры СПб — ориентиры для сравнения" : "Цифры места"}</h2></div>
      <form class="panel pad stack" id="factsForm">${factsHTML(p)}
        ${canWrite() ? `<div class="btns"><button type="submit" class="btn">Сохранить цифры</button><span class="msg" id="factsMsg" role="status"></span></div>` : ""}
      </form>
    </section>
    <section class="block">
      <div class="sec-head"><h2>Карточка места</h2></div>
      <form class="panel pad stack" id="placeForm">
        <div class="frow">
          <label class="field"><span class="lbl">Название</span><input type="text" name="name" value="${esc(p.name)}" ${canWrite() ? "" : "disabled"}></label>
          ${M.isBase(p) ? "" : `<label class="field"><span class="lbl">Статус</span><select name="status" ${canWrite() ? "" : "disabled"}>${(p.status && !statuses.includes(p.status) ? [p.status] : []).concat(statuses.filter(s => s !== "база")).map(s => `<option${s === (p.status || "кандидат") ? " selected" : ""}>${esc(s)}</option>`).join("")}</select></label>`}
          <label class="field"><span class="lbl">Тип места</span><input type="text" name="archetype" list="archetypes" value="${esc(p.archetype || "")}" placeholder="курорт, город у моря, мегаполис, горы" ${canWrite() ? "" : "disabled"}><datalist id="archetypes">${ARCHETYPES.map(a => `<option value="${esc(a)}">`).join("")}</datalist></label>
        </div>
        <label class="field" id="reasonBox"${p.status === "отсев" ? "" : " hidden"}><span class="lbl">Причина отсева</span><input type="text" name="reason" value="${esc(p.reason || "")}" ${canWrite() ? "" : "disabled"}></label>
        <label class="field"><span class="lbl">Вопросы к следующей поездке</span><textarea name="questions" rows="3" ${canWrite() ? "" : "disabled"}>${esc(p.questions || "")}</textarea></label>
        ${canWrite() ? `<div class="btns"><button type="submit" class="btn">Сохранить карточку</button><span class="msg" id="placeMsg" role="status"></span></div>` : ""}
      </form>
    </section>`;
  const dirtyForms = new Set(), renderDoc = state.data.view().places.find(x => x.id === p.id) || state.data.docOf(`places/${p.id}.json`) || p, bases = {};
  const F_ALL = state.schema.facts || [];
  const fieldName = k => k.startsWith("facts.") ? ((F_ALL.find(f => f.key === k.slice(6)) || {}).name || k) : ({ name: "Название", status: "Статус", archetype: "Тип места", reason: "Причина отсева", questions: "Вопросы" })[k] || k;
  const fieldVal = (k, v) => { if (v == null || v === "") return "пусто"; const f = k.startsWith("facts.") && F_ALL.find(x => x.key === k.slice(6)), n = v && typeof v === "object" ? v.v : v; return f ? (f.rule === "money" ? `${n}\u00a0€` : `${n}\u00a0${f.unit}`) : `«${textLine(n).slice(0, 80)}»`; };
  const savePlaceDoc = async (formId, patch, msgId, okText) => {
    const btn = $(formId).querySelector("[type=submit]"), label = btn.textContent;
    if (btn.disabled) return;
    btn.disabled = true; btn.textContent = "Сохраняю…";
    const base = Object.fromEntries(Object.keys(patch).map(k => [k, k in bases ? bases[k] : getK(renderDoc, k)]));
    const say = (text, err) => { const m = $(msgId); if (m) { m.textContent = text; m.className = err ? "msg err" : "msg"; } };
    try {
      const { r, doc } = await state.data.updatePlace(p.id, patch, { base });
      savedNow(r);
      dirtyForms.delete(formId);
      Object.keys(patch).forEach(k => { bases[k] = r === "sent" && doc ? getK(doc, k) : patch[k]; });
      if (formId === "placeForm") Object.keys(patch).forEach(k => { if (k in cardOrig) cardOrig[k] = patch[k]; });
      else (state.schema.facts || []).forEach(F => { if ("facts." + F.key in patch) factsOrig[F.key] = factIn(F); });
      state.dirty = dirtyForms.size > 0;
      const text = r !== "queued" ? okText : waitMsg("правка", "сохранена");
      toast(text);
      if (!state.dirty && state.route.name === "place" && state.route.arg === p.id) { const y = scrollY; render(); scrollTo(0, y); const a = document.activeElement; if ((!a || a === document.body) && $(formId)) $(formId).querySelector("[type=submit]").focus({ preventScroll: true }); }
      say(text);
    } catch (err) {
      const what = formId === "factsForm" ? "Цифры" : "Карточку";
      if (err.code === "clash") {
        (err.theirs || []).forEach(([k, v]) => { bases[k] = v; });
        const there = (err.theirs || []).map(([k, v]) => `${fieldName(k)} — ${fieldVal(k, v)}`).join("; ");
        say(`${what} только что изменили на другом устройстве${there ? ` (там: ${there})` : ""}. Нажмите «${label}» ещё раз — запишется ваше.`, true);
      } else if (btn.isConnected && !btn.closest("[hidden]")) say(`${what === "Цифры" ? "Цифры не сохранены" : "Карточка не сохранена"}: ${failWhy(err)}. Правки остались в форме — нажмите «${label}» ещё раз ${failWhen(err)}.`, true);
      else { state.placeDrafts = Object.assign(state.placeDrafts || {}, { [p.id + "|" + formId]: patch }); toast(`${what === "Цифры" ? "Цифры" : "Карточка"} «${p.name}» не ${what === "Цифры" ? "сохранены" : "сохранена"}: ${failWhy(err)}. Правки вернутся в форму, когда откроете досье.`); }
    } finally { if (btn.isConnected) { btn.disabled = false; btn.textContent = label; } }
  };
  [$("placeForm"), $("factsForm")].forEach(f => f.addEventListener("input", () => { dirtyForms.add(f.id); state.dirty = true; }));
  $("placeForm").querySelector('[name="status"]')?.addEventListener("change", e => { $("reasonBox").hidden = e.target.value !== "отсев"; });
  const factIn = F => ({ raw: String(($("factsForm").querySelector(`[name="fact_${F.key}"]`) || {}).value || "").trim(), src: String(($("factsForm").querySelector(`[name="src_${F.key}"]`) || {}).value || "").trim() });
  const factsOrig = Object.fromEntries((state.schema.facts || []).map(F => [F.key, factIn(F)]));
  $("factsForm").addEventListener("submit", e => {
    e.preventDefault();
    const edits = {}, bad = [], need = [], typo = [], first = {};
    $("factsForm").querySelectorAll("[aria-invalid]").forEach(x => x.removeAttribute("aria-invalid"));
    (state.schema.facts || []).forEach(F => {
      const cur = factIn(F), was = factsOrig[F.key];
      if (cur.raw === was.raw && cur.src === was.src) return;
      if (!cur.raw) { if (was.raw) edits[F.key] = null; else if (cur.src) { need.push(F.name); first.need ||= F.key; } return; }
      const v = parseAmount(cur.raw);
      if (!(v > 0)) { bad.push(F.name); first.bad ||= F.key; return; }
      if (F.rule === "money" && v < 5) { typo.push(`${F.name}: ${cur.raw}`); first.typo ||= F.key; return; }
      edits[F.key] = { v, src: cur.src, at: todayISO() };
    });
    const fail = text => { $("factsMsg").textContent = text; $("factsMsg").className = "msg err"; const k = need.length ? first.need : bad.length ? first.bad : first.typo, inp = k && $("factsForm").querySelector(`[name="fact_${k}"]`); if (inp) { inp.setAttribute("aria-invalid", "true"); inp.setAttribute("aria-describedby", "factsMsg"); inp.focus(); } };
    if (need.length) return fail("Впишите число: " + need.join(", ") + ". Источник без числа не сохраняется.");
    if (bad.length) return fail("Не число: " + bad.join(", ") + ". Впишите одну сумму цифрами, например 640 или 1 050.");
    if (typo.length) return fail("Похоже на опечатку: " + typo.join(", ") + ". Впишите сумму целиком, например 1050.");
    if (!Object.keys(edits).length) { $("factsMsg").textContent = "Ничего не изменилось."; $("factsMsg").className = "msg"; return; }
    savePlaceDoc("factsForm", Object.fromEntries(Object.entries(edits).map(([k, v]) => ["facts." + k, v])), "factsMsg", "Цифры сохранены");
  });
  $("showEmpty").addEventListener("change", e => { state.showEmpty = e.target.checked; e.target.closest(".block").querySelector(".subtable").innerHTML = subtableHTML(state.M, state.M.PLACE[p.id] || p, state.showEmpty, typed); });
  const pf = $("placeForm");
  const cardIn = () => { const f = new FormData(pf); return { name: String(f.get("name") || "").trim(), status: M.isBase(p) ? p.status : f.get("status"), archetype: String(f.get("archetype") || "").trim(), reason: String(f.get("reason") || "").trim(), questions: String(f.get("questions") || "").trim() }; };
  const cardOrig = cardIn();
  pf.addEventListener("submit", e => {
    e.preventDefault();
    const now = cardIn(), edits = {};
    Object.keys(now).forEach(k => { if (now[k] !== cardOrig[k]) edits[k] = now[k]; });
    if ("name" in edits && !edits.name) { $("placeMsg").textContent = "Название не может быть пустым."; $("placeMsg").className = "msg err"; const n = pf.querySelector('[name="name"]'); n.setAttribute("aria-invalid", "true"); n.setAttribute("aria-describedby", "placeMsg"); n.focus(); return; }
    pf.querySelector('[name="name"]').removeAttribute("aria-invalid");
    if (!Object.keys(edits).length) { $("placeMsg").textContent = "Ничего не изменилось."; $("placeMsg").className = "msg"; return; }
    savePlaceDoc("placeForm", edits, "placeMsg", "Карточка сохранена");
  });
  Object.keys(state.placeDrafts || {}).filter(k => k.startsWith(p.id + "|")).forEach(k => {
    const formId = k.slice(p.id.length + 1), form = $(formId), patch = state.placeDrafts[k];
    delete state.placeDrafts[k];
    if (!form) return;
    Object.entries(patch).forEach(([key, v]) => {
      if (key.startsWith("facts.")) { const a = form.querySelector(`[name="fact_${key.slice(6)}"]`), b = form.querySelector(`[name="src_${key.slice(6)}"]`); if (a) a.value = v ? v.v : ""; if (b && v) b.value = v.src || ""; }
      else { const e = form.querySelector(`[name="${key}"]`); if (e) e.value = v; }
    });
    if (formId === "placeForm") $("reasonBox").hidden = form.querySelector('[name="status"]')?.value !== "отсев";
    dirtyForms.add(formId); state.dirty = true;
    const m = $(formId === "factsForm" ? "factsMsg" : "placeMsg");
    if (m) { m.textContent = "Эти правки не сохранились и вернулись в форму — нажмите кнопку сохранения ещё раз."; m.className = "msg err"; }
  });
  el.querySelector("[data-focus]")?.addEventListener("click", e => { e.preventDefault(); focusPlace(p.id); });
  if (state.flashTrip) {
    const t = el.querySelector(`.trip[data-rid="${CSS.escape(state.flashTrip)}"]`);
    state.flashTrip = null;
    if (t) { t.classList.add("flash"); setTimeout(() => t.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" }), 50); }
  }
  fillSimilar(p);
}

const hintList = h => { const m = String(h).match(/^(.*?):\s*(.+)\.$/); return m && m[2].split(",").length > 8 ? m : null; };
const hintHTML = h => { const m = hintList(h); return m ? esc(m[1]) + "." : esc(h); };
const ARCHETYPES = ["курорт", "малый курорт", "город у моря", "мегаполис", "столица", "горы"];

function factsHTML(p) {
  const base = state.M.isBase(p);
  const F = state.schema.facts || [];
  const dis = canWrite() ? "" : " disabled";
  const spb = state.M.places.find(state.M.isBase);
  return `<p class="small muted">${base ? `С этими цифрами сравниваются цифры других мест: в полтора раза дороже СПб — оценка на 1 ниже. Пустое поле — берётся ориентир по умолчанию; где его нет (${F.filter(f => f.rule === "money" && !f.ref).map(f => esc(f.name.toLowerCase())).join(", ")}), без цифры СПб сравнить не с чем.` : "Цифры вписываются один раз на место — приложение само сравнит их с СПб. Плашка у названия — получившаяся оценка 1–5, 3 — как в СПб."}</p>` + F.map(f => {
    const cur = p.facts && p.facts[f.key];
    const ref = factRef(f, state.M.places);
    const sc = base ? null : factScore(f, factValue(p, f.key), ref);
    return `<div class="fact">
      <label class="field"><span class="lbl">${esc(f.name)}, ${esc(f.unit)}${sc != null ? ` <span class="badge" title="Оценка ${fmt(sc)} из 5 для итога, 3 — как в СПб" aria-label="оценка ${fmt(sc)} из 5" style="background:${scoreHex(sc)};color:${inkOn(scoreHex(sc))}">${fmt(sc)}</span>` : ""}</span>
        <input type="text" inputmode="decimal" name="fact_${f.key}" value="${cur ? esc(String(cur.v)) : ""}" placeholder="${base && f.ref ? "по умолчанию " + f.ref : ""}"${dis}></label>
      <label class="field src"><span class="lbl">Откуда</span><input type="text" name="src_${f.key}" value="${cur ? esc(cur.src || "") : ""}" placeholder="сайт, число объявлений" aria-label="${esc(f.name)}: откуда цифра"${dis}></label>
      <span class="small muted">${hintHTML(f.hint)}${!base && f.rule === "money" ? ref ? ` СПб: ${ref}\u00a0€.` : ` Оценки нет, пока не вписан чек СПб: ${spb ? `<a href="${placeHref(spb.id)}">досье СПб</a>` : "досье СПб"}, «Цифры».` : ""}${cur && cur.at ? ` Вписано ${esc(dayRu(cur.at).replace(/\.$/, ""))}.` : ""}</span>${hintList(f.hint) ? `<details class="inline small muted"><summary>Список</summary>${esc(hintList(f.hint)[2])}.</details>` : ""}
    </div>`;
  }).join("");
}

function climLegend(name, withRef) {
  return `<div class="legend small"><span><i class="sw v"></i>${esc(name)}, средняя °C</span>${withRef ? `<span><i class="sw base" style="width:14px;height:0;border-top:2px dashed var(--muted)"></i>СПб, °C</span>` : ""}<span><i class="sw" style="background:var(--pos);opacity:.4;border-radius:2px"></i>осадки, мм — модель, у моря и в горах бывает завышено</span></div>`;
}

async function fillSimilar(p) {
  const box = $("simBox");
  if (!box) return;
  await state.world.loadCities();
  if (state.world.citiesFailed) { box.innerHTML = `<p class="small muted">Данные городов не загрузились, поэтому похожие места не найти. Обновите страницу позже.</p>`; return; }
  if (!state.sim) state.sim = new Similar(state.world, state.schema.groups);
  const city = state.world.placeCity(p);
  if (!p.cc && !city) { box.innerHTML = `<p class="small muted">У места нет координат и страны — сравнивать не с чем.</p>`; return; }
  if (p.lat == null || !city) {
    box.innerHTML = `<p class="small muted">У места нет координат, поэтому похожие ищем только по данным страны: климат и размер города не сравниваются.</p>` + similarCountriesHTML(state.sim.similarCountries(p.cc, W(), 8));
    box.addEventListener("click", e => { const b = e.target.closest("[data-country]"); if (b) { go("#/map"); setTimeout(() => showCountry(b.dataset.country), 60); } });
    return;
  }
  const sp = state.sim.similarSplit({ cc: p.cc, city: city && !city.synthetic ? city : null, lat: p.lat, lon: p.lon }, W());
  if ($("simBox") !== box) return;
  box.innerHTML = similarSplitHTML(sp, p.cc) + (sp.home.length || sp.abroad.length ? `<div class="btns" style="margin-top:10px"><button type="button" class="btn ghost small" id="simMap">Показать на карте</button></div>` : "");
  box.addEventListener("click", e => {
    const b = e.target.closest("[data-city]");
    if (b) { const c = state.world.cities.find(x => String(x.id) === b.dataset.city); if (c) { go("#/map"); setTimeout(() => openCity(c, true), 50); } }
  });
  $("simMap")?.addEventListener("click", () => { state.layers.city = "similar"; state.layers.simTo = { type: "place", id: p.id }; state.fitSimilar = true; saveLayers(); go("#/map"); });
}

function draftNote(p) {
  if (state.M.isBase(p)) return "";
  const f = state.form ? state.form.form : local.get("draft", {}), all = [f].concat(Object.values(state.form ? state.form.drafts : local.get("drafts", {})));
  const d = all.find(x => x && !x.id && x.place === p.id && (!me() || x.who === me()) && x.scores && Object.keys(x.scores).length);
  if (!d) return "";
  const n = Object.keys(d.scores).length;
  return `<p class="banner small">Есть несохранённый черновик вашей оценки: ${n} ${plural(n, "ответ", "ответа", "ответов")}. <a href="#/rate/new/${encodeURIComponent(p.id)}">Продолжить</a></p>`;
}

/* ---------- rate ---------- */
function outcome(M, placeId, doc, partner, blind) {
  const p = M.PLACE[placeId] || {}, theirs = M.full.vetoes().find(r => r.place === placeId && r.who !== doc.who);
  const hide = blind ? `${partner} не увидит вашу оценку, пока не оценит место.` : "";
  if (doc.veto) return `Сохранено. Вето: место убрано из рейтинга для обоих.${blind ? ` Ваше вето ${partner} увидит, когда оценит место.` : ""}`;
  if (p.status === "отсев") return ["Сохранено. Место в отсеве и в рейтинг не входит — вернуть его можно в карточке места.", hide].filter(Boolean).join(" ");
  if (theirs) return `Сохранено. В рейтинг не входит: вето ${gen(theirs.who)} — «${theirs.veto}».`;
  return ["Сохранено.", M.ownEnough(placeId) ? "Рейтинг обновился." : "В рейтинг место попадёт, когда будут ответы хотя бы на половину главных ★ вопросов.", hide].filter(Boolean).join(" ");
}

function renderRate(arg) {
  if (!state.form) {
    state.form = new RateForm($("rateForm"), state.schema, {
      canWrite,
      save: (body, { isNew, baseOid, questions, patch, was } = {}) => state.data.saveRating(body, { isNew, baseOid, questions, patch, was }),
      saved: (res, placeId) => {
        savedNow(res.r);
        const M = state.M, who = res.doc && res.doc.who, partner = M.PEOPLE.find(w => w !== who);
        const blind = partner && me() === who && !M.full.ratingsOf(placeId).some(r => r.who === partner);
        const text = res.r === "queued"
          ? waitMsg("оценка", "сохранена")
          : outcome(M, placeId, res.doc || {}, partner, blind);
        const place = (M.PLACE[placeId] || {}).name;
        state.flashTrip = res.doc && res.doc.id;
        if (state.route.name === "rate") { toast(text); go(placeHref(placeId)); } else toast(res.r === "queued" ? text : `Сохранено: ${place || "оценка"}`);
      },
      failed: () => { if (state.route.name !== "rate") toast("Оценка не сохранена — ответы остались во вкладке «Оценить»"); },
      placeQuestions: id => (state.M.PLACE[id] || {}).questions || "",
      isDeleted: rid => { const r = state.data.docOf(`ratings/${rid}.json`); return !r || !!r.deleted; },
      emptyNote,
      remove: (rid, oid) => {
        const r = state.data.view().ratings.find(x => x.id === rid);
        if (!r) return Promise.reject(new Error("Оценка не найдена"));
        return state.data.deleteRating(r, oid || undefined);
      },
      removed: (placeId, r) => { savedNow(r); toast(r === "queued" ? waitMsg("удаление", "сохранено") : "Оценка удалена."); go(placeId && state.M.PLACE[placeId] ? placeHref(placeId) : "#/places"); },
      placeName: id => (state.M.PLACE[id] || {}).name || "",
      myRating: (placeId, who) => state.M.ratingsOf(placeId).filter(r => r.who === who).sort((a, b) => String(b.start || b.updatedAt || "").localeCompare(String(a.start || a.updatedAt || "")))[0] || null,
      edit: rid => go("#/rate/" + encodeURIComponent(rid)),
    });
  }
  state.form.setPlaces(state.M.places);
  state.pendingEdit = null;
  state.interrupted = null;
  state.route.arg = "";
  if (arg && arg.startsWith("new/")) {
    state.form.startFor(arg.slice(4));
    history.replaceState(history.state, "", "#/rate");
  } else if (arg) {
    const r = state.data.view().ratings.find(x => x.id === arg && !x.deleted);
    if (r && state.M.hidden(r.place, r.who)) { toast(hiddenRate(r)); state.form.startNew(); history.replaceState(history.state, "", placeHref(r.place)); setTimeout(route); return; }
    if (r) state.form.load(r, state.data.oidOf("ratings", r.id));
    else if (state.data.hasToken && !state.data.loadedAt && ["idle", "sync"].includes(state.data.status)) state.pendingEdit = arg;
    else toast("Оценка не найдена");
    history.replaceState(history.state, "", "#/rate");
  } else state.form.startNew();
  if (!$("rateBanner")) $("fTop").insertAdjacentHTML("beforebegin", `<div id="rateBanner"></div>`);
  $("rateBanner").innerHTML = bannerHTML();
}

/* ---------- settings ---------- */
function openPendingEdit() {
  const id = state.pendingEdit, d = state.data;
  if (!id || state.route.name !== "rate" || ["idle", "sync"].includes(d.status)) return;
  state.pendingEdit = null;
  const r = d.view().ratings.find(x => x.id === id && !x.deleted);
  if (r && state.M.hidden(r.place, r.who)) { toast(hiddenRate(r)); go(placeHref(r.place)); return; }
  if (r) state.form.load(r, d.oidOf("ratings", r.id)); else toast("Оценка не найдена");
}

function setMe(who) {
  local.set("me", who);
  if (state.form) state.form.forWho(who);
  rebuild();
  ["v-rank", "v-places", "v-place"].forEach(v => { if (VIEWS[state.route.name] !== v) $(v).innerHTML = ""; });
  if ($("sheet").hidden) $("sheetBody").innerHTML = ""; else refreshSheet();
}
const hidLine = (M, id, hid) => !hid.length ? "" : `<p class="small muted">${hid.length > 1 ? "Оценки" : "Оценка"} ${esc(hid.map(gen).join(" и "))} ${hid.length > 1 ? "скрыты" : "скрыта"}, ${me() ? `пока вы не оцените место сами. <button type="button" class="linkbtn" data-reveal="${esc(id)}">Показать всё равно</button>` : `пока не выбрано, кто вы на этом устройстве: ${M.PEOPLE.map(w => `<button type="button" class="linkbtn" data-setme="${esc(w)}">${esc(w)}</button>`).join(" или ")}`}</p>`;
const hiddenRate = r => `Эта оценка ${gen(r.who)} скрыта, пока вы не оцените место сами. Открыть её можно в досье кнопкой «Показать всё равно».`;

function rerender(fn) {
  const view = $(VIEWS[state.route.name]);
  const typed = [...view.querySelectorAll("form[id]")].flatMap(f => [...f.elements].filter(e => e.name && !/^(checkbox|radio|submit|button|hidden)$/.test(e.type) && (e.tagName === "SELECT" ? !(e.selectedOptions[0] || {}).defaultSelected : e.value !== e.defaultValue)).map(e => [f.id, e.name, e.value]));
  const FOC = "button, a[href], input, select, textarea, summary";
  const a = document.activeElement, g = a && a !== document.body && a.parentElement && a.parentElement.closest("[id]");
  const sel = g && [...a.attributes].filter(x => x.name.startsWith("data-")).map(x => `[${x.name}="${CSS.escape(x.value)}"]`).join("");
  const at = g ? [...g.querySelectorAll(FOC)].indexOf(a) : -1, gid = g && g.id, aid = a && a.id;
  fn();
  typed.forEach(([fid, n, v]) => { const e = $(fid) && $(fid).elements[n]; if (e && e.value !== v) { e.value = v; e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); } });
  if (!g || a.isConnected) return;
  const box = $(gid), b = aid ? $(aid) : box && (sel ? box.querySelector(sel) : at >= 0 ? box.querySelectorAll(FOC)[at] : null);
  if (b) b.focus({ preventScroll: true });
}

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
      <div class="panel pad help">${/Android/i.test(navigator.userAgent) ? `<span>Android: Chrome → ⋮ → «Добавить на главный экран». Дальше открывайте с иконки, как обычное приложение.</span>` : /CriOS/.test(navigator.userAgent) ? `<span>iPhone, Chrome: ⋯ или «Поделиться» → «На экран „Домой“». Если такого пункта нет — откройте эту страницу в Safari и добавьте оттуда.</span>` : /iPhone|iPad/.test(navigator.userAgent) && !/Safari\//.test(navigator.userAgent) ? `<span>Из Telegram или Instagram на экран «Домой» не добавить: откройте страницу в Safari (⋯ → «Открыть в Safari»), затем Поделиться → «На экран „Домой“».</span>` : `<span>iPhone: Safari → Поделиться → «На экран „Домой“» (Share → Add to Home Screen). Открывайте с иконки: так данные не сотрутся через неделю, как во вкладке Safari.</span>`}<span>У приложения с экрана «Домой» своя память, отдельная от Safari, поэтому ключ доступа вставляется уже в нём.</span></div>
    </section>`;
  $("v-settings").innerHTML = `
    <header><h1>Настройки</h1></header>
    ${d.lost.length ? bannerHTML() : ""}
    ${installFirst ? install : ""}
    <section class="block"><h2>Кто я на этом устройстве</h2>
      <div class="panel pad stack"><div class="seg" role="group" aria-label="Кто я на этом устройстве" id="meSeg">${state.schema.people.map(w => `<button type="button" data-me="${esc(w)}" aria-pressed="${w === who}">${esc(w)}</button>`).join("")}</div><p class="small muted">Подставляется в форму оценки. Оценки другого скрыты, пока вы не оцените место сами, чтобы не подглядывать.</p></div>
    </section>
    <section class="block"><h2>Подключение к данным</h2>
      <form class="panel pad stack" id="tokenForm">
        <p class="small">Наши оценки лежат в закрытом хранилище на GitHub. Чтобы видеть и сохранять их с этого устройства, нужен ключ доступа: его делают один раз, на каждое устройство свой.</p>
        <input type="text" name="username" value="where-to-live-${esc(slugMe())}" autocomplete="username" hidden>
        <label class="field"><span class="lbl">Ключ доступа ${d.hasToken ? "(уже сохранён; вставьте новый, чтобы заменить)" : ""}</span><input type="password" name="token" placeholder="github_pat_…" spellcheck="false" autocapitalize="off" autocorrect="off" autocomplete="current-password"></label>
        <div class="btns"><button type="submit" class="btn">Сохранить и проверить</button>${d.hasToken ? `<button type="button" class="btn danger" id="forget">Забыть ключ на этом устройстве</button>` : ""}</div>
        <p class="msg${d.status === "auth" || d.status === "error" ? " err" : ""}" id="tokenMsg" role="status">${d.hasToken ? statusHTML() : ""}</p>
        ${d.hasToken ? `<div class="btns"><button type="button" class="btn ghost small" id="refreshBtn">Обновить данные</button></div>` : ""}
        <details${d.hasToken ? "" : " open"}><summary class="small">Как получить ключ</summary><ol class="small help" style="padding-left:18px">
          <li>Откройте <a href="${esc(tokenUrl)}" target="_blank" rel="noopener noreferrer">создание ключа на GitHub</a> (войти под аккаунтом Михаила). Имя, срок «без срока» и право Contents: Read and write уже подставлены.</li>
          <li>Repository access → Only select repositories → <b>${esc(d.repo.split("/")[1] || "where-to-live-data")}</b>.</li>
          <li>Generate token, скопируйте и вставьте сюда. Для телефона Вики — отдельный ключ с её именем, чтобы отзывать независимо.</li>
          <li>Сохраните ключ ещё и в Связке ключей или менеджере паролей: на сайт его можно ввести заново за минуту.</li></ol></details>
        <details><summary class="small">Технические подробности</summary><div class="stack" style="margin-top:8px">
          <p class="small muted">Это fine-grained токен GitHub с доступом только к одному репозиторию. Он хранится в памяти браузера на этом устройстве и уходит только на api.github.com.</p>
          <label class="field"><span class="lbl">Репозиторий с данными</span><input type="text" name="repo" value="${esc(d.repo)}" spellcheck="false" autocapitalize="off" autocorrect="off" autocomplete="off"></label>
        </div></details>
      </form>
    </section>
    <section class="block"><h2>Как считается итог</h2>
      <div class="panel pad stack">
        <label class="toggle"><input type="checkbox" id="useData"${useData() ? " checked" : ""}> Учитывать мировые данные в итоге: показатели стран (цены, медицина, безопасность, свободы) и климат городов</label>
        <p class="small muted">Мировые данные переводятся в оценку 1–5, где 3 — как в России и СПб. Где туристу видно мало, они весят больше наших оценок.</p>
        <p class="small muted" id="useDataMsg" role="status"></p>
      </div>
    </section>
    <section class="block"><h2>Вид</h2>
      <div class="panel pad stack">
        <div class="seg" role="group" aria-label="Тема" id="themeSeg">${[["auto", "Как в системе"], ["light", "Светлая"], ["dark", "Тёмная"]].map(([k, n]) => `<button type="button" data-theme="${k}" aria-pressed="${k === theme}">${n}</button>`).join("")}</div>
        <div class="btns"><button type="button" class="btn ghost small" id="helpBtn">Как пользоваться картой</button></div>
      </div>
    </section>
    ${installFirst || isStandalone() ? "" : install}
    <section class="block"><h2>Приложение</h2>
      <div class="panel pad stack"><p class="small">Работает и без интернета: приложение и наши данные хранятся на устройстве. Новые оценки отправятся, когда появится связь. Карта и поиск мест без интернета не работают.</p><p class="small muted">Версия приложения: <span id="appVersion">—</span></p></div>
    </section>
    <section class="block"><h2>Копия данных</h2>
      <div class="panel pad stack"><p class="small muted">Все места, оценки и веса одним файлом — на случай, если что-то пойдёт не так. ${hiddenPairs(state.M) ? "В файле есть и скрытые от вас оценки." : ""}</p><div class="btns"><button type="button" class="btn ghost" id="exportBtn">Скачать копию данных</button></div></div>
    </section>
    <section class="block"><h2>Источники данных</h2>
      <div class="panel pad small help">
        <span>Карта: © участники OpenStreetMap (ODbL), тайлы OSM. Поиск: Nominatim, данные © OpenStreetMap. Границы: Natural Earth (public domain), показаны de facto.</span>
        <span>Города: GeoNames (CC BY 4.0). Климат: CHELSA V2.1, 1981–2010 (CC0). Световой день — расчёт по формуле NOAA. Аэропорты с регулярными рейсами: OurAirports (public domain), аэропорты стран, куда с паспортом РФ нужна виза, не учитываются.</span>
        ${ind.length ? `<span>Показатели стран (выгрузка ${esc(dayRu(state.world.generated))}): ${[...new Set(ind.map(i => `${i.source}${i.license ? " — " + i.license : ""}`))].map(esc).join("; ")}. Значения переведены в шкалу 1–5 приложением.</span>` : ""}
        <span>Код: <a href="https://github.com/Mihinator3000/where-to-live" target="_blank" rel="noopener noreferrer">github.com/Mihinator3000/where-to-live</a>.</span>
      </div>
    </section>`;
  $("meSeg").addEventListener("click", e => { const b = e.target.closest("[data-me]"); if (!b) return; setMe(b.dataset.me); rerender(renderSettings); });
  $("themeSeg").addEventListener("click", e => { const b = e.target.closest("[data-theme]"); if (!b) return; setTheme(b.dataset.theme); rerender(renderSettings); });
  $("useData").addEventListener("change", e => { local.set("worldData", e.target.checked); rebuild(); const t = e.target.checked ? "Итоги и рейтинг пересчитаны с мировыми данными." : "Итоги и рейтинг пересчитаны без мировых данных: только по нашим оценкам и цифрам мест."; $("useDataMsg").textContent = t; toast(t); });
  $("tokenForm").addEventListener("input", () => { state.dirty = true; });
  $("tokenForm").addEventListener("submit", async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const token = String(f.get("token") || "").trim();
    const repo = String(f.get("repo") || DEFAULT_REPO).trim() || DEFAULT_REPO;
    const msg = $("tokenMsg"), btn = e.target.querySelector("[type=submit]");
    if (btn.disabled) return;
    msg.className = "msg";
    const fail = text => { msg.textContent = text; msg.className = "msg err"; };
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return fail("Репозиторий укажите как владелец/имя, например Mihinator3000/where-to-live-data.");
    if (!token && !d.hasToken) return fail("Вставьте ключ доступа: без него данные не загрузить.");
    btn.disabled = true; btn.textContent = "Проверяю…";
    const done = () => { if (btn.isConnected) { btn.disabled = false; btn.textContent = "Сохранить и проверить"; } };
    if (token) {
      msg.textContent = "Проверяю ключ…";
      const [owner, name] = repo.split("/");
      try {
        await new GitHubStore({ owner, repo: name, token }).load();
      } catch (err) {
        const dataRepo = name || "where-to-live-data";
        msg.textContent = (err.code === "offline" ? "Нет связи, ключ не проверен и не сохранён." : ["http", "graphql", "limit", "timeout", "conflict", "rejected"].includes(err.code) ? `${failWhy(err)}, поэтому ключ не проверен и не сохранён. Попробуйте ещё раз ${err.code === "limit" ? "позже" : "через минуту"}.` : err.code === "access" ? `Ключ не сохранён: он не видит хранилище ${dataRepo}. Создайте ключ заново и на шаге 2 выберите Repository access → Only select repositories → ${dataRepo}.` : err.code === "auth" ? "Ключ не подошёл, он не сохранён. Проверьте, что скопировали его целиком (начинается с github_pat_) и что у него не истёк срок." : "Ключ не подошёл, он не сохранён." + (err.message ? " " + err.message : "")) + (d.hasToken ? " Остался прежний ключ." : "");
        msg.className = "msg err";
        done();
        return;
      }
      e.target.querySelector('[name="token"]').value = "";
    }
    d.setCredentials(repo, token || null);
    if (token && d.token !== token) { fail("Браузер не даёт сайту хранить данные (частный режим или запрет в настройках браузера), поэтому сохранить ключ на этом устройстве нельзя. Откройте приложение в обычном окне или разрешите сайту хранить данные."); done(); return; }
    msg.textContent = "Загружаю данные…";
    await d.refresh();
    done();
    msg.innerHTML = statusHTML();
    msg.className = "msg" + (d.status === "live" ? "" : " err");
    if (d.status === "live") { toast("Подключено: данные загружены"); if (token) state.fitPending = true; renderSettings(); }
  });
  $("forget")?.addEventListener("click", e => {
    const b = e.currentTarget;
    if (!b.dataset.armed) {
      b.dataset.armed = "1"; b.textContent = "Точно забыть? Нажмите ещё раз";
      setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = "Забыть ключ на этом устройстве"; } }, 5000);
      return;
    }
    d.forget();
    toast(d.pending.length ? `Ключ и данные удалены с этого устройства. Неотправленные правки (${d.queued}) уйдут после нового ключа` : "Ключ и данные удалены с этого устройства");
    renderSettings();
  });
  if (window.caches) caches.keys().then(k => { const v = k.find(x => x.startsWith("wtl-")); if (v && $("appVersion")) $("appVersion").textContent = v.replace(/^wtl-/, ""); }).catch(() => {});
  $("exportBtn").addEventListener("click", () => {
    const v = state.data.view();
    const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), places: v.places, ratings: v.ratings, weights: v.weightDocs, notSent: local.get("lost", []) }, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `where-to-live-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast(/iPhone|iPad/.test(navigator.userAgent) ? `Копия скачана: ${a.download} — в «Файлах», папка «Загрузки»` : `Копия скачана: ${a.download}`);
  });
  $("helpBtn").addEventListener("click", () => { local.del("introSeen"); state.introShown = false; go("#/map"); });
  $("refreshBtn")?.addEventListener("click", async e => {
    const b = e.currentTarget;
    if (b.disabled) return;
    b.disabled = true; b.textContent = "Обновляю…";
    await d.refresh();
    if (b.isConnected) { b.disabled = false; b.textContent = "Обновить данные"; }
    const M = state.M;
    toast(d.status === "live" ? `Данные обновлены: мест ${M.places.filter(p => !M.isBase(p)).length}, оценок ${ratingCount(M)}` : d.error || "Не удалось обновить данные");
  });
}

function statusHTML() {
  const d = state.data, M = state.M;
  if (d.status !== "live") return d.status === "error" && d.queued ? esc(`${ghDown()}. Ждут ${onDevice()}: ${d.queued} — `) + (d.stuck ? `они сохранены здесь, и я продолжаю отправлять их сам. На всякий случай скачайте копию ниже — «Скачать копию данных».` : esc(`отправлю сам, ${d.errorCode === "limit" ? "после этого времени" : "когда GitHub ответит"}.`)) : esc(d.error || "");
  const n = M.places.filter(p => !M.isBase(p)).length, base = M.places.find(M.isBase);
  return esc(`Подключено: мест ${n}${base ? " и СПб" : ""}, оценок ${ratingCount(M)}.`) + (n ? ` Дальше: <a href="#/rank">рейтинг</a> или <a href="#/map">карта</a>.` : ` Мест пока нет: <a href="#/map">добавьте первое место через поиск на карте</a>.`) + (me() ? "" : " Теперь выберите выше, кто вы на этом устройстве: от этого зависит, чьи оценки скрыты.");
}

/* ---------- map ---------- */
function saveLayers() { local.set("layers", state.layers); }

function placeMarkers() {
  const M = state.M, norm = W();
  return M.places.map(p => {
    const t = placeScore(M, p, norm);
    const out = p.status === "отсев" || M.vetoed(p);
    const thin = !M.isBase(p) && !M.ownEnough(p.id);
    const hex = t.score == null || M.isBase(p) ? null : scoreHex(t.score);
    const why = M.isBase(p) ? "" : p.status === "отсев" ? "отсев" : M.vetoed(p) ? "вето" : "";
    return { id: p.id, name: p.name, lat: p.lat, lon: p.lon, base: M.isBase(p), out, thin, why, ink: hex ? inkOn(hex) : "", color: M.isBase(p) ? "var(--base)" : hex || "var(--none)", text: M.isBase(p) ? "" : t.score == null ? "" : fmt(t.score) };
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
    return { list: list.map(x => x.city), fn: c => { const q = rank.get(c.id); return q == null ? null : { fill: scoreHex(5 - 2 * q), r: 7 - 3 * q }; }, label: c => `${c.n}: похоже на ${pct.get(c.id)}%`, target, legend: { title: `Похожие на «${target.name}», топ-${list.length}`, ramp: [3, 3.5, 4, 4.5, 5].map(scoreHex), lo: "менее похожи", hi: "более похожи", note: `кольцо — «${target.name}», с ним сравниваем` } };
  }
  if (L.city === "predict") {
    const fn = predictor();
    if (!fn) return null;
    const cache = new Map();
    const get = c => { if (!cache.has(c.id)) cache.set(c.id, fn({ cc: c.cc, city: c })); return cache.get(c.id); };
    return { list: Wd.cities, fn: c => { const r = get(c); return r ? { fill: scoreHex(r.score) } : null; }, label: c => { const r = get(c); return r ? `${c.n}: прогноз ${fmt(r.score)} (уверенность ${Math.round(r.conf * 100)}%)` : c.n; }, legend: { title: "Прогноз для нас по похожим местам", rel: true, mid: "3 — как в СПб" } };
  }
  const ind = Wd.CIND[L.city];
  if (!ind) return null;
  if (ind.scale && ind.dir) return { list: Wd.cities, fn: c => { const s = Wd.cityScore(c, ind.key); return s == null ? null : { fill: scoreHex(s) }; }, label: c => `${c.n}: ${fmtValue(ind, ind.get(c))}`, legend: ind.scale.type === "abs" ? { title: ind.name, rel: true, mid: "3 из 5", note: "фиксированные пороги, не от СПб" } : { title: ind.name, rel: true, ref: "СПб" } };
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
    return t.score == null ? null : { cc: p.cc, city: city && !city.synthetic ? city : null, score: t.score, name: p.name };
  }).filter(Boolean);
  return state.sim.predictor(rated, norm);
}

function similarTarget() { return targetOf(state.layers.simTo); }

function targetOf(t) {
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
    const abs = leg.ind.scale && leg.ind.scale.type === "abs";
    if (leg.raw) parts.push(`<div class="ramp">${leg.ramp.map(c => `<i style="background:${c}"></i>`).join("")}</div><div class="ends"><span>${esc(leg.lo)}</span><span>квантили</span><span>${esc(leg.hi)}</span></div>`);
    else parts.push(`<div class="ramp">${relRamp}</div><div class="ends"><span>хуже</span><span>${abs ? "3 из 5" : "≈ Россия"}</span><span>лучше</span></div>`);
    parts.push(`<div class="src">${leg.raw ? "каждый цвет — пятая часть стран, от меньших значений к большим · " : abs ? "фиксированные пороги, не от России · " : ""}${esc(leg.ind.source || "")} · без заливки — нет данных</div>`);
  }
  const cc = state.cityLegend;
  if (cc) {
    parts.push(`<div style="margin-top:4px"><b>Города: ${esc(cc.title)}</b></div>`);
    if (cc.ramp) parts.push(`<div class="ramp">${cc.ramp.map(c => `<i style="background:${c}"></i>`).join("")}</div><div class="ends"><span>${esc(cc.lo)}</span><span>${esc(cc.hi)}</span></div>`);
    else parts.push(`<div class="ramp">${relRamp}</div><div class="ends"><span>${esc(cc.lo || "хуже")}</span><span>${esc(cc.mid || (cc.ref ? "≈ " + cc.ref : ""))}</span><span>${esc(cc.hi || "лучше")}</span></div>`);
    if (cc.note) parts.push(`<div class="src">${esc(cc.note)}</div>`);
  }
  return parts.join("");
}

function layersHTML() {
  const L = state.layers, Wd = state.world, G = state.schema.groups;
  const byGroup = G.map(g => ({ g, list: Wd.indicators.filter(i => i.group === g.key) })).filter(x => x.list.length);
  const ratedCount = state.M.candidates().filter(p => state.M.ratingsOf(p.id).length).length;
  const simT = targetOf(L.city === "similar" ? L.simTo : state.simCandidate || L.simTo);
  return `${Wd.missing.length ? `<p class="small">${Wd.missing.includes("indicators") ? "Данные стран" : "Границы стран"} не загрузились: раскраска и карточки стран недоступны. Обновите страницу позже.</p>` : ""}
    <div class="field"><label class="lbl" for="lyCountry">Раскраска стран</label>
      <select id="lyCountry"><option value="">Без раскраски</option>${byGroup.map(x => `<optgroup label="${esc(x.g.name)}">${x.list.map(i => `<option value="${i.key}"${i.key === L.country ? " selected" : ""}>${esc(i.name)}</option>`).join("")}</optgroup>`).join("")}</select>
      ${L.country ? `<div class="seg" role="group" aria-label="Шкала раскраски" id="lyMode"><button type="button" data-mode="rel" aria-pressed="${L.mode !== "raw"}">Относительно России</button><button type="button" data-mode="raw" aria-pressed="${L.mode === "raw"}">Сырые значения</button></div><span class="desc">«Относительно России» — оценка 1–5 для нас: средний цвет — как в России, синее — лучше, красное — хуже. «Сырые значения» — сами цифры показателя: каждый цвет — пятая часть стран.</span>` : ""}
    </div>
    <div class="field"><label class="lbl" for="lyCity">Города мира</label>
      <select id="lyCity"><option value="">Не показывать</option>${CITY_INDICATORS.map(i => `<option value="${i.key}"${i.key === L.city ? " selected" : ""}>${esc(i.name)}</option>`).join("")}<option value="similar"${L.city === "similar" ? " selected" : ""}${simT ? "" : " disabled"}>${simT ? `Похожие на «${esc(simT.name)}»` : "Похожие на выбранное место (нажмите место или город на карте)"}</option><option value="predict"${L.city === "predict" ? " selected" : ""}${ratedCount >= 3 ? "" : " disabled"}>Прогноз для нас${ratedCount >= 3 ? "" : " (нужно ≥ 3 оценённых места)"}</option></select>
      <span class="desc">Около 4 тыс. городов, в основном крупнее 15 тыс. жителей.${cityDesc(L.city)} «Прогноз для нас» — понравился бы нам город, судя по похожим оценённым местам; считается по весам из «Рейтинга».</span>
      ${L.city === "predict" ? predictTopHTML() : ""}
    </div>
    <label class="toggle"><input type="checkbox" id="lyPlaces"${L.places ? " checked" : ""}> Наши места</label>
    <span class="desc">Кружок — наше место, число — итог 1–5. Полый — своих оценок мало. Бледный — отсев или вето. Квадрат — СПб. Кружок с числом — несколько мест рядом.</span>
    <label class="toggle"><input type="checkbox" id="lyVisited"${L.visited ? " checked" : ""}> Страны, где были: обведены контуром</label>
    <span class="desc">Сплошной — были оба, пунктир фиолетовый — только ${esc(state.schema.people[0])}, оранжевый — только ${esc(state.schema.people[1])}.</span>
    <div class="btns"><button type="button" class="btn ghost small" id="lyClose">Готово</button></div>`;
}

function cityDesc(key) {
  if (!key) return "";
  if (key === "similar") return " Ярче и крупнее — более похожие.";
  if (key === "predict") return " Цвет — прогноз 1–5, где 3 — как в СПб.";
  const ind = state.world.CIND[key];
  if (!ind) return "";
  if (ind.scale && ind.dir) return ind.scale.type === "abs" ? " Цвет — оценка 1–5 по фиксированным порогам, синее — лучше." : " Синее — лучше СПб, красное — хуже.";
  return " Цвет — само значение: от тёмного (меньше) к жёлтому (больше), не «лучше» или «хуже».";
}

function predictTopHTML() {
  const fn = predictor();
  if (!fn) return "";
  const ours = state.M.places.filter(p => p.lat != null);
  const list = state.world.cities.filter(c => !ours.some(p => haversine(p, c) < 15)).map(c => ({ c, r: fn({ cc: c.cc, city: c }) })).filter(x => x.r).sort((a, b) => b.r.score - a.r.score).slice(0, 10);
  if (!list.length) return "";
  return `<div class="ptop"><span class="lbl">Лучшие по прогнозу</span>${list.map(x => `<button type="button" data-pcity="${x.c.id}"><span>${esc(x.c.n)}<span class="muted"> · ${esc(state.world.nameOf(x.c.cc))}</span></span><span class="num">${fmt(x.r.score)}</span><small class="muted">уверенность ${Math.round(x.r.conf * 100)}%</small></button>`).join("")}<span class="desc">Прогноз — как нам понравилось бы, судя по оценённым местам, похожим на этот город. Уверенность ниже, когда похожих оценённых мест мало.</span></div>`;
}

function initMap() {
  if (state.mapView) return;
  state.mapView = new MapView($("map"), {
    onPlace: (id, kb) => { openPlace(id); const p = state.M.PLACE[id]; if (p) state.mapView.keepVisible(p.lat, p.lon); if (kb) focusSheet(); },
    onCountry: (iso, latlng) => openCountry(iso, latlng),
    onCity: c => { openCity(c); state.mapView.keepVisible(c.lat, c.lon); },
    onBlank: () => { closeSheet(); closeLayers(); },
    onZoom: () => { if (!state.mapView) return; const z = zoomedIn(); if (z !== state.zoomedIn) { state.zoomedIn = z; state.mapView.restyleCountries(countryStyle()); } },
  });
  state.zoomedIn = zoomedIn();
  if (state.world.geo) state.mapView.setCountries(state.world.geo, countryStyle());
  $("mapHelpBtn").addEventListener("click", () => { closeLayers(); openIntro(); });
  $("layersBtn").addEventListener("click", () => {
    const p = $("layersPanel");
    p.hidden = !p.hidden;
    $("layersBtn").setAttribute("aria-expanded", String(!p.hidden));
    if (!p.hidden) p.innerHTML = layersHTML();
  });
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape" || state.route.name !== "map") return;
    if (!$("searchResults").hidden && document.activeElement && document.activeElement.closest(".search")) { searchSeq++; $("searchResults").hidden = true; quietFocus = true; $("searchInput").focus(); quietFocus = false; }
    else if (!$("layersPanel").hidden) closeLayers();
    else if (state.sheet) closeSheet();
  });
  $("layersPanel").addEventListener("change", e => {
    const L = state.layers;
    if (e.target.id === "lyCountry") L.country = e.target.value;
    if (e.target.id === "lyCity") { L.city = e.target.value; if (L.city === "similar") L.simTo = state.simCandidate || L.simTo; }
    if (e.target.id === "lyPlaces") L.places = e.target.checked;
    if (e.target.id === "lyVisited") L.visited = e.target.checked;
    saveLayers(); renderMap();
    if (e.target.id === "lyCity" || e.target.id === "lyCountry") rerender(() => { $("layersPanel").innerHTML = layersHTML(); });
  });
  $("layersPanel").addEventListener("click", e => {
    if (e.target.closest("#lyClose")) { closeLayers(); return; }
    const pc = e.target.closest("[data-pcity]");
    if (pc) { const c = state.world.cities.find(x => String(x.id) === pc.dataset.pcity); if (c) openCity(c, true); return; }
    const b = e.target.closest("[data-mode]");
    if (!b) return;
    state.layers.mode = b.dataset.mode; saveLayers();
    rerender(() => { $("layersPanel").innerHTML = layersHTML(); });
    renderMap();
  });
  $("searchForm").addEventListener("submit", e => { e.preventDefault(); runSearch($("searchInput").value.trim(), true); });
  $("searchInput").addEventListener("input", e => runSearch(e.target.value.trim(), false));
  $("searchInput").addEventListener("focus", e => { closeLayers(); if (!quietFocus && e.target.value.trim()) runSearch(e.target.value.trim(), false); });
  $("searchResults").addEventListener("click", e => {
    const b = e.target.closest("button[data-i]");
    if (!b) return;
    const item = state.searchItems[Number(b.dataset.i)], kb = e.detail === 0;
    searchSeq++;
    $("searchResults").hidden = true;
    if (item.type !== "remote") $("searchInput").value = "";
    if (kb && item.type !== "remote") { quietFocus = true; $("searchInput").focus({ preventScroll: true }); quietFocus = false; } else $("searchInput").blur();
    if (item.type === "place") { openPlace(item.id, true); }
    else if (item.type === "city") { openCity(item.city, true); }
    else if (item.type === "country") showCountry(item.iso);
    else if (item.type === "geo") { openGeo(item.geo); }
    else if (item.type === "remote") { runSearch($("searchInput").value.trim(), true); if (kb) { quietFocus = true; $("searchInput").focus(); quietFocus = false; } }
    if (kb && item.type !== "remote") focusSheet();
  });
  document.addEventListener("click", e => { if (!e.target.closest(".search")) $("searchResults").hidden = true; });
  $("sheetClose").addEventListener("click", closeSheet);
  let gripY = null, swiped = 0;
  $("sheetGrip").addEventListener("touchstart", e => { gripY = e.touches[0].clientY; }, { passive: true });
  $("sheetGrip").addEventListener("touchend", e => {
    if (gripY == null) return;
    const dy = e.changedTouches[0].clientY - gripY, c = $("sheet").classList;
    gripY = null;
    if (Math.abs(dy) < 40) return;
    swiped = Date.now();
    if (dy > 0 && c.contains("peek")) closeSheet();
    else if (dy > 0) { c.remove("full"); c.add("peek"); }
    else if (c.contains("peek")) c.remove("peek");
    else c.add("full");
  });
  $("sheetGrip").addEventListener("click", () => {
    if (Date.now() - swiped < 600) return;
    const c = $("sheet").classList, b = $("sheetBody");
    if (c.contains("peek")) c.remove("peek");
    else if (!c.contains("full") && b.scrollHeight > b.clientHeight + 1) c.add("full");
    else { c.remove("full"); c.add("peek"); }
  });
  $("sheetBody").addEventListener("click", onSheetClick);
}

const leafletReady = new Promise(r => { if (window.L) r(); else document.addEventListener("DOMContentLoaded", () => r(), { once: true }); });

function renderMap() {
  if (!window.L) { leafletReady.then(() => { if (state.route.name === "map" && window.L) renderMap(); }); return; }
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
    if (state.fitSimilar && state.layers.city === "similar" && col) {
      state.fitSimilar = false;
      if (col.list.length) {
        const t = similarTarget(), wide = innerWidth >= 860, side = wide && !$("sheet").hidden;
        const pts = col.list.map(c => [c.lat, c.lon]).concat(t && t.x.lat != null ? [[t.x.lat, t.x.lon]] : []);
        mv.map.invalidateSize();
        mv.map.fitBounds(window.L.latLngBounds(pts), { paddingTopLeft: [side ? 424 : 20, 70], paddingBottomRight: [20, wide ? 40 : 110], maxZoom: 7, animate: false });
      }
    }
  }
  const tgt = state.layers.city === "similar" && state.world.cities ? similarTarget() : null;
  if (state.simMark) { state.simMark.remove(); state.simMark = null; }
  if (tgt && tgt.x.lat != null) state.simMark = window.L.circleMarker([tgt.x.lat, tgt.x.lon], { radius: 11, color: pal().ink, weight: 3, fill: false, interactive: false, pane: "places" }).addTo(mv.map);
  const pts = state.layers.places && state.fitPending && !mv.restoreView() ? state.M.places.filter(p => p.lat != null).map(p => [p.lat, p.lon]) : [];
  if (pts.length > 1) {
    state.fitPending = false;
    const wide = innerWidth >= 860;
    mv.map.invalidateSize();
    mv.map.fitBounds(window.L.latLngBounds(pts), { paddingTopLeft: [24, wide ? 70 : 80], paddingBottomRight: [24, wide ? 40 : 110], maxZoom: 6, animate: false });
  }
  const off = state.data.status === "offline", note = [];
  if (!state.data.hasToken) note.push(`Данные не подключены — <a href="#/settings">вставьте ключ</a>, чтобы видеть наши места и оценки.`);
  else if (off) note.push(esc(state.data.loadedAt ? `Нет связи: на карте сохранённая копия наших данных на ${whenRu(state.data.loadedAt)}. Подложка карты и поиск мест вернутся с интернетом.` : "Нет связи: наши места и оценки ещё не загружены на это устройство и появятся, когда появится связь."));
  const cut = state.data.hasToken ? cutNote() : "";
  if (cut) note.push(cut);
  $("mapNote").hidden = !note.length;
  $("mapNote").classList.toggle("err", !!cut);
  $("mapNote").innerHTML = note.join("<br>");
  const lg = legendHTML();
  $("legendBox").hidden = !lg;
  $("legendBox").innerHTML = lg;
  if (!local.get("introSeen", false) && $("sheet").hidden && !state.introShown) { state.introShown = true; openIntro(); }
}

function openIntro() {
  state.sheet = { type: "intro" };
  openSheet(`<h3 id="sheetTitle" aria-level="2" tabindex="-1">Как пользоваться картой</h3>
    <div class="help small"><span><b>Здесь мы выбираем, где жить:</b> наши оценки и мировые данные (показатели стран, климат городов) сводятся в итог 1–5, где 3 — как в СПб.</span><span>Кружки — наши места; полый — своих оценок мало, бледный — отсев или вето. Квадрат — СПб, кружок с числом — несколько мест рядом.</span><span>Нажмите на страну или город — данные и похожие места. Поиск — найти или добавить место. После поездки — вкладка «Оценить».</span>${state.data.hasToken ? "" : `<span>Чтобы видеть и сохранять наши оценки, вставьте ключ доступа в <a href="#/settings">настройках</a>.</span>`}</div>
    <div class="btns sticky"><button type="button" class="btn" data-act="introok">Понятно</button></div>`);
}

function refreshSheet() {
  const s = state.sheet;
  if (!s || $("sheet").hidden) return;
  const body = $("sheet").classList, top = $("sheetBody").scrollTop, size = ["full", "peek"].filter(c => body.contains(c));
  if (s.type === "place") { if (!state.M.PLACE[s.id]) { closeSheet(); return; } openPlace(s.id); }
  else if (s.type === "country") openCountry(s.iso, s.latlng, s.exact !== false);
  else return;
  if (s.sim) { state.sheet.sim = s.sim; showSim(s.sim); }
  $("sheetBody").scrollTop = top;
  size.forEach(c => body.add(c));
}

/* ---------- search ---------- */
let searchTimer = null, searchSeq = 0, quietFocus = false;
const normQ = s => String(s || "").toLowerCase().replace(/ё/g, "е");
function runSearch(q, remote) {
  const box = $("searchResults");
  const seq = ++searchSeq;
  clearTimeout(searchTimer);
  if (!q) { box.hidden = true; return; }
  const ql = normQ(q);
  const items = [];
  const ours = state.M.places.filter(p => p.lat != null);
  const near = (x, km) => ours.some(p => haversine(p, x) < km);
  const ownOf = c => ours.find(p => haversine(p, c) < 5);
  const cities = state.world.cities ? state.world.cities.filter(c => normQ(c.n).startsWith(ql) || (c.en && normQ(c.en).startsWith(ql))) : [];
  if (!state.world.cities) state.world.loadCities();
  const mine = state.M.places.filter(p => normQ(p.name).includes(ql));
  cities.forEach(c => { const p = ownOf(c); if (p && !mine.includes(p)) mine.push(p); });
  mine.slice(0, 4).forEach(p => items.push({ type: "place", id: p.id, title: p.name, sub: p.country || "" }));
  const Wn = state.world;
  Object.keys(Wn.names || {}).filter(iso => [normQ(Wn.nameOf(iso)), normQ(Wn.enNameOf(iso))].some(n => n === ql || (ql.length >= 4 && n.startsWith(ql)))).slice(0, 2).forEach(iso => items.push({ type: "country", iso, title: Wn.nameOf(iso), sub: "страна" }));
  const exact = c => (normQ(c.n) === ql || normQ(c.en) === ql ? 1 : 0);
  cities.filter(c => !ownOf(c)).sort((a, b) => exact(b) - exact(a)).slice(0, 5).forEach(c => items.push({ type: "city", city: c, title: c.n, sub: state.world.nameOf(c.cc) + (c.pop ? " · " + popRu(c.pop) : "") }));
  const GROUP = { place: "Наши места", country: "Страны", city: "Города мира", geo: "OpenStreetMap", remote: "" };
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
    show([{ type: "remote", title: `Искать «${q}» везде`, sub: matchMedia("(pointer: coarse)").matches ? "нажмите — поиск по OpenStreetMap" : "Enter · поиск по OpenStreetMap" }]);
    return;
  }
  const say = t => { $("searchStatus").textContent = t; };
  show([], "Ищу в OpenStreetMap…");
  say("Ищу в OpenStreetMap…");
  search(q).then(res => {
    if (seq !== searchSeq) return;
    const fresh = res.filter(g => !near(g, 3));
    const kept = items.filter(it => it.type !== "city" || !fresh.some(g => haversine(it.city, g) < 5));
    items.splice(0, items.length, ...kept);
    show(fresh.map(g => ({ type: "geo", geo: g, title: g.name, sub: g.label })), fresh.length ? "Поиск: Nominatim, данные © OpenStreetMap" : res.length ? "Всё найденное уже есть среди наших мест" : "Ничего не нашлось");
    say(fresh.length ? `Найдено: ${state.searchItems.length}` : res.length ? "Всё найденное уже есть среди наших мест" : "Ничего не нашлось");
  }).catch(err => { if (seq === searchSeq) { show([], esc(err.message)); say(err.message); } });
}

/* ---------- sheet ---------- */
function openSheet(html) {
  const a = document.activeElement;
  if (a && a !== document.body && !a.closest("#sheet")) state.opener = { el: a, pin: a.matches(".leaflet-marker-icon") ? a.getAttribute("title") : "" };
  else if (!state.sheet || $("sheet").hidden) state.opener = null;
  $("sheetBody").innerHTML = html;
  $("sheet").hidden = false;
  $("sheetBody").scrollTop = 0;
  $("sheet").classList.remove("full", "peek");
  $("layersPanel").hidden = true;
  $("layersBtn").setAttribute("aria-expanded", "false");
}

function closeLayers() {
  if ($("layersPanel").hidden) return;
  if ($("layersPanel").contains(document.activeElement)) $("layersBtn").focus();
  $("layersPanel").hidden = true;
  $("layersBtn").setAttribute("aria-expanded", "false");
}

function closeSheet() {
  if (state.sheet && state.sheet.type === "intro") local.set("introSeen", true);
  const a = document.activeElement, back = !$("sheet").hidden && (!a || a === document.body || a.closest("#sheet")), o = state.opener;
  $("sheet").hidden = true;
  state.sheet = null;
  state.opener = null;
  if (state.mapView) state.mapView.clearTemp();
  if (!back || !o || state.route.name !== "map") return;
  const el = o.el && o.el.isConnected && !o.el.closest("[hidden]") ? o.el : o.pin ? document.querySelector(`.leaflet-marker-icon[title="${CSS.escape(o.pin)}"]`) : null;
  if (!el) return;
  quietFocus = true; el.focus({ preventScroll: true }); quietFocus = false;
}

function focusSheet() { const h = $("sheetTitle"); if (h && !$("sheet").hidden) h.focus({ preventScroll: true }); }

function scoreLine(M, p) {
  const t = placeScore(M, p, W());
  const per = M.PEOPLE.map((w, i) => { const s = M.hidden(p.id, w) ? null : M.total(p, W(), w).score; return s == null ? "" : `<span><i class="sw ${i ? "v" : "m"}"></i>${esc(w)} ${fmt(s)}</span>`; }).join("");
  const own = M.ratingsOf(p.id).length, thin = !M.isBase(p) && own && !M.ownEnough(p.id), hid = hiddenWho(M, p.id).length > 0;
  return `<div class="bigscore"><b>${M.isBase(p) ? "3.0" : fmt(t.score)}</b><span class="muted small">${M.isBase(p) ? "точка отсчёта: с ним сравниваем все места" : t.score == null ? "оценок нет" : `из 5, где 3 — как в СПб${own ? "" : hid ? " · пока только мировые данные" : " · только мировые данные"}${thin ? ` · мало своих оценок: ${Math.round(M.ownShare(p.id) * M.STAR_KEYS.length)} из ${M.STAR_KEYS.length} главных вопросов ★, нужно ${Math.ceil(MIN_OWN * M.STAR_KEYS.length)}` : ""}`}</span></div>${per ? `<div class="legend">${per}</div>` : ""}`;
}

function openPlace(id, fly) {
  const M = state.M, p = M.PLACE[id];
  if (!p) return;
  state.sheet = { type: "place", id };
  state.simCandidate = { type: "place", id };
  const rs = M.ratingsOf(p.id).filter(r => r.review && !M.hidden(p.id, r.who)).slice(-3).reverse();
  const hid = hiddenWho(M, p.id);
  const years = yearsLine(M, p.id);
  const vetoR = !M.isBase(p) && M.vetoes().find(r => r.place === p.id);
  const pf = !M.isBase(p) && !M.ratingsOf(p.id).length && state.world.cities ? predictor() : null, city = pf && state.world.placeCity(p), pr = pf && pf({ cc: p.cc, city: city && !city.synthetic ? city : null, lat: p.lat, lon: p.lon });
  openSheet(`<h3 id="sheetTitle" aria-level="2" tabindex="-1">${esc(p.name)}</h3>
    <div class="chips">${p.country ? `<span class="chip">${esc(p.country)}</span>` : ""}<span class="chip">${esc(p.status || "кандидат")}</span>${vetoR ? `<span class="chip warn">вето</span>` : ""}${years ? `<span class="chip" title="Прожили бы здесь год? 0–10">прожили бы год здесь: ${esc(years)}</span>` : ""}${M.isBase(p) ? "" : `<span class="chip">оценок: ${M.ratingsOf(p.id).length + hid.length}</span>`}</div>
    ${scoreLine(M, p)}
    ${hidLine(M, p.id, hid)}
    <div class="btns"><a class="btn" href="${placeHref(p.id)}">Досье</a>${M.isBase(p) ? "" : `<a class="btn ghost" href="#/rate/new/${encodeURIComponent(p.id)}">Оценить</a>`}<button type="button" class="btn ghost" data-act="simplace" data-id="${esc(p.id)}">Похожие</button></div>
    ${pr ? `<p class="small muted">Итог выше — по мировым данным. По похожим оценённым местам${pr.near && pr.near.length ? ` (${esc(pr.near.join(", "))})` : ""} прогноз для нас — ${fmt(pr.score)} из 5, уверенность ${Math.round(pr.conf * 100)}%.</p>` : ""}
    ${p.status === "отсев" ? `<p class="small"><b>Отсев:</b> ${esc(p.reason || "причина не указана")}</p>` : ""}
    ${vetoR ? `<p class="small"><b>Вето ${esc(gen(vetoR.who))}:</b> ${esc(vetoR.veto)}</p>` : ""}
    <div id="simPlaceBox"></div>
    ${rs.map(r => `<div class="review ${r.who === M.PEOPLE[1] ? "v" : "m"}"><b>${esc(r.who)}${r.start ? " · " + esc(datesRu(r.start, r.end)) : ""}:</b> ${esc(r.review)}</div>`).join("")}`);
  if (fly && p.lat != null) state.mapView.flyTo(p.lat, p.lon, 10);
}

function focusPlace(id) {
  go("#/map");
  setTimeout(() => openPlace(id, true), 60);
}

function openCountry(iso, latlng, exact = true) {
  const Wd = state.world, M = state.M;
  state.sheet = { type: "country", iso, latlng, exact };
  const ours = M.places.filter(p => p.cc === iso);
  const visited = visitedBy()[iso];
  if (exact) state.mapView.showTemp(latlng.lat, latlng.lng);
  openSheet(`<h3 id="sheetTitle" aria-level="2" tabindex="-1">${esc(Wd.nameOf(iso))}</h3>
    ${visited ? (() => { const who = [...visited].filter(x => x !== "*"), base = visited.has("*") && (M.places.find(M.isBase) || {}).name; return `<div class="chips"><span class="chip solid">${esc(who.length ? `были: ${who.join(", ")}${base ? ` · база — ${base}` : ""}` : `здесь база — ${base}`)}</span></div>`; })() : ""}
    ${ours.length ? `<div class="small">Наши места: ${ours.map(p => `<a href="${placeHref(p.id)}">${esc(p.name)}</a>`).join(", ")}</div>` : ""}
    <div class="btns"><button type="button" class="btn ghost" data-act="simcountry" data-iso="${iso}">Похожие страны</button>${exact ? `<button type="button" class="btn ghost" data-act="addhere">Найти город в этой точке</button>` : ""}</div>${exact ? "" : `<p class="small muted">Чтобы добавить город, найдите его в поиске или нажмите на него на карте.</p>`}
    <div id="simCountryBox"></div>
    <div class="world">${worldRowsHTML(iso, null, state.layers.country)}</div>`);
}

function showCountry(iso) {
  const f = state.world.geo && state.world.geo.features.find(x => x.properties.iso3 === iso), bb = f && window.L.geoJSON(f).getBounds();
  openCountry(iso, bb ? bb.getCenter() : { lat: 0, lng: 0 }, false);
  if (bb) state.mapView.map[reducedMotion() ? "fitBounds" : "flyToBounds"](bb, { maxZoom: 6, duration: 0.8, animate: !reducedMotion() });
}

function openCity(c, fly) {
  const Wd = state.world;
  state.sheet = { type: "city", city: c };
  state.simCandidate = { type: "city", id: c.id };
  const own = state.M.places.find(p => p.lat != null && haversine(p, c) < 5);
  const ownT = own && !state.M.isBase(own) && state.M.full.ratingsOf(own.id).length ? placeScore(state.M, own, W()) : null;
  const pf = Wd.cities && !ownT ? predictor() : null, pr = pf && pf({ cc: c.cc, city: c });
  openSheet(`<h3 id="sheetTitle" aria-level="2" tabindex="-1">${esc(c.n)}</h3>
    <div class="chips"><span class="chip">${esc(Wd.nameOf(c.cc))}</span>${c.pop ? `<span class="chip">${popRu(c.pop)}</span>` : ""}${c.kg ? `<span class="chip" title="Тип климата по Кёппену">климат: ${esc(kgName(c.kg))}</span>` : ""}</div>
    ${ownT && ownT.score != null ? `<div class="bigscore"><b>${fmt(ownT.score)}</b><span class="muted small">наш итог: из 5, где 3 — как в СПб</span></div>` : pr ? `<div class="bigscore"><b>${fmt(pr.score)}</b><span class="muted small">прогноз для нас: из 5, где 3 — как в СПб · по похожим оценённым местам · уверенность ${Math.round(pr.conf * 100)}%${pr.near && pr.near.length ? ` · ближе всего к: ${esc(pr.near.join(", "))}` : ""}</span></div>` : ""}
    <div class="btns">${own ? `<a class="btn" href="${placeHref(own.id)}">Наше место: ${esc(own.name)}</a>` : `<button type="button" class="btn" data-act="addcity">Добавить как место</button>`}<button type="button" class="btn ghost" data-act="simcity">Похожие города</button></div>
    <div id="simCityBox"></div>
    ${Array.isArray(c.t) ? `<div class="clim">${climateSVG(c, Wd.spbCity)}</div>${climLegend(c.n, Wd.spbCity && Wd.spbCity !== c)}` : ""}
    <div class="world">${worldRowsHTML(c.cc, c)}</div>`);
  state.mapView.showTemp(c.lat, c.lon);
  if (fly) state.mapView.flyTo(c.lat, c.lon, 9);
}

function openGeo(g) {
  state.sheet = { type: "geo", geo: g };
  const iso = state.world.iso3of(g.cc2);
  const city = (state.world.cities || []).find(c => haversine(c, g) < 5);
  state.mapView.showTemp(g.lat, g.lon);
  openSheet(`<h3 id="sheetTitle" aria-level="2" tabindex="-1">${esc(g.name)}</h3>
    <p class="small muted">${esc(g.label)}</p>
    <div class="btns"><button type="button" class="btn" data-act="addgeo">Добавить как место</button>${iso ? `<button type="button" class="btn ghost" data-act="country" data-iso="${iso}">О стране</button>` : ""}${city ? `<button type="button" class="btn ghost" data-city="${city.id}">Климат и похожие</button>` : ""}</div>
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
    toast(r === "queued" ? waitMsg("место", "сохранено") : `Добавлено: ${saved.name}`);
    rebuild();
    state.mapView.clearTemp();
    renderMap();
    openPlace(saved.id, false);
  } catch (err) {
    if (err.code !== "clash") { toast(`Место не добавлено: ${failWhy(err)}. Попробуйте ещё раз ${failWhen(err)}.`); return; }
    rebuild(); renderMap();
    const p = state.M.places.find(x => x.lat != null && haversine(x, info) < 3) || state.M.PLACE[(err.paths || [""])[0].replace(/^places\/|\.json$/g, "")];
    if (p) { toast("Это место уже есть: " + p.name); openPlace(p.id, true); } else toast("Это только что изменили на другом устройстве. Попробуйте ещё раз.");
  }
}

async function onSheetClick(e) {
  const b = e.target.closest("[data-act], [data-city], [data-country]");
  if (e.target.closest("[data-reveal]")) return;
  if (!b) return;
  const Wd = state.world;
  if (b.dataset.city) { const c = Wd.cities.find(x => String(x.id) === b.dataset.city); if (c) openCity(c, true); return; }
  if (b.dataset.country) { showCountry(b.dataset.country); return; }
  const act = b.dataset.act;
  if (act === "introok") { closeSheet(); return; }
  if (act === "addhere") {
    const ll = state.sheet && state.sheet.latlng;
    if (!ll) return;
    b.disabled = true; b.textContent = "Определяю место…";
    try {
      const g = await reverse(ll.lat.toFixed(5), ll.lng.toFixed(5));
      if (!g) { toast("Здесь не нашлось населённого пункта"); b.disabled = false; b.textContent = "Найти город в этой точке"; return; }
      openGeo(Object.assign(g, { lat: Number(ll.lat.toFixed(5)), lon: Number(ll.lng.toFixed(5)) }));
    } catch (err) { toast(err.message); b.disabled = false; b.textContent = "Найти город в этой точке"; }
  } else if (act === "addgeo" || act === "addcity") {
    if (b.disabled) return;
    const label = b.textContent;
    b.disabled = true; b.textContent = "Добавляю…";
    const g = state.sheet.geo, c = state.sheet.city;
    await addPlace(act === "addgeo" ? { name: g.name, country: g.country, cc: Wd.iso3of(g.cc2), lat: g.lat, lon: g.lon, osm: g.osm } : { name: c.n, cc: c.cc, lat: c.lat, lon: c.lon, geonameid: c.id });
    if (b.isConnected) { b.disabled = false; b.textContent = label; }
  } else if (act === "country") {
    const iso = b.dataset.iso; const g = state.sheet.geo;
    openCountry(iso, { lat: g.lat, lng: g.lon });
  } else if (act === "simcountry" || act === "simcity" || act === "simplace") {
    const sheet = state.sheet;
    if (act !== "simcountry") await Wd.loadCities();
    if (state.sheet !== sheet) return;
    const sim = act === "simcountry" ? { act, iso: b.dataset.iso } : act === "simcity" ? { act, city: sheet.city } : { act, id: b.dataset.id };
    sheet.sim = sim;
    showSim(sim, true);
  } else if (act === "simshow" && state.simCandidate) {
    state.layers.simTo = state.simCandidate; state.layers.city = "similar"; state.fitSimilar = true; saveLayers();
    if (innerWidth < 860) closeSheet();
    renderMap();
    toast("На карте: похожие города, ярче — похожее");
  }
}

function revealBox(id) {
  const b = $("sheetBody"), box = $(id);
  if (!box) return;
  $("sheet").classList.remove("peek"); $("sheet").classList.add("full");
  b.scrollTo({ top: Math.max(0, b.scrollTop + box.getBoundingClientRect().top - b.getBoundingClientRect().top - 8), behavior: reducedMotion() ? "auto" : "smooth" });
}

function showSim(sim, reveal) {
  const Wd = state.world;
  if (!state.sim) state.sim = new Similar(Wd, state.schema.groups);
  const preset = presetNames(state.M).includes(state.preset) ? state.preset : "Поровну";
  if (sim.act === "simcountry") { if ($("simCountryBox")) $("simCountryBox").innerHTML = `<h3 class="sim-title">Похожие страны · веса «${esc(preset)}» из «Рейтинга»</h3><p class="small muted">Процент — сходство стран по мировым показателям: цены, медпомощь, безопасность, воздух, свободы. Что важнее — по весам из «Рейтинга».</p>` + similarCountriesHTML(state.sim.similarCountries(sim.iso, W(), 8)); if (reveal) revealBox("simCountryBox"); return; }
  let x, boxId;
  if (sim.act === "simcity") { const c = sim.city; x = { cc: c.cc, city: c, lat: c.lat, lon: c.lon }; state.simCandidate = { type: "city", id: c.id }; boxId = "simCityBox"; }
  else { const p = state.M.PLACE[sim.id]; if (!p) return; const city = Wd.placeCity(p); x = { cc: p.cc, city: city && !city.synthetic ? city : null, lat: p.lat, lon: p.lon }; state.simCandidate = { type: "place", id: p.id }; boxId = "simPlaceBox"; }
  const sp = state.sim.similarSplit(x, W(), { home: 3, abroad: 6 });
  const html = `<h3 class="sim-title">Похожие · веса «${esc(preset)}» из «Рейтинга»</h3><p class="small muted">Процент — сходство: климат по месяцам, размер города, аэропорт, часовой пояс и данные страны. Что важнее — по весам из «Рейтинга».</p>` + similarSplitHTML(sp, x.cc, "h4") + `<div class="btns" style="margin-top:8px"><button type="button" class="btn ghost small" data-act="simshow">Показать все на карте</button></div>`;
  if ($(boxId)) $(boxId).innerHTML = html;
  if (reveal) revealBox(boxId);
}

/* ---------- theme ---------- */
function setTheme(t) {
  local.set("theme", t);
  applyTheme();
}
function applyTheme() {
  const t = local.get("theme", "auto");
  if (t === "auto") document.documentElement.removeAttribute("data-theme"); else document.documentElement.setAttribute("data-theme", t);
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => { if (m.dataset.orig == null) m.dataset.orig = m.content; m.content = t === "auto" ? m.dataset.orig : t === "dark" ? "#181b1e" : "#fdfdfd"; });
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
  const hide = () => { tip.hidden = true; };
  document.addEventListener("pointermove", e => { if (e.pointerType === "mouse") show(e); else hide(); });
  document.addEventListener("pointerdown", show);
  document.addEventListener("pointercancel", hide);
  document.addEventListener("scroll", hide, { capture: true, passive: true });
  addEventListener("hashchange", hide);
}

function initKeyboard() {
  const tall = {}, vv = window.visualViewport;
  const check = () => {
    const w = innerWidth, h = vv ? vv.height : innerHeight, a = document.activeElement;
    tall[w] = Math.max(tall[w] || 0, h);
    const field = !!a && a.matches("textarea, select, input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit])");
    const on = field && h < tall[w] * 0.8, html = document.documentElement;
    if (on === html.classList.contains("typing")) return;
    html.classList.toggle("typing", on);
    if (on) requestAnimationFrame(() => a.scrollIntoView({ block: "center" }));
  };
  addEventListener("resize", check);
  if (vv) vv.addEventListener("resize", check);
  document.addEventListener("focusin", check);
  document.addEventListener("focusout", () => setTimeout(check, 0));
}

/* ---------- boot ---------- */
function initUpdates() {
  if (!("serviceWorker" in navigator)) return;
  let prev = navigator.serviceWorker.controller;
  navigator.serviceWorker.register("sw.js").catch(() => {});
  navigator.serviceWorker.addEventListener("controllerchange", () => { const was = prev; prev = navigator.serviceWorker.controller; if (was) $("updateBar").hidden = false; });
  $("updateLater").addEventListener("click", () => { $("updateBar").hidden = true; });
  $("updateBtn").addEventListener("click", () => {
    const b = $("updateBtn");
    if (state.form) state.form.flush();
    if (state.dirty && !b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Всё равно обновить"; $("updateBar").querySelector("span").textContent = "Правка на этой странице не сохранена и пропадёт при обновлении. Сохраните её или нажмите ещё раз."; return; }
    location.reload();
  });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") navigator.serviceWorker.getRegistration().then(r => r && r.update()).catch(() => {}); });
}

async function boot() {
  state.interrupted = local.get("saving", null);
  local.del("saving");
  initUpdates();
  applyTheme();
  initTips();
  initKeyboard();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
  const cached = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
  if (cached) state.world.loadCities();
  const [schema] = await Promise.all([fetch("schema.json").then(r => r.json()), state.world.load()]);
  if (cached || !/^#\/(rank|places|place|rate|settings)\b/.test(location.hash)) await state.world.geoReady;
  else state.world.geoReady.then(() => { if (window.__booted && !state.dirty && state.route.name !== "rate") rerender(render); });
  state.schema = schema;
  rebuild();
  state.data.addEventListener("change", () => {
    const d = state.data;
    if (d.flushed || d.clashed || d.refused) { const where = state.route.name === "map" ? "Нажмите «Не отправлено» вверху" : "Что делать — в красной плашке"; toast([d.flushed ? "Отправлено из очереди: " + d.flushed : "", d.clashed ? `Не отправлено: ${d.clashed} — это уже поправили на другом устройстве. ${where}` : "", d.refused ? `Не отправлено: ${d.refused} — ${String(d.refusal || "GitHub не принял правку").replace(/\.$/, "")}. ${where}` : ""].filter(Boolean).join(". ")); if (d.flushed) savedNow("sent"); d.flushed = 0; d.clashed = 0; d.refused = 0; }
    rebuild();
    if (state.route.name === "rate") { renderSync(); if (state.form) state.form.setPlaces(state.M.places); if ($("rateBanner")) $("rateBanner").innerHTML = bannerHTML(); openPendingEdit(); }
    else if (state.dirty && (state.route.name === "place" || state.route.name === "settings")) { renderSync(); if ($("placeBanner")) $("placeBanner").innerHTML = bannerHTML(); }
    else rerender(render);
  });
  $("themeBtn").addEventListener("click", () => {
    const order = ["auto", "light", "dark"], t = order[(order.indexOf(local.get("theme", "auto")) + 1) % 3];
    setTheme(t);
    toast("Тема: " + ({ auto: "как в системе", light: "светлая", dark: "тёмная" })[t]);
    if (state.route.name === "settings") rerender(renderSettings);
  });
  $("syncBtn").addEventListener("click", () => { const d = state.data; if (!d.hasToken || d.status === "auth") go("#/settings"); else if (d.limited) toast(`GitHub ограничил запросы до ${hhmmOf(d.limitUntil)}. ${d.queued ? `Ждут ${onDevice()}: ${d.queued} — отправлю сам после этого времени.` : "Обновлю данные сам после этого времени."}`); else if (state.route.name === "map" && state.data.status === "live" && state.data.lost.length) go("#/rank"); else { const h = state.data.head, was = state.data.status; state.data.refresh().then(() => { const M = state.M; if (state.data.status === "live" && was === "live") toast(state.data.head !== h ? `Данные обновлены: мест ${M.places.filter(p => !M.isBase(p)).length}, оценок ${ratingCount(M)}` : "Данные актуальны: нового нет"); }); } });
  document.addEventListener("click", e => {
    if (e.target.closest("[data-dismiss-notice]")) { state.data.notice = ""; state.data.emit(); return; }
    const bk = e.target.closest("[data-back]");
    if (bk && state.backTo && history.state && history.state.wtl === state.backHist) { e.preventDefault(); history.back(); return; }
    const ur = e.target.closest("[data-unreveal]");
    if (ur) { state.revealed.delete(ur.dataset.unreveal); local.set("revealed", [...state.revealed]); rebuild(); rerender(render); return; }
    const rv = e.target.closest("[data-reveal]");
    if (rv) {
      const kb = e.detail === 0 || document.activeElement === rv, who = hiddenWho(state.M, rv.dataset.reveal);
      state.revealed.add(rv.dataset.reveal); local.set("revealed", [...state.revealed]); rebuild(); rerender(render);
      if (who.length) toast(`${who.length > 1 ? "Оценки" : "Оценка"} ${who.map(gen).join(" и ")} ${who.length > 1 ? "открыты" : "открыта"}. Скрыть снова можно в досье места.`);
      const a = document.activeElement;
      if (kb && (!a || a === document.body)) { const t = state.route.name === "map" ? $("sheetTitle") : document.querySelector(".view:not([hidden]) .trip"); if (t) { if (!t.hasAttribute("tabindex")) t.tabIndex = -1; t.focus({ preventScroll: true }); } }
      return;
    }
    const sm = e.target.closest("[data-setme]");
    if (sm) { setMe(sm.dataset.setme); rerender(render); toast("Это устройство: " + sm.dataset.setme); return; }
    const la = e.target.closest("[data-lostapply]");
    if (la) {
      la.closest(".lost").querySelectorAll("button").forEach(b => { b.disabled = true; });
      const again = (state.data.lost[Number(la.dataset.lostapply)] || {}).why === "rejected";
      state.data.applyLost(Number(la.dataset.lostapply)).then(r => { if (!r) return; savedNow(r); toast(r === "queued" ? waitMsg("правка", "сохранена") : again ? "Отправлено" : "Записано поверх"); }).catch(err => { toast(err.code === "clash" ? "Снова изменили на другом устройстве — данные обновлены, нажмите «Записать мою» ещё раз" : err.message); state.data.emit(); });
      return;
    }
    const ld = e.target.closest("[data-lostdrop]");
    if (ld) {
      if (Number(ld.dataset.armed || 0) > Date.now() - 5000) { state.data.dropLost(Number(ld.dataset.lostdrop)); return; }
      ld.dataset.armed = Date.now();
      ld.textContent = "Точно выбросить? Нажмите ещё раз";
      setTimeout(() => { if (ld.isConnected) { ld.textContent = "Выбросить"; delete ld.dataset.armed; } }, 5000);
    }
  });
  addEventListener("hashchange", () => route());
  $("skipLink").addEventListener("click", e => { e.preventDefault(); if (state.route.name === "map" && state.sheet) focusSheet(); else focusView(); });
  document.addEventListener("click", e => { const a = e.target.closest("a[data-nav]"); if (a && a.getAttribute("href") === location.hash) { e.preventDefault(); route(true); } });
  if (!/^#\/(rank|places|place|rate|settings)\b/.test(location.hash)) await leafletReady;
  const early = cached && /^#\/(rank|places|place)\b/.test(location.hash);
  if (early) { await state.world.loadCities(); state.sim = null; rebuild(); }
  route();
  window.__booted = true;
  if (!early) state.world.loadCities().then(() => { state.sim = null; rebuild(); if (!["rate", "settings"].includes(state.route.name) && !state.dirty) rerender(render); });
  setInterval(() => { if (document.visibilityState === "visible") state.data.poll(); }, 60000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") state.data.poll(); });
  if (state.data.hasToken) await state.data.refresh();
}

boot().catch(err => {
  if (window.__booted) { console.error(err); return; }
  window.__booted = true;
  $("bootNote")?.remove();
  console.error(err);
  document.getElementById("main").insertAdjacentHTML("afterbegin", `<div class="page" id="bootFail"><div class="banner err"><b>Не удалось загрузить приложение:</b> нет связи с сайтом или файл пришёл с ошибкой. Проверьте интернет и попробуйте ещё раз.</div><div class="btns"><button type="button" class="btn" id="bootRetry">Попробовать ещё раз</button></div></div>`);
  $("bootRetry").addEventListener("click", () => location.reload());
});

export { state, uid, SHORT, toScore };
