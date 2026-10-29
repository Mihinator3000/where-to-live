const API = "https://api.github.com";
const DIRS = ["places", "ratings", "weights"];

export class StoreError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function b64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const READ = `query($owner:String!,$name:String!,$ref:String!){
  repository(owner:$owner,name:$name){
    ref(qualifiedName:$ref){ target{ oid ... on Commit { tree { oid entries { name type object { ... on Tree { entries { name oid object { ... on Blob { text isTruncated } } } } } } } } } }
  }
}`;

const WRITE = `mutation($input:CreateCommitOnBranchInput!){ createCommitOnBranch(input:$input){ commit{ oid } } }`;

export function serialize(doc) {
  return JSON.stringify(doc, null, 1) + "\n";
}

export async function blobOid(text) {
  const body = new TextEncoder().encode(text);
  const head = new TextEncoder().encode("blob " + body.length + "\0");
  const all = new Uint8Array(head.length + body.length);
  all.set(head);
  all.set(body, head.length);
  const hash = await crypto.subtle.digest("SHA-1", all);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
}

export class GitHubStore {
  constructor({ owner, repo, branch = "main", token, fetchImpl }) {
    this.owner = owner;
    this.repo = repo;
    this.branch = branch;
    this.token = token;
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.head = null;
    this.tree = null;
    this.oids = {};
    this.docs = null;
    this.etag = null;
    this.etagSha = null;
    this.mode = "graphql";
  }

  async call(method, path, body, extra = {}) {
    let res;
    try {
      res = await this.fetch(API + path, {
        method,
        cache: "no-cache",
        headers: Object.assign({ Authorization: "Bearer " + this.token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }, body ? { "Content-Type": "application/json" } : {}, extra),
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new StoreError("offline", "Нет связи с GitHub");
    }
    if (res.status === 401) throw new StoreError("auth", "Токен не подходит или истёк");
    if (res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")) throw new StoreError("limit", "GitHub ограничил запросы, попробуйте через минуту");
    return res;
  }

  async gql(query, variables) {
    const res = await this.call("POST", "/graphql", { query, variables });
    if (res.status === 403) throw new StoreError("forbidden", "Токену не хватает прав");
    if (!res.ok) throw new StoreError("http", "GitHub ответил " + res.status);
    const body = await res.json();
    if (body.errors && body.errors.length) {
      const m = body.errors.map(e => e.message).join("; ");
      const types = body.errors.map(e => e.type || "").join(" ");
      if (/expected.*head|head.*expected|is at .* but expected/i.test(m) || /STALE_DATA/.test(types)) throw new StoreError("conflict", m);
      if (/FORBIDDEN/.test(types) || /not accessible by/i.test(m)) throw new StoreError("forbidden", m);
      if (/NOT_FOUND/.test(types) || /could not resolve to a repository/i.test(m)) throw new StoreError("access", "Репозиторий не найден или токен без доступа к нему");
      throw new StoreError("graphql", m);
    }
    return body.data;
  }

  async load() {
    const data = await this.gql(READ, { owner: this.owner, name: this.repo, ref: "refs/heads/" + this.branch });
    const repo = data && data.repository;
    if (!repo) throw new StoreError("access", "Репозиторий не найден или токен без доступа к нему");
    if (!repo.ref) throw new StoreError("empty", "В репозитории нет ветки " + this.branch);
    const out = { places: [], ratings: [], weights: [] };
    const oids = {};
    const bad = [];
    (repo.ref.target.tree.entries || []).forEach(dir => {
      if (dir.type !== "tree" || !DIRS.includes(dir.name)) return;
      (dir.object.entries || []).forEach(f => {
        if (!f.name.endsWith(".json") || !f.object || f.object.text == null) return;
        const path = dir.name + "/" + f.name;
        oids[path] = f.oid;
        if (f.object.isTruncated) { bad.push(path); return; }
        try {
          const doc = JSON.parse(f.object.text);
          doc.id = doc.id || f.name.slice(0, -5);
          out[dir.name].push(doc);
        } catch (e) {
          bad.push(path);
        }
      });
    });
    this.head = repo.ref.target.oid;
    this.tree = repo.ref.target.tree.oid;
    this.oids = oids;
    this.docs = out;
    return { head: this.head, docs: out, oids, bad };
  }

  async remoteHead() {
    const res = await this.call("GET", `/repos/${this.owner}/${this.repo}/commits/${this.branch}`, null, Object.assign({ Accept: "application/vnd.github.sha" }, this.etag ? { "If-None-Match": this.etag } : {}));
    if (res.status === 304 && this.etagSha) return this.etagSha;
    if (!res.ok) throw new StoreError(res.status === 404 ? "access" : "http", "GitHub ответил " + res.status);
    const sha = (await res.text()).trim();
    this.etag = res.headers.get("ETag");
    this.etagSha = sha;
    return sha;
  }

  async commitGraphql(changes, message) {
    const additions = changes.filter(c => c.content != null).map(c => ({ path: c.path, contents: b64(c.content) }));
    const deletions = changes.filter(c => c.content == null).map(c => ({ path: c.path }));
    const data = await this.gql(WRITE, {
      input: {
        branch: { repositoryNameWithOwner: this.owner + "/" + this.repo, branchName: this.branch },
        message: { headline: message },
        expectedHeadOid: this.head,
        fileChanges: { additions, deletions },
      },
    });
    return data.createCommitOnBranch.commit.oid;
  }

  async commitRest(changes, message) {
    const base = `/repos/${this.owner}/${this.repo}/git`;
    const json = async res => {
      if (res.status === 403 || res.status === 404) throw new StoreError("forbidden", "Токену не хватает прав на запись (нужно Contents: Read and write)");
      if (!res.ok) throw new StoreError("http", "GitHub ответил " + res.status);
      return res.json();
    };
    const tree = await json(await this.call("POST", base + "/trees", {
      base_tree: this.tree,
      tree: changes.map(c => (c.content == null ? { path: c.path, mode: "100644", type: "blob", sha: null } : { path: c.path, mode: "100644", type: "blob", content: c.content })),
    }));
    const commit = await json(await this.call("POST", base + "/commits", { message, tree: tree.sha, parents: [this.head] }));
    const res = await this.call("PATCH", base + "/refs/heads/" + this.branch, { sha: commit.sha, force: false });
    if (res.status === 422 || res.status === 409) throw new StoreError("conflict", "Ветка ушла вперёд");
    await json(res);
    this.tree = tree.sha;
    return commit.sha;
  }

  applyDocs(changes) {
    if (!this.docs) return;
    for (const c of changes) {
      const [dir, file] = c.path.split("/");
      if (!this.docs[dir]) continue;
      const id = file.replace(/\.json$/, "");
      this.docs[dir] = this.docs[dir].filter(d => d.id !== id);
      if (c.content != null) {
        const doc = JSON.parse(c.content);
        doc.id = doc.id || id;
        this.docs[dir].push(doc);
      }
    }
  }

  async commit(changes, message) {
    if (!this.head) await this.load();
    for (let attempt = 0; attempt < 4; attempt++) {
      const todo = [], clash = [];
      for (const c of changes) {
        const cur = this.oids[c.path] || null;
        if (c.baseOid === undefined || cur === (c.baseOid || null)) { todo.push(c); continue; }
        const done = c.content == null ? cur == null : cur === (await blobOid(c.content));
        if (!done) clash.push(c.path);
      }
      if (clash.length) throw Object.assign(new StoreError("clash", "Это только что изменили с другого телефона: " + clash.join(", ")), { paths: clash });
      if (!todo.length) return this.head;
      try {
        let oid;
        if (this.mode === "graphql") {
          try { oid = await this.commitGraphql(todo, message); }
          catch (e) { if (e.code !== "forbidden") throw e; this.mode = "rest"; }
        }
        if (this.mode === "rest") {
          if (!this.tree) await this.load();
          oid = await this.commitRest(todo, message);
        }
        this.head = oid;
        for (const c of todo) {
          if (c.content == null) delete this.oids[c.path];
          else this.oids[c.path] = await blobOid(c.content);
        }
        this.applyDocs(todo);
        if (this.mode === "graphql") this.tree = null;
        return this.head;
      } catch (e) {
        if (e.code !== "conflict" || attempt === 3) throw e;
        await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
        await this.load();
      }
    }
  }
}
