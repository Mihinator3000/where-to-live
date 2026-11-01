import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach } from "node:test";

export const CHROME = [process.env.CHROME, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(p => p && existsSync(p));
const MOCK = readFileSync(new URL("./mock.js", import.meta.url), "utf8");
const SHOTS = new URL("./shots/", import.meta.url).pathname;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const live = new Set();
beforeEach(async () => { for (const p of live) await p.viewport(390, 844).catch(() => {}); });
const freePort = () => new Promise(r => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });

const procs = new Set();
const killAll = () => { for (const p of procs) try { p.kill("SIGKILL"); } catch {} };
process.on("exit", killAll);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { killAll(); process.exit(128 + (sig === "SIGINT" ? 2 : 15)); });

export async function launch() {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "wtl-e2e-"));
  const proc = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--disable-gpu", "--disable-extensions", "--lang=ru", "about:blank"], { stdio: "ignore" });
  let targets = null;
  for (let i = 0; i < 100 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await sleep(100); } }
  if (!targets) { proc.kill(); throw new Error("Chrome did not start"); }
  const page = new Page(targets.find(t => t.type === "page").webSocketDebuggerUrl);
  await page.open();
  live.add(page);
  procs.add(proc);
  page.close = async () => {
    live.delete(page);
    try { page.ws.close(); } catch {}
    const gone = new Promise(r => (proc.exitCode !== null || proc.signalCode ? r() : proc.once("exit", r)));
    proc.kill();
    await Promise.race([gone, sleep(3000)]);
    if (proc.exitCode === null && !proc.signalCode) { proc.kill("SIGKILL"); await Promise.race([gone, sleep(1000)]); }
    procs.delete(proc);
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  };
  return page;
}

export class Page {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); this.errors = []; this.vp = { w: 390, h: 844, dark: false }; }

  async open() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
      if (m.method === "Runtime.exceptionThrown") this.errors.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).split("\n")[0]);
      if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") this.errors.push("console.error: " + m.params.args.map(a => a.value ?? a.description ?? "").join(" "));
      if (m.method === "Page.javascriptDialogOpening") { this.errors.push("unexpected dialog: " + m.params.message); this.send("Page.handleJavaScriptDialog", { accept: true }); }
    };
    await this.send("Runtime.enable");
    await this.send("Page.enable");
    await this.send("Network.enable");
    await this.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await this.send("Network.setBlockedURLs", { urls: ["*tile.openstreetmap.org*"] });
    await this.send("Page.addScriptToEvaluateOnNewDocument", { source: MOCK });
    await this.viewport(390, 844);
  }

  send(method, params = {}) {
    const i = ++this.id;
    this.ws.send(JSON.stringify({ id: i, method, params }));
    return new Promise((res, rej) => this.pending.set(i, m => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result))));
  }

  async eval(js) {
    const r = await this.send("Runtime.evaluate", { expression: js, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error("eval failed: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).split("\n")[0]);
    return r.result.value;
  }

  async viewport(w, h, opts = {}) {
    Object.assign(this.vp, { w, h, dark: false }, opts);
    const mobile = w < 800;
    await this.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
    await this.send("Emulation.setTouchEmulationEnabled", mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
    await this.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: this.vp.dark ? "dark" : "light" }] });
  }

  async goto(url, settle = 300) {
    await this.send("Page.navigate", { url });
    await this.waitFor("document.readyState === 'complete'", 10000);
    await sleep(settle);
  }

  async waitFor(js, timeout = 5000, what = js) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
      try { last = await this.eval(`(() => { try { return (${js}); } catch (e) { return false; } })()`); if (last) return last; } catch {}
      await sleep(80);
    }
    throw new Error(`timeout waiting for: ${what}`);
  }

  async text(sel) { return this.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e ? e.innerText : null; })()`); }
  async visible(sel) { return this.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e || e.closest("[hidden]")) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; })()`); }

  async locate(target) {
    const t = typeof target === "string" ? { sel: target } : target;
    return this.eval(`(() => {
      const want = ${JSON.stringify(t.text || "")}, sel = ${JSON.stringify(t.sel || "button, a, summary, label, select, input, textarea, [role=button]")}, nth = ${t.nth || 0}, within = ${JSON.stringify(t.within || "")};
      const root = within ? document.querySelector(within) : document;
      if (!root) return { error: "no container " + within };
      const vis = e => { if (e.closest("[hidden]")) return false; for (let d = e.closest("details"); d; d = d.parentElement.closest("details")) if (!d.open && !(e.closest("summary") && e.closest("summary").parentElement === d)) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; };
      const norm = s => (s || "").replace(/\\s+/g, " ").trim().toLowerCase();
      let els = [...root.querySelectorAll(sel)].filter(vis);
      if (want) { const w = norm(want); const tx = e => [e.innerText, e.value, e.getAttribute("aria-label"), e.title].map(norm).filter(Boolean); const exact = els.filter(e => tx(e).some(x => x === w)); els = exact.length ? exact : els.filter(e => tx(e).some(x => x.includes(w))); }
      const e = els[nth];
      if (!e) return { error: "not found", count: els.length };
      const inMap = !!e.closest(".leaflet-container");
      let r = e.getBoundingClientRect();
      if (!inMap && (r.top < 60 || r.bottom > innerHeight - 90)) { e.scrollIntoView({ block: "center" }); r = e.getBoundingClientRect(); }
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { x, y, scrollY, covered: !!hit && hit !== e && !e.contains(hit) && !hit.contains(e) ? (hit.id || hit.className || hit.tagName) : "", label: norm(e.innerText || e.value || e.getAttribute("aria-label")).slice(0, 60) };
    })()`);
  }

  async tap(target, settle = 250) {
    let r = await this.locate(target);
    for (let i = 0; i < 4 && !r.error; i++) {
      await sleep(60);
      const again = await this.locate(target);
      if (again.error || (Math.abs(again.x - r.x) < 1 && Math.abs(again.y - r.y) < 1 && (await this.eval("scrollY")) === r.scrollY)) { r = again; break; }
      r = again;
    }
    if (r.error) throw new Error(`tap: ${r.error}: ${JSON.stringify(target)}`);
    if (r.covered) throw new Error(`tap: ${JSON.stringify(target)} is covered by ${r.covered}`);
    await this.click(r.x, r.y);
    await sleep(settle);
    return r;
  }

  async click(x, y) {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  async type(text) { await this.send("Input.insertText", { text }); await sleep(120); }

  async key(key) {
    const code = { Enter: 13, Escape: 27, Backspace: 8, Tab: 9 }[key] || 0;
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: code, text: key === "Enter" ? "\r" : undefined });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: code });
    await sleep(150);
  }

  async fill(sel, value) {
    const ok = await this.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.focus(); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); e.blur(); return true; })()`);
    if (!ok) throw new Error("fill: not found " + sel);
    await sleep(120);
  }

  async select(sel, optionText) {
    const v = await this.eval(`(() => { const s = document.querySelector(${JSON.stringify(sel)}); if (!s) return null; const o = [...s.options].find(o => o.text.includes(${JSON.stringify(optionText)}) || o.value === ${JSON.stringify(optionText)}); if (!o) return null; s.value = o.value; s.dispatchEvent(new Event("change", { bubbles: true })); return o.value; })()`);
    if (v == null) throw new Error(`select: no option ${optionText} in ${sel}`);
    await sleep(150);
    return v;
  }

  async shot(name) {
    mkdirSync(SHOTS, { recursive: true });
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    const f = SHOTS + name.replace(/[^\w.-]+/g, "_") + ".png";
    writeFileSync(f, Buffer.from(r.data, "base64"));
    return f;
  }

  takeErrors() { const e = this.errors; this.errors = []; return e; }
}
