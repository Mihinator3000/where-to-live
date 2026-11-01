import { fmt, MIN_COVERAGE, MIN_OWN, gen, byScore } from "./calc.js";
import { esc, heatHex, inkOn, scoreColor, plural } from "./util.js";
import { CONF, datesRu, MODE_LABEL } from "./form.js";

export const SHORT = { legal: "Легализ.", money: "Деньги", work: "Работа", health: "Здоровье", safety: "Безоп.", climate: "Климат", housing: "Жильё", city: "Город", nature: "Природа", people: "Люди", links: "Связь" };
const pct = v => ((v - 1) / 4 * 100).toFixed(2) + "%";
export const placeHref = id => "#/place/" + encodeURIComponent(id);
const personClass = (M, who) => (who === M.PEOPLE[1] ? "v" : "m");

const hidden = (M, id, w) => !!(M.hidden && M.hidden(id, w));
export const hiddenWho = (M, id) => M.PEOPLE.filter(w => hidden(M, id, w));
export const hasResidents = M => M.places.some(p => p.ext && Object.values(p.ext).some(e => e && e.res != null));
const anon = M => M.me === "";
export const hiddenNote = (M, id) => { const w = hiddenWho(M, id), why = M.me === "" ? "пока не выбрано, кто вы" : "до вашей оценки"; return w.length === 1 ? `оценка ${gen(w[0])} скрыта${M.me === "" ? ", " : " "}${why}` : w.length ? `оценки ${w.map(gen).join(" и ")} скрыты${M.me === "" ? ", " : " "}${why}` : ""; };

export function yearsLine(M, id) {
  return M.PEOPLE.map(w => { const y = hidden(M, id, w) ? null : M.latestYear(id, w); return y == null ? null : `${w} ${y}/10`; }).filter(Boolean).join(" · ");
}

export function rankHTML(M, W, moves = {}, fast = false) {
  const r = M.ranking(W, fast);
  const ticks = [1, 2, 3, 4, 5].map(v => `<span style="left:${pct(v)}">${v === 3 ? "3 · СПб" : v}</span>`).join("");
  let html = r.rated.length || r.base.length ? `<div class="rank-axis" aria-hidden="true"><span></span><span></span><div class="ticks num">${ticks}</div><span></span></div>` : "";
  const people = row => M.PEOPLE.map((w, i) => row.per[w] == null || hidden(M, row.p.id, w) ? "" : `<span class="dot ${i ? "v" : "m"}" style="left:${pct(row.per[w])}" data-tip="${esc(w)}: ${fmt(row.per[w])}" aria-hidden="true"></span>`).join("");
  const said = row => { const t = M.PEOPLE.filter(w => row.per[w] != null && !hidden(M, row.p.id, w)).map(w => `${w} ${fmt(row.per[w])}`).join(", "); return t ? `<span class="sr-only">оценки: ${esc(t)}</span>` : ""; };
  const own = r.rated.filter(row => M.ownEnough(row.p.id)), dataOnly = r.rated.filter(row => !M.ownEnough(row.p.id));
  const rowHTML = (row, pos, pale) => {
    const s = row.t.score, lo = Math.min(s, 3), hi = Math.max(s, 3);
    const rr = row.range;
    const rangeChip = !pale && rr && rr.min !== rr.max ? `№${rr.min}–${rr.max} в зависимости от весов` : "";
    const years = yearsLine(M, row.p.id);
    const share = M.ownShare(row.p.id), note = hiddenNote(M, row.p.id);
    const why = !pale ? "" : note || (share || M.ratingsOf(row.p.id).length ? `своих ответов на ★: ${Math.round(share * M.STAR_KEYS.length)} из ${M.STAR_KEYS.length}` : "только мировые данные");
    const mv = !pale && moves[row.p.id];
    return `<a class="row${pale ? " pale" : ""}" href="${placeHref(row.p.id)}">
      <span class="pos num">${pale ? "·" : pos}</span>
      <div class="name"><b>${esc(row.p.name)}</b><div class="chips">${mv ? `<span class="chip move" title="Место сдвинулось после смены весов">${mv > 0 ? "↑" + mv : "↓" + -mv}</span>` : ""}${row.p.status === "финалист" ? `<span class="chip solid">финалист</span>` : ""}${row.p.country ? `<span class="chip">${esc(row.p.country)}</span>` : ""}${why ? `<span class="chip">${esc(why)}</span>` : ""}${rangeChip ? `<span class="chip">${rangeChip}</span>` : ""}${row.t.coverage < 0.7 ? `<span class="chip">заполнено ${Math.round(row.t.coverage * 100)}%</span>` : ""}${years ? `<span class="chip" title="Прожили бы здесь год? 0–10">год здесь: ${esc(years)}</span>` : ""}</div></div>
      <div class="track"><span class="base"></span><span class="bar ${s >= 3 ? "up" : "down"}" style="left:${pct(lo)};width:calc(${pct(hi)} - ${pct(lo)})" data-tip="Итог: ${fmt(s)}"></span>${people(row)}</div>
      <div class="score num">${fmt(s)}<small>из 5</small></div>${said(row)}
    </a>`;
  };
  const RULE = "Место попадёт сюда, когда отвечено хотя бы на половину главных вопросов ★.";
  const anyOwn = r.rated.concat(r.thin, r.unrated).some(row => M.ratingsOf(row.p.id).length);
  const waitFor = M.candidates().filter(p => hiddenWho(M, p.id).length), them = [...new Set(waitFor.flatMap(p => hiddenWho(M, p.id)))];
  const VERB = { "Михаил": "оценил", "Вика": "оценила" };
  const blindNote = () => anon(M) ? `Пока не выбрано, кто вы на этом устройстве, оценки мест, которые оценил только один из нас, скрыты: ${waitFor.length} ${plural(waitFor.length, "место", "места", "мест")} (список ниже). ${RULE}` : `Ваших оценок пока нет. ${esc(them.join(" и "))} уже ${them.length > 1 ? "оценили" : VERB[them[0]] || "оценил(а)"} ${waitFor.length} ${plural(waitFor.length, "место", "места", "мест")} — ${them.length > 1 ? "их оценки скрыты" : `оценки ${esc(gen(them[0]))} скрыты`}, пока вы не оцените эти места сами (список ниже). ${RULE}`;
  if (!own.length) html += `<div class="empty-row">${anyOwn ? "Пока ни одно место не набрало ответов на половину главных вопросов ★ — места с нашими оценками ниже." : waitFor.length ? blindNote() : !M.places.some(p => !M.isBase(p)) ? `Мест пока нет: добавьте первое через поиск на <a href="#/map">карте</a>. ${RULE}` : M.candidates().length ? `Своих оценок пока нет: <a href="#/rate">оцените первую поездку</a>. ${RULE}` : `Своих оценок пока нет. ${RULE}`}</div>`;
  const baseRows = () => r.base.forEach(p => {
    html += `<a class="row" href="${placeHref(p.id)}"><span class="pos num">—</span><div class="name"><b>${esc(p.name)}</b><div class="chips"><span class="chip solid" title="Точка отсчёта: все оценки — относительно СПб">база</span></div></div><div class="track"><span class="base"></span></div><div class="score num">3.0<small>всегда</small></div></a>`;
  });
  const above = row => Math.round(row.t.score * 10) >= 30;
  own.forEach((row, i) => { if (above(row)) html += rowHTML(row, i + 1, false); });
  baseRows();
  own.forEach((row, i) => { if (!above(row)) html += rowHTML(row, i + 1, false); });
  if (dataOnly.length) {
    html += `<div class="rank-sub"><b>Мало своих оценок</b><span>Для рейтинга нужно хотя бы ${Math.ceil(MIN_OWN * M.STAR_KEYS.length)} из ${M.STAR_KEYS.length} ответов на главные вопросы ★; пока итог в основном по мировым данным.</span></div>`;
    dataOnly.forEach(row => { html += rowHTML(row, 0, true); });
  }
  if (r.thin.length) html += `<div class="empty-row">Мало данных для рейтинга (заполнено меньше ${MIN_COVERAGE * 100}%): ${r.thin.map(x => `<a href="${placeHref(x.p.id)}">${esc(x.p.name)}</a> — ${Math.round(x.t.coverage * 100)}%`).join(", ")}</div>`;
  const waiting = r.unrated.filter(x => hiddenWho(M, x.p.id).length), unrated = r.unrated.filter(x => !waiting.includes(x));
  if (waiting.length) html += `<div class="empty-row">${anon(M) ? "Скрыты, пока не выбрано, кто вы" : "Ждут вашей оценки"}: ${waiting.map(x => `<a href="${placeHref(x.p.id)}">${esc(x.p.name)}</a> — ${esc(anon(M) ? hiddenWho(M, x.p.id).map(w => "оценка " + gen(w)).join(" и ") : hiddenNote(M, x.p.id))}`).join("; ")}</div>`;
  if (unrated.length) html += `<div class="empty-row">Ещё без оценок и данных: ${unrated.map(x => `<a href="${placeHref(x.p.id)}">${esc(x.p.name)}</a>`).join(", ")}</div>`;
  if (r.out.length) html += `<div class="empty-row">Отсев: ${r.out.map(x => `<a href="${placeHref(x.p.id)}">${esc(x.p.name)}</a> — ${esc(x.why)}`).join("; ")}</div>`;
  return html;
}

export function heatHTML(M, W) {
  const list = M.candidates().map(p => ({ p, s: M.total(p, W, "final").score }));
  list.sort((a, b) => byScore(a.s, b.s, a.p, b.p));
  const rows = M.places.filter(M.isBase).map(p => ({ p })).concat(list);
  let html = `<thead><tr><th>Место</th>${M.GROUPS.map(g => `<th title="${esc(g.name)}">${SHORT[g.key] || esc(g.name)}</th>`).join("")}</tr></thead><tbody>`;
  rows.forEach(({ p }) => {
    const thin = !M.isBase(p) && !M.ownEnough(p.id);
    const tag = !thin ? "" : hiddenNote(M, p.id) || (M.ratingsOf(p.id).length ? "мало своих оценок" : "только мировые данные");
    html += `<tr${thin ? ` class="pale"` : ""}><th class="rowh"><a href="${placeHref(p.id)}">${esc(p.name)}</a>${tag ? `<small class="muted tag">${esc(tag)}</small>` : ""}</th>`;
    M.GROUPS.forEach(g => {
      const v = M.groupScore(p, g.key, "final"), bg = v == null ? null : heatHex(v);
      html += `<td class="cell${v == null ? " none" : ""}" style="${bg ? `background:${bg};color:${inkOn(bg)}` : ""}" data-tip="${esc(p.name)} · ${esc(g.name)}: ${fmt(v)}">${fmt(v)}</td>`;
    });
    html += "</tr>";
  });
  return html + "</tbody>";
}

export function flagsHTML(M, all = false) {
  const label = { crit: "красный флаг", serious: "разногласие", warn: "иллюзия туриста", info: "недооценили" };
  const shown = M.allFlags(), off = M.places.some(p => hiddenWho(M, p.id).length);
  const note = off ? `<p class="small muted">${anon(M) ? "Флаги по местам, которые оценил только один из нас, скрыты, пока не выбрано, кто вы на этом устройстве." : "Флаги по местам, которые вы сами ещё не оценили, появятся после вашей оценки — чтобы не подглядывать."}</p>` : "";
  const legend = `<p class="small muted">Красный флаг — оценка 1.5 и ниже или вето. Разногласие — наши оценки разошлись на 1.5 и больше. Иллюзия туриста и «недооценили» — так же разошлись мы и живущие.</p>`;
  const byPlace = new Map();
  shown.forEach(f => { if (!byPlace.has(f.place)) byPlace.set(f.place, []); byPlace.get(f.place).push(f); });
  const names = Object.fromEntries(M.places.map(p => [p.id, p.name]));
  let groups = [...byPlace], n = 0;
  if (!all && shown.length > 60) groups = groups.filter(([, fs]) => (n += fs.length) - fs.length < 40);
  const rest = shown.length - groups.reduce((a, [, fs]) => a + fs.length, 0);
  return {
    count: shown.length,
    html: shown.length
      ? legend + note + groups.map(([id, fs]) => `<div class="flag-place"><a href="${placeHref(id)}">${esc(names[id] || id)}</a></div>` + fs.map(f => `<div class="flag"><span class="sev ${f.sev}">${label[f.sev]}</span><div class="t"><a href="${placeHref(f.place)}">${esc(f.what || f.head)}</a><small>${esc(f.text)}</small></div></div>`).join("")).join("") + (rest ? `<div class="btns"><button type="button" class="btn ghost small" id="flagsAll">Показать остальные ${rest} ${plural(rest, "флаг", "флага", "флагов")}</button></div>` : "")
      : note || `<p class="small muted">Флагов нет. Здесь появятся оценки ≤1.5, расхождения между нами от 1.5 балла и вето.</p>`,
  };
}

export function radarSVG(M, p) {
  const S = 440, cx = S / 2, cy = S / 2 + 4, R = 150, r1 = 18;
  const G = M.GROUPS, n = G.length;
  const ang = i => -Math.PI / 2 + i * 2 * Math.PI / n;
  const rad = v => r1 + (v - 1) / 4 * (R - r1);
  const pt = (i, v) => [cx + Math.cos(ang(i)) * rad(v), cy + Math.sin(ang(i)) * rad(v)];
  let g = "";
  [1, 2, 3, 4, 5].forEach(v => {
    const pts = G.map((_, i) => pt(i, v).map(x => x.toFixed(1)).join(",")).join(" ");
    g += `<polygon class="ring${v === 3 ? " base" : ""}" points="${pts}"/>`;
  });
  G.forEach((gr, i) => {
    const [x, y] = pt(i, 5);
    g += `<line class="spoke" x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>`;
    const lx = cx + Math.cos(ang(i)) * (R + 22), ly = cy + Math.sin(ang(i)) * (R + 22);
    const anchor = Math.abs(Math.cos(ang(i))) < 0.2 ? "middle" : (Math.cos(ang(i)) > 0 ? "start" : "end");
    g += `<text x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" text-anchor="${anchor}">${SHORT[gr.key] || esc(gr.name)}</text>`;
  });
  const [bx, by] = pt(0, 3);
  g += `<text x="${(bx + 4).toFixed(1)}" y="${(by - 4).toFixed(1)}" style="font-size:10px;fill:var(--muted)">СПб</text>`;
  const series = [
    { src: M.PEOPLE[0], color: "var(--m)", dash: "", fill: true },
    { src: M.PEOPLE[1], color: "var(--v)", dash: "", fill: true },
    { src: "res", color: "var(--res)", dash: "", fill: false, label: "Живущие" },
    { src: "data", color: "var(--data)", dash: "5 4", fill: false, label: "Мировые данные" },
  ];
  series.forEach(s => {
    if (hidden(M, p.id, s.src)) return;
    const vals = G.map(gr => M.groupScore(p, gr.key, s.src));
    if (vals.every(v => v == null)) return;
    const label = s.label || s.src;
    if (vals.every(v => v != null) && s.fill) g += `<polygon points="${vals.map((v, i) => pt(i, v).join(",")).join(" ")}" fill="${s.color}" fill-opacity="0.08" stroke="none"/>`;
    let path = "";
    vals.forEach((v, i) => {
      const j = (i + 1) % n, w = vals[j];
      if (v != null && w != null) { const a = pt(i, v), b = pt(j, w); path += `M${a[0].toFixed(1)},${a[1].toFixed(1)}L${b[0].toFixed(1)},${b[1].toFixed(1)}`; }
    });
    if (path) g += `<path d="${path}" fill="none" stroke="${s.color}" stroke-width="2" stroke-dasharray="${s.dash}" stroke-linecap="round"/>`;
    vals.forEach((v, i) => {
      if (v == null) return;
      const [x, y] = pt(i, v);
      g += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.5" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/>`;
      g += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="12" fill="transparent" data-tip="${esc(label)} · ${esc(G[i].name)}: ${fmt(v)}"/>`;
    });
  });
  return `<svg viewBox="-36 0 ${S + 72} ${S + 8}" role="img" aria-label="Оценки по группам: ${esc(p.name)}">${g}</svg>`;
}


export function radarLegend(M, p, data = "Мировые данные") {
  const S = [[M.PEOPLE[0], "m", M.PEOPLE[0]], [M.PEOPLE[1], "v", M.PEOPLE[1]], ["res", "res", "Живущие"], ["data", "data", data]];
  const drawn = src => M.GROUPS.some(g => M.groupScore(p, g.key, src) != null);
  return S.map(([src, cls, name]) => hidden(M, p.id, src) ? `<span><i class="sw hid"></i>${esc(name)} — ${anon(M) ? "скрыто, пока не выбрано, кто вы" : "скрыто до вашей оценки"}</span>` : drawn(src) ? `<span><i class="sw ${cls}"></i>${esc(name)}</span>` : "").join("") + `<span><i class="sw base"></i>СПб = 3</span><span class="muted">ближе к краю — лучше</span>`;
}

export function radarTable(M, p) {
  const cols = M.PEOPLE.filter(w => !hidden(M, p.id, w)).map(w => [w, w]).concat([["res", "Живущие"], ["data", "Данные"]]).filter(([src]) => M.GROUPS.some(g => M.groupScore(p, g.key, src) != null));
  if (!cols.length) return "";
  return `<details class="small radar-nums"><summary>Цифрами</summary><table><thead><tr><th>Группа</th>${cols.map(([, n]) => `<th class="n">${esc(n)}</th>`).join("")}</tr></thead><tbody>${M.GROUPS.map(g => `<tr><td>${esc(g.name)}</td>${cols.map(([src]) => `<td class="n">${fmt(M.groupScore(p, g.key, src))}</td>`).join("")}</tr>`).join("")}</tbody></table></details>`;
}

export function notesText(M, notes) {
  return Object.keys(notes || {}).filter(k => notes[k]).map(k => `${(M.GROUP[k] && M.GROUP[k].name) || k}: ${notes[k]}`).join("\n");
}

export function tripsHTML(M, p, editable, me, waiting = new Set()) {
  if (M.isBase(p)) return `<p class="small muted">СПб — точка отсчёта: его не оценивают, все места сравниваются с ним.</p>`;
  const rs = M.ratingsOf(p.id).slice().sort((a, b) => String(b.start || b.updatedAt || "").localeCompare(String(a.start || a.updatedAt || "")));
  const years = M.PEOPLE.map(w => { if (hidden(M, p.id, w)) return `<span>${esc(w)} <span class="muted small">скрыто</span></span>`; const y = M.latestYear(p.id, w); return `<span>${esc(w)} <b>${y == null ? "—" : esc(y)}</b>${y == null ? "" : "/10"}</span>`; }).join("");
  if (!rs.length && !hiddenWho(M, p.id).length) return `<div class="year"><span class="muted">Прожили бы здесь год?</span><div class="yv">${years}</div></div><p class="small muted">Своих оценок пока нет.</p>`;
  let html = `<div class="year"><span class="muted">Прожили бы здесь год?</span><div class="yv">${years}</div></div>`;
  rs.forEach(r => {
    const cls = personClass(M, r.who);
    const filled = M.STAR_KEYS.filter(k => r.scores && r.scores[k] != null).length;
    const dates = r.start ? datesRu(r.start, r.end) : "даты не указаны";
    const facts = [r.days ? r.days + " дн." : "", r.season ? "сезон: " + r.season : "", MODE_LABEL[r.mode] || r.mode, r.housing, r.retro ? "по памяти" : ""].filter(Boolean).map(esc).join(" · ");
    const partner = M.PEOPLE.find(w => w !== r.who), blind = me && r.who === me && partner && M.full && !M.full.ratingsOf(p.id).some(x => x.who === partner);
    const notes = [notesText(M, r.notes), r.surprises].filter(Boolean).join("\n\n");
    const mine = !me || r.who === me;
    html += `<div class="trip" data-rid="${esc(r.id)}"><div class="who"><i class="sw ${cls}"></i>${esc(r.who)}<span class="muted small" style="font-weight:400">· ${esc(dates)}</span>${waiting.has(r.id) ? `<span class="chip warn" title="Сохранена на этом устройстве и отправится сама">ждёт отправки</span>` : ""}</div>
      ${facts ? `<div class="small muted">${facts}</div>` : ""}
      ${r.review ? `<div class="review ${cls}">${esc(r.review)}</div>` : ""}
      <div class="small">Ответы на главные вопросы ★: <span class="num">${filled} из ${M.STAR_KEYS.length}</span>${r.veto ? ` · <span class="sev crit">вето: ${esc(r.veto)}</span>` : ""}</div>
      ${notes ? `<details><summary class="small">Комментарии</summary><pre>${esc(notes)}</pre></details>` : ""}
      ${blind ? `<div class="small muted">${esc(partner)} увидит эту оценку, когда оценит место.</div>` : ""}
      ${editable && mine ? `<div><a class="btn ghost small" href="#/rate/${encodeURIComponent(r.id)}">Изменить</a></div>` : ""}</div>`;
  });
  if (M.PEOPLE.some(w => rs.filter(r => r.who === w).length > 1)) html += `<p class="small muted">Несколько поездок одного человека сводятся в одну оценку: поездки в худший сезон и на удалёнке весят больше, по памяти — меньше.</p>`;
  hiddenWho(M, p.id).forEach(w => { html += `<div class="trip hidden-trip"><div class="small">${esc(w)}: оценка скрыта, ${anon(M) ? "пока не выбрано, кто вы на этом устройстве" : "пока вы не оцените это место сами, чтобы не подглядывать"}.</div></div>`; });
  return html;
}

export function subtableHTML(M, p, showEmpty, typed = {}) {
  const res = hasResidents(M);
  let html = `<thead><tr><th>Подкатегория</th><th class="n">Итог</th>${M.PEOPLE.map(w => `<th class="n">${esc(w)}</th>`).join("")}${res ? `<th class="n">Живущие</th>` : ""}<th class="n">Данные</th><th class="flagcol">Флаг</th></tr></thead><tbody>`;
  let any = false;
  M.GROUPS.forEach(g => {
    const rows = [];
    M.CATS.filter(c => c.group === g.key).forEach(c => {
      const per = M.PEOPLE.map(w => (M.isBase(p) ? null : M.personCat(p.id, w, c.key)));
      const rv = M.extCat(p, c.key, "res"), dat = M.extCat(p, c.key, "data"), fin = M.finalCat(p, c.key);
      const has = per.some(v => v != null) || rv != null || dat != null;
      if (!has && !showEmpty) return;
      const conf = M.PEOPLE.map(w => M.confOf(p.id, w, c.key));
      const flags = M.catFlags(p, c.key).map(f => `<span class="sev ${f.sev}">${esc(f.short)}</span>`).join(" ");
      const mark = `<span class="c" title="Оценка посчитана из «Цифр места»">ц</span>`;
      const cell = (v, i) => hidden(M, p.id, M.PEOPLE[i]) ? `<td class="n muted" title="${anon(M) ? "скрыто, пока не выбрано, кто вы" : "скрыто, пока вы не оцените сами"}"><span role="img" aria-label="скрыто">·</span></td>` : `<td class="n">${fmt(v)}${v != null && conf[i] ? `<span class="c" title="${esc(CONF[conf[i]] || "")}">${esc(conf[i])}</span>` : ""}</td>`;
      rows.push(`<tr><td>${c.star ? '<span class="star" data-tip="Главный вопрос каждой поездки">★</span> ' : ""}${esc(c.name)}${flags ? `<span class="flags-in">${flags}</span>` : ""}</td><td class="n"><b>${fmt(fin)}</b></td>${per.map(cell).join("")}${res ? `<td class="n">${fmt(rv)}</td>` : ""}${typed[c.key] && dat != null ? `<td class="n" title="${esc(typed[c.key])}">${fmt(dat)}${mark}</td>` : `<td class="n">${fmt(dat)}</td>`}<td class="flagcol">${flags}</td></tr>`);
    });
    if (rows.length) {
      any = true;
      html += `<tr class="grp"><td colspan="${4 + M.PEOPLE.length + (res ? 1 : 0)}">${esc(g.name)}${g.scale === "abs" ? ' <span class="muted small" style="font-weight:400">· шкала абсолютная: 5 — как у гражданина или как из СПб</span>' : ""}</td></tr>` + rows.join("");
    }
  });
  if (!any) return `<tbody><tr><td class="muted small" style="padding:14px 16px">По этому месту пока нет ни одной оценки. Включите «Показать пустые», чтобы увидеть весь список.</td></tr></tbody>`;
  return html + "</tbody>";
}

export function placeScore(M, p, W) {
  if (M.isBase(p)) return { score: 3, coverage: 1, base: true };
  return M.total(p, W, "final");
}

export function placesListHTML(M, W, filter, connected = true) {
  const norm = s => String(s || "").toLowerCase().replace(/ё/g, "е");
  const q = norm(filter).trim();
  const order = { "финалист": 0, "кандидат": 1, "база": 2, "отсев": 3 };
  const key = p => (p.status !== "база" && M.vetoed(p) ? 3 : order[p.status] ?? 1.5);
  const list = M.places.filter(p => !q || norm(p.name).includes(q) || norm(p.country).includes(q));
  list.sort((a, b) => key(a) - key(b) || String(a.name).localeCompare(String(b.name), "ru"));
  const HEAD = ["Финалисты", "Кандидаты", "", "База", "Отсев и вето"], grp = p => (p.status === "база" ? 3 : key(p) === 3 ? 4 : key(p) === 0 ? 0 : 1);
  const many = !q && new Set(list.map(grp)).size > 1;
  if (!list.length) return `<p class="pad small muted">${q ? `Ничего не нашлось. Новое место добавляется через <a href="#/map">поиск на карте</a>.` : typeof connected === "string" ? esc(connected) : connected ? `Мест пока нет. Добавьте первое через поиск на <a href="#/map">карте</a>.` : `Места появятся после подключения данных: вставьте ключ в <a href="#/settings">настройках</a>.`}</p>`;
  let last = -1;
  return list.map(p => {
    const t = placeScore(M, p, W);
    const n = M.ratingsOf(p.id).length;
    const years = yearsLine(M, p.id);
    const out = p.status === "отсев" || M.vetoed(p);
    const g = grp(p), head = many && g !== last ? `<div class="plist-h">${HEAD[g]}</div>` : "";
    last = g;
    if (t.base) return `${head}<a class="prow" href="${placeHref(p.id)}"><i class="sw" style="background:var(--base)"></i><b>${esc(p.name)}</b><span class="score num">3.0</span>
      <span class="meta">${p.country ? `<span>${esc(p.country)}</span>` : ""}<span>точка отсчёта: с ним сравниваем все места</span></span></a>`;
    return `${head}<a class="prow" href="${placeHref(p.id)}"><i class="sw" style="background:${t.score == null ? "var(--none)" : scoreColor(t.score)}"></i><b>${esc(p.name)}</b><span class="score num">${fmt(t.score)}</span>
      <span class="meta">${p.country ? `<span>${esc(p.country)}</span>` : ""}<span>${esc(out && p.status !== "отсев" ? "вето" : p.status || "кандидат")}</span><span>${n ? "оценок: " + n : hiddenNote(M, p.id) || (t.score != null ? "только мировые данные" : "оценок нет")}</span>${years ? `<span title="Прожили бы здесь год? 0–10">прожили бы здесь год: ${esc(years)}</span>` : ""}${t.score != null && t.coverage < MIN_COVERAGE ? `<span>заполнено ${Math.round(t.coverage * 100)}%</span>` : ""}</span></a>`;
  }).join("");
}
