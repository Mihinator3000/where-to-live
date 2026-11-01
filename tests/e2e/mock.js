(() => {
  if (location.hostname !== "127.0.0.1") return;
  const real = window.fetch.bind(window);
  const get = () => JSON.parse(localStorage.getItem("mock:files") || "null");
  const save = f => localStorage.setItem("mock:files", JSON.stringify(f));
  const head = () => localStorage.getItem("mock:head") || "h0";
  const log = e => { const l = JSON.parse(localStorage.getItem("mock:log") || "[]"); l.push(e); localStorage.setItem("mock:log", JSON.stringify(l)); };
  const sha1 = async t => {
    const b = new TextEncoder().encode(t), h = new TextEncoder().encode("blob " + b.length + "\0");
    const all = new Uint8Array(h.length + b.length); all.set(h); all.set(b, h.length);
    return [...new Uint8Array(await crypto.subtle.digest("SHA-1", all))].map(x => x.toString(16).padStart(2, "0")).join("");
  };
  const json = (o, st = 200, hd = {}) => new Response(JSON.stringify(o), { status: st, headers: Object.assign({ "Content-Type": "application/json" }, hd) });
  const geo = (name, country, cc, lat, lon) => ({ name, display_name: `${name}, ${country}`, lat: String(lat), lon: String(lon), osm_type: "relation", osm_id: Math.round(lat * 1000 + lon), addresstype: "town", address: { town: name, country, country_code: cc } });
  const GEO = [geo("Херцег-Нови", "Черногория", "me", 42.4531, 18.5375), geo("Бар", "Черногория", "me", 42.0931, 19.1003), geo("Порту", "Португалия", "pt", 41.1496, -8.611)];
  window.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith("https://nominatim.openstreetmap.org/")) {
      await new Promise(r => setTimeout(r, 100));
      const u = new URL(url);
      if (u.pathname === "/search") { const q = (u.searchParams.get("q") || "").toLowerCase(); return json(GEO.filter(g => g.name.toLowerCase().includes(q) || q === "*")); }
      if (u.pathname === "/reverse") return json(GEO[0]);
      return json({ error: "unknown" }, 404);
    }
    if (!url.startsWith("https://api.github.com/")) return real(input, init);
    await new Promise(r => setTimeout(r, Number(localStorage.getItem("mock:delay") || 150)));
    while (localStorage.getItem("mock:hold") === "1") await new Promise(r => setTimeout(r, 40));
    if (localStorage.getItem("mock:offline") === "1") throw new TypeError("Failed to fetch");
    const auth = (init.headers && (init.headers.Authorization || init.headers.authorization)) || "";
    if (!/^Bearer github_pat_TEST/.test(auth)) return json({ message: "Bad credentials" }, 401);
    const files = get();
    if (!files) return json({ data: { repository: null } });
    const path = new URL(url).pathname;
    if (path === "/graphql") {
      const { query, variables } = JSON.parse(init.body);
      if (query.includes("createCommitOnBranch")) {
        const inp = variables.input;
        if (inp.expectedHeadOid !== head()) return json({ data: null, errors: [{ type: "STALE_DATA", message: "Expected branch to point to " + inp.expectedHeadOid }] });
        for (const a of inp.fileChanges.additions || []) { files[a.path] = new TextDecoder().decode(Uint8Array.from(atob(a.contents), c => c.charCodeAt(0))); log({ op: "add", path: a.path }); }
        for (const d of inp.fileChanges.deletions || []) { delete files[d.path]; log({ op: "del", path: d.path }); }
        save(files);
        const n = "h" + (Number(head().slice(1)) + 1);
        localStorage.setItem("mock:head", n);
        return json({ data: { createCommitOnBranch: { commit: { oid: n } } } });
      }
      const dirs = {};
      for (const [p, text] of Object.entries(files)) { const [d, f] = p.split("/"); (dirs[d] = dirs[d] || []).push({ name: f, oid: await sha1(text), object: { text, isTruncated: false } }); }
      return json({ data: { repository: { ref: { target: { oid: head(), tree: { oid: "t" + head(), entries: Object.entries(dirs).map(([name, entries]) => ({ name, type: "tree", object: { entries } })) } } } } } });
    }
    if (path.endsWith("/commits/main")) return new Response(head(), { status: 200, headers: { ETag: 'W/"' + head() + '"' } });
    return json({ message: "Not Found" }, 404);
  };
  // window.__mockNet counts the requests the page has running (busy) and when the last one started or ended (at), for
  // page.idle(). Test probes wrap window.fetch after this script; reading window.fetch hands out a counting wrapper of
  // whatever is installed at that moment, so every request is counted once at the outermost layer, however many probes
  // wrap it (inner layers may count it again, which keeps busy balanced).
  const net = window.__mockNet = { busy: 0, at: performance.now() };
  let top = window.fetch;
  const counted = f => function (...args) {
    net.busy++; net.at = performance.now();
    let p;
    try { p = Promise.resolve(f.apply(this, args)); } catch (e) { p = Promise.reject(e); }
    return p.finally(() => { net.busy--; net.at = performance.now(); });
  };
  Object.defineProperty(window, "fetch", { configurable: true, enumerable: true, get: () => counted(top), set: f => { top = f; } });
})();
