import { esc, plural, reducedMotion, sideSheet } from "./util.js";

const TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> · <a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener noreferrer">Natural Earth</a>';

export class MapView {
  constructor(el, hooks) {
    const L = window.L;
    this.L = L;
    this.hooks = hooks;
    const touch = matchMedia("(pointer: coarse)").matches;
    this.map = L.map(el, { zoomControl: false, attributionControl: false, worldCopyJump: true, minZoom: 2, maxZoom: 17, zoomSnap: 1, tapTolerance: 12 });
    L.control.attribution({ position: "bottomright", prefix: false }).addAttribution(ATTR).addTo(this.map);
    if (!touch) L.control.zoom({ position: "bottomright", zoomInTitle: "Приблизить", zoomOutTitle: "Отдалить" }).addTo(this.map);
    this.tiles = L.tileLayer(TILES, { maxZoom: 19, crossOrigin: false, className: "basemap" }).addTo(this.map);
    this.map.createPane("countries").style.zIndex = 350;
    this.map.createPane("cities").style.zIndex = 450;
    this.map.createPane("places").style.zIndex = 620;
    this.canvas = L.canvas({ padding: 0.3, pane: "countries", tolerance: 6 });
    this.cityCanvas = this.canvas;
    this.countryLayer = null;
    this.placeLayer = L.layerGroup().addTo(this.map);
    this.cityLayer = L.layerGroup().addTo(this.map);
    this.temp = null;
    this.styleFn = () => ({});
    this.placeList = [];
    this.map.on("zoomend", () => { this.drawPlaces(); if (this.hooks.onZoom) this.hooks.onZoom(this.map.getZoom()); });
    this.map.on("click", e => { if (!e.originalEvent._handled) this.hooks.onBlank(e.latlng); });
    const view = this.restoreView();
    if (view) this.map.setView(view.c, Math.round(view.z)); else this.map.setView([44, 22], 4);
    this.map.on("moveend", () => { try { localStorage.setItem("wtl:view", JSON.stringify({ c: this.map.getCenter(), z: this.map.getZoom() })); } catch (e) {} });
  }

  restoreView() { try { return JSON.parse(localStorage.getItem("wtl:view")); } catch (e) { return null; } }

  invalidate() { this.map.invalidateSize(); }

  setCountries(geo, styleFn) {
    const L = this.L;
    this.styleFn = styleFn;
    if (this.countryLayer) this.countryLayer.remove();
    this.countryLayer = L.geoJSON(geo, {
      renderer: this.canvas,
      pane: "countries",
      style: f => this.styleFn(f.properties.iso3),
      onEachFeature: (f, layer) => {
        layer.on("click", e => { e.originalEvent._handled = true; this.hooks.onCountry(f.properties.iso3, e.latlng); });
      },
    }).addTo(this.map);
    this.cityLayer.eachLayer(l => l.bringToFront());
  }

  restyleCountries(styleFn) {
    if (styleFn) this.styleFn = styleFn;
    if (this.countryLayer) this.countryLayer.setStyle(f => this.styleFn(f.properties.iso3));
  }

  setPlaces(list) {
    this.placeList = list.filter(p => p.lat != null && p.lon != null);
    this.drawPlaces();
  }

  drawPlaces() {
    const L = this.L, z = this.map.getZoom();
    this.placeLayer.clearLayers();
    this.markers = {};
    const groups = [];
    this.placeList.forEach(p => {
      const pt = this.map.project([p.lat, p.lon], z);
      const g = z < 12 && groups.find(x => x.pt.distanceTo(pt) < 32);
      if (g) g.items.push(p); else groups.push({ pt, items: [p] });
    });
    groups.forEach(g => (g.items.length === 1 ? this.addPin(g.items[0]) : this.addCluster(g.items)));
    this.labels();
  }

  addPin(p) {
    const L = this.L;
    const size = p.base ? 26 : 30;
    const icon = L.divIcon({
      className: "",
      html: `<div class="pin${p.base ? " base" : ""}${p.out ? " out" : ""}${p.thin ? " thin" : ""}" style="width:${size}px;height:${size}px;${p.thin ? "border-color" : "background"}:${p.color}${!p.thin && p.ink ? ";color:" + p.ink : ""}">${esc(p.text || "")}</div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    });
    const m = L.marker([p.lat, p.lon], { icon, pane: "places", keyboard: true, title: p.name, riseOnHover: true });
    m.bindTooltip(esc(p.base ? p.name + " · база, 3" : p.name), { permanent: true, direction: "right", offset: [size / 2, 0], className: "pin-label" });
    m.isBase = !!p.base;
    m.on("click", e => { if (e.originalEvent) e.originalEvent._handled = true; this.hooks.onPlace(p.id); });
    this.onKey(m, () => this.hooks.onPlace(p.id, true));
    m.addTo(this.placeLayer);
    m.getElement().setAttribute("aria-label", p.name + (p.base ? ", база" : p.text ? ", итог " + p.text : "") + (p.why ? ", " + p.why : p.thin ? ", мало своих оценок, пока не в рейтинге" : ""));
    this.markers[p.id] = m;
  }

  addCluster(items) {
    const L = this.L;
    const lat = items.reduce((a, p) => a + p.lat, 0) / items.length, lon = items.reduce((a, p) => a + p.lon, 0) / items.length;
    const icon = L.divIcon({ className: "", html: `<div class="pin cluster">${items.length}</div>`, iconSize: [34, 34], iconAnchor: [17, 17] });
    const m = L.marker([lat, lon], { icon, pane: "places", keyboard: true, title: items.map(p => p.name).join(", "), riseOnHover: true });
    m.bindTooltip(esc(items.map(p => p.name).join(", ")), { direction: "right", offset: [17, 0], className: "pin-label" });
    const open = () => {
      const b = L.latLngBounds(items.map(p => [p.lat, p.lon]));
      const z = this.map.getZoom();
      const still = reducedMotion();
      if (b.getNorthEast().equals(b.getSouthWest())) this.map[still ? "setView" : "flyTo"](b.getCenter(), Math.min(z + 3, 14), still ? { animate: false } : {});
      else this.map[still ? "fitBounds" : "flyToBounds"](b, { padding: [70, 70], maxZoom: Math.max(z + 2, 9), duration: 0.6, animate: !still });
    };
    m.on("click", e => { if (e.originalEvent) e.originalEvent._handled = true; open(); });
    this.onKey(m, open);
    m.addTo(this.placeLayer);
    m.getElement().setAttribute("aria-label", `${items.length} ${plural(items.length, "место", "места", "мест")} рядом: ${items.map(p => p.name).join(", ")}. Приблизить`);
  }

  onKey(m, fn) {
    m.on("keypress", e => { const o = e.originalEvent; if (o.key === "Enter" || o.key === " " || o.keyCode === 13) { o._handled = true; o.preventDefault(); fn(); } });
  }

  keepVisible(lat, lon) {
    const sheet = document.getElementById("sheet");
    if (!sheet || sheet.hidden || lat == null) return;
    const pt = this.map.latLngToContainerPoint([lat, lon]);
    if (!sideSheet()) { const top = sheet.offsetTop; if (pt.y > top - 40) this.map.panBy([0, pt.y - Math.max(90, top - 80)]); }
    else { const right = sheet.offsetLeft + sheet.offsetWidth; if (pt.x < right + 20) this.map.panBy([pt.x - (right + 80), 0]); }
  }

  labels() {
    const show = this.map.getZoom() >= 6;
    Object.values(this.markers || {}).forEach(m => { const t = m.getTooltip(); if (t) t.setOpacity(show || m.isBase ? 1 : 0); });
  }

  setCities(list, colorFn, labelFn) {
    const L = this.L;
    this.cityLayer.clearLayers();
    if (!list) return;
    const ring = getComputedStyle(document.documentElement).colorScheme === "dark" ? "rgba(255,255,255,0.6)" : "rgba(0,0,0,0.45)";
    list.forEach(c => {
      const col = colorFn(c);
      if (!col) return;
      const r = col.r || Math.max(3, Math.min(9, Math.sqrt((c.pop || 20000) / 1e6) * 4.5));
      const m = L.circleMarker([c.lat, c.lon], { renderer: this.cityCanvas, pane: "countries", radius: r, color: col.stroke || ring, weight: col.ring ? 2 : 0.8, fillColor: col.fill, fillOpacity: col.ring ? 0 : 0.9 });
      m.bindTooltip(esc(labelFn(c)), { direction: "top", className: "city-tip", sticky: false });
      m.on("click", e => { e.originalEvent._handled = true; this.hooks.onCity(c); });
      m.addTo(this.cityLayer);
    });
  }

  flyTo(lat, lon, zoom) {
    const z = zoom || Math.max(this.map.getZoom(), 9);
    const sheet = document.getElementById("sheet");
    const mobile = !sideSheet();
    const off = sheet && !sheet.hidden ? (mobile ? sheet.offsetHeight / 2 : -200) : 0;
    const target = this.map.project([lat, lon], z).add(mobile ? [0, off] : [off, 0]);
    if (reducedMotion()) this.map.setView(this.map.unproject(target, z), z, { animate: false });
    else this.map.flyTo(this.map.unproject(target, z), z, { duration: 0.8 });
  }

  showTemp(lat, lon) {
    const L = this.L;
    if (this.temp) this.temp.remove();
    this.temp = L.circleMarker([lat, lon], { radius: 9, color: "#fff", weight: 3, fillColor: "#121518", fillOpacity: 1, pane: "places" }).addTo(this.map);
  }

  clearTemp() { if (this.temp) { this.temp.remove(); this.temp = null; } }
}
