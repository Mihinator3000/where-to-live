import { $, esc, local, daysBetween } from "./util.js";

const HALF = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];
export const CONF = { A: "проверили в быту", B: "видели как туристы", C: "со слов живущих", D: "только по рейтингу" };
const emptyForm = () => ({ id: null, createdAt: null, who: local.get("me", ""), place: "", start: "", end: "", season: "", mode: "", housing: "", retro: false, year: null, veto: "", review: "", surprises: "", scores: {}, conf: {}, notes: {} });

export class RateForm {
  constructor(el, schema, hooks) {
    this.el = el;
    this.schema = schema;
    this.hooks = hooks;
    this.PEOPLE = schema.people;
    this.STAR_KEYS = schema.cats.filter(c => c.star).map(c => c.key);
    this.GROUPS = schema.groups.map(g => ({ g, cats: schema.cats.filter(c => c.group === g.key && c.form).sort((a, b) => Number(b.star) - Number(a.star)) })).filter(x => x.cats.length);
    this.form = Object.assign(emptyForm(), local.get("draft", {}));
    this.onlyStar = local.get("onlyStar", false);
    this.deleteArmed = false;
    this.confOpen = null;
    this.saving = false;
    this.places = [];
    this.timer = null;
    this.build();
  }

  saveDraft() { clearTimeout(this.timer); this.timer = setTimeout(() => local.set("draft", this.form), 300); }

  build() {
    const O = this.schema.options;
    const seg = (name, values) => values.map(v => `<button type="button" data-opt="${name}" data-val="${esc(v)}" aria-pressed="false">${esc(v)}</button>`).join("");
    let html = `<div class="panel fcard">
      <h3>Кто и где</h3>
      <div class="help"><span>Каждый оценивает сам, не глядя в оценки другого. Шкала 1–5, где 3 — как в СПб. Пропускайте то, что не проверили.</span><span>Под поставленной оценкой видно, откуда мы это знаем: по умолчанию «видели как туристы». Если проверили в быту, знаем со слов живущих или только по рейтингу, нажмите и выберите.</span></div>
      <div class="field"><span class="lbl">Кто оценивает</span><div class="seg" role="group" aria-label="Кто оценивает">${this.PEOPLE.map(w => `<button type="button" data-who="${esc(w)}" aria-pressed="false">${esc(w)}</button>`).join("")}</div></div>
      <div class="field"><label class="lbl" for="fPlace">Место</label><select id="fPlace"></select><span class="small muted">Нет в списке — <a href="#/map">найдите на карте</a> и нажмите «Добавить место».</span></div>
      <div class="frow">
        <label class="field" for="fStart"><span class="lbl">Приехали</span><input type="date" id="fStart"></label>
        <label class="field" for="fEnd"><span class="lbl">Уехали</span><input type="date" id="fEnd"></label>
      </div>
      <div class="field"><span class="lbl">Сезон</span><div class="seg" role="group" aria-label="Сезон">${seg("season", O.season)}</div></div>
      <div class="field"><span class="lbl">Режим</span><div class="seg" role="group" aria-label="Режим">${seg("mode", O.mode)}</div></div>
      <div class="field"><span class="lbl">Где жили</span><div class="seg" role="group" aria-label="Где жили">${seg("housing", O.housing)}</div></div>
      <label class="toggle" for="fRetro"><input type="checkbox" id="fRetro"> Оцениваем задним числом (поездка давно прошла)</label>
      <label class="toggle" for="fOnlyStar"><input type="checkbox" id="fOnlyStar"> Только обязательные ★ (${this.STAR_KEYS.length})</label>
    </div>`;
    this.GROUPS.forEach(({ g, cats }) => {
      html += `<div class="panel fcard" data-group="${g.key}"><h3>${esc(g.name)} <span class="gcount" id="gc-${g.key}"></span></h3><div>`;
      cats.forEach(c => {
        html += `<div class="q" data-q="${c.key}" data-star="${c.star ? 1 : 0}">
          <div class="q-head"><span class="q-name">${c.star ? "★ " : ""}${esc(c.name)}</span></div>
          ${c.hint ? `<span class="q-hint">${esc(c.hint)}</span>` : ""}
          <div class="pick" role="group" aria-label="${esc(c.name)}">${HALF.map(v => `<button type="button" class="${v % 1 ? "half" : ""}" data-score="${c.key}" data-v="${v}" aria-label="${v}" aria-pressed="false">${v % 1 ? "½" : v}</button>`).join("")}</div>
          <button type="button" class="conf" data-conf="${c.key}" aria-expanded="false" hidden></button>
          <div class="conf-pick" data-confpick="${c.key}" role="group" aria-label="Откуда знаем" hidden>${Object.keys(CONF).map(l => `<button type="button" data-confset="${c.key}" data-l="${l}" aria-pressed="false">${CONF[l]}</button>`).join("")}</div>
        </div>`;
      });
      html += `</div><label class="field" for="note-${g.key}"><span class="lbl">Комментарий по группе</span><textarea id="note-${g.key}" data-note="${g.key}" rows="2"></textarea></label></div>`;
    });
    html += `<div class="panel fcard"><h3>Итог</h3>
      <div class="field"><span class="lbl">Прожили бы здесь год? 0 — ни за что, 10 — хоть завтра</span><div class="pick y" role="group" aria-label="Год здесь">${Array.from({ length: 11 }, (_, i) => `<button type="button" data-year="${i}" aria-pressed="false">${i}</button>`).join("")}</div></div>
      <label class="field" for="fReview"><span class="lbl">Отзыв в двух-трёх фразах (виден на карте)</span><textarea id="fReview" rows="3"></textarea></label>
      <label class="field" for="fVeto"><span class="lbl">Вето: место отпадает совсем, потому что…</span><input type="text" id="fVeto" autocomplete="off" placeholder="оставьте пустым, если вето нет"></label>
      <label class="field" for="fSurprises"><span class="lbl">Сюрпризы и вопросы к следующей поездке</span><textarea id="fSurprises" rows="3"></textarea></label>
    </div>
    <div class="savebar">
      <span class="counts" id="fCounts"></span>
      <span class="msg" id="fMsg" role="status"></span>
      <div class="btns">
        <button type="button" class="btn danger" id="fDelete" hidden>Удалить оценку</button>
        <button type="button" class="btn ghost" id="fReset">Очистить форму</button>
        <button type="submit" class="btn" id="fSave">Сохранить</button>
      </div>
    </div>`;
    this.el.innerHTML = html;
    this.el.addEventListener("click", e => this.onClick(e));
    this.el.addEventListener("input", e => this.onInput(e));
    this.el.addEventListener("change", e => this.onInput(e));
    this.el.addEventListener("submit", e => { e.preventDefault(); this.save(); });
    $("fReset").addEventListener("click", () => { this.form = emptyForm(); this.deleteArmed = false; local.set("draft", this.form); this.sync(); this.msg(""); });
    $("fDelete").addEventListener("click", () => this.remove());
  }

  onClick(e) {
    const b = e.target.closest("button");
    if (!b || b.type === "submit" || b.id === "fReset" || b.id === "fDelete") return;
    const f = this.form;
    if (b.dataset.who) f.who = b.dataset.who;
    else if (b.dataset.opt) f[b.dataset.opt] = f[b.dataset.opt] === b.dataset.val ? "" : b.dataset.val;
    else if (b.dataset.score) {
      const k = b.dataset.score, v = Number(b.dataset.v);
      if (f.scores[k] === v) { delete f.scores[k]; delete f.conf[k]; } else f.scores[k] = v;
    } else if (b.dataset.conf) {
      this.confOpen = this.confOpen === b.dataset.conf ? null : b.dataset.conf;
    } else if (b.dataset.confset) {
      const k = b.dataset.confset;
      if (b.dataset.l === "B") delete f.conf[k]; else f.conf[k] = b.dataset.l;
      this.confOpen = null;
    } else if (b.dataset.year) {
      const v = Number(b.dataset.year);
      f.year = f.year === v ? null : v;
    } else return;
    this.saveDraft(); this.sync();
  }

  onInput(e) {
    const t = e.target, f = this.form;
    if (t.dataset.note) f.notes[t.dataset.note] = t.value;
    else if (t.id === "fPlace") f.place = t.value;
    else if (t.id === "fStart") f.start = t.value;
    else if (t.id === "fEnd") f.end = t.value;
    else if (t.id === "fRetro") f.retro = t.checked;
    else if (t.id === "fVeto") f.veto = t.value;
    else if (t.id === "fReview") f.review = t.value;
    else if (t.id === "fSurprises") f.surprises = t.value;
    else if (t.id === "fOnlyStar") { this.onlyStar = t.checked; local.set("onlyStar", this.onlyStar); }
    else return;
    this.saveDraft(); this.sync();
  }

  setPlaces(places) {
    this.places = places.filter(p => p.status !== "база");
    const sel = $("fPlace");
    const opts = this.places.slice().sort((a, b) => a.name.localeCompare(b.name, "ru"));
    sel.innerHTML = `<option value="">— выберите —</option>` + opts.map(p => `<option value="${esc(p.id)}">${esc(p.name)}${p.country ? " · " + esc(p.country) : ""}</option>`).join("");
    sel.value = this.form.place;
    this.sync();
  }

  startFor(placeId) {
    if (this.form.id || this.form.place !== placeId) {
      const keepWho = this.form.who;
      this.form = Object.assign(emptyForm(), { place: placeId, who: keepWho || local.get("me", "") });
      local.set("draft", this.form);
    }
    this.setPlaces(this.places);
  }

  load(r) {
    this.form = Object.assign(emptyForm(), {
      id: r.id, createdAt: r.createdAt || null, who: r.who, place: r.place, start: r.start || "", end: r.end || "",
      season: r.season || "", mode: r.mode || "", housing: r.housing || "", retro: !!r.retro, year: r.year == null ? null : r.year,
      veto: r.veto || "", review: r.review || "", surprises: r.surprises || "",
      scores: Object.assign({}, r.scores), conf: Object.assign({}, r.conf), notes: Object.assign({}, r.notes),
    });
    this.deleteArmed = false;
    local.set("draft", this.form);
    this.setPlaces(this.places);
    this.msg("");
  }

  sync() {
    const el = this.el, f = this.form;
    const setVal = (id, v) => { const x = $(id); if (x && x.value !== v) x.value = v; };
    el.querySelectorAll("[data-who]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.who === f.who)));
    el.querySelectorAll("[data-opt]").forEach(b => b.setAttribute("aria-pressed", String(f[b.dataset.opt] === b.dataset.val)));
    el.querySelectorAll("[data-score]").forEach(b => b.setAttribute("aria-pressed", String(f.scores[b.dataset.score] === Number(b.dataset.v))));
    el.querySelectorAll("[data-conf]").forEach(b => {
      const k = b.dataset.conf, l = f.conf[k] || "B";
      b.hidden = f.scores[k] == null;
      b.textContent = "откуда знаем: " + CONF[l];
      b.classList.toggle("set", l !== "B");
      b.setAttribute("aria-expanded", String(this.confOpen === k));
    });
    el.querySelectorAll("[data-confpick]").forEach(d => { const k = d.dataset.confpick; d.hidden = this.confOpen !== k || f.scores[k] == null; });
    el.querySelectorAll("[data-confset]").forEach(b => b.setAttribute("aria-pressed", String((f.conf[b.dataset.confset] || "B") === b.dataset.l)));
    el.querySelectorAll("[data-year]").forEach(b => b.setAttribute("aria-pressed", String(f.year === Number(b.dataset.year))));
    el.querySelectorAll("[data-q]").forEach(q => { q.hidden = this.onlyStar && q.dataset.star !== "1"; });
    el.querySelectorAll("[data-note]").forEach(t => { const v = f.notes[t.dataset.note] || ""; if (t.value !== v) t.value = v; });
    setVal("fPlace", f.place);
    setVal("fStart", f.start || ""); setVal("fEnd", f.end || "");
    $("fRetro").checked = !!f.retro; $("fOnlyStar").checked = this.onlyStar;
    setVal("fVeto", f.veto); setVal("fReview", f.review); setVal("fSurprises", f.surprises);
    this.GROUPS.forEach(({ g, cats }) => { $("gc-" + g.key).textContent = `· ${cats.filter(c => f.scores[c.key] != null).length} из ${cats.length}`; });
    const n = Object.keys(f.scores).length;
    const stars = this.STAR_KEYS.filter(k => f.scores[k] != null).length;
    $("fCounts").textContent = `${f.id ? "Правка · " : ""}оценок: ${n} · ★ ${stars} из ${this.STAR_KEYS.length}`;
    const del = $("fDelete");
    del.hidden = !f.id;
    del.textContent = this.deleteArmed ? "Точно удалить?" : "Удалить оценку";
    const canWrite = this.hooks.canWrite();
    $("fSave").disabled = this.saving || !canWrite;
    $("fSave").textContent = f.id ? "Сохранить правку" : "Сохранить";
    $("fSave").title = canWrite ? "" : "Сначала введите токен в настройках";
  }

  msg(text, err) { const m = $("fMsg"); m.textContent = text; m.classList.toggle("err", !!err); }

  async save() {
    this.msg("");
    const f = this.form;
    if (!f.who) return this.msg("Выберите, кто оценивает.", true);
    if (!f.place || !this.places.some(p => p.id === f.place)) return this.msg("Выберите место.", true);
    if (!Object.keys(f.scores).length && f.year == null && !f.review.trim()) return this.msg("Поставьте хотя бы одну оценку.", true);
    const conf = {};
    Object.keys(f.conf).forEach(k => { if (f.scores[k] != null && f.conf[k] !== "B") conf[k] = f.conf[k]; });
    const notes = {};
    Object.keys(f.notes).forEach(k => { const v = (f.notes[k] || "").trim(); if (v) notes[k] = v; });
    const body = {
      id: f.id || undefined, place: f.place, who: f.who, start: f.start || null, end: f.end || null, days: daysBetween(f.start, f.end),
      season: f.season, mode: f.mode, housing: f.housing, retro: !!f.retro, year: f.year,
      veto: f.veto.trim(), review: f.review.trim(), scores: Object.assign({}, f.scores), conf, notes, surprises: f.surprises.trim(),
      createdAt: f.createdAt || undefined,
    };
    if (!body.id) delete body.id;
    if (!body.createdAt) delete body.createdAt;
    this.saving = true; this.sync();
    try {
      const res = await this.hooks.save(body);
      local.set("me", f.who);
      this.form = emptyForm(); this.deleteArmed = false; local.set("draft", this.form);
      this.saving = false; this.sync();
      this.hooks.saved(res, body.place);
    } catch (err) {
      this.saving = false; this.sync();
      this.msg(err.message || "Не сохранилось", true);
    }
  }

  async remove() {
    if (!this.form.id) return;
    if (!this.deleteArmed) { this.deleteArmed = true; this.sync(); setTimeout(() => { this.deleteArmed = false; this.sync(); }, 5000); return; }
    try {
      await this.hooks.remove(this.form.id);
      this.form = emptyForm(); this.deleteArmed = false; local.set("draft", this.form); this.sync();
      this.hooks.removed();
    } catch (err) { this.msg(err.message || "Не удалилось", true); }
  }
}
