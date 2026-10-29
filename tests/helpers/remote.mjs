import { blobOid } from "../../js/store.js";

export function makeRemote(files) {
  const state = { head: "h0", files: Object.assign({}, files), n: 0, offlineNext: 0, dropResponseNext: 0, failNext: 0, log: [] };
  const commit = (adds, dels) => {
    for (const a of adds) state.files[a.path] = Buffer.from(a.contents, "base64").toString("utf8");
    for (const d of dels) delete state.files[d.path];
    state.head = "h" + (++state.n);
  };
  const res = (status, body, headers = {}) => new Response(status === 304 ? null : (typeof body === "string" ? body : JSON.stringify(body)), { status, headers });
  const fetchImpl = async (url, opts) => {
    if (state.offlineNext > 0) { state.offlineNext--; throw new TypeError("Load failed"); }
    if (state.failNext > 0) { state.failNext--; return new Response(JSON.stringify({ message: "Server Error" }), { status: 502 }); }
    const u = new URL(url);
    const h = opts.headers || {};
    state.log.push(opts.method + " " + u.pathname);
    if (u.pathname === "/graphql") {
      const { query, variables } = JSON.parse(opts.body);
      if (query.includes("createCommitOnBranch")) {
        const inp = variables.input;
        if (inp.expectedHeadOid !== state.head) return res(200, { data: null, errors: [{ type: "STALE_DATA", message: `Expected branch to point to "${inp.expectedHeadOid}" but it did not. Pull and try again.` }] });
        commit(inp.fileChanges.additions || [], inp.fileChanges.deletions || []);
        if (state.dropResponseNext > 0) { state.dropResponseNext--; throw new TypeError("Load failed"); }
        return res(200, { data: { createCommitOnBranch: { commit: { oid: state.head } } } });
      }
      const dirs = {};
      for (const [p, text] of Object.entries(state.files)) {
        const [d, f] = p.split("/");
        (dirs[d] = dirs[d] || []).push({ name: f, oid: await blobOid(text), object: { text, isTruncated: false } });
      }
      return res(200, { data: { repository: { ref: { target: { oid: state.head, tree: { oid: "t-" + state.head, entries: Object.entries(dirs).map(([name, entries]) => ({ name, type: "tree", object: { entries } })) } } } } } });
    }
    if (u.pathname.endsWith("/commits/main")) {
      const etag = `W/"${state.head}"`;
      if (h["If-None-Match"] === etag) return res(304, "");
      return res(200, state.head, { ETag: etag });
    }
    return res(404, {});
  };
  return { state, fetchImpl };
}
