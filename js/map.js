import { esc } from "./util.js";

const TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · <a href="https://www.naturalearthdata.com/">Natural Earth</a>';

export class MapView {
  constructor(el, hooks) {
    const L = window.L;
    this.L = L;
    this.hooks = hooks;
    const touch = matchMedia("(pointer: coarse)").matches;
    this.map = L.map(el, { zoomControl: !touch, attributionControl: false, worldCopyJump: true, minZoom: 2, maxZoom: 17, zoomSnap: 0.5, tapTolerance: 12 });
    L.control.attribution({ position: "topright", prefix: false }).addAttribution(ATTR).addTo(this.map);
    if (!touch) this.map.zoomControl.setPosition("bottomright");
    this.tiles = L.tileLayer(TILES, { maxZoom: 19, crossOrigin: false, className: "basemap" }).addTo(this.map);
    this.map.createPane("countries").style.zIndex = 350;
    this.map.createPane("cities").style.zIndex = 450;
    this.map.createPane("places").style.zIndex = 620;
    this.canvas = L.canvas({ padding: 0.3, pane: "countries" });
    this.cityCanvas = L.canvas({ padding: 0.3, pane: "cities", tolerance: 6 });
    this.countryLayer = null;
    this.placeLayer = L.layerGroup().addTo(this.map);
    this.cityLayer = L.layerGroup().addTo(this.map);
    this.temp = null;
    this.styleFn = () => ({});
    this.map.on("zoomend", () => this.labels());
    this.map.on("click", e => { if (!e.originalEvent._handled) this.hooks.onBlank(e.latlng); });
    const view = this.restoreView();
    if (view) this.map.setView(view.c, view.z); else this.map.setView([44, 22], 4);
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
  }

  restyleCountries(styleFn) {
    if (styleFn) this.styleFn = styleFn;
    if (this.countryLayer) this.countryLayer.setStyle(f => this.styleFn(f.properties.iso3));
  }

  setPlaces(list) {
    const L = this.L;
    this.placeLayer.clearLayers();
    this.markers = {};
    list.forEach(p => {
      if (p.lat == null || p.lon == null) return;
      const size = p.base ? 26 : 30;
      const icon = L.divIcon({
        className: "",
        html: `<div class="pin${p.base ? " base" : ""}${p.out ? " out" : ""}" style="width:${size}px;height:${size}px;background:${p.color}">${esc(p.text || "")}</div>`,
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
      });
      const m = L.marker([p.lat, p.lon], { icon, pane: "places", keyboard: true, title: p.name, riseOnHover: true });
      m.bindTooltip(esc(p.name), { permanent: true, direction: "right", offset: [size / 2, 0], className: "pin-label" });
      m.on("click", e => { if (e.originalEvent) e.originalEvent._handled = true; this.hooks.onPlace(p.id); });
      m.addTo(this.placeLayer);
      this.markers[p.id] = m;
    });
    this.labels();
  }

  labels() {
    const show = this.map.getZoom() >= 6;
    Object.values(this.markers || {}).forEach(m => { const t = m.getTooltip(); if (t) t.setOpacity(show ? 1 : 0); });
  }

  setCities(list, colorFn, labelFn) {
    const L = this.L;
    this.cityLayer.clearLayers();
    if (!list) return;
    list.forEach(c => {
      const col = colorFn(c);
      if (!col) return;
      const r = col.r || Math.max(3, Math.min(9, Math.sqrt((c.pop || 20000) / 1e6) * 4.5));
      const m = L.circleMarker([c.lat, c.lon], { renderer: this.cityCanvas, pane: "cities", radius: r, color: col.stroke || "rgba(0,0,0,0.45)", weight: col.ring ? 2 : 0.8, fillColor: col.fill, fillOpacity: col.ring ? 0 : 0.9 });
      m.bindTooltip(labelFn(c), { direction: "top", className: "city-tip", sticky: false });
      m.on("click", e => { e.originalEvent._handled = true; this.hooks.onCity(c); });
      m.addTo(this.cityLayer);
    });
  }

  flyTo(lat, lon, zoom) {
    const z = zoom || Math.max(this.map.getZoom(), 9);
    const sheet = document.getElementById("sheet");
    const mobile = innerWidth < 860;
    const off = sheet && !sheet.hidden ? (mobile ? sheet.offsetHeight / 2 : -200) : 0;
    const target = this.map.project([lat, lon], z).add(mobile ? [0, off] : [off, 0]);
    this.map.flyTo(this.map.unproject(target, z), z, { duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 0.8 });
  }

  showTemp(lat, lon) {
    const L = this.L;
    if (this.temp) this.temp.remove();
    this.temp = L.circleMarker([lat, lon], { radius: 9, color: "#fff", weight: 3, fillColor: "#121518", fillOpacity: 1, pane: "places" }).addTo(this.map);
  }

  clearTemp() { if (this.temp) { this.temp.remove(); this.temp = null; } }
}
