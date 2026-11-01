import { $, esc, local, daysBetween, uid, plural, todayISO } from "./util.js";

const HALF = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];
export const CONF = { A: "проверили в быту", B: "видели как туристы", C: "со слов живущих", D: "по сайтам и рейтингам" };
export const MODE_LABEL = { "отпуск": "не работали", "удалёнка": "работали все будни", "смешанно": "работали часть дней" };
const emptyForm = (who = local.get("me", "")) => ({ id: null, createdAt: null, who, place: "", start: "", end: "", season: "", mode: "", housing: "", retro: false, year: null, veto: "", review: "", surprises: "", questions: "", scores: {}, conf: {}, notes: {}, draftId: null, stamp: null, _oid: null });
const cap = s => String(s).charAt(0).toUpperCase() + String(s).slice(1);
const keyOf = f => (f.id ? "edit:" + f.id : f.place || "_new");
const snap = f => JSON.stringify(Object.assign({}, f, { _orig: undefined, _oid: undefined, _was: undefined }));
const FIELDS = ["start", "end", "days", "season", "mode", "housing", "retro", "year", "veto", "review", "surprises"];
const same = (a, b) => JSON.stringify(a == null || a === "" ? null : a) === JSON.stringify(b == null || b === "" ? null : b);
function diff(body, was) {
  const patch = {}, base = {};
  FIELDS.forEach(k => { if (!same(body[k], was[k])) { patch[k] = body[k]; base[k] = was[k] == null ? null : was[k]; } });
  ["scores", "conf", "notes"].forEach(g => new Set(Object.keys(body[g] || {}).concat(Object.keys(was[g] || {}))).forEach(k => { const a = (body[g] || {})[k], b = (was[g] || {})[k]; if (!same(a, b)) { patch[g + "." + k] = a == null ? null : a; base[g + "." + k] = b == null ? null : b; } }));
  patch.deleted = false; base.deleted = was.deleted == null ? null : was.deleted;
  return { patch, base };
}
const changed = f => !f.id || f._orig !== snap(f);
const hasContent = f => Object.keys(f.scores).length > 0 || f.year != null || !!(f.start || f.end || f.season || f.mode || f.housing) || !!(f.review.trim() || f.surprises.trim() || f.veto.trim() || (f.questions || "").trim()) || Object.values(f.notes).some(v => v && v.trim());
const numRu = v => String(v).replace(".", ",");
const numDot = v => String(v);
const hintText = h => h.replace(/уверенность ([ABCD])/g, (m, l) => `откуда знаем: «${CONF[l]}»`);

export function datesRu(start, end) {
  const M = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  const p = s => { const [y, m, d] = String(s).split("-").map(Number); return { y, m, d }; };
  if (!start) return "";
  const ok = s => /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(String(s));
  if (!ok(start) || (end && !ok(end))) return [start, end].filter(Boolean).join(" – ");
  const a = p(start);
  if (!end || end === start) return `${a.d} ${M[a.m - 1]} ${a.y}`;
  const b = p(end);
  if (a.y === b.y && a.m === b.m) return `${a.d}–${b.d} ${M[a.m - 1]} ${a.y}`;
  if (a.y === b.y) return `${a.d} ${M[a.m - 1]} – ${b.d} ${M[b.m - 1]} ${a.y}`;
  return `${a.d} ${M[a.m - 1]} ${a.y} – ${b.d} ${M[b.m - 1]} ${b.y}`;
}

export function ratingField(schema, k, v) {
  const [a, b] = String(k).split(".");
  if (["days", "createdAt", "updatedAt", "id", "place", "who"].includes(a)) return null;
  const empty = v == null || v === "", s = String(v);
  const text = x => `«${String(x).length > 60 ? String(x).slice(0, 60) + "…" : x}»`;
  const cat = key => (schema.cats.find(c => c.key === key) || {}).name || key;
  if (a === "scores") return { name: cat(b), value: empty ? "без оценки" : s };
  if (a === "conf") return { name: `Откуда знаем (${cat(b)})`, value: `«${CONF[v] || CONF.B}»` };
  if (a === "notes") return { name: `Комментарий: ${(schema.groups.find(g => g.key === b) || {}).name || b}`, value: empty ? "пусто" : text(v) };
  if (a === "start" || a === "end") return { name: a === "start" ? "Приехали" : "Уехали", value: empty ? "пусто" : datesRu(s) };
  if (a === "retro") return { name: "Когда оценивали", value: v ? "по памяти" : "сразу после поездки" };
  if (a === "year") return { name: "Год здесь", value: empty ? "пусто" : `${s}/10` };
  if (a === "mode") return { name: "Работа", value: empty ? "пусто" : text(MODE_LABEL[v] || v) };
  if (a === "deleted") return { name: "Оценка", value: v ? "удалена" : "не удалена" };
  const NAMES = { review: "Отзыв", veto: "Вето", surprises: "Сюрпризы", season: "Сезон", housing: "Жильё" };
  return { name: NAMES[a] || k, value: empty ? "пусто" : typeof v === "string" ? text(v) : s };
}

function theirText(schema, theirs) {
  const items = (theirs || []).map(([k, v]) => ratingField(schema, k, v)).filter(Boolean).map(x => `${x.name} — ${x.value}`);
  return items.length ? ` (там: ${items.join("; ")})` : "";
}

export class RateForm {
  constructor(el, schema, hooks) {
    this.el = el;
    this.schema = schema;
    this.hooks = hooks;
    this.PEOPLE = schema.people;
    this.STAR_KEYS = schema.cats.filter(c => c.star && c.form).map(c => c.key);
    this.GROUPS = schema.groups.map(g => ({ g, cats: schema.cats.filter(c => c.group === g.key && c.form).sort((a, b) => Number(b.star) - Number(a.star) || Number(!!a.opt) - Number(!!b.opt)) })).filter(x => x.cats.length);
    this.form = Object.assign(emptyForm(), local.get("draft", {}));
    this.drafts = local.get("drafts", {});
    this.restored = !this.form.id && hasContent(this.form);
    this.onlyStar = local.get("onlyStar", true);
    this.armed = "";
    this.confOpen = null;
    this.notesOpen = new Set();
    this.shown = new Set();
    this.saving = false;
    this.places = [];
    this.timer = null;
    this.build();
  }

  saveDraft() { clearTimeout(this.timer); this.timer = setTimeout(() => { this.timer = null; this.stored(local.set("draft", this.form)); }, 300); }

  flush() { if (!this.timer) return; clearTimeout(this.timer); this.timer = null; this.stored(local.set("draft", this.form)); }

  own(d) { const me = local.get("me", ""); return d && (!me || !d.who || d.who === me) ? d : null; }

  forWho(who) {
    const f = this.form;
    if (f.who === who) return;
    if (f.who && (f.id || hasContent(f))) this.switchTo(emptyForm(who));
    else if (f.place && this.drafts[f.place] && this.drafts[f.place].who === who) this.switchTo(this.drafts[f.place]);
    else { f.who = who; this.persist(); this.sync(); }
  }

  persist() { this.stored(local.set("draft", this.form) && local.set("drafts", this.drafts)); }

  stored(ok) { if (ok === !this.full) return; this.full = !ok; this.sync(); }

  stash() {
    const f = this.form, k = keyOf(f);
    if (hasContent(f) && changed(f)) this.drafts[this.drafts[k] && this.drafts[k] !== f ? k + "~" + Date.now().toString(36) : k] = f;
    else this.drop(f);
  }

  drop(f) { Object.keys(this.drafts).forEach(k => { if (this.drafts[k] === f) delete this.drafts[k]; }); }

  switchTo(next) {
    this.restored = false;
    this.stash();
    this.form = next;
    this.drop(next);
    this.armed = ""; this.confOpen = null; this.notesOpen.clear(); this.shown.clear();
    this.persist();
    this.setPlaces(this.places);
    this.msg("");
  }

  reset() {
    this.form = emptyForm();
    this.drafts = {};
    this.armed = ""; this.confOpen = null; this.notesOpen.clear(); this.shown.clear();
    this.persist();
    this.sync();
  }

  build() {
    const O = this.schema.options;
    const seg = (name, values, label = v => v) => values.map(v => `<button type="button" data-opt="${name}" data-val="${esc(v)}" aria-pressed="false">${esc(label(v))}</button>`).join("");
    const extra = this.schema.cats.filter(c => c.form && !c.star).length;
    let html = `<h1>Оценить поездку</h1><div id="fTop"></div><div class="panel fcard">
      <h2>Кто и где</h2>
      <div class="help"><span>Каждый оценивает сам, не глядя в оценки другого. Пропускайте то, что не проверили: пустой ответ лучше догадки.</span><span><b>Шкала 1–5 относительно СПб:</b> 1 — сильно хуже, 3 — как в СПб, 5 — сильно лучше для нас: тише, чище, безопаснее.</span><span>Аренду и цены здесь не спрашиваем: их вписывают в «Цифры места» в досье.</span></div>
      <div class="field"><span class="lbl">Кто оценивает</span><div class="seg" role="group" aria-label="Кто оценивает" id="fWho">${this.PEOPLE.map(w => `<button type="button" data-who="${esc(w)}" aria-pressed="false">${esc(w)}</button>`).join("")}</div><span class="small muted" id="fWhoNote" hidden></span></div>
      <div class="field"><label class="lbl" for="fPlace">Место</label><select id="fPlace"></select><span class="small muted" id="fPlaceHint">Нет в списке — <a href="#/map">найдите на карте</a>, откройте карточку и нажмите «Добавить как место».</span></div>
      <div class="frow">
        <label class="field" for="fStart"><span class="lbl">Приехали</span><input type="date" id="fStart"></label>
        <label class="field" for="fEnd"><span class="lbl">Уехали</span><input type="date" id="fEnd"></label>
      </div>
      <div class="field"><span class="lbl">Сезон</span><div class="seg" role="group" aria-label="Сезон">${seg("season", O.season, cap)}</div><span class="small muted">Пик — когда едут все (для моря — лето). Худший — самое неудобное время. Межсезон — между ними. Худший сезон весит вдвое, межсезон — в полтора раза: так виднее обычная жизнь.</span></div>
      <div class="field"><span class="lbl">Работали из поездки?</span><div class="seg" role="group" aria-label="Работали из поездки">${seg("mode", O.mode, v => cap(MODE_LABEL[v] || v))}</div><span class="small muted">Рабочие будни показывают обычную жизнь, поэтому такая поездка весит больше.</span></div>
      <div class="field"><span class="lbl">Где жили</span><div class="seg" role="group" aria-label="Где жили">${seg("housing", O.housing, cap)}</div><span class="small muted">Жилой район — где живут местные, центр — главные улицы, туристическая зона — набережная и отели. Объясняет шум, цены и пустые улицы зимой.</span></div>
      <label class="toggle" for="fRetro"><input type="checkbox" id="fRetro"> По памяти: поездка закончилась больше месяца назад (такая оценка весит меньше)</label>
      <label class="toggle" for="fOnlyStar"><input type="checkbox" id="fOnlyStar"> Только главные вопросы ★ (${this.STAR_KEYS.length})</label>
      <span class="small muted">Остальные вопросы — по желанию: отвечайте, если было что проверить.</span>
    </div>`;
    this.GROUPS.forEach(({ g, cats }) => {
      html += `<div class="panel fcard" data-group="${g.key}"><h2>${esc(g.name)} <span class="gcount" id="gc-${g.key}"></span></h2><div>`;
      cats.forEach(c => {
        const vals = HALF.filter(v => v <= (c.cap || 5));
        const ends = c.cap ? `<span>сильно хуже</span><span></span><span>как СПб</span>` : `<span>хуже СПб</span><span>как СПб</span><span>лучше</span>`;
        html += `<div class="q${c.cap ? " capped" : ""}" data-q="${c.key}" data-star="${c.star ? 1 : 0}">
          <div class="q-head"><span class="q-name">${c.star ? "★ " : ""}${esc(c.name)}</span><span class="q-val" data-qval="${c.key}"></span></div>
          ${c.hint ? `<span class="q-hint">${esc(hintText(c.hint))}</span>` : ""}
          <div class="pick" role="group" aria-label="${esc(c.name)}" style="--n:${vals.length}">${vals.map(v => `<button type="button" class="${v % 1 ? "half" : ""}" data-score="${c.key}" data-v="${v}" aria-label="${numRu(v)}" aria-pressed="false">${v % 1 ? Math.floor(v) + "½" : v}</button>`).join("")}</div>
          <div class="pick-ends" aria-hidden="true">${ends}</div>
          <div class="conf-line"><button type="button" class="conf" data-conf="${c.key}" aria-expanded="false"></button></div>
          <div class="conf-pick" data-confpick="${c.key}" role="group" aria-label="Откуда знаем" hidden>${Object.keys(CONF).map(l => `<button type="button" data-confset="${c.key}" data-l="${l}" aria-pressed="false">${CONF[l]}</button>`).join("")}<span class="small muted">Откуда знаем: жили этим сами (снимали жильё, ходили к врачу) — «в быту»; сами не видели — «со слов живущих» или «по сайтам».</span></div>
        </div>`;
      });
      html += `</div><button type="button" class="linkbtn small addnote" data-addnote="${g.key}">+ комментарий: ${esc(g.name)}</button><label class="field" for="note-${g.key}" data-notebox="${g.key}" hidden><span class="lbl">Комментарий: что видели, почему такие баллы</span><textarea id="note-${g.key}" data-note="${g.key}" rows="2"></textarea></label></div>`;
    });
    html += `<button type="button" class="btn ghost wide" id="fShowAll" hidden>Показать остальные вопросы (ещё ${extra}, по желанию)</button>
    <div class="panel fcard"><h2>В целом</h2>
      <div class="field"><span class="lbl">Прожили бы здесь год? Отдельная шкала 0–10: 0 — ни за что, 10 — хоть завтра</span><div class="pick y" role="group" aria-label="Год здесь">${Array.from({ length: 11 }, (_, i) => `<button type="button" data-year="${i}" aria-pressed="false">${i}</button>`).join("")}</div></div>
      <label class="field" for="fReview"><span class="lbl">Отзыв в двух-трёх фразах (виден в досье места и на карте; второй из вас увидит его после своей оценки)</span><textarea id="fReview" rows="3"></textarea></label>
      <label class="field" for="fSurprises"><span class="lbl">Сюрпризы: что оказалось не так, как ждали</span><textarea id="fSurprises" rows="2"></textarea></label>
      <label class="field" for="fQuestions"><span class="lbl">Вопросы к следующей поездке (допишутся в карточку места и сразу видны обоим)</span><textarea id="fQuestions" rows="2"></textarea><span class="small muted" id="fQuestionsNow" hidden></span></label>
      <label class="field" for="fVeto"><span class="lbl">Вето: место убирается из рейтинга для обоих, потому что…</span><input type="text" id="fVeto" autocomplete="off" placeholder="оставьте пустым, если вето нет"></label>
    </div>
    <div class="panel fcard"><div class="btns">
      <button type="button" class="btn ghost" id="fReset">Очистить форму</button>
      <button type="button" class="btn ghost" id="fCancel" hidden>Отменить правку</button>
      <button type="button" class="btn ghost" id="fDeleteNo" hidden>Не удалять</button>
      <button type="button" class="btn danger" id="fDelete" hidden>Удалить оценку</button>
    </div></div>
    <div class="savebar">
      <span class="counts" id="fCounts" aria-live="off"></span>
      <span class="msg" id="fMsg" role="status"></span>
      <span class="msg" id="fNoKey" hidden>Сохранять можно после того, как <a href="#/settings">подключите данные в настройках</a>.</span>
      <button type="submit" class="btn" id="fSave">Сохранить</button>
    </div>`;
    this.el.innerHTML = html;
    this.el.addEventListener("click", e => this.onClick(e));
    addEventListener("pagehide", () => this.flush());
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") this.flush(); });
    this.el.addEventListener("input", e => this.onInput(e));
    this.el.addEventListener("change", e => this.onInput(e));
    this.el.addEventListener("submit", e => { e.preventDefault(); this.save(); });
    this.el.addEventListener("keydown", e => this.onKey(e));
  }

  onKey(e) {
    const t = e.target;
    if (e.key === "Enter" && t.tagName === "INPUT") { e.preventDefault(); return; }
    if (e.key === "Escape" && this.confOpen) { const k = this.confOpen; this.confOpen = null; this.sync(); this.el.querySelector(`[data-conf="${CSS.escape(k)}"]`).focus({ preventScroll: true }); e.preventDefault(); return; }
    const pick = t.closest && t.closest(".pick");
    if (!pick || t.tagName !== "BUTTON") return;
    const bs = [...pick.querySelectorAll("button")], i = bs.indexOf(t);
    const j = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: bs.length - 1 }[e.key];
    if (j == null) return;
    e.preventDefault();
    const b = bs[Math.max(0, Math.min(bs.length - 1, j))];
    bs.forEach(x => { x.tabIndex = x === b ? 0 : -1; });
    b.focus();
  }

  arm(name) {
    if (this.armed === name) { this.armed = ""; return true; }
    this.armed = name; this.sync();
    setTimeout(() => { if (this.armed === name) { this.armed = ""; this.sync(); } }, 5000);
    return false;
  }

  showAll() {
    const before = new Set([...this.el.querySelectorAll("[data-q]:not([hidden])")].map(q => q.dataset.q));
    this.onlyStar = false; local.set("onlyStar", false); this.shown.clear(); this.sync();
    const first = [...this.el.querySelectorAll("[data-q]")].find(q => !q.hidden && !q.closest("[hidden]") && !before.has(q.dataset.q));
    if (first) first.scrollIntoView({ block: "center" });
  }

  onClick(e) {
    const b = e.target.closest("button");
    if (!b || b.type === "submit") return;
    const f = this.form;
    if (b.id === "fReset") {
      if (!this.arm("reset")) return;
      this.restored = false;
      this.form = Object.assign(emptyForm(f.who), { id: f.id, createdAt: f.createdAt, place: f.place, _oid: f._oid, _orig: f._orig });
      this.persist(); this.sync(); this.msg("Форма очищена");
      return;
    }
    if (b.id === "fCancel") { this.drop(f); this.form = emptyForm(f.who); this.armed = ""; this.persist(); this.setPlaces(this.places); this.msg("Правка отменена"); return; }
    if (b.id === "fNew") { this.switchTo(this.drafts._new || emptyForm(f.who)); window.scrollTo(0, 0); return; }
    if (b.id === "fDelete") { this.remove(); return; }
    if (b.id === "fDeleteNo") { this.armed = ""; this.sync(); $("fDelete").focus(); return; }
    if (b.id === "fShowAll") { this.showAll(); return; }
    if (b.dataset.addnote) { this.notesOpen.add(b.dataset.addnote); this.sync(); const t = $("note-" + b.dataset.addnote); t.focus({ preventScroll: true }); t.scrollIntoView({ block: "nearest" }); return; }
    if (b.dataset.draft) { const d = this.drafts[b.dataset.draft]; if (d) this.switchTo(d); window.scrollTo(0, 0); return; }
    if (b.dataset.dropdraft) {
      if (!this.arm("drop:" + b.dataset.dropdraft)) return;
      delete this.drafts[b.dataset.dropdraft]; this.persist(); this.sync(); return;
    }
    if (b.dataset.editrating) { this.hooks.edit(b.dataset.editrating); return; }
    this.msg("");
    if (b.dataset.who) { if (f.id) return; f.who = b.dataset.who; }
    else if (b.dataset.opt) f[b.dataset.opt] = f[b.dataset.opt] === b.dataset.val ? "" : b.dataset.val;
    else if (b.dataset.score) {
      const k = b.dataset.score, v = Number(b.dataset.v);
      if (f.scores[k] === v) { delete f.scores[k]; delete f.conf[k]; if (this.confOpen === k) this.confOpen = null; } else f.scores[k] = v;
    } else if (b.dataset.conf) {
      this.confOpen = this.confOpen === b.dataset.conf ? null : b.dataset.conf;
    } else if (b.dataset.confset) {
      const k = b.dataset.confset;
      if (b.dataset.l === "B") delete f.conf[k]; else f.conf[k] = b.dataset.l;
      this.confOpen = null;
      this.saveDraft(); this.sync();
      this.el.querySelector(`[data-conf="${CSS.escape(k)}"]`).focus({ preventScroll: true });
      return;
    } else if (b.dataset.year) {
      const v = Number(b.dataset.year);
      f.year = f.year === v ? null : v;
    } else return;
    this.saveDraft(); this.sync();
    if (b.dataset.conf && this.confOpen) this.el.querySelector(`[data-confpick="${CSS.escape(this.confOpen)}"]`).scrollIntoView({ block: "nearest" });
  }

  pickPlace(id) {
    const f = this.form;
    if (f.id || id === f.place) return;
    if (!hasContent(f)) { this.switchTo(this.own(this.drafts[id]) || Object.assign(emptyForm(f.who), { place: id })); return; }
    if (this.restored && f.place) { const was = this.hooks.placeName(f.place) || "прошлое место"; this.switchTo(this.own(this.drafts[id]) || Object.assign(emptyForm(f.who), { place: id })); this.msg(`Ответы про ${was} остались в черновике — он вверху, в «Несохранённых черновиках».`); return; }
    if (this.drafts[id] && this.drafts[id] !== f && this.own(this.drafts[id])) { this.drafts[id + "~" + Date.now().toString(36)] = this.drafts[id]; delete this.drafts[id]; }
    this.drop(f);
    f.place = id;
    this.persist();
  }

  onInput(e) {
    const t = e.target, f = this.form;
    if (t.dataset.note) f.notes[t.dataset.note] = t.value;
    else if (t.id === "fPlace") { if (e.type !== "change") return; this.msg(""); this.pickPlace(t.value); this.saveDraft(); this.sync(); return; }
    else if (t.id === "fStart") f.start = t.value;
    else if (t.id === "fEnd") { f.end = t.value; if (f.end) { const ref = f.id && f.createdAt ? Date.parse(f.createdAt) : Date.now(); f.retro = (ref - new Date(f.end).getTime()) / 864e5 > 31; } }
    else if (t.id === "fRetro") f.retro = t.checked;
    else if (t.id === "fVeto") f.veto = t.value;
    else if (t.id === "fReview") f.review = t.value;
    else if (t.id === "fSurprises") f.surprises = t.value;
    else if (t.id === "fQuestions") f.questions = t.value;
    else if (t.id === "fOnlyStar") { if (!t.checked) { this.showAll(); return; } this.onlyStar = true; local.set("onlyStar", true); this.shown.clear(); }
    else return;
    if (e.type === "change" || t.tagName === "SELECT") this.msg("");
    this.saveDraft(); this.sync();
  }

  setPlaces(places) {
    this.places = places.filter(p => p.status !== "база");
    const sel = $("fPlace");
    const opts = this.places.slice().sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "ru"));
    sel.innerHTML = `<option value="">— выберите —</option>` + opts.map(p => `<option value="${esc(p.id)}">${esc(p.name)}${p.country ? " · " + esc(p.country) : ""}${p.status === "отсев" ? " · отсев" : ""}</option>`).join("");
    sel.value = this.form.place;
    const note = !this.places.length && this.hooks.emptyNote ? this.hooks.emptyNote() : true;
    $("fPlaceHint").innerHTML = note === true ? `Нет в списке — <a href="#/map">найдите на карте</a>, откройте карточку и нажмите «Добавить как место».` : note ? esc(note) : `Места появятся после подключения данных: вставьте ключ в <a href="#/settings">настройках</a>.`;
    this.sync();
  }

  startFor(placeId) {
    const mine = this.own(this.drafts[placeId]);
    if (!this.form.id && this.form.place === placeId && !(mine && mine !== this.form && !hasContent(this.form))) return this.setPlaces(this.places);
    if (!this.form.id && !this.form.place && hasContent(this.form) && !this.own(this.drafts[placeId])) { this.form.place = placeId; this.persist(); return this.setPlaces(this.places); }
    this.switchTo(this.own(this.drafts[placeId]) || Object.assign(emptyForm(this.form.who), { place: placeId }));
  }

  startNew() {
    const f = this.form;
    if (!f.id || (hasContent(f) && changed(f))) return this.setPlaces(this.places);
    this.switchTo(this.own(this.drafts._new) || emptyForm(f.who));
  }

  load(r, oid) {
    if (this.form.id === r.id && (!oid || !this.form._oid || oid === this.form._oid)) return this.setPlaces(this.places);
    if (this.form.id === r.id) { if (changed(this.form)) this.drafts["edit:" + r.id + "~" + Date.now().toString(36)] = this.form; this.form = emptyForm(this.form.who); }
    const key = "edit:" + r.id, draft = this.drafts[key];
    if (draft && oid && draft._oid && oid !== draft._oid) {
      delete this.drafts[key];
      if (changed(draft)) this.drafts[key + "~" + Date.now().toString(36)] = draft;
    } else if (draft) { draft._oid = oid || draft._oid || null; return this.switchTo(draft); }
    const f = Object.assign(emptyForm(), {
      id: r.id, createdAt: r.createdAt || null, who: r.who, place: r.place, start: r.start || "", end: r.end || "",
      season: r.season || "", mode: r.mode || "", housing: r.housing || "", retro: !!r.retro, year: r.year == null ? null : r.year,
      veto: r.veto || "", review: r.review || "", surprises: r.surprises || "",
      scores: Object.assign({}, r.scores), conf: Object.assign({}, r.conf), notes: Object.assign({}, r.notes),
    });
    f._oid = oid || null;
    f._was = structuredClone(r);
    f._orig = snap(f);
    this.switchTo(f);
  }

  topHTML() {
    const f = this.form, H = this.hooks;
    let html = "";
    const others = Object.keys(this.drafts).filter(k => this.drafts[k] !== f && hasContent(this.drafts[k]) && this.own(this.drafts[k]));
    if (others.length) html += `<div class="banner drafts"><b>Несохранённые черновики:</b> ${others.map(k => { const d = this.drafts[k]; const n = Object.keys(d.scores).length; const armed = this.armed === "drop:" + k; return `<span class="draft-chip"><button type="button" class="linkbtn" data-draft="${esc(k)}">${d.id ? "правка: " : ""}${esc(H.placeName(d.place) || "без места")}${n ? ` (${n} ${plural(n, "ответ", "ответа", "ответов")})` : ""}</button><button type="button" class="chipx${armed ? " armed" : ""}" data-dropdraft="${esc(k)}" aria-label="Выбросить черновик: ${esc(H.placeName(d.place) || "без места")}">${armed ? "Выбросить?" : "×"}</button></span>`; }).join("")}</div>`;
    if (this.full) html += `<div class="banner err">Память браузера на этом устройстве переполнена: ответы не сохраняются и пропадут, если закрыть приложение. Нажмите «Сохранить», чтобы отправить оценку.</div>`;
    if (this.restored && !f.id && hasContent(f)) { const n = Object.keys(f.scores).length; html += `<div class="banner">Черновик — ещё не сохранён${f.place ? ": " + esc(H.placeName(f.place) || "место") : ""}${n ? `, ${n} ${plural(n, "ответ", "ответа", "ответов")}` : ""}. Допишите и нажмите «Сохранить» или «Очистить форму».</div>`; }
    if (f.id) html += `<div class="edit-head"><span>Правка оценки: <b>${esc(H.placeName(f.place) || "место удалено из данных")}</b> · ${esc(f.who)}${f.start ? " · " + esc(datesRu(f.start, f.end)) : ""}</span><button type="button" class="btn ghost small" id="fNew">Новая оценка</button></div>${H.placeName(f.place) ? "" : `<div class="banner err">Места этой оценки больше нет в данных, поэтому её нельзя пересохранить — только удалить.</div>`}`;
    else if (f.place && f.who) {
      const mine = H.myRating(f.place, f.who);
      if (mine) html += `<div class="banner">У вас уже есть оценка этого места${mine.start ? " за " + esc(datesRu(mine.start, mine.end)) : ""}. Если это новая поездка, заполняйте дальше. Если та же — <button type="button" class="linkbtn" data-editrating="${esc(mine.id)}">исправьте прежнюю</button>.</div>`;
    }
    return html;
  }

  sync() {
    const el = this.el, f = this.form;
    const setVal = (id, v) => { const x = $(id); if (x && x.value !== v) x.value = v; };
    $("fTop").innerHTML = this.topHTML();
    el.querySelectorAll("[data-who]").forEach(b => { b.setAttribute("aria-pressed", String(b.dataset.who === f.who)); b.disabled = !!f.id; });
    const me = local.get("me", ""), wn = $("fWhoNote");
    wn.textContent = f.id ? "Автора правки не меняют. Если оценку записали не на того — удалите её и оцените заново." : me && f.who && f.who !== me ? `Оценка запишется на имя «${f.who}», хотя на этом устройстве оценивает ${me}. Если оцениваете за себя — нажмите своё имя.` : "";
    wn.hidden = !wn.textContent;
    const qn = $("fQuestionsNow"), qs = f.place && this.hooks.placeQuestions ? this.hooks.placeQuestions(f.place) : "";
    qn.textContent = qs ? "Уже в карточке: " + qs : "";
    qn.hidden = !qs;
    el.querySelectorAll("[data-opt]").forEach(b => b.setAttribute("aria-pressed", String(f[b.dataset.opt] === b.dataset.val)));
    el.querySelectorAll("[data-score]").forEach(b => b.setAttribute("aria-pressed", String(f.scores[b.dataset.score] === Number(b.dataset.v))));
    el.querySelectorAll("[data-qval]").forEach(s => { const v = f.scores[s.dataset.qval]; s.textContent = v == null ? "" : numDot(v); });
    el.querySelectorAll("[data-conf]").forEach(b => {
      const k = b.dataset.conf, l = f.conf[k] || "B";
      b.style.visibility = f.scores[k] == null ? "hidden" : "visible";
      b.textContent = "откуда знаем: " + CONF[l];
      b.classList.toggle("set", l !== "B");
      b.setAttribute("aria-expanded", String(this.confOpen === k));
    });
    el.querySelectorAll("[data-confpick]").forEach(d => { const k = d.dataset.confpick; d.hidden = this.confOpen !== k || f.scores[k] == null; });
    el.querySelectorAll("[data-confset]").forEach(b => b.setAttribute("aria-pressed", String((f.conf[b.dataset.confset] || "B") === b.dataset.l)));
    el.querySelectorAll("[data-year]").forEach(b => b.setAttribute("aria-pressed", String(f.year === Number(b.dataset.year))));
    el.querySelectorAll(".pick").forEach(p => { const bs = [...p.querySelectorAll("button")], on = bs.find(b => b.getAttribute("aria-pressed") === "true") || (bs.includes(document.activeElement) ? document.activeElement : bs[0]); bs.forEach(b => { b.tabIndex = b === on ? 0 : -1; }); });
    Object.keys(f.scores).forEach(k => this.shown.add(k));
    el.querySelectorAll("[data-q]").forEach(q => { q.hidden = this.onlyStar && q.dataset.star !== "1" && !this.shown.has(q.dataset.q); });
    this.GROUPS.forEach(({ g, cats }) => {
      const vis = cats.filter(c => !this.onlyStar || c.star || this.shown.has(c.key));
      const note = (f.notes[g.key] || "").trim();
      el.querySelector(`[data-group="${g.key}"]`).hidden = !vis.length && !note;
      $("gc-" + g.key).textContent = vis.length ? `· ${vis.filter(c => f.scores[c.key] != null).length} из ${vis.length}` : "";
      const open = !!note || this.notesOpen.has(g.key);
      el.querySelector(`[data-notebox="${g.key}"]`).hidden = !open;
      el.querySelector(`[data-addnote="${g.key}"]`).hidden = open;
    });
    $("fShowAll").hidden = !this.onlyStar;
    el.querySelectorAll("[data-note]").forEach(t => { const v = f.notes[t.dataset.note] || ""; if (t.value !== v) t.value = v; });
    setVal("fPlace", f.place);
    $("fPlace").disabled = !!f.id;
    $("fPlaceHint").hidden = !!f.id;
    setVal("fStart", f.start || ""); setVal("fEnd", f.end || "");
    $("fEnd").min = f.start || "";
    $("fStart").max = todayISO();
    $("fRetro").checked = !!f.retro; $("fOnlyStar").checked = this.onlyStar;
    setVal("fVeto", f.veto); setVal("fReview", f.review); setVal("fSurprises", f.surprises); setVal("fQuestions", f.questions || "");
    const n = Object.keys(f.scores).length;
    const stars = this.STAR_KEYS.filter(k => f.scores[k] != null).length;
    const need = Math.ceil(this.STAR_KEYS.length / 2);
    $("fCounts").textContent = `главные ★ ${stars} из ${this.STAR_KEYS.length}${n > stars ? ` · ещё ${n - stars}` : ""}${stars && stars < need ? ` · нужно ${need}` : ""}`;
    $("fCounts").title = `Ответов на главные ★ вопросы: ${stars} из ${this.STAR_KEYS.length}. В рейтинг место попадает, когда на половину из них ответил кто-то из вас`;
    $("fReset").textContent = this.armed === "reset" ? "Точно стереть все ответы?" : "Очистить форму";
    $("fReset").classList.toggle("danger", this.armed === "reset");
    $("fCancel").hidden = !f.id;
    const del = $("fDelete");
    del.hidden = !f.id;
    $("fDeleteNo").hidden = !f.id || this.armed !== "delete" || !!this.removing;
    del.textContent = this.removing ? "Удаляю…" : this.armed === "delete" ? "Точно удалить?" : "Удалить оценку";
    del.disabled = !!this.removing;
    const canWrite = this.hooks.canWrite(), orphan = !!f.id && !this.hooks.placeName(f.place);
    $("fSave").disabled = this.saving || !canWrite || orphan;
    $("fSave").textContent = this.saving ? "Сохраняю…" : f.id ? "Сохранить правку" : "Сохранить";
    $("fSave").title = canWrite ? "" : "Сначала подключите данные в настройках";
    $("fNoKey").hidden = canWrite;
  }


  msg(text, err) { const m = $("fMsg"); m.textContent = text; m.classList.toggle("err", !!err); }

  fail(text, target) {
    this.msg(text, true);
    if (!target) return;
    const t = target.matches("input, select, textarea, button") ? target : target.querySelector("button") || target;
    target.scrollIntoView({ block: "center" });
    target.setAttribute("aria-invalid", "true");
    target.setAttribute("aria-describedby", "fMsg");
    t.focus({ preventScroll: true });
  }

  async save() {
    this.msg("");
    this.el.querySelectorAll("[aria-invalid]").forEach(x => { x.removeAttribute("aria-invalid"); x.removeAttribute("aria-describedby"); });
    const f = this.form;
    if (!f.who) return this.fail("Выберите, кто оценивает.", $("fWho"));
    if (!f.place || !this.places.some(p => p.id === f.place)) return this.fail("Выберите место.", $("fPlace"));
    if (f.start && f.end && f.end < f.start) return this.fail("«Уехали» раньше, чем «Приехали».", $("fEnd"));
    if (f.start && f.start > todayISO()) return this.fail("«Приехали» позже сегодняшнего дня — проверьте год.", $("fStart"));
    if (!Object.keys(f.scores).length && f.year == null && !f.review.trim() && !f.veto.trim()) return this.fail("Поставьте хотя бы одну оценку, ответьте «Прожили бы здесь год?» или напишите отзыв.");
    const conf = {};
    Object.keys(f.conf).forEach(k => { if (f.scores[k] != null && f.conf[k] !== "B") conf[k] = f.conf[k]; });
    const notes = {};
    Object.keys(f.notes).forEach(k => { const v = (f.notes[k] || "").trim(); if (v) notes[k] = v; });
    const isNew = !f.id;
    if (isNew && !f.draftId) f.draftId = uid("r");
    if (!f.stamp) f.stamp = new Date().toISOString();
    this.persist();
    const body = {
      id: f.id || f.draftId, place: f.place, who: f.who, start: f.start || null, end: f.end || null, days: daysBetween(f.start, f.end),
      season: f.season, mode: f.mode, housing: f.housing, retro: !!f.retro, year: f.year,
      veto: f.veto.trim(), review: f.review.trim(), scores: Object.assign({}, f.scores), conf, notes, surprises: f.surprises.trim(),
      createdAt: f.createdAt || f.stamp, updatedAt: f.stamp,
    };
    this.saving = true; this.sync();
    local.set("saving", { id: body.id, place: body.place, stamp: body.updatedAt, edit: !isNew });
    try {
      const d = !isNew && f._was ? diff(body, f._was) : null;
      const res = await this.hooks.save(body, { isNew, baseOid: f._oid || undefined, questions: (f.questions || "").trim(), patch: d && d.patch, was: d && d.base });
      if (!local.get("me", "")) local.set("me", f.who);
      this.drop(f);
      if (this.form === f) { this.form = emptyForm(f.who); this.armed = ""; this.shown.clear(); this.restored = false; }
      this.persist();
      local.del("saving");
      this.saving = false; this.sync();
      this.hooks.saved(res, body.place);
    } catch (err) {
      local.del("saving");
      this.saving = false;
      const gone = err.code === "clash" && f.id && this.hooks.isDeleted && this.hooks.isDeleted(f.id);
      if (gone) { f.id = null; f._oid = null; f._orig = undefined; f.createdAt = null; f.draftId = null; f.stamp = null; this.persist(); }
      this.sync();
      const text = gone ? "Эту оценку удалили на другом устройстве. Ваши ответы остались в форме: нажмите «Сохранить», чтобы записать их как новую оценку, или «Очистить форму»."
        : err.code === "clash" && f._was && (err.theirs || []).length ? (err.theirs.forEach(([k, v]) => { const [a, b] = k.split("."); if (b) f._was[a] = Object.assign({}, f._was[a], { [b]: v }); else f._was[a] = v; }), this.persist(), `Эту оценку только что изменили на другом устройстве${theirText(this.schema, err.theirs)}. Нажмите «Сохранить правку» ещё раз — запишется ваше.`)
        : err.code === "clash" ? "Эту оценку уже изменили на другом устройстве. Ваши правки остались в форме: откройте оценку заново из досье и перенесите их."
        : err.code === "limit" ? `${err.message}. Оценка не сохранена, ответы остались в форме — нажмите «Сохранить» ещё раз после этого времени.`
        : err.code === "forbidden" ? "Оценка не сохранена, ответы остались в форме: у ключа нет прав на запись. Замените ключ в настройках — нужен доступ на чтение и запись."
        : err.code === "rejected" ? `${err.message}. Оценка не сохранена, ответы остались в форме. Нажмите «${f.id ? "Сохранить правку" : "Сохранить"}» ещё раз позже; если GitHub откажет снова, причину нужно исправить в хранилище на GitHub — или попросите Claude.`
        : err.code === "storage" ? "Нет связи, а память браузера на этом устройстве переполнена, поэтому оценку не сохранить даже в очередь. Ответы остались в форме — нажмите «Сохранить», когда появится связь."
        : ["http", "graphql", "conflict", "timeout"].includes(err.code) ? `${err.message}. Оценка не сохранена, ответы остались в форме — нажмите «Сохранить» ещё раз через минуту.`
        : err.message || "Оценка не сохранена, ответы остались в форме.";
      this.msg(text, true);
      if (this.hooks.failed) this.hooks.failed(err, text);
    }
  }

  async remove() {
    const f = this.form;
    if (!f.id || this.removing || !this.arm("delete")) return;
    this.removing = true; this.sync();
    try {
      const r = await this.hooks.remove(f.id, f._oid);
      const place = f.place;
      this.drop(f);
      if (this.form === f) this.form = emptyForm(f.who);
      this.persist(); this.sync();
      this.removing = false; this.sync();
      this.hooks.removed(place, r);
    } catch (err) {
      this.removing = false; this.sync();
      this.msg(err.code === "clash" ? "Эту оценку уже изменили на другом устройстве. Откройте её заново из досье." : `Оценка не удалена: ${err.code === "forbidden" ? "у ключа нет прав на запись — замените ключ в настройках" : err.message || "неизвестная ошибка"}. Попробуйте ещё раз ${err.code === "limit" ? "после этого времени" : err.code === "rejected" ? "позже; если GitHub откажет снова, причину нужно исправить в хранилище на GitHub" : "через минуту"}.`, true);
    }
  }
}
