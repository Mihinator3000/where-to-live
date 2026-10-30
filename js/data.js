import { GitHubStore, StoreError, serialize } from "./store.js";
import { local, slug, uid } from "./util.js";

export const DEFAULT_REPO = "Mihinator3000/where-to-live-data";
const DIRS = ["places", "ratings", "weights"];

const pathOf = (dir, id) => `${dir}/${id}.json`;
const QUEUE = ["offline", "auth", "access", "timeout"];
const getK = (d, k) => { const [a, b] = k.split("."); const x = d ? d[a] : undefined; return b ? (x || {})[b] : x; };
const setK = (d, k, v) => { const [a, b] = k.split("."); if (!b) { d[a] = v; return; } const o = Object.assign({}, d[a]); if (v == null) delete o[b]; else o[b] = v; d[a] = o; };
const same = (a, b) => JSON.stringify(a == null || a === "" ? null : a) === JSON.stringify(b == null || b === "" ? null : b);
export { getK };

export function patchDoc(doc, patch, add) {
  const d = Object.assign({}, doc);
  Object.keys(patch || {}).forEach(k => setK(d, k, patch[k]));
  Object.keys(add || {}).forEach(k => { const v = String(add[k] || "").trim(), cur = d[k] ? String(d[k]).trim() : ""; if (v && !("\n" + cur + "\n").includes("\n" + v + "\n")) d[k] = cur ? cur + "\n" + v : v; });
  return d;
}

const LINES = ["questions"];
const lines = s => String(s == null ? "" : s).split("\n").map(x => x.trim()).filter(Boolean);
const grown = (was, now) => { const a = lines(was), b = lines(now); return a.every((x, i) => b[i] === x) ? b.slice(a.length) : null; };
export function lineMerge(remote, ch) {
  if (!ch.patch) return ch;
  const keys = LINES.filter(k => k in ch.patch && k in (ch.base || {}) && grown(ch.base[k], getK(remote, k)) && grown(ch.base[k], ch.patch[k]));
  if (!keys.length) return ch;
  const patch = Object.assign({}, ch.patch), base = Object.assign({}, ch.base), add = Object.assign({}, ch.add);
  keys.forEach(k => { const more = grown(base[k], patch[k]).join("\n"); delete patch[k]; delete base[k]; if (more) add[k] = add[k] ? more + "\n" + add[k] : more; });
  return Object.assign({}, ch, { patch, base, add });
}

export const overlap = (remote, ch) => Object.keys(ch.patch || {}).filter(k => !same(getK(remote, k), (ch.base || {})[k]) && !same(getK(remote, k), ch.patch[k]));

const created = (c, i) => i === 0 && c.baseOid === null && !c.patch && !c.add && c.path.startsWith("places/");
const pick = (o, ks) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => ks.includes(k)));

function fold(list) {
  const last = list[list.length - 1];
  if (!list.every((c, i) => c.patch || c.add || created(c, i))) return Object.assign({}, last, { patch: null, base: null, add: null });
  const patch = {}, base = {}, add = {};
  list.forEach(c => {
    Object.keys(c.patch || {}).forEach(k => { if (!(k in base)) base[k] = (c.base || {})[k]; patch[k] = c.patch[k]; delete add[k]; });
    Object.keys(c.add || {}).forEach(k => { add[k] = add[k] ? add[k] + "\n" + c.add[k] : c.add[k]; });
  });
  return Object.assign({}, last, { patch, base, add, baseOid: list[0].baseOid });
}

export class Data extends EventTarget {
  constructor() {
    super();
    const cache = local.get("cache", null);
    this.docs = (cache && cache.docs) || { places: [], ratings: [], weights: [] };
    this.oids = (cache && cache.oids) || {};
    this.head = (cache && cache.head) || null;
    this.loadedAt = (cache && cache.at) || null;
    this.pending = local.get("pending", []);
    this.status = "idle";
    this.error = "";
    this.broken = [];
    this.notice = "";
    this.store = null;
    this.busy = null;
    this.chain = Promise.resolve();
    this.configure();
    addEventListener("online", () => this.refresh());
  }

  get repo() { return local.get("repo", DEFAULT_REPO); }
  get token() { return local.get("token", ""); }
  get hasToken() { return !!this.token; }

  setCredentials(repo, token) {
    if (repo != null) local.set("repo", repo.trim() || DEFAULT_REPO);
    if (token != null) { if (token.trim()) local.set("token", token.trim()); else local.del("token"); }
    this.configure();
  }

  forget() {
    local.del("token");
    local.del("cache");
    this.docs = { places: [], ratings: [], weights: [] };
    this.oids = {};
    this.head = null;
    this.configure();
    this.emit();
  }

  configure() {
    const [owner, repo] = this.repo.split("/");
    this.store = this.token && owner && repo ? new GitHubStore({ owner, repo, token: this.token }) : null;
    this.status = this.store ? "idle" : "notoken";
  }

  emit() { this.dispatchEvent(new Event("change")); }

  serial(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  adopt() {
    const st = this.store;
    if (!st || !st.docs) return;
    this.docs = structuredClone(st.docs);
    this.oids = Object.assign({}, st.oids);
    this.head = st.head;
    local.set("cache", { docs: this.docs, oids: this.oids, head: this.head, at: this.loadedAt });
  }

  view() {
    const docs = { places: [...this.docs.places], ratings: [...this.docs.ratings], weights: [...this.docs.weights] };
    this.pending.forEach(ch => {
      const [dir, file] = ch.path.split("/");
      if (!DIRS.includes(dir)) return;
      const id = file.replace(/\.json$/, "");
      docs[dir] = docs[dir].filter(d => d.id !== id);
      if (ch.content != null) docs[dir].push(JSON.parse(ch.content));
    });
    const weights = {};
    docs.weights.forEach(d => { if (d.who && d.w) weights[d.who] = d.w; });
    return { places: docs.places, ratings: docs.ratings, weights, weightDocs: docs.weights };
  }

  oidOf(dir, id) { return this.oids[pathOf(dir, id)] || null; }

  keep() {
    if (local.set("pending", this.pending)) return true;
    local.del("cache");
    return local.set("pending", this.pending);
  }

  hold(changes, message, e) {
    this.pending.push(...changes.map(c => Object.assign({ message }, c)));
    if (this.keep()) return;
    this.pending = this.pending.slice(0, -changes.length);
    if (e.code === "offline") this.status = "offline"; else this.fail(e);
    this.emit();
    throw new StoreError("storage", "память браузера на этом устройстве переполнена");
  }

  fail(e) {
    this.status = e.code === "offline" ? "offline" : ["auth", "access", "forbidden"].includes(e.code) ? "auth" : "error";
    this.error = e.message;
    this.errorCode = e.code;
  }

  docOf(path) {
    const [dir, file] = path.split("/");
    return (this.docs[dir] || []).find(d => d.id === file.replace(/\.json$/, "")) || null;
  }

  rebase(c) {
    const remote = this.docOf(c.path);
    if (!c.patch && !c.add || !remote) return null;
    if (c.path.startsWith("ratings/") && c.patch && c.patch.deleted === true && !remote.deleted) return null;
    c = lineMerge(remote, c);
    if (overlap(remote, c).length) return null;
    const now = new Date().toISOString();
    return Object.assign({}, c, { content: serialize(Object.assign(patchDoc(remote, c.patch, c.add), { updatedAt: now })), baseOid: this.oids[c.path] || null });
  }

  async refresh() {
    if (!this.store) { this.status = "notoken"; this.emit(); return; }
    if (this.busy) return this.busy;
    this.busy = this.serial(async () => {
      this.status = "sync";
      this.emit();
      try {
        await this.flush();
        const res = await this.store.load();
        this.loadedAt = new Date().toISOString();
        this.adopt();
        this.status = this.pending.length ? "pending" : "live";
        this.error = res.bad.length ? "Не читаются файлы: " + res.bad.join(", ") : "";
        this.broken = res.bad;
      } catch (e) {
        this.adopt();
        this.fail(e);
      } finally {
        this.busy = null;
        this.emit();
      }
    });
    return this.busy;
  }

  async poll() {
    if (!this.store || this.busy) return;
    try {
      const head = await this.store.remoteHead();
      if (head !== this.head || this.pending.length || this.status === "error") await this.refresh();
      else if (this.status === "offline") { this.status = "live"; this.error = ""; this.emit(); }
    } catch (e) {
      if (e.code === "offline" && this.status !== "offline") { this.status = "offline"; this.emit(); }
      else if (["auth", "access"].includes(e.code)) { this.fail(e); this.emit(); }
    }
  }

  async flush() {
    for (let round = 0; this.pending.length && round < 6; round++) {
      const n = this.pending.length;
      const byPath = new Map();
      this.pending.forEach(c => {
        const b = byPath.get(c.path);
        if (b) { b.content = c.content; b.messages.push(c.message); }
        else byPath.set(c.path, { path: c.path, content: c.content, baseOid: c.baseOid, messages: [c.message] });
      });
      const batch = [...byPath.values()];
      try {
        await this.store.commit(batch.map(c => ({ path: c.path, content: c.content, baseOid: c.baseOid })), batch.flatMap(c => c.messages).join("; ").slice(0, 200));
        this.pending = this.pending.slice(n);
        this.flushed = (this.flushed || 0) + new Set(batch.flatMap(c => c.messages)).size;
      } catch (e) {
        if (e.code !== "clash") throw e;
        this.adopt();
        const keep = [], lost = [];
        e.paths.forEach(p => {
          const f = fold(this.pending.filter(c => c.path === p));
          const merged = this.rebase(f);
          if (merged) { keep.push(merged); return; }
          const remote = this.docOf(p), o = remote && f.patch && !(p.startsWith("ratings/") && f.patch.deleted === true) ? overlap(remote, lineMerge(remote, f)) : [];
          const rest = o.length ? Object.keys(f.patch).filter(k => !o.includes(k)) : [];
          const part = rest.length && this.rebase(Object.assign({}, f, { patch: pick(f.patch, rest), base: pick(f.base, rest) }));
          if (!part) { lost.push(f); return; }
          keep.push(part);
          lost.push(Object.assign({}, f, { patch: pick(f.patch, o), base: pick(f.base, o), add: null }));
        });
        if (lost.length) {
          local.set("lost", local.get("lost", []).concat(lost.map(c => Object.assign({ at: new Date().toISOString() }, c))).slice(-50));
          this.clashed = (this.clashed || 0) + lost.length;
          this.notice = "Не отправлено: это же изменили на другом устройстве.";
        }
        this.pending = this.pending.filter(c => !e.paths.includes(c.path)).concat(keep);
      }
      local.set("pending", this.pending);
      this.adopt();
    }
  }

  write(make, message) {
    if (!this.store) return Promise.reject(new StoreError("notoken", "Сначала вставьте ключ доступа в настройках"));
    return this.serial(async () => {
      let changes = typeof make === "function" ? make() : make;
      const queued = new Set(this.pending.map(c => c.path));
      if (changes.some(c => queued.has(c.path))) {
        const mine = changes.map(c => Object.assign({ message }, c));
        this.pending.push(...mine);
        if (!this.keep()) { this.pending = this.pending.filter(c => !mine.includes(c)); throw new StoreError("storage", "память браузера на этом устройстве переполнена"); }
        const since = new Date().toISOString();
        try {
          await this.flush();
          const lost = this.lost;
          const clashed = lost.filter(l => l.at >= since && mine.some(c => c.path === l.path));
          if (clashed.length) {
            local.set("lost", lost.filter(l => !clashed.includes(l)));
            this.clashed = Math.max(0, (this.clashed || 0) - clashed.length);
            if (this.lost.length === 0) this.notice = "";
            this.emit();
            throw Object.assign(new StoreError("clash", "Это уже изменили на другом устройстве"), { paths: clashed.map(l => l.path) });
          }
          this.retire(mine);
          this.status = "live";
          this.error = "";
          this.emit();
          return "sent";
        } catch (e) {
          this.adopt();
          if (e.code === "clash") throw e;
          if (!QUEUE.includes(e.code)) {
            this.pending = this.pending.filter(c => !mine.includes(c));
            local.set("pending", this.pending);
            this.fail(e); this.emit(); throw e;
          }
          if (e.code === "offline") this.status = "pending"; else this.fail(e);
          this.emit();
          return "queued";
        }
      }
      for (let round = 0; ; round++) {
        try {
          await this.flush();
          await this.store.commit(changes, message);
          this.adopt();
          this.retire(changes);
          this.status = "live";
          this.error = "";
          this.emit();
          return "sent";
        } catch (e) {
          this.adopt();
          if (e.code === "clash") {
            const next = round < 3 && changes.map(c => (!e.paths.includes(c.path) ? c : c.overwrite ? Object.assign({}, c, { baseOid: this.oids[c.path] || null }) : this.rebase(c)));
            if (next && next.every(Boolean)) { changes = next; continue; }
            const c = changes.find(x => e.paths.includes(x.path) && x.patch), remote = c && this.docOf(c.path);
            if (remote) e.theirs = overlap(remote, c).map(k => [k, getK(remote, k)]);
            this.emit(); throw e;
          }
          if (!QUEUE.includes(e.code)) { this.fail(e); this.emit(); throw e; }
          this.hold(changes, message, e);
          if (e.code === "offline") this.status = "pending"; else this.fail(e);
          this.emit();
          return "queued";
        }
      }
    });
  }

  newPlaceId(name) {
    const base = slug(name);
    const taken = new Set(this.view().places.map(p => p.id));
    let id = base, n = 2;
    while (taken.has(id)) id = `${base}-${n++}`;
    return id;
  }

  savePlace(place, isNew, baseOid) {
    const now = new Date().toISOString();
    const doc = Object.assign({}, place, { updatedAt: now, createdAt: place.createdAt || now });
    if (!doc.id) doc.id = this.newPlaceId(doc.name);
    return this.write([{ path: pathOf("places", doc.id), content: serialize(doc), baseOid: isNew ? null : baseOid || this.oidOf("places", doc.id) }], `${isNew ? "Add" : "Update"} place ${doc.id}`).then(r => ({ r, doc }));
  }

  saveRating(rating, { extra = [], isNew = !rating.id, baseOid, questions, patch, was } = {}) {
    const now = new Date().toISOString();
    const doc = Object.assign({}, rating, { id: rating.id || uid("r"), updatedAt: rating.updatedAt || now, createdAt: rating.createdAt || now, deleted: false });
    const base = isNew ? null : baseOid || this.oidOf("ratings", doc.id);
    const make = () => {
      const q = questions && this.view().places.find(p => p.id === doc.place);
      return extra.concat(q ? [this.placeChange(q, {}, { questions })] : [], [Object.assign({ path: pathOf("ratings", doc.id), content: serialize(doc), baseOid: base }, !isNew && patch ? { patch, base: was || {} } : {})]);
    };
    return this.write(make, `${isNew ? "Add" : "Update"} rating ${doc.id}`).then(r => ({ r, doc }));
  }

  updatePlace(id, patch, { base } = {}) {
    let doc = null;
    return this.write(() => {
      const cur = this.view().places.find(p => p.id === id);
      if (!cur) throw new StoreError("gone", "Этого места больше нет в данных");
      const path = pathOf("places", id), queued = this.pending.some(c => c.path === path);
      const remote = base && !queued && this.docOf(path), o = remote ? overlap(remote, { patch, base }) : [];
      if (o.length) throw Object.assign(new StoreError("clash", "Это только что изменили на другом устройстве"), { paths: [path], theirs: o.map(k => [k, getK(remote, k)]) });
      const ch = this.placeChange(cur, patch, null, base);
      doc = JSON.parse(ch.content);
      return [ch];
    }, `Update place ${id}`).then(r => ({ r, doc }));
  }

  deleteRating(rating, baseOid) {
    const doc = Object.assign({}, rating, { deleted: true, updatedAt: new Date().toISOString() });
    return this.write([{ path: pathOf("ratings", doc.id), content: serialize(doc), baseOid: baseOid || this.oidOf("ratings", doc.id), patch: { deleted: true }, base: { deleted: rating.deleted == null ? null : rating.deleted } }], `Delete rating ${doc.id}`);
  }

  get lost() { return local.get("lost", []); }

  get queued() { return new Set(this.pending.map(c => c.message || c.path)).size; }

  retire(changes) {
    const l = this.lost;
    const out = l.map(x => {
      const c = changes.find(y => y.path === x.path);
      if (!c) return x;
      if (!c.patch || !x.patch) return null;
      const left = Object.keys(x.patch).filter(k => !(k in c.patch));
      if (!left.length && !Object.keys(x.add || {}).length) return null;
      return Object.assign({}, x, { patch: pick(x.patch, left), base: pick(x.base, left) });
    }).filter(Boolean);
    if (JSON.stringify(out) === JSON.stringify(l)) return;
    local.set("lost", out);
    if (!out.length) this.notice = "";
  }

  dropLost(i) {
    const l = this.lost;
    l.splice(i, 1);
    local.set("lost", l);
    if (!l.length) this.notice = "";
    this.emit();
  }

  applyLost(i) {
    const item = this.lost[i];
    if (!item) return Promise.resolve(null);
    return this.write(() => {
      const remote = (item.patch || item.add) && this.docOf(item.path);
      const content = remote ? serialize(Object.assign(patchDoc(remote, item.patch, item.add), { updatedAt: new Date().toISOString() })) : item.content;
      const was = remote && item.patch ? Object.fromEntries(Object.keys(item.patch).map(k => [k, getK(remote, k)])) : null;
      return [Object.assign({ path: item.path, content, baseOid: this.oids[item.path] || null }, was ? { patch: item.patch, base: was, add: item.add || null } : {})];
    }, (item.message || "Apply") + " (повтор)").then(r => {
      const j = this.lost.findIndex(l => l.path === item.path && l.at === item.at);
      if (j >= 0) this.dropLost(j);
      return r;
    });
  }

  saveWeights(who, w) {
    const id = slug(who);
    const doc = { id, who, w, updatedAt: new Date().toISOString() };
    const path = pathOf("weights", id), queued = this.pending.find(c => c.path === path);
    return this.write([{ path, content: serialize(doc), baseOid: queued ? queued.baseOid : this.oids[path] || null, overwrite: true }], `Update weights ${id}`);
  }

  placeChange(place, patch, add, base) {
    const now = new Date().toISOString();
    const doc = Object.assign(patch || add ? patchDoc(place, patch, add) : Object.assign({}, place), { updatedAt: now, createdAt: place.createdAt || now });
    const ch = { path: pathOf("places", doc.id), content: serialize(doc), baseOid: this.oidOf("places", doc.id) };
    if (patch || add) Object.assign(ch, { patch: patch || {}, base: base || Object.fromEntries(Object.keys(patch || {}).map(k => [k, getK(place, k)])), add: add || null });
    return ch;
  }
}
