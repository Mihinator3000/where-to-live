import { fmt, MIN_COVERAGE } from "./calc.js";
import { esc, heatStyle, scoreColor } from "./util.js";
import { CONF, datesRu } from "./form.js";

export const SHORT = { legal: "Легализ.", money: "Деньги", work: "Работа", health: "Здоровье", safety: "Безоп.", climate: "Климат", housing: "Жильё", city: "Город", nature: "Природа", people: "Люди", links: "Связь" };
const pct = v => ((v - 1) / 4 * 100).toFixed(2) + "%";
export const placeHref = id => "#/place/" + encodeURIComponent(id);
const personClass = (M, who) => (who === M.PEOPLE[1] ? "v" : "m");

const hidden = (M, id, w) => !!(M.hidden && M.hidden(id, w));
export const hiddenWho = (M, id) => M.PEOPLE.filter(w => hidden(M, id, w));
export const hasResidents = M => M.places.some(p => p.ext && Object.values(p.ext).some(e => e && e.res != null));
export const hiddenNote = (M, id) => { const w = hiddenWho(M, id); return w.length ? `оценка ${w.join(", ")} скрыта до вашей` : ""; };

export function yearsLine(M, id) {
  return M.PEOPLE.map(w => { const y = hidden(M, id, w) ? null : M.latestYear(id, w); return y == null ? null : `${w} ${y}/10`; }).filter(Boolean).join(" · ");
}

export function rankHTML(M, W) {
  const r = M.ranking(W);
  const ticks = [1, 2, 3, 4, 5].map(v => `<span style="left:${pct(v)}">${v === 3 ? "3 · СПб" : v}</span>`).join("");
  let html = `<div class="rank-axis"><span></span><span></span><div class="ticks num">${ticks}</div><span></span></div>`;
  const people = row => M.PEOPLE.map((w, i) => row.per[w] == null || hidden(M, row.p.id, w) ? "" : `<span class="dot ${i ? "v" : "m"}" style="left:${pct(row.per[w])}" data-tip="${esc(w)}: ${fmt(row.per[w])}"></span>`).join("");
  const own = r.rated.filter(row => M.ownEnough(row.p.id)), dataOnly = r.rated.filter(row => !M.ownEnough(row.p.id));
  const rowHTML = (row, pos, pale) => {
    const s = row.t.score, lo = Math.min(s, 3), hi = Math.max(s, 3);
    const rr = row.range;
    const rangeChip = !pale && rr && rr.min !== rr.max ? `№${rr.min}–${rr.max} в зависимости от весов` : "";
    const years = yearsLine(M, row.p.id);
    const share = M.ownShare(row.p.id), note = hiddenNote(M, row.p.id);
    const why = !pale ? "" : note || (share ? `своих ответов на ★: ${Math.round(share * M.STAR_KEYS.length)} из ${M.STAR_KEYS.length}` : "только мировые данные");
    return `<a class="row${pale ? " pale" : ""}" href="${placeHref(row.p.id)}">
      <span class="pos num">${pale ? "·" : pos}</span>
      <div class="name"><b>${esc(row.p.name)}</b><div class="chips">${row.p.country ? `<span class="chip">${esc(row.p.country)}</span>` : ""}${why ? `<span class="chip">${esc(why)}</span>` : ""}${rangeChip ? `<span class="chip">${rangeChip}</span>` : ""}${row.t.coverage < 0.7 ? `<span class="chip">заполнено ${Math.round(row.t.coverage * 100)}%</span>` : ""}${years ? `<span class="chip" title="Прожили бы здесь год? 0–10">год здесь: ${esc(years)}</span>` : ""}</div></div>
      <div class="track"><span class="base"></span><span class="bar ${s >= 3 ? "up" : "down"}" style="left:${pct(lo)};width:calc(${pct(hi)} - ${pct(lo)})" data-tip="Итог: ${fmt(s)}"></span>${people(row)}</div>
      <div class="score num">${fmt(s)}<small>из 5</small></div>
    </a>`;
  };
  own.forEach((row, i) => { html += rowHTML(row, i + 1, false); });
  if (!own.length) html += `<div class="empty-row">Своих оценок пока нет. Место попадёт сюда, когда отвечено хотя бы на половину главных вопросов ★.</div>`;
  r.base.forEach(p => {
    html += `<a class="row" href="${placeHref(p.id)}"><span class="pos num">—</span><div class="name"><b>${esc(p.name)}</b><div class="chips"><span class="chip solid">база</span></div></div><div class="track"><span class="base"></span></div><div class="score num">3.0<small>по определению</small></div></a>`;
  });
  if (dataOnly.length) {
    html += `<div class="rank-sub">Мало своих оценок — итог в основном по мировым данным</div>`;
    dataOnly.forEach(row => { html += rowHTML(row, 0, true); });
  }
  if (r.thin.length) html += `<div class="empty-row">Мало данных для рейтинга (заполнено меньше ${MIN_COVERAGE * 100}%): ${r.thin.map(x => `<a href="${placeHref(x.p.id)}">${esc(x.p.name)}</a> — ${Math.round(x.t.coverage * 100)}%`).join(", ")}</div>`;
  if (r.unrated.length) html += `<div class="empty-row">Ещё без оценок и данных: ${r.unrated.map(x => `<a href="${placeHref(x.p.id)}">${esc(x.p.name)}</a>`).join(", ")}</div>`;
  if (r.out.length) html += `<div class="empty-row">Отсев: ${r.out.map(x => `<a href="${placeHref(x.p.id)}">${esc(x.p.name)}</a> — ${esc(x.why)}`).join("; ")}</div>`;
  return html;
}

export function heatHTML(M, W) {
  const list = M.candidates().map(p => ({ p, s: M.total(p, W, "final").score }));
  list.sort((a, b) => (b.s == null ? -9 : b.s) - (a.s == null ? -9 : a.s));
  const rows = M.places.filter(M.isBase).map(p => ({ p })).concat(list);
  let html = `<thead><tr><th>Место</th>${M.GROUPS.map(g => `<th title="${esc(g.name)}">${SHORT[g.key] || esc(g.name)}</th>`).join("")}</tr></thead><tbody>`;
  rows.forEach(({ p }) => {
    html += `<tr><th class="rowh"><a href="${placeHref(p.id)}">${esc(p.name)}</a></th>`;
    M.GROUPS.forEach(g => {
      const v = M.groupScore(p, g.key, "final");
      const strong = v != null && Math.abs(v - 3) >= 1.4;
      html += `<td class="cell${v == null ? " none" : ""}${strong ? " strong" : ""}" style="${heatStyle(v)}" data-tip="${esc(p.name)} · ${esc(g.name)}: ${fmt(v)}">${fmt(v)}</td>`;
    });
    html += "</tr>";
  });
  return html + "</tbody>";
}

export function flagsHTML(M) {
  const label = { crit: "красный флаг", serious: "разногласие", warn: "иллюзия туриста", info: "недооценили" };
  const shown = M.allFlags(), off = M.full ? Math.max(0, M.full.allFlags().length - shown.length) : 0;
  const note = off ? `<p class="small muted">Ещё ${off} — по местам, которые вы сами пока не оценили: скрыты, чтобы не подглядывать.</p>` : "";
  return {
    count: shown.length,
    html: shown.length
      ? shown.map(f => `<div class="flag"><span class="sev ${f.sev}">${label[f.sev]}</span><div class="t"><a href="${placeHref(f.place)}">${esc(f.head)}</a><small>${esc(f.text)}</small></div></div>`).join("") + note
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
    { src: "data", color: "var(--data)", dash: "5 4", fill: false, label: "Данные" },
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


export function notesText(M, notes) {
  return Object.keys(notes || {}).filter(k => notes[k]).map(k => `${(M.GROUP[k] && M.GROUP[k].name) || k}: ${notes[k]}`).join("\n");
}

export function tripsHTML(M, p, editable, me) {
  if (M.isBase(p)) return `<p class="small muted">СПб — точка отсчёта: по бытовым группам 3 по определению. Позже сюда придут данные и отзывы, включая риски варианта «остаться».</p>`;
  const rs = M.ratingsOf(p.id).slice().sort((a, b) => String(b.start || b.updatedAt || "").localeCompare(String(a.start || a.updatedAt || "")));
  const years = M.PEOPLE.map(w => { const y = hidden(M, p.id, w) ? "скрыто" : M.latestYear(p.id, w); return `<span>${esc(w)} <b>${y == null ? "—" : esc(y)}</b>${y == null || y === "скрыто" ? "" : "/10"}</span>`; }).join("");
  if (!rs.length && !hiddenWho(M, p.id).length) return `<div class="year"><span class="muted">Прожили бы здесь год?</span><div class="yv">${years}</div></div><p class="small muted">Своих оценок пока нет.</p>`;
  let html = `<div class="year"><span class="muted">Прожили бы здесь год?</span><div class="yv">${years}</div></div>`;
  if (!rs.length) html += `<p class="small muted">Ваших оценок здесь пока нет.</p>`;
  rs.forEach(r => {
    const cls = personClass(M, r.who);
    const filled = M.STAR_KEYS.filter(k => r.scores && r.scores[k] != null).length;
    const dates = r.start ? datesRu(r.start, r.end) : "даты не указаны";
    const facts = [r.days ? r.days + " дн." : "", r.season, r.mode, r.housing, r.retro ? "по памяти" : ""].filter(Boolean).map(esc).join(" · ");
    const notes = [notesText(M, r.notes), r.surprises].filter(Boolean).join("\n\n");
    const mine = !me || r.who === me;
    html += `<div class="trip" data-rid="${esc(r.id)}"><div class="who"><i class="sw ${cls}"></i>${esc(r.who)}<span class="muted small" style="font-weight:400">· ${esc(dates)}</span></div>
      ${facts ? `<div class="small muted">${facts}</div>` : ""}
      ${r.review ? `<div class="review ${cls}">${esc(r.review)}</div>` : ""}
      <div class="small">★ заполнено: <span class="num">${filled} из ${M.STAR_KEYS.length}</span>${r.veto ? ` · <span class="sev crit">вето: ${esc(r.veto)}</span>` : ""}</div>
      ${notes ? `<details><summary class="small">Комментарии</summary><pre>${esc(notes)}</pre></details>` : ""}
      ${editable && mine ? `<div><a class="btn ghost small" href="#/rate/${encodeURIComponent(r.id)}">Изменить</a></div>` : ""}</div>`;
  });
  hiddenWho(M, p.id).forEach(w => { html += `<div class="trip hidden-trip"><div class="small">${esc(w)}: оценка скрыта, пока вы не оцените это место сами, чтобы не подглядывать.</div><button type="button" class="linkbtn small" data-reveal="${esc(p.id)}">Показать всё равно</button></div>`; });
  return html;
}

export function subtableHTML(M, p, showEmpty) {
  const res = hasResidents(M);
  let html = `<thead><tr><th>Подкатегория</th><th class="n">Итог</th>${M.PEOPLE.map(w => `<th class="n">${esc(w)}</th>`).join("")}${res ? `<th class="n">Живущие</th>` : ""}<th class="n">Данные</th><th>Флаг</th></tr></thead><tbody>`;
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
      const cell = (v, i) => hidden(M, p.id, M.PEOPLE[i]) ? `<td class="n muted" title="скрыто, пока вы не оцените сами">·</td>` : `<td class="n">${fmt(v)}${v != null && conf[i] ? `<span class="c" title="${esc(CONF[conf[i]] || "")}">${esc(conf[i])}</span>` : ""}</td>`;
      rows.push(`<tr><td>${c.star ? '<span class="star" title="Главный вопрос каждой поездки">★</span> ' : ""}${esc(c.name)}</td><td class="n"><b>${fmt(fin)}</b></td>${per.map(cell).join("")}${res ? `<td class="n">${fmt(rv)}</td>` : ""}<td class="n">${fmt(dat)}</td><td>${flags}</td></tr>`);
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
  const q = (filter || "").trim().toLowerCase();
  const order = { "финалист": 0, "кандидат": 1, "база": 2, "отсев": 3 };
  const list = M.places.filter(p => !q || p.name.toLowerCase().includes(q) || String(p.country || "").toLowerCase().includes(q));
  list.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || a.name.localeCompare(b.name, "ru"));
  if (!list.length) return `<p class="pad small muted">${q ? `Ничего не нашлось. Новое место добавляется через <a href="#/map">поиск на карте</a>.` : connected ? "Мест пока нет. Добавьте первое через поиск на карте." : `Места появятся после подключения данных: вставьте ключ в <a href="#/settings">настройках</a>.`}</p>`;
  return list.map(p => {
    const t = placeScore(M, p, W);
    const n = M.ratingsOf(p.id).length;
    const years = yearsLine(M, p.id);
    const out = p.status === "отсев" || M.vetoed(p);
    return `<a class="prow" href="${placeHref(p.id)}"><i class="sw" style="background:${t.score == null ? "var(--none)" : scoreColor(t.score)}"></i><b>${esc(p.name)}</b><span class="score num">${t.base ? "база" : fmt(t.score)}</span>
      <span class="meta">${p.country ? `<span>${esc(p.country)}</span>` : ""}<span>${esc(out && p.status !== "отсев" ? "вето" : p.status || "кандидат")}</span><span>${n ? "оценок: " + n : hiddenNote(M, p.id) || (t.score != null && !t.base ? "только мировые данные" : "оценок нет")}</span>${years ? `<span>год здесь: ${esc(years)}</span>` : ""}${!t.base && t.score != null && t.coverage < MIN_COVERAGE ? `<span>заполнено ${Math.round(t.coverage * 100)}%</span>` : ""}</span></a>`;
  }).join("");
}
