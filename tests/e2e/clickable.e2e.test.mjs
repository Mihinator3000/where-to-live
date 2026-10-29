import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, CHROME } from "./cdp.mjs";
import { serve } from "./server.mjs";
import { openApp } from "./fixtures.mjs";

const ROUTES = ["#/map", "#/rank", "#/places", "#/place/porto", "#/place/sankt-peterburg", "#/rate", "#/settings"];
const VIEWPORTS = [[390, 844], [1280, 800]];
let srv, page;

before(async () => { srv = await serve(); page = await launch(); });
after(async () => { await page?.close(); await srv?.close(); });

const AUDIT = `(() => {
  const out = { unnamed: [], small: [], covered: [], overflow: document.documentElement.scrollWidth - innerWidth };
  const vis = e => { if (e.closest("[hidden], .leaflet-container")) return false; for (let d = e.closest("details"); d; d = d.parentElement.closest("details")) if (!d.open && !(e.closest("summary") && e.closest("summary").parentElement === d)) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; };
  const name = e => (e.getAttribute("aria-label") || e.title || e.innerText || e.value || e.placeholder || (e.id && document.querySelector('label[for="' + e.id + '"]')?.innerText) || e.closest("label")?.innerText || "").trim();
  const desc = e => (e.id ? "#" + e.id : e.tagName.toLowerCase() + (e.className ? "." + String(e.className).split(" ")[0] : "")) + " «" + name(e).slice(0, 30) + "»";
  const view = document.querySelector(".view:not([hidden])");
  const els = [...document.querySelectorAll(".appbar button, .appbar a, .bottomnav a")].concat([...view.querySelectorAll("button, a[href], input, select, textarea, summary")]).filter(vis);
  for (const e of els) {
    if (!name(e) && e.type !== "hidden") out.unnamed.push(desc(e));
    const inline = e.tagName === "A" && getComputedStyle(e).display === "inline" || e.classList.contains("linkbtn");
    const r = e.getBoundingClientRect();
    if (!inline && !["checkbox", "radio", "range"].includes(e.type) && Math.min(r.width, r.height) < 24) out.small.push(desc(e) + " " + Math.round(r.width) + "×" + Math.round(r.height));
    if (!e.closest(".appbar, .bottomnav, .savebar, #sheet, .map-top")) e.scrollIntoView({ block: "center" });
    const b = e.getBoundingClientRect();
    const x = Math.min(Math.max(b.left + b.width / 2, 1), innerWidth - 1), y = Math.min(Math.max(b.top + b.height / 2, 1), innerHeight - 1);
    const hit = document.elementFromPoint(x, y);
    if (hit && hit !== e && !e.contains(hit) && !hit.contains(e) && !(e.tagName === "INPUT" && hit.closest("label") === e.closest("label"))) out.covered.push(desc(e) + " under " + (hit.id ? "#" + hit.id : hit.className || hit.tagName));
  }
  scrollTo(0, 0);
  return out;
})()`;

for (const [w, h] of VIEWPORTS) {
  for (const route of ROUTES) {
    test(`${route} at ${w}px: every control is named, tappable and not covered`, { skip: !CHROME && "no Chrome" }, async () => {
      await page.viewport(w, h);
      await openApp(page, srv.url, { hash: route });
      if (route === "#/rate") await page.tap({ sel: "#fShowAll" }).catch(() => {});
      const r = await page.eval(AUDIT);
      assert.deepEqual(page.takeErrors(), [], "no JS errors");
      assert.deepEqual(r.unnamed, [], "controls without a name");
      assert.deepEqual(r.small, [], "tap targets smaller than 24px");
      assert.deepEqual(r.covered, [], "controls covered by something else");
      assert.ok(r.overflow <= 1, `page scrolls sideways by ${r.overflow}px`);
    });
  }
}
