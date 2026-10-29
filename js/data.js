import { GitHubStore, StoreError, serialize } from "./store.js";
import { local, slug, uid } from "./util.js";

export const DEFAULT_REPO = "Mihinator3000/where-to-live-data";
const DIRS = ["places", "ratings", "weights"];

const pathOf = (dir, id) => `${dir}/${id}.json`;

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
    local.del("draft");
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

  fail(e) {
    this.status = e.code === "offline" ? "offline" : e.code === "auth" || e.code === "access" ? "auth" : "error";
    this.error = e.message;
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
    }
  }

  async flush() {
    while (this.pending.length) {
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
      } catch (e) {
        if (e.code !== "clash") throw e;
        const lost = this.pending.filter(c => e.paths.includes(c.path));
        local.set("lost", local.get("lost", []).concat(lost.map(c => Object.assign({ at: new Date().toISOString() }, c))).slice(-50));
        this.pending = this.pending.filter(c => !e.paths.includes(c.path));
        this.notice = "Не отправлено: это же изменили с другого телефона (" + e.paths.join(", ") + "). Ваша версия есть в экспорте JSON в настройках.";
      }
      local.set("pending", this.pending);
      this.adopt();
    }
  }

  write(changes, message) {
    if (!this.store) return Promise.reject(new StoreError("notoken", "Сначала вставьте ключ доступа в настройках"));
    return this.serial(async () => {
      try {
        await this.flush();
        await this.store.commit(changes, message);
        this.adopt();
        this.status = "live";
        this.error = "";
        this.emit();
        return "sent";
      } catch (e) {
        this.adopt();
        if (e.code !== "offline") { this.fail(e); this.emit(); throw e; }
        changes.forEach(c => this.pending.push(Object.assign({ message }, c)));
        local.set("pending", this.pending);
        this.status = "pending";
        this.emit();
        return "queued";
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

  savePlace(place, isNew) {
    const now = new Date().toISOString();
    const doc = Object.assign({}, place, { updatedAt: now, createdAt: place.createdAt || now });
    if (!doc.id) doc.id = this.newPlaceId(doc.name);
    return this.write([{ path: pathOf("places", doc.id), content: serialize(doc), baseOid: isNew ? null : this.oidOf("places", doc.id) }], `${isNew ? "Add" : "Update"} place ${doc.id}`).then(r => ({ r, doc }));
  }

  saveRating(rating, extra = []) {
    const now = new Date().toISOString();
    const isNew = !rating.id;
    const doc = Object.assign({}, rating, { id: rating.id || uid("r"), updatedAt: now, createdAt: rating.createdAt || now, deleted: false });
    const changes = extra.concat([{ path: pathOf("ratings", doc.id), content: serialize(doc), baseOid: isNew ? null : this.oidOf("ratings", doc.id) }]);
    return this.write(changes, `${isNew ? "Add" : "Update"} rating ${doc.id}`).then(r => ({ r, doc }));
  }

  deleteRating(rating) {
    const doc = Object.assign({}, rating, { deleted: true, updatedAt: new Date().toISOString() });
    return this.write([{ path: pathOf("ratings", doc.id), content: serialize(doc), baseOid: this.oidOf("ratings", doc.id) }], `Delete rating ${doc.id}`);
  }

  saveWeights(who, w) {
    const id = slug(who);
    const doc = { id, who, w, updatedAt: new Date().toISOString() };
    return this.write([{ path: pathOf("weights", id), content: serialize(doc) }], `Update weights ${id}`);
  }

  placeChange(place) {
    const now = new Date().toISOString();
    const doc = Object.assign({}, place, { updatedAt: now, createdAt: place.createdAt || now });
    return { path: pathOf("places", doc.id), content: serialize(doc), baseOid: null };
  }
}
