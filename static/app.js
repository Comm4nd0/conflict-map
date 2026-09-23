/* Conflict Map — frontend */
const STATUS_COLOR = {
  escalating: "#d03b3b", active: "#ec835a", "de-escalating": "#fab219",
  ceasefire: "#0ca30c", frozen: "#898781",
};
const SIDE_COLOR = { A: "#3987e5", B: "#d95926", other: "#9085e9" };
const WEAPON_COLOR = { missile: "#ffffff", drone: "#eda100", airstrike: "#e87ba4", artillery: "#c3c2b7", shelling: "#c3c2b7",
                       ground: "#e34948", bombing: "#f2a33a", naval: "#1baf7a", other: "#9085e9" };
/* weapon glyphs on a 24x24 grid, nose up; each entry is a list of filled SVG subpaths.
   `dir` glyphs are rotated along their flight path while in the air. */
const WEAPON_GLYPH = {
  missile:   { dir: true, d: ["M12 1L14.3 5.5V15.5L18 19.5V22L14.3 20.3L13.2 22H10.8L9.7 20.3L6 22V19.5L9.7 15.5V5.5Z"] },
  drone:     { d: ["M2 5a3.2 3.2 0 1 0 6.4 0a3.2 3.2 0 1 0 -6.4 0Z", "M15.6 5a3.2 3.2 0 1 0 6.4 0a3.2 3.2 0 1 0 -6.4 0Z",
                   "M2 19a3.2 3.2 0 1 0 6.4 0a3.2 3.2 0 1 0 -6.4 0Z", "M15.6 19a3.2 3.2 0 1 0 6.4 0a3.2 3.2 0 1 0 -6.4 0Z",
                   "M4 5.6L5.6 4L20 18.4L18.4 20Z", "M18.4 4L20 5.6L5.6 20L4 18.4Z", "M8.6 8.6H15.4V15.4H8.6Z"] },
  airstrike: { dir: true, d: ["M12 1L13.4 5.5V9.5L22 16.5V18.5L13.4 15.5V18.5L16.5 21V22.8L12 21.6L7.5 22.8V21L10.6 18.5V15.5L2 18.5V16.5L10.6 9.5V5.5Z"] },
  artillery: { dir: true, d: ["M12 1.5C14.6 4 15.8 7 15.8 10.5V18.5H8.2V10.5C8.2 7 9.4 4 12 1.5Z", "M7.6 19.5H16.4V22.5H7.6Z"] },
  bombing:   { dir: true, d: ["M12 22C9.3 20.2 8.3 17.5 8.3 14.5V9.5L12 7.5L15.7 9.5V14.5C15.7 17.5 14.7 20.2 12 22Z",
                              "M11.2 2H12.8V8H11.2Z", "M8 1.5H16L12 6.5Z"] },
  ground:    { d: ["M1.5 14H22.5L20 20.5H4Z", "M6.5 9H15L16.5 13.2H5.5Z", "M14.5 10.2H23V11.8H14.5Z"] },
  naval:     { d: ["M1 14.5H23L19.5 20.5H4.5Z", "M7.5 9.5H16V13.7H7.5Z", "M10.3 4H12.2V9H10.3Z", "M12.2 6.2H15.8V7.6H12.2Z"] },
  other:     { d: ["M12 1.5L14 8.2L20.5 5L16.6 11L22.5 13.5L15.8 14.8L17.5 21.5L12 17L6.5 21.5L8.2 14.8L1.5 13.5L7.4 11L3.5 5L10 8.2Z"] },
};
WEAPON_GLYPH.shelling = WEAPON_GLYPH.artillery;
const weaponKey = (w) => WEAPON_GLYPH[w] ? w : "other";
function weaponSvg(w, size = 14) {
  const g = WEAPON_GLYPH[weaponKey(w)], c = WEAPON_COLOR[w] || WEAPON_COLOR.other;
  return `<svg class="wi" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">` +
    g.d.map(d => `<path d="${d}" fill="${c}" stroke="rgba(0,0,0,.85)" stroke-width="1.6" stroke-linejoin="round" paint-order="stroke"/>`).join("") + `</svg>`;
}
const LAND = "#3f4048", HEAT = "#f2a33a";

let COUNTRIES = {};          // iso3 -> {iso3, iso2, name, lat, lon}
let STATE = null;            // last /api/state
let selected = null;         // conflict id
const $ = (s) => document.querySelector(s);

/* ---------- helpers ---------- */
const norm = (code) => (code && COUNTRIES[code]) ? COUNTRIES[code].iso3 : null;
function flag(code) {
  const c = COUNTRIES[code]; if (!c || !c.iso2) return "";
  return [...c.iso2.toUpperCase()].map(ch => String.fromCodePoint(0x1F1E6 + ch.charCodeAt(0) - 65)).join("");
}
const cname = (code) => (COUNTRIES[code] || {}).name || code;
function ago(ts) {
  if (!ts) return "never";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* great-circle arc between two [lon,lat] points */
function arc(from, to, n = 40) {
  const r = Math.PI / 180;
  const [l1, p1] = [from[0] * r, from[1] * r], [l2, p2] = [to[0] * r, to[1] * r];
  const d = 2 * Math.asin(Math.sqrt(Math.sin((p1 - p2) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l1 - l2) / 2) ** 2));
  if (d < 1e-6) return [from, to];
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n, A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    const z = A * Math.sin(p1) + B * Math.sin(p2);
    pts.push([Math.atan2(y, x) / r, Math.atan2(z, Math.sqrt(x * x + y * y)) / r]);
  }
  // avoid wrapping lines across the antimeridian
  for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i][0] - pts[i - 1][0]) > 180) return [from, to];
  return pts;
}

/* ---------- layout ---------- */
const mobileMQ = window.matchMedia("(max-width: 900px)");
const coarseMQ = window.matchMedia("(pointer: coarse)");
const isMobile = () => mobileMQ.matches;
/* zoom at which the whole globe fits the narrow side of the map (phones start zoomed out) */
function fitGlobeZoom() {
  const m = document.getElementById("map");
  const d = 0.92 * Math.min(m.clientWidth || innerWidth, m.clientHeight || innerHeight);
  return Math.max(0.8, Math.min(2.25, Math.log2(d * Math.PI / 512)));
}

/* ---------- map ---------- */
const OCEAN = "#070b14";
const HEAT_COLOR_EXPR = ["interpolate", ["linear"], ["coalesce", ["feature-state", "heat"], 0], 0, LAND, 1, HEAT];
const HEAT_OPACITY_EXPR = ["+", 0.12, ["*", 0.6, ["coalesce", ["feature-state", "heat"], 0]]];
const hashParam = (k) => new URLSearchParams(location.hash.slice(1)).get(k);
// read before the map exists: with hash: "map" it writes its own #map= on load
const sharedView = !!hashParam("map");
const map = new maplibregl.Map({
  container: "map",
  style: {
    version: 8,
    glyphs: "/static/fonts/{fontstack}/{range}.pbf",
    projection: { type: "globe" },
    sky: {
      "sky-color": "#06080f", "horizon-color": "#1c2a48", "fog-color": "#06080f",
      "sky-horizon-blend": 0.6, "horizon-fog-blend": 0.6, "fog-ground-blend": 0.6,
      "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 6, 1, 8, 0],
    },
    sources: {
      relief: { type: "raster", tiles: ["/static/tiles/{z}/{x}/{y}.jpg"], tileSize: 512, minzoom: 0, maxzoom: 4 },
    },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": OCEAN, "background-color-transition": { duration: 450 } } },
      { id: "relief", type: "raster", source: "relief", paint: { "raster-opacity": 1, "raster-fade-duration": 150 } },
    ],
  },
  center: [25, 22], zoom: isMobile() ? fitGlobeZoom() : 2.25, minZoom: 0.8, maxZoom: 9, attributionControl: false, preserveDrawingBuffer: true,
  maxPitch: 0,
  hash: "map",   // #map=zoom/lat/lon in the URL, so a view can be copied and shared
});
function setHashParam(k, v) {
  const q = new URLSearchParams(location.hash.slice(1));
  if (v) q.set(k, v); else q.delete(k);
  history.replaceState(null, "", "#" + q.toString().replace(/%2F/g, "/"));
}
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
let hoverIso = null;

map.on("load", async () => {
  map.addSource("countries", { type: "geojson", data: "/static/data/ne_50m_admin_0_countries.geojson", promoteId: "ADM0_A3" });
  map.addSource("lakes", { type: "geojson", data: "/static/data/ne_50m_lakes.geojson" });
  map.addSource("rivers", { type: "geojson", data: "/static/data/ne_50m_rivers_lake_centerlines.geojson" });
  map.addSource("admin1", { type: "geojson", data: "/static/data/ne_50m_admin_1_states_provinces_lines.geojson" });
  map.addSource("places", { type: "geojson", data: "/static/data/places.geojson" });
  map.addSource("labels", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addSource("points", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addSource("arcs", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addSource("garcs", { type: "geojson", data: { type: "FeatureCollection", features: [] } });

  // land tint: heat / side colour over the relief
  map.addLayer({
    id: "country-fill", type: "fill", source: "countries",
    paint: {
      "fill-color": HEAT_COLOR_EXPR, "fill-opacity": HEAT_OPACITY_EXPR,
      "fill-color-transition": { duration: 650 }, "fill-opacity-transition": { duration: 650 },
    },
  });
  map.addLayer({ id: "lakes", type: "fill", source: "lakes", paint: { "fill-color": "#0c1424", "fill-opacity": 0.9 } });
  map.addLayer({
    id: "rivers", type: "line", source: "rivers", minzoom: 3,
    paint: { "line-color": "#1d2d4d", "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.4, 7, 1.2], "line-opacity": 0.8 },
  });
  map.addLayer({
    id: "admin1", type: "line", source: "admin1", minzoom: 4,
    paint: { "line-color": "rgba(255,255,255,0.08)", "line-width": 0.5, "line-dasharray": [3, 2] },
  });
  // soft glow along coasts and borders, then the crisp border line
  map.addLayer({
    id: "country-glow", type: "line", source: "countries",
    paint: { "line-color": "#7fa6e0", "line-width": ["interpolate", ["linear"], ["zoom"], 1, 1.5, 6, 4], "line-blur": 4, "line-opacity": 0.22 },
  });
  map.addLayer({
    id: "country-line", type: "line", source: "countries",
    paint: { "line-color": "rgba(210,225,255,0.22)", "line-width": ["interpolate", ["linear"], ["zoom"], 1, 0.5, 6, 1.1] },
  });
  // day/night: three nested night polygons (sun below 0°, -6°, -12°) give a soft twilight edge
  map.addSource("night", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "night", type: "fill", source: "night",
    paint: { "fill-color": "#030718", "fill-opacity": ["get", "a"], "fill-antialias": false },
  });
  // a faint warm line where the sun is just setting/rising
  map.addSource("terminator", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "terminator", type: "line", source: "terminator",
    paint: { "line-color": "#ffb46b", "line-width": ["interpolate", ["linear"], ["zoom"], 1, 6, 6, 18],
             "line-blur": ["interpolate", ["linear"], ["zoom"], 1, 6, 6, 16], "line-opacity": 0.14 },
  });
  // city lights: populated places glow only where it is dark (filter updated with the terminator)
  map.addLayer({
    id: "city-lights", type: "circle", source: "places", maxzoom: 7,
    filter: ["boolean", false],
    paint: {
      "circle-color": "#ffd58a",
      "circle-radius": ["interpolate", ["linear"], ["zoom"],
        1, ["interpolate", ["linear"], ["coalesce", ["get", "pop_max"], 0], 0, 0.6, 1000000, 1.6, 20000000, 4],
        6, ["interpolate", ["linear"], ["coalesce", ["get", "pop_max"], 0], 0, 2, 1000000, 6, 20000000, 14]],
      "circle-blur": 0.9,
      "circle-opacity": ["interpolate", ["linear"], ["coalesce", ["get", "pop_max"], 0], 0, 0.25, 500000, 0.55, 5000000, 0.85],
    },
  });
  map.addSource("sun", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "sun", type: "circle", source: "sun",
    paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 40, 5, 120], "circle-color": "#fff0c2",
             "circle-opacity": 0.1, "circle-blur": 1 },
  });
  updateNight();
  setInterval(updateNight, 60000);

  map.addLayer({
    id: "country-hover", type: "line", source: "countries",
    paint: { "line-color": "#ffffff", "line-width": 1.6,
             "line-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 0.7, 0] },
  });
  map.addLayer({
    id: "country-involved", type: "line", source: "countries",
    paint: { "line-color": SIDE_COLOR.other, "line-width": 1.8, "line-opacity": 0,
             "line-color-transition": { duration: 650 }, "line-opacity-transition": { duration: 650 } },
  });
  map.addLayer({
    id: "heat", type: "heatmap", source: "points", maxzoom: 9,
    paint: {
      "heatmap-weight": ["interpolate", ["linear"], ["get", "w"], 1, 0.05, 100, 1],
      "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 1, 0.35, 6, 1.5],
      "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 1, 6, 6, 24],
      "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"],
        0, "rgba(242,163,58,0)", 0.3, "rgba(242,163,58,0.25)", 0.7, "rgba(236,131,90,0.6)", 1, "rgba(208,59,59,0.85)"],
      "heatmap-opacity": 0.7,
    },
  });
  // focus mode: darkens everything not involved in the selected conflict
  map.addLayer({
    id: "country-dim", type: "fill", source: "countries",
    paint: { "fill-color": "#04050a", "fill-opacity": 0, "fill-opacity-transition": { duration: 650 } },
  });
  map.addLayer({
    id: "garcs", type: "line", source: "garcs", layout: { visibility: "none" },
    paint: { "line-color": "#c3c2b7", "line-width": ["interpolate", ["linear"], ["get", "w"], 0, 0.5, 1, 3], "line-opacity": 0.35 },
  });
  map.addLayer({
    id: "arcs", type: "line", source: "arcs",
    paint: {
      "line-color": ["get", "color"],
      "line-width": ["case", ["get", "combat"], 2.2, 1.4],
      "line-opacity": 0.85, "line-opacity-transition": { duration: 650 },
      "line-dasharray": [2, 1.5],
    },
  });

  // ---- labels: capitals, cities, country names
  map.addLayer({
    id: "capital-dots", type: "circle", source: "places", minzoom: 2.5,
    filter: ["==", ["get", "adm0cap"], 1],
    paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 2.5, 1.5, 6, 3.5], "circle-color": "#e8ecf5",
             "circle-stroke-color": "rgba(0,0,0,0.6)", "circle-stroke-width": 1, "circle-opacity": 0.85 },
  });
  map.addLayer({
    id: "city-dots", type: "circle", source: "places", minzoom: 4.5,
    filter: ["all", ["!=", ["get", "adm0cap"], 1], ["<=", ["get", "scalerank"], 6]],
    paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 4.5, 1, 8, 2.5], "circle-color": "#c3c2b7", "circle-opacity": 0.7 },
  });
  const cityLabel = (id, minzoom, filter, size, color) => map.addLayer({
    id, type: "symbol", source: "places", minzoom, filter,
    layout: { "text-field": ["get", "name"], "text-font": ["Open Sans Regular"], "text-size": size,
              "text-offset": [0.6, 0], "text-anchor": "left", "text-max-width": 8, "text-padding": 4 },
    paint: { "text-color": color, "text-halo-color": "rgba(0,0,0,0.85)", "text-halo-width": 1.2, "text-halo-blur": 0.5 },
  });
  cityLabel("capital-labels", 3, ["==", ["get", "adm0cap"], 1], ["interpolate", ["linear"], ["zoom"], 3, 10, 7, 13], "#e8ecf5");
  cityLabel("city-labels", 4.8, ["all", ["!=", ["get", "adm0cap"], 1], ["<=", ["get", "scalerank"], 6]],
            ["interpolate", ["linear"], ["zoom"], 4.8, 9.5, 8, 12], "#c3c2b7");
  cityLabel("town-labels", 6.5, ["all", ["!=", ["get", "adm0cap"], 1], [">", ["get", "scalerank"], 6]], 10, "#a9a89f");
  map.addLayer({
    id: "country-labels", type: "symbol", source: "labels", minzoom: 1.4, maxzoom: 7.5,
    layout: {
      "text-field": ["get", "name"], "text-font": ["Open Sans Semibold"], "text-transform": "uppercase",
      "text-letter-spacing": 0.15, "text-max-width": 7,
      "text-size": ["interpolate", ["linear"], ["zoom"], 1.4, 8, 3, 11, 6, 15],
      "symbol-sort-key": ["get", "rank"],
    },
    paint: { "text-color": "rgba(230,235,245,0.75)", "text-halo-color": "rgba(0,0,0,0.7)", "text-halo-width": 1.2,
             "text-opacity": ["interpolate", ["linear"], ["zoom"], 1.4, 0.6, 3, 0.9] },
  });

  // ---- strikes: paths, impacts, animated projectiles, impact flashes
  for (const id of ["strike-paths", "strike-impacts", "projectiles", "flashes"])
    map.addSource(id, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "strike-paths", type: "line", source: "strike-paths",
    paint: { "line-color": ["get", "color"], "line-width": 1, "line-opacity": 0.3, "line-opacity-transition": { duration: 650 } },
  }, "capital-dots");
  map.addLayer({
    id: "flashes", type: "circle", source: "flashes",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, ["*", 10, ["get", "r"]], 6, ["*", 40, ["get", "r"]]],
      "circle-color": ["get", "color"], "circle-opacity": ["*", 0.35, ["get", "a"]],
      "circle-stroke-color": ["get", "color"], "circle-stroke-width": 1.5, "circle-stroke-opacity": ["get", "a"],
      "circle-blur": 0.4,
    },
  }, "capital-dots");
  for (const w of Object.keys(WEAPON_GLYPH)) map.addImage("w-" + w, weaponIcon(w), { pixelRatio: 2 });
  // a soft halo sized by volume (a ring when only the country is known), with the weapon icon on top
  map.addLayer({
    id: "strike-impacts", type: "circle", source: "strike-impacts",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"],
        1, ["case", ["==", ["get", "precision"], "country"], 10, ["+", 2, ["get", "r"]]],
        6, ["case", ["==", ["get", "precision"], "country"], 16, ["*", 2.4, ["get", "r"]]]],
      "circle-color": ["get", "color"],
      "circle-opacity": ["case", ["==", ["get", "precision"], "country"], 0.08, 0.2],
      "circle-stroke-color": ["get", "color"], "circle-stroke-width": 1.2,
      "circle-stroke-opacity": ["case", ["==", ["get", "precision"], "country"], 0.9, 0],
      "circle-opacity-transition": { duration: 650 }, "circle-stroke-opacity-transition": { duration: 650 },
    },
  }, "capital-dots");
  map.addLayer({
    id: "strike-icons", type: "symbol", source: "strike-impacts",
    layout: {
      "icon-image": ["concat", "w-", ["get", "icon"]],
      "icon-size": ["interpolate", ["linear"], ["zoom"], 1, ["+", 0.45, ["*", 0.04, ["get", "r"]]], 6, ["+", 0.7, ["*", 0.06, ["get", "r"]]]],
      "icon-allow-overlap": true, "icon-ignore-placement": true,
    },
    paint: { "icon-opacity": ["case", ["==", ["get", "precision"], "country"], 0.6, 1], "icon-opacity-transition": { duration: 650 } },
  }, "capital-dots");
  map.addLayer({
    id: "projectiles", type: "symbol", source: "projectiles",
    layout: {
      "icon-image": ["concat", "w-", ["get", "icon"]], "icon-size": ["interpolate", ["linear"], ["zoom"], 1, 0.6, 6, 0.85],
      "icon-rotate": ["get", "rot"], "icon-rotation-alignment": "map",
      "icon-allow-overlap": true, "icon-ignore-placement": true,
    },
  });
  map.on("mousemove", ["strike-icons", "strike-impacts"], (e) => {
    const p = e.features[0].properties; const tip = $("#tooltip");
    tip.innerHTML = strikeHtml(p);
    tip.hidden = false; tip.style.left = (e.point.x + 14) + "px"; tip.style.top = (e.point.y + 14) + "px";
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", ["strike-icons", "strike-impacts"], () => { $("#tooltip").hidden = true; map.getCanvas().style.cursor = ""; });
  map.on("click", ["strike-icons", "strike-impacts"], (e) => {
    e.originalEvent._handled = true;
    openStrikeFeature(e.features[0], e.lngLat);
  });

  // ---- GDELT located incidents (fight / mass-violence events with a place and a source)
  map.addSource("incidents", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "incidents", type: "circle", source: "incidents", minzoom: 3,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, ["+", 1.5, ["*", 0.6, ["get", "lm"]]], 8, ["+", 3, ["*", 1.6, ["get", "lm"]]]],
      "circle-color": ["match", ["get", "root"], 20, "#d03b3b", "#ec835a"],
      "circle-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0.35, 5, 0.6],
      "circle-stroke-color": "rgba(0,0,0,0.5)", "circle-stroke-width": 0.6,
      "circle-opacity-transition": { duration: 650 },
    },
  }, "capital-dots");
  map.on("mousemove", "incidents", (e) => {
    const p = e.features[0].properties; const tip = $("#tooltip");
    tip.innerHTML = incidentHtml(p);
    tip.hidden = false; tip.style.left = (e.point.x + 14) + "px"; tip.style.top = (e.point.y + 14) + "px";
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", "incidents", () => { $("#tooltip").hidden = true; map.getCanvas().style.cursor = ""; });
  map.on("click", "incidents", (e) => {
    e.originalEvent._handled = true;
    openIncidentFeature(e.features[0]);
  });

  // ---- military aircraft (public ADS-B, served with a delay)
  map.addImage("plane", planeIcon(), { sdf: true, pixelRatio: 2 });
  map.addImage("plane-outline", planeIcon(true), { pixelRatio: 2 });
  map.addImage("heli", heliIcon(), { sdf: true, pixelRatio: 2 });
  map.addImage("heli-outline", heliIcon(true), { pixelRatio: 2 });
  map.addSource("aircraft", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addSource("aircraft-trails", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  const acColor = ["match", ["get", "cat"], ...Object.entries(AIRCRAFT_COLOR).flat(), AIRCRAFT_COLOR.other];
  map.addLayer({
    id: "aircraft-trails-casing", type: "line", source: "aircraft-trails",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "rgba(0,0,0,0.55)", "line-width": 4 },
  });
  map.addLayer({
    id: "aircraft-trails", type: "line", source: "aircraft-trails",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": acColor, "line-width": 2, "line-opacity": 0.85 },
  });
  // a solid dark silhouette underneath gives every plane a crisp outline on any background
  map.addLayer({
    id: "aircraft-outline", type: "symbol", source: "aircraft",
    layout: {
      "icon-image": ["match", ["get", "cat"], "heli", "heli-outline", "plane-outline"], "icon-size": ["interpolate", ["linear"], ["zoom"], 1, 0.9, 6, 1.35],
      "icon-rotate": ["coalesce", ["get", "track"], 0], "icon-rotation-alignment": "map",
      "icon-allow-overlap": true, "icon-ignore-placement": true,
    },
  });
  map.addLayer({
    id: "aircraft", type: "symbol", source: "aircraft",
    layout: {
      "icon-image": ["match", ["get", "cat"], "heli", "heli", "plane"], "icon-size": ["interpolate", ["linear"], ["zoom"], 1, 0.9, 6, 1.35],
      "icon-rotate": ["coalesce", ["get", "track"], 0], "icon-rotation-alignment": "map",
      "icon-allow-overlap": true, "icon-ignore-placement": true,
      "text-field": ["step", ["zoom"], "", 4, ["coalesce", ["get", "flight"], ""]],
      "text-font": ["Open Sans Regular"], "text-size": 10, "text-offset": [0, 1.3], "text-anchor": "top", "text-optional": true,
    },
    paint: { "icon-color": acColor,
             "text-color": "#e6e4da", "text-halo-color": "#000", "text-halo-width": 1.4 },
  });
  map.on("mousemove", "aircraft", (e) => {
    const tip = $("#tooltip");
    tip.innerHTML = aircraftHtml(e.features[0].properties, false);
    tip.hidden = false; tip.style.left = (e.point.x + 14) + "px"; tip.style.top = (e.point.y + 14) + "px";
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", "aircraft", () => { $("#tooltip").hidden = true; map.getCanvas().style.cursor = ""; });
  map.on("click", "aircraft", (e) => {
    e.originalEvent._handled = true;
    openAircraftFeature(e.features[0]);
  });

  // ---- military ships (AIS, served with a delay)
  map.addImage("ship", shipIcon(), { sdf: true, pixelRatio: 2 });
  map.addImage("ship-outline", shipIcon(true), { pixelRatio: 2 });
  map.addSource("ships", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addSource("ship-trails", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "ship-trails", type: "line", source: "ship-trails", layout: { visibility: "none", "line-cap": "round" },
    paint: { "line-color": SHIP_COLOR, "line-width": 1.6, "line-opacity": 0.6, "line-dasharray": [1, 1.5] } });
  const shipLayout = (img) => ({ visibility: "none", "icon-image": img,
    "icon-size": ["interpolate", ["linear"], ["zoom"], 1, 0.8, 6, 1.25],
    "icon-rotate": ["coalesce", ["get", "heading"], 0], "icon-rotation-alignment": "map",
    "icon-allow-overlap": true, "icon-ignore-placement": true });
  map.addLayer({ id: "ships-outline", type: "symbol", source: "ships", layout: shipLayout("ship-outline") });
  map.addLayer({ id: "ships", type: "symbol", source: "ships",
    layout: { ...shipLayout("ship"), "text-field": ["step", ["zoom"], "", 4, ["get", "name"]], "text-font": ["Open Sans Regular"],
              "text-size": 10, "text-offset": [0, 1.4], "text-anchor": "top", "text-optional": true },
    paint: { "icon-color": SHIP_COLOR, "text-color": "#cfe9ff", "text-halo-color": "#000", "text-halo-width": 1.4 } });
  map.on("mousemove", "ships", (e) => {
    const tip = $("#tooltip"); tip.innerHTML = shipHtml(e.features[0].properties, false);
    tip.hidden = false; tip.style.left = (e.point.x + 14) + "px"; tip.style.top = (e.point.y + 14) + "px";
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", "ships", () => { $("#tooltip").hidden = true; map.getCanvas().style.cursor = ""; });
  map.on("click", "ships", (e) => {
    e.originalEvent._handled = true;
    const f = e.features[0];
    new maplibregl.Popup({ closeButton: true, maxWidth: "300px" }).setLngLat(f.geometry.coordinates).setHTML(shipHtml(f.properties)).addTo(map);
  });
  setInterval(loadShips, 60000);

  // hover outline
  map.on("mousemove", "country-fill", (e) => {
    const iso = e.features[0].properties.ADM0_A3;
    if (iso !== hoverIso) {
      if (hoverIso) map.setFeatureState({ source: "countries", id: hoverIso }, { hover: false });
      map.setFeatureState({ source: "countries", id: iso }, { hover: true });
      hoverIso = iso;
    }
  });
  map.on("mouseleave", "country-fill", () => {
    if (hoverIso) map.setFeatureState({ source: "countries", id: hoverIso }, { hover: false });
    hoverIso = null;
  });

  // hover tooltip on countries
  const tip = $("#tooltip");
  map.on("mousemove", "country-fill", (e) => {
    const f = e.features[0]; const iso = f.properties.ADM0_A3;
    const h = STATE?.gdelt.heat[iso];
    const inv = STATE ? STATE.conflicts.filter(c => c.parties.some(p => norm(p.country) === iso)).map(c => c.name) : [];
    tip.innerHTML = `<b>${esc(f.properties.NAME_EN || f.properties.NAME)}</b>` +
      (h ? `<br>${h.events} conflict events · ${h.mentions} mentions (${STATE.gdelt.hours}h)` : "<br>no GDELT conflict events") +
      (inv.length ? `<br>involved in: ${esc(inv.join(", "))}` : "");
    tip.hidden = false; tip.style.left = (e.point.x + 14) + "px"; tip.style.top = (e.point.y + 14) + "px";
  });
  map.on("mouseleave", "country-fill", () => { tip.hidden = true; });
  map.on("click", "country-fill", (e) => {
    if (e.originalEvent._handled) return;          // an incident / attack circle on top took this click
    if (fuzzyTap(e)) return;                        // a finger landed next to one
    const iso = e.features[0].properties.ADM0_A3;
    const list = conflictsFor(iso);
    if (!list.length) return;                       // fall through to the map click (deselect)
    e.originalEvent._handled = true;
    const idx = list.findIndex(c => c.id === selected);
    select(list[(idx + 1) % list.length].id);      // clicking again cycles through that country's conflicts
  });

  await loadCountries();
  restoreSettings();          // before the first data load so the 24h/48h window is right
  await load();
  const shared = hashParam("c");
  if (shared && STATE.conflicts.find(c => c.id === shared)) select(shared, { keepView: true });
  setInterval(load, 60000);
  // off by default: start the aircraft layers hidden until the toggle is ticked
  for (const id of ["aircraft", "aircraft-outline", "aircraft-trails", "aircraft-trails-casing"])
    map.setLayoutProperty(id, "visibility", $("#tg-aircraft").checked ? "visible" : "none");
  loadAircraft();
  setInterval(loadAircraft, 60000);
});

async function loadCountries() {
  COUNTRIES = await (await fetch("/api/countries")).json();
  const seen = new Set();
  const feats = [];
  for (const c of Object.values(COUNTRIES)) {
    if (seen.has(c.iso3) || !c.name) continue;
    seen.add(c.iso3);
    feats.push({ type: "Feature", geometry: { type: "Point", coordinates: [c.lon, c.lat] },
                 properties: { name: (c.label || c.name).replace("United States of America", "United States"), rank: (c.label || c.name).length } });
  }
  map.getSource("labels").setData({ type: "FeatureCollection", features: feats });
}

/* ---------- data ---------- */
async function load() {
  const hours = $("#window").value;
  STATE = await (await fetch(`/api/state?hours=${hours}`)).json();
  render();
}

function render() {
  renderStatus();
  renderHeat();
  renderMarkers();
  renderArcs();
  renderGdeltArcs();
  renderStrikes();
  renderIncidents();
  if (readerOpen) { /* leave the article on screen; the list/detail refresh underneath when it closes */ }
  else if (selected && STATE.conflicts.find(c => c.id === selected)) renderDetail(); else { selected = null; renderList(); }
  applyInvolvement();
}

function renderStatus() {
  const m = STATE.meta, g = STATE.gdelt;
  const parts = [];
  parts.push(`${STATE.conflicts.length} conflicts`);
  parts.push(`${m.sources} sources`);
  parts.push(`${g.total.toLocaleString()} GDELT events / ${g.hours}h`);
  parts.push(`extract ${ago(m.last_extract?.at)}`);
  if (m.busy) parts.push(`⟳ refreshing (${m.unprocessed} articles queued)`);
  else if (m.unprocessed) parts.push(`${m.unprocessed} articles queued`);
  $("#status").textContent = parts.join(" · ");
  $("#refresh").disabled = !!m.busy;
  $("#refresh").hidden = !!m.serve_only;
}

function renderHeat() {
  const heat = STATE.gdelt.heat;
  // power curve so only genuinely hot countries glow, not every country with a few events
  const vals = Object.values(heat).map(h => Math.log1p(h.mentions));
  const max = Math.max(1, ...vals);
  const curve = (v) => Math.pow(v / max, 3);
  for (const iso of Object.keys(COUNTRIES)) map.setFeatureState({ source: "countries", id: iso }, { heat: 0 });
  for (const [iso, h] of Object.entries(heat)) {
    map.setFeatureState({ source: "countries", id: iso }, { heat: curve(Math.log1p(h.mentions)) });
  }
  map.getSource("points").setData({
    type: "FeatureCollection",
    features: STATE.gdelt.points.map(([lon, lat, w]) => ({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: { w } })),
  });
}

const markerById = new Map();
function renderMarkers() {
  const live = new Set();
  for (const c of STATE.conflicts) {
    const ep = c.epicenter; if (!ep || typeof ep.lat !== "number") continue;
    live.add(c.id);
    let m = markerById.get(c.id);
    if (!m) {
      const el = document.createElement("div");
      el.className = "mk";
      const lbl = document.createElement("span"); lbl.className = "mk-label"; el.appendChild(lbl);
      el.addEventListener("click", (e) => { e.stopPropagation(); select(c.id); });
      m = new maplibregl.Marker({ element: el }).setLngLat([ep.lon, ep.lat]).addTo(map);
      markerById.set(c.id, m);
    }
    const el = m.getElement();
    const size = 8 + (c.severity || 1) * 3;
    el.style.width = el.style.height = size + "px";
    el.style.background = el.style.color = STATUS_COLOR[c.status] || STATUS_COLOR.active;
    el.title = c.name;
    el.querySelector(".mk-label").textContent = c.name;
    el.querySelector(".mk-label").style.left = (size + 2) + "px";
    el.classList.toggle("dim", !!(selected && selected !== c.id));
    el.classList.toggle("selected", selected === c.id);
    m.setLngLat([ep.lon, ep.lat]);
  }
  for (const [id, m] of markerById) if (!live.has(id)) { m.remove(); markerById.delete(id); }
}

function renderArcs() {
  const feats = [];
  for (const c of STATE.conflicts) {
    const ep = c.epicenter; if (!ep) continue;
    for (const p of c.parties) {
      const iso = norm(p.country); if (!iso) continue;
      const cc = COUNTRIES[iso];
      // combatants whose own territory hosts the epicenter don't need an arc
      const from = [cc.lon, cc.lat], to = [ep.lon, ep.lat];
      const dist = Math.hypot(from[0] - to[0], from[1] - to[1]);
      if (p.role === "combatant" && dist < 12) continue;
      feats.push({
        type: "Feature", geometry: { type: "LineString", coordinates: arc(from, to) },
        properties: { color: SIDE_COLOR[p.side] || SIDE_COLOR.other, combat: p.role === "combatant", conflict: c.id },
      });
    }
  }
  map.getSource("arcs").setData({ type: "FeatureCollection", features: feats });
}

function renderGdeltArcs() {
  const pairs = STATE.gdelt.pairs; const max = Math.max(1, ...pairs.map(p => p.mentions));
  const feats = pairs.filter(p => COUNTRIES[p.a] && COUNTRIES[p.b]).map(p => ({
    type: "Feature",
    geometry: { type: "LineString", coordinates: arc([COUNTRIES[p.a].lon, COUNTRIES[p.a].lat], [COUNTRIES[p.b].lon, COUNTRIES[p.b].lat]) },
    properties: { w: p.mentions / max },
  }));
  map.getSource("garcs").setData({ type: "FeatureCollection", features: feats });
}

function applyInvolvement() {
  const c = STATE.conflicts.find(x => x.id === selected);
  const sides = {};                                  // iso -> side
  if (c) for (const p of c.parties) { const iso = norm(p.country); if (iso && !sides[iso]) sides[iso] = p.side || "other"; }
  const isos = Object.keys(sides);
  const inList = ["in", ["get", "ADM0_A3"], ["literal", isos]];
  const sideColor = isos.length
    ? ["match", ["get", "ADM0_A3"], ...isos.flatMap(i => [i, SIDE_COLOR[sides[i]] || SIDE_COLOR.other]), SIDE_COLOR.other]
    : SIDE_COLOR.other;
  // every change goes through setPaintProperty so MapLibre cross-fades old and new values per feature
  map.setPaintProperty("country-fill", "fill-color", isos.length ? ["case", inList, sideColor, HEAT_COLOR_EXPR] : HEAT_COLOR_EXPR);
  map.setPaintProperty("country-fill", "fill-opacity", isos.length ? ["case", inList, 0.5, HEAT_OPACITY_EXPR] : HEAT_OPACITY_EXPR);
  map.setPaintProperty("country-involved", "line-color", sideColor);
  map.setPaintProperty("country-involved", "line-opacity", isos.length ? ["case", inList, 1, 0] : 0);
  map.setPaintProperty("country-dim", "fill-opacity", c ? ["case", inList, 0, 0.78] : 0);
  // arcs and strikes of other conflicts fade instead of snapping
  const own = (full, dimmed) => c ? ["case", ["==", ["get", "conflict"], c.id], full, dimmed] : full;
  map.setPaintProperty("arcs", "line-opacity", own(0.85, 0.12));
  map.setPaintProperty("strike-paths", "line-opacity", own(0.3, 0.06));
  const isCountry = ["==", ["get", "precision"], "country"];
  map.setPaintProperty("strike-impacts", "circle-opacity", own(["case", isCountry, 0.08, 0.2], 0.04));
  map.setPaintProperty("strike-impacts", "circle-stroke-opacity", own(["case", isCountry, 0.9, 0], ["case", isCountry, 0.12, 0]));
  map.setPaintProperty("strike-icons", "icon-opacity", own(["case", isCountry, 0.6, 1], 0.15));
  setFocus(!!c);
  if (map.getLayer("incidents")) applyIncidentFocus();
}

function setFocus(on) {
  map.setPaintProperty("bg", "background-color", on ? "#03040a" : OCEAN);
  map.setPaintProperty("relief", "raster-opacity", on ? 0.45 : 1);
  map.setPaintProperty("heat", "heatmap-opacity", on ? 0.25 : 0.7);
  map.setPaintProperty("country-glow", "line-opacity", on ? 0.08 : 0.22);
  map.setPaintProperty("country-line", "line-color", on ? "rgba(210,225,255,0.08)" : "rgba(210,225,255,0.22)");
}

/* which conflicts is a country a party to? */
const conflictsFor = (iso) => STATE.conflicts.filter(c => c.parties.some(p => norm(p.country) === iso));

/* ---------- panel ---------- */
function sevbar(n) { return `<span class="sevbar">${[1, 2, 3, 4, 5].map(i => `<i class="${i <= n ? "on" : ""}"></i>`).join("")}</span>`; }

function reveal(el) { el.classList.remove("reveal"); void el.offsetWidth; el.classList.add("reveal"); }
function renderList() {
  $("#reader").hidden = true; readerOpen = false;
  $("#detail").hidden = true; $("#list").hidden = false; reveal($("#list"));
  if (!STATE.conflicts.length) {
    $("#list").innerHTML = `<div class="empty">No conflicts extracted yet.<br><br>${STATE.meta.busy ? "The first refresh is running — the local model is reading the news feeds now." : "Press Refresh to fetch the feeds and run extraction."}</div>`;
    return;
  }
  $("#list").innerHTML = STATE.conflicts.map(c => {
    const combat = c.parties.filter(p => p.role === "combatant" && norm(p.country)).map(p => flag(norm(p.country)));
    const others = c.parties.filter(p => p.role !== "combatant" && norm(p.country)).map(p => flag(norm(p.country)));
    return `<div class="card ${c.id === selected ? "selected" : ""}" data-id="${esc(c.id)}">
      <div class="head"><span class="name">${esc(c.name)}</span>${sevbar(c.severity)}<span class="badge st-${esc(c.status)}">${esc(c.status)}</span></div>
      <div class="region">${esc(c.region || "")} · updated ${ago(c.updated)}${nStrikes(c.id) ? ` · ${nStrikes(c.id)} strikes / 7d` : ""}</div>
      <div class="flags">${[...new Set(combat)].join(" ")}<span style="opacity:.5"> ${[...new Set(others)].join(" ")}</span></div>
    </div>`;
  }).join("");
  document.querySelectorAll(".card").forEach(el => el.addEventListener("click", () => select(el.dataset.id)));
}

function renderDetail() {
  const c = STATE.conflicts.find(x => x.id === selected); if (!c) return renderList();
  $("#reader").hidden = true; readerOpen = false;
  $("#list").hidden = true; const d = $("#detail"); d.hidden = false; reveal(d);
  const bySide = { A: [], B: [], other: [] };
  for (const p of c.parties) (bySide[p.side] || bySide.other).push(p);
  const party = (p) => {
    const iso = norm(p.country);
    return `<div class="party ${esc(p.side || "other")}"><span class="flag">${iso ? flag(iso) : "▪"}</span>
      <span class="pname">${esc(p.name)}</span><span class="role">${esc(p.role)}</span><span class="note">${esc(p.note || "")}</span></div>`;
  };
  const sideBlock = (k, lbl) => bySide[k].length ? `<div class="side"><div class="lbl">${lbl}</div>${bySide[k].map(party).join("")}</div>` : "";
  d.innerHTML = `
    <span class="back">← all conflicts</span>
    <h2>${esc(c.name)}</h2>
    <div class="meta"><span class="badge st-${esc(c.status)}">${esc(c.status)}</span>${sevbar(c.severity)} <span>${esc(c.region || "")}</span></div>
    ${statTiles(c)}
    <p class="summary">${esc(c.summary)}</p>
    ${figureList(c)}
    <h3>Who is involved</h3>
    ${sideBlock("A", "Side A")}${sideBlock("B", "Side B")}${sideBlock("other", "Mediators / others")}
    <h3>Consequences</h3>
    <div class="cons">${(c.consequences || []).map(x => `<div class="con"><span class="cat">${esc(x.category)}</span><span>${esc(x.text)}${(x.affects || []).length ? ` <span style="opacity:.6">${x.affects.map(a => flag(norm(a))).join(" ")}</span>` : ""}</span></div>`).join("") || "<div class='empty'>none recorded</div>"}</div>
    <h3>Latest developments</h3>
    ${(c.developments || []).map(x => `<div class="dev" data-url="${esc((x.sources || [])[0] || "")}"><span class="date">${esc(x.date)}</span><span>${esc(x.text)}${(x.sources || []).map(u => ` <a href="${esc(u)}" target="_blank" title="open original">↗</a>`).join("")}</span></div>`).join("")}
    <h3>Reported attacks (7 days)</h3>
    ${conflictStrikes(c.id).map(st => `<div class="strike" data-id="${st.id}">
      <span class="date">${esc(st.date.slice(5).replace("-", "/"))}</span><span class="w">${weaponSvg(st.weapon)}</span>
      <span class="body"><span class="route">${(st.attacker && st.attacker !== "unknown") ? esc(st.attacker) + " → " : st.origin_name ? esc(st.origin_name) + " → " : ""}${esc(st.target_name)}</span><span class="prec">${esc(st.target_precision)}</span><br>
      <span class="meta">${esc(st.weapon)}${st.launched != null ? ` · ${st.launched} launched` : ""}${st.intercepted != null ? ` · ${st.intercepted} intercepted` : ""}${st.outcome ? ` · ${esc(st.outcome)}` : ""}</span></span>
    </div>`).join("") || "<div class='empty'>none reported in the feeds</div>"}
    <h3>Sources</h3>
    ${(c.sources || []).slice(0, 12).map(s => `<div class="src" data-url="${esc(s.link)}" data-title="${esc(s.title)}" data-source="${esc(s.source)}">${esc(s.title)} <span class="s">— ${esc(s.source)}</span> <a href="${esc(s.link)}" target="_blank" title="open original">↗</a></div>`).join("")}
  `;
  d.querySelector(".back").addEventListener("click", () => select(null));
  d.querySelectorAll(".fig[data-url]").forEach(el => el.addEventListener("click", (ev) => {
    if (ev.target.tagName === "A") return;
    openArticle(el.dataset.url, { title: el.dataset.title, source: el.dataset.source });
  }));
  d.querySelectorAll(".src").forEach(el => el.addEventListener("click", (ev) => {
    if (ev.target.tagName === "A") return;
    openArticle(el.dataset.url, { title: el.dataset.title, source: el.dataset.source });
  }));
  d.querySelectorAll(".dev").forEach(el => el.addEventListener("click", (ev) => {
    if (ev.target.tagName === "A" || !el.dataset.url) return;
    openArticle(el.dataset.url, {});
  }));
  d.querySelectorAll(".strike").forEach(el => el.addEventListener("click", () => {
    const st = STATE.strikes.find(x => x.id === +el.dataset.id);
    if (!st) return;
    map.flyTo({ center: [st.target_lon, st.target_lat], zoom: Math.max(map.getZoom(), 5.5), speed: 0.9, padding: sheetPadding() });
    if (st.link) openArticle(st.link, { title: st.title, source: st.source, context: strikeHtml(st) });   // show the report too
    else if (isMobile() && $("#panel").dataset.sheet === "full") setSheet("peek");
  }));
}

function select(id, opts = {}) {
  selected = id;
  if (id && $("#tg-rotate").checked) { $("#tg-rotate").checked = false; $("#tg-rotate").dispatchEvent(new Event("change")); }
  const c = STATE.conflicts.find(x => x.id === id);
  setHashParam("c", c ? c.id : null);
  if (c && isMobile() && $("#panel").dataset.sheet === "min") setSheet("peek");
  if (c && c.epicenter && !opts.keepView) map.flyTo({ center: [c.epicenter.lon, c.epicenter.lat], zoom: Math.max(map.getZoom(), 3.2), speed: 0.55, curve: 1.3, essential: true, padding: sheetPadding() });
  renderMarkers(); renderArcs(); applyInvolvement(); renderStrikes();
  if (c) renderDetail(); else renderList();
}

/* ---------- remember settings across reloads (per browser) ---------- */
const SETTINGS_KEY = "conflictMapSettings";
const SETTING_IDS = ["tg-globe", "tg-rotate", "tg-night", "tg-heat", "tg-arcs", "tg-gdelt-arcs", "tg-strikes",
                     "tg-incidents", "tg-aircraft", "tg-ships", "window"];
function saveSettings() {
  const out = {};
  for (const id of SETTING_IDS) { const el = document.getElementById(id); if (el) out[id] = el.type === "checkbox" ? el.checked : el.value; }
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(out)); } catch (_) {}
}
function restoreSettings() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null"); } catch (_) {}
  for (const id of SETTING_IDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener("change", saveSettings);
    if (!saved || !(id in saved)) continue;
    if (id === "tg-rotate" && sharedView) continue;           // a shared link keeps its own view still
    const cur = el.type === "checkbox" ? el.checked : el.value;
    if (cur === saved[id]) continue;
    if (el.type === "checkbox") el.checked = saved[id]; else el.value = saved[id];
    if (id !== "window") el.dispatchEvent(new Event("change"));   // apply it through the normal handler
  }
}

/* ---------- conflict stats ---------- */
const FIG_LABEL = {
  killed: "killed", casualties: "killed + wounded", killed_civilians: "civilians killed", wounded: "wounded",
  displaced: "displaced", refugees: "refugees", in_need: "need aid", hostages: "hostages", missing: "missing",
};
function fmtNum(v) {
  if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
  if (v >= 1e4) return Math.round(v / 1e3) + "k";
  return v.toLocaleString("en-GB");
}
function parseStart(d) {
  const m = String(d || "").match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/);
  return m ? { date: new Date(Date.UTC(+m[1], m[2] ? +m[2] - 1 : 0, m[3] ? +m[3] : 1)), precision: m[3] ? "day" : m[2] ? "month" : "year" } : null;
}
function durationText(start) {
  const days = Math.floor((Date.now() - start.date.getTime()) / 86400000);
  if (days < 60) return { big: `${days}`, unit: days === 1 ? "day" : "days" };
  const years = days / 365.25;
  if (years < 2) return { big: `${Math.round(days / 30.44)}`, unit: "months" };
  return { big: years.toFixed(1).replace(/\.0$/, ""), unit: "years" };
}
function partyIsos(c) { return [...new Set(c.parties.map(p => norm(p.country)).filter(Boolean))]; }
function statTiles(c) {
  const tiles = [];
  const st = c.stats || {};
  const start = parseStart(st.started && st.started.date);
  if (start) {
    const dur = durationText(start);
    const fmt = { day: { day: "numeric", month: "short", year: "numeric" }, month: { month: "short", year: "numeric" }, year: { year: "numeric" } }[start.precision];
    const since = start.date.toLocaleDateString("en-GB", { ...fmt, timeZone: "UTC" });
    tiles.push(`<div class="tile" title="${esc(st.started.event || "")}${st.started.basis === "background" ? " (start date from background knowledge, not a cited article)" : ""}">
      <div class="big">${dur.big}<span class="unit"> ${dur.unit}</span></div><div class="lbl">since ${esc(since)}</div></div>`);
  }
  const a = c.activity || {};
  if (a.attacks_7d || a.attacks_prev_7d) {
    const diff = (a.attacks_7d || 0) - (a.attacks_prev_7d || 0);
    const fullPrevWeek = STATE.meta.attacks_since && (Date.now() / 1000 - STATE.meta.attacks_since) > 14 * 86400;
    const trend = !fullPrevWeek ? "" : diff > 0 ? `<span class="up">▲ ${diff}</span>` : diff < 0 ? `<span class="down">▼ ${-diff}</span>` : `<span class="flat">=</span>`;
    tiles.push(`<div class="tile" title="Located attacks extracted from the news, this week vs the week before">
      <div class="big">${a.attacks_7d || 0} ${trend}</div><div class="lbl">attacks reported, 7 days</div></div>`);
  }
  const isos = partyIsos(c);
  const inc = (STATE.gdelt.incidents || []).filter(i => isos.includes(i.iso3)).reduce((n, i) => n + i.n, 0);
  if (inc) tiles.push(`<div class="tile" title="GDELT fighting / mass-violence events located in the parties' countries (press attention, not a verified count)">
      <div class="big">${fmtNum(inc)}</div><div class="lbl">press-reported clashes, ${STATE.gdelt.hours}h</div></div>`);
  const outlets = new Set((c.sources || []).map(s => s.source)).size;
  if (outlets) tiles.push(`<div class="tile" title="Distinct outlets among this conflict's recent sources"><div class="big">${outlets}</div><div class="lbl">outlets reporting</div></div>`);
  return tiles.length ? `<div class="tiles">${tiles.join("")}</div>` : "";
}
function figureList(c) {
  const figs = ((c.stats || {}).figures || []).slice().sort((x, y) => (y.cumulative === true) - (x.cumulative === true) || (y.as_of || "").localeCompare(x.as_of || ""));
  if (!figs.length) return "";
  const sideName = (side) => side === "A" || side === "B" ? (c.parties.find(p => p.side === side && p.role === "combatant") || {}).name || `side ${side}` : "";
  const rows = figs.slice(0, 8).map(f => {
    const who = sideName(f.side);
    const period = f.cumulative ? "since the start" : f.period;
    return `<div class="fig" data-url="${esc(f.link || "")}" data-title="${esc(f.title || "")}" data-source="${esc(f.source || "")}">
      <div class="fighead"><span class="num">${fmtNum(f.value)}</span> <span class="what">${esc(FIG_LABEL[f.key] || f.key)}${who ? ` · ${esc(who)}` : ""}</span>
        <span class="per">${esc(period)}</span>${f.claimant_is_party ? `<span class="claim" title="Figure published by one of the warring parties">party claim</span>` : ""}</div>
      ${f.quote ? `<div class="quote">“${esc(f.quote)}”</div>` : ""}
      <div class="figsrc">${esc(f.reported_by || "")}${f.as_of ? ` · ${esc(f.as_of)}` : ""} · ${esc(f.source || "")} <a href="${esc(f.link || "#")}" target="_blank" rel="noopener" title="open original">↗</a></div>
    </div>`;
  }).join("");
  return `<h3>Figures in recent reports</h3><div class="figs">${rows}</div>
    <div class="fignote">Quoted from the linked articles. Counts differ between sources and are often disputed.</div>`;
}

/* ---------- reader: show an article in the panel instead of leaving the site ---------- */
let readerOpen = false, readerSeq = 0;
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (_) { return u; } };
async function openArticle(url, opts = {}) {
  const r = $("#reader"); const seq = ++readerSeq;
  $("#list").hidden = true; $("#detail").hidden = true; r.hidden = false; readerOpen = true; reveal(r);
  if (isMobile()) setSheet("full");
  $("#panel").scrollTop = 0;
  const alts = opts.alternatives && opts.alternatives.length > 1 ? opts.alternatives : null;
  const altHtml = alts ? `<div class="alt">${alts.map(u => `<div class="${u === url ? "on" : ""}" data-url="${esc(u)}">${esc(host(u))}</div>`).join("")}</div>` : "";
  r.innerHTML = `<span class="back">← back</span>
    ${opts.context ? `<div class="meta" style="margin-bottom:8px">${opts.context}</div>` : ""}${altHtml}
    <div class="site">${esc(opts.source || host(url))}</div>
    <h2>${esc(opts.title || "")}</h2>
    <div class="loading">Loading article</div>`;
  r.querySelector(".back").addEventListener("click", closeReader);
  r.querySelectorAll(".alt div").forEach(el => el.addEventListener("click", () => openArticle(el.dataset.url, opts)));
  let a;
  try { a = await (await fetch(`/api/article?url=${encodeURIComponent(url)}`)).json(); }
  catch (_) { a = { ok: false, error: "could not reach the server" }; }
  if (a && a.error && /too many/.test(a.error)) a.error = "you've opened a lot of articles in the last minute; wait a moment";
  if (seq !== readerSeq) return;           // another article was opened meanwhile
  const orig = `<a href="${esc(a.final_url || url)}" target="_blank">open original ↗</a>`;
  if (!a.ok) {
    r.querySelector(".loading").outerHTML = `<div class="err">Couldn't extract this article (${esc(a.error || "unknown error")}).<br>${orig}</div>`;
    return;
  }
  r.querySelector(".site").textContent = a.site || host(a.final_url || url);
  r.querySelector("h2").textContent = a.title || opts.title || "";
  r.querySelector(".loading").outerHTML =
    `<div class="meta">${[a.byline, a.date].filter(Boolean).map(esc).join(" · ")}${a.byline || a.date ? " · " : ""}${orig}</div>` +
    (a.image ? `<img class="hero" src="${esc(a.image)}" alt="" loading="lazy" onerror="this.remove()">` : "") +
    (a.note ? `<div class="err">${esc(a.note)}</div>` : "") +
    a.paragraphs.map(t => `<p>${esc(t)}</p>`).join("") +
    `<div class="meta" style="margin-top:14px">Reader view · ${orig}</div>`;
}
function closeReader() {
  readerOpen = false; $("#reader").hidden = true;
  if (isMobile() && $("#panel").dataset.sheet === "full") setSheet("peek");
  $("#panel").scrollTop = 0;
  if (selected && STATE.conflicts.find(c => c.id === selected)) renderDetail(); else renderList();
}

function openStrikeFeature(f, lngLat) {
  const p = f.properties;
  if (p.link) openArticle(p.link, { title: p.title, source: p.source, context: strikeHtml(p) });
  else new maplibregl.Popup({ closeButton: true, maxWidth: "300px" }).setLngLat(lngLat).setHTML(strikeHtml(p)).addTo(map);
}
function openIncidentFeature(f) {
  const p = f.properties;
  let urls = [];
  try { urls = JSON.parse(p.urls || "[]"); } catch (_) { urls = p.url ? [p.url] : []; }
  if (urls.length) openArticle(urls[0], { alternatives: urls, context: incidentHtml(p) + `<div style="opacity:.55;margin-top:4px">Articles GDELT tagged with this place. Placement is automatic and can be wrong.</div>` });
}
/* fingers are imprecise: on touch screens a tap near a strike / incident circle counts as a hit */
function fuzzyTap(e) {
  if (!coarseMQ.matches || e.originalEvent._handled) return false;
  const r = 14, { x, y } = e.point;
  const layers = ["aircraft", "strike-impacts", "incidents"].filter(id => map.getLayer(id) && map.getLayoutProperty(id, "visibility") !== "none");
  const hits = map.queryRenderedFeatures([[x - r, y - r], [x + r, y + r]], { layers });
  if (!hits.length) return false;
  e.originalEvent._handled = true;
  const f = hits.find(h => h.layer.id === "aircraft") || hits.find(h => h.layer.id === "strike-impacts") || hits[0];
  if (f.layer.id === "aircraft") openAircraftFeature(f);
  else if (f.layer.id === "strike-impacts") openStrikeFeature(f, e.lngLat); else openIncidentFeature(f);
  return true;
}

/* ---------- military ships ---------- */
const SHIP_COLOR = "#8fd3ff";
let SHIPS = null;
/* top-down hull, bow up */
function shipIcon(outline = false) {
  const n = 48, c = document.createElement("canvas"); c.width = c.height = n;
  const g = c.getContext("2d"); g.beginPath();
  [[24, 3], [31, 14], [31, 41], [24, 45], [17, 41], [17, 14]].forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y));
  g.closePath();
  if (outline) { g.lineJoin = "round"; g.lineWidth = 6; g.strokeStyle = "rgba(0,0,0,0.9)"; g.stroke(); g.fillStyle = "rgba(0,0,0,0.9)"; g.fill(); }
  else { g.fillStyle = "#fff"; g.fill(); g.globalCompositeOperation = "destination-out"; g.fillRect(21, 20, 6, 9); }   // superstructure cut-out
  return g.getImageData(0, 0, n, n);
}
async function loadShips() {
  if (!$("#tg-ships").checked || document.hidden) return;
  try { SHIPS = await (await fetch("/api/ships")).json(); } catch (_) { return; }
  const list = SHIPS.ships || [];
  map.getSource("ships").setData({ type: "FeatureCollection", features: list.map(v => ({
    type: "Feature", geometry: { type: "Point", coordinates: [v.lon, v.lat] }, properties: { ...v, trail: undefined } })) });
  map.getSource("ship-trails").setData({ type: "FeatureCollection", features: list.filter(v => v.trail.length > 1).map(v => ({
    type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: v.trail } })) });
  const lbl = $("#ships-count");
  lbl.textContent = SHIPS.enabled ? `(${list.length})` : "(off)";
  lbl.parentElement.title = SHIPS.enabled
    ? `Naval vessels broadcasting AIS in watched seas, ${SHIPS.delay_min}-min delay. Most warships switch AIS off; auxiliaries and patrol vessels are the usual catch.`
    : "Ship layer needs an aisstream.io API key on the server";
}
function shipHtml(p, full = true) {
  const kn = p.sog != null && p.sog !== "" ? `${(+p.sog).toFixed(1)} kn` : "";
  const when = p.seen ? new Date(p.seen * 1000).toISOString().slice(11, 16) + " UTC" : "";
  let h = `<b>${esc(p.name)}</b>${p.callsign ? ` · ${esc(p.callsign)}` : ""}<br>${[kn, p.dest ? "→ " + esc(p.dest) : ""].filter(Boolean).join(" · ")}`;
  if (full) h += `<br><span style="opacity:.6">Position at ${when}, shown ${SHIPS ? SHIPS.delay_min : 20} min late on purpose.<br>AIS via aisstream.io. MMSI ${esc(p.mmsi)}.</span>` +
    `<br><a href="https://www.marinetraffic.com/en/ais/details/ships/mmsi:${encodeURIComponent(p.mmsi)}" target="_blank" rel="noopener">more on MarineTraffic ↗</a>`;
  return h;
}

/* ---------- military aircraft ---------- */
const AIRCRAFT_COLOR = { tanker: "#5ec8e5", isr: "#c792ff", transport: "#e6e4da", combat: "#ff5a5a", heli: "#7ed67e", other: "#f0f3fa" };
let AIR = null;             // last /api/aircraft
/* top-down plane silhouette, nose up, drawn once as an SDF so the layer can tint it */
/* weapon icon in its own colour with a dark outline baked in (48px canvas, shown at 24px) */
function weaponIcon(w) {
  const n = 48, c = document.createElement("canvas"); c.width = c.height = n;
  const g = c.getContext("2d"), paths = WEAPON_GLYPH[w].d.map(d => new Path2D(d));
  g.scale(1.6, 1.6); g.translate(3, 3);            // 24-unit glyph centred with room for the outline
  g.lineJoin = "round"; g.lineWidth = 3; g.strokeStyle = "rgba(0,0,0,0.9)"; g.fillStyle = "rgba(0,0,0,0.9)";
  for (const p of paths) { g.stroke(p); g.fill(p); }
  g.fillStyle = WEAPON_COLOR[w] || WEAPON_COLOR.other;
  for (const p of paths) g.fill(p);
  return g.getImageData(0, 0, n, n);
}
function planeIcon(outline = false) {
  const n = 48, c = document.createElement("canvas"); c.width = c.height = n;
  const g = c.getContext("2d"); g.beginPath();
  const pts = [[24, 3], [27, 9], [27, 19], [44, 29], [44, 33], [27, 28], [26, 38], [32, 43], [32, 46], [24, 43.5],
               [16, 46], [16, 43], [22, 38], [21, 28], [4, 33], [4, 29], [21, 19], [21, 9]];
  pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y));
  g.closePath();
  if (outline) { g.lineJoin = "round"; g.lineWidth = 6; g.strokeStyle = "rgba(0,0,0,0.9)"; g.stroke(); g.fillStyle = "rgba(0,0,0,0.9)"; }
  else g.fillStyle = "#fff";
  g.fill();
  return g.getImageData(0, 0, n, n);
}
/* top-down helicopter: rotor disc with two blades, fuselage, tail boom and tail rotor, nose up */
function heliIcon(outline = false) {
  const n = 48, c = document.createElement("canvas"); c.width = c.height = n;
  const g = c.getContext("2d");
  const ink = outline ? "rgba(0,0,0,0.9)" : "#fff";
  g.strokeStyle = ink; g.fillStyle = ink; g.lineCap = "round";
  const pad = outline ? 3 : 0;
  // fuselage + tail boom + tail rotor
  g.beginPath(); g.ellipse(24, 20, 6 + pad, 9 + pad, 0, 0, Math.PI * 2); g.fill();
  g.lineWidth = 3 + pad * 2; g.beginPath(); g.moveTo(24, 27); g.lineTo(24, 42); g.stroke();
  g.lineWidth = 2.5 + pad * 2; g.beginPath(); g.moveTo(19, 42); g.lineTo(29, 42); g.stroke();
  // main rotor: two crossed blades + faint disc
  g.lineWidth = 2.5 + pad * 2; g.beginPath(); g.moveTo(6, 8); g.lineTo(42, 32); g.moveTo(42, 8); g.lineTo(6, 32); g.stroke();
  if (!outline) { g.globalAlpha = 0.35; g.lineWidth = 1.5; g.beginPath(); g.arc(24, 20, 21, 0, Math.PI * 2); g.stroke(); g.globalAlpha = 1; }
  return g.getImageData(0, 0, n, n);
}
async function loadAircraft() {
  if (!$("#tg-aircraft").checked || document.hidden) return;
  try { AIR = await (await fetch("/api/aircraft")).json(); } catch (_) { return; }
  const list = AIR.aircraft || [];
  map.getSource("aircraft").setData({ type: "FeatureCollection", features: list.map(a => ({
    type: "Feature", geometry: { type: "Point", coordinates: [a.lon, a.lat] },
    properties: { ...a, trail: undefined },
  })) });
  map.getSource("aircraft-trails").setData({ type: "FeatureCollection", features: list.filter(a => a.trail.length > 1).map(a => {
    const parts = [[a.trail[0]]];                  // break the trail where it crosses the antimeridian
    for (let i = 1; i < a.trail.length; i++) {
      if (Math.abs(a.trail[i][0] - a.trail[i - 1][0]) > 180) parts.push([]);
      parts[parts.length - 1].push(a.trail[i]);
    }
    return { type: "Feature", properties: { cat: a.cat }, geometry: { type: "MultiLineString", coordinates: parts.filter(p => p.length > 1) } };
  }) });
  if (AIR.delay_min != null) $("#aircraft-note").textContent = `aircraft: public ADS-B (${AIR.source || "airplanes.live"}), ${AIR.delay_min} min delay, only those broadcasting`;
  const lbl = $("#aircraft-count");
  lbl.textContent = AIR.enabled === false ? "(off)" : AIR.warming_up_min ? "(…)" : `(${list.length})`;
  lbl.parentElement.title = AIR.enabled === false ? "Aircraft layer is disabled on this server"
    : AIR.warming_up_min ? `Collecting positions: first ones appear in ~${AIR.warming_up_min} min (shown with a ${AIR.delay_min}-min delay)`
    : `Military aircraft broadcasting ADS-B, as of ${AIR.as_of ? new Date(AIR.as_of * 1000).toISOString().slice(11, 16) + " UTC" : "—"} (${AIR.delay_min}-min delay). Source: ${AIR.source || "none"}`;
}
function aircraftHtml(p, full = true) {
  const fmt = (v, unit) => (v === undefined || v === null || v === "") ? null : `${Math.round(v).toLocaleString()} ${unit}`;
  const title = p.flight || p.reg || String(p.hex).toUpperCase();
  const bits = [fmt(p.alt, "ft"), fmt(p.gs, "kt"), p.track != null && p.track !== "" ? `heading ${Math.round(p.track)}°` : null].filter(Boolean);
  let h = `<b>${esc(title)}</b> <span style="opacity:.6">${esc(p.type)}</span><br>${esc(p.name)}${p.reg && p.reg !== title ? ` · ${esc(p.reg)}` : ""}`;
  if (bits.length) h += `<br>${bits.join(" · ")}`;
  if (full) {
    const when = AIR && AIR.as_of ? new Date(AIR.as_of * 1000).toISOString().slice(11, 16) + " UTC" : "";
    h += `<br><span style="opacity:.6">Position at ${when}, shown ${AIR ? AIR.delay_min : 20} min late on purpose.<br>ADS-B via ${esc(AIR?.source || "airplanes.live")}. Only aircraft that choose to broadcast appear.</span>` +
         `<br><a href="https://globe.airplanes.live/?icao=${encodeURIComponent(p.hex)}" target="_blank" rel="noopener">more on airplanes.live ↗</a>`;
  }
  return h;
}
function openAircraftFeature(f) {
  $("#tooltip").hidden = true;
  new maplibregl.Popup({ closeButton: true, maxWidth: "300px" }).setLngLat(f.geometry.coordinates).setHTML(aircraftHtml(f.properties)).addTo(map);
}

/* ---------- GDELT incidents ---------- */
function incidentHtml(p) {
  const kind = p.root == 20 ? "mass violence" : "fighting / armed clash";
  const day = String(p.day || ""); const d = day.length === 8 ? `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}` : day;
  return `<b>${esc(p.name || "")}</b><br>${esc(kind)} · ${p.n} event${p.n == 1 ? "" : "s"} · ${p.m} mentions · ${esc(d)}<br><span style="opacity:.6">GDELT, press-reported</span>`;
}
function renderIncidents() {
  const feats = (STATE.gdelt.incidents || []).map(i => ({
    type: "Feature", geometry: { type: "Point", coordinates: [i.lon, i.lat] },
    properties: { name: i.name, n: i.n, m: i.m, lm: Math.log2(1 + i.m), root: i.root, day: i.day, url: i.url, urls: JSON.stringify(i.urls || [i.url]), iso3: i.iso3 || "" },
  }));
  map.getSource("incidents").setData({ type: "FeatureCollection", features: feats });
  applyIncidentFocus();
}
function applyIncidentFocus() {
  const c = STATE.conflicts.find(x => x.id === selected);
  const isos = c ? [...new Set(c.parties.map(p => norm(p.country)).filter(Boolean))] : [];
  map.setFilter("incidents", isos.length ? ["in", ["get", "iso3"], ["literal", isos]] : null);
}

/* ---------- strikes ---------- */
let strikeAnim = null;      // {items:[{path, color, id, hasPath}], start}
const dayFilter = () => +$("#day").value;   // 0 = all, 1 = today, 2 = yesterday …
const dayString = (offset) => new Date(Date.now() - (offset - 1) * 86400000).toISOString().slice(0, 10);
function visibleStrikes() {
  let list = STATE.strikes || [];
  const d = dayFilter();
  if (d) list = list.filter(s => s.date === dayString(d));
  return list;
}
const nStrikes = (cid) => (STATE.strikes || []).filter(s => s.conflict_id === cid).length;
const conflictStrikes = (cid) => (STATE.strikes || []).filter(s => s.conflict_id === cid);

/* bent arc: great-circle path bulged sideways so it reads as a trajectory */
function trajectory(from, to) {
  const pts = arc(from, to, 48);
  const dx = to[0] - from[0], dy = to[1] - from[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;                 // perpendicular
  const bulge = Math.min(6, len * 0.18);
  return pts.map((p, i) => { const f = i / (pts.length - 1); const b = Math.sin(Math.PI * f) * bulge; return [p[0] + nx * b, p[1] + ny * b]; });
}

function strikeHtml(p) {
  const who = p.attacker && p.attacker !== "unknown" ? p.attacker : (p.origin_name || "");
  return `<b>${esc(who ? who + " → " : "")}${esc(p.target_name)}</b> <span style="opacity:.6">${esc(p.target_precision)}</span><br>` +
    `${esc(p.date)} · ${esc(p.weapon)}${p.launched != null && p.launched !== "" ? ` · ${p.launched} launched` : ""}${p.intercepted != null && p.intercepted !== "" ? ` · ${p.intercepted} intercepted` : ""}` +
    (p.outcome ? `<br>${esc(p.outcome)}` : "") + (p.source ? `<br><span style="opacity:.6">${esc(p.source)}</span>` : "");
}

function renderStrikes() {
  const list = visibleStrikes();
  const paths = [], impacts = [], items = [];
  list.forEach((st, i) => {
    const color = WEAPON_COLOR[st.weapon] || WEAPON_COLOR.other;
    const dim = !!(selected && selected !== st.conflict_id);   // projectiles of other conflicts stay hidden
    const to = [st.target_lon, st.target_lat];
    const r = 3 + Math.min(6, Math.log2(1 + (st.launched || 1)));
    impacts.push({ type: "Feature", geometry: { type: "Point", coordinates: to },
      properties: { ...st, color, r, icon: weaponKey(st.weapon), precision: st.target_precision, conflict: st.conflict_id } });
    let path = null;
    const crossBorder = st.origin_country && st.target_country && st.origin_country !== st.target_country;
    const usableOrigin = st.origin_lat != null && (st.origin_precision !== "country" || crossBorder);
    if (usableOrigin) {
      path = trajectory([st.origin_lon, st.origin_lat], to);
      paths.push({ type: "Feature", geometry: { type: "LineString", coordinates: path }, properties: { color, conflict: st.conflict_id } });
    }
    items.push({ id: st.id, path, to, color, icon: weaponKey(st.weapon), dir: !!WEAPON_GLYPH[weaponKey(st.weapon)].dir, dim, phase: (i * 0.73) % 1 });
  });
  map.getSource("strike-paths").setData({ type: "FeatureCollection", features: paths });
  map.getSource("strike-impacts").setData({ type: "FeatureCollection", features: impacts });
  strikeAnim = { items };
  if (!strikeAnim.raf) tickStrikes();
}

const PERIOD = 7000; // ms per replay cycle
function tickStrikes() {
  if (!strikeAnim) return;
  if ($("#tg-strikes").checked && !document.hidden) {
    const now = performance.now();
    const proj = [], flashes = [];
    for (const it of strikeAnim.items) {
      if (it.dim) continue;
      const t = ((now / PERIOD) + it.phase) % 1;      // 0..1 within cycle
      if (it.path && t < 0.55) {
        const f = t / 0.55, k = f * (it.path.length - 1), i0 = Math.floor(k), i1 = Math.min(it.path.length - 1, i0 + 1), fr = k - i0;
        const p0 = it.path[i0], p1 = it.path[i1];
        const lat = p0[1] + (p1[1] - p0[1]) * fr;
        const rot = it.dir ? Math.atan2((p1[0] - p0[0]) * Math.cos(lat * Math.PI / 180), p1[1] - p0[1]) * 180 / Math.PI : 0;
        proj.push({ type: "Feature", geometry: { type: "Point", coordinates: [p0[0] + (p1[0] - p0[0]) * fr, lat] }, properties: { icon: it.icon, rot } });
      } else if (t >= 0.55 && t < 0.85) {
        const f = (t - 0.55) / 0.3;
        flashes.push({ type: "Feature", geometry: { type: "Point", coordinates: it.to }, properties: { color: it.color, r: 0.2 + f, a: 1 - f } });
      } else if (!it.path && t < 0.3) {
        // no known origin (internal conflict, unspecified launch site): a second, softer pulse so the impact still reads as active
        const f = t / 0.3;
        flashes.push({ type: "Feature", geometry: { type: "Point", coordinates: it.to }, properties: { color: it.color, r: 0.15 + f * 0.7, a: 0.7 * (1 - f) } });
      }
    }
    map.getSource("projectiles").setData({ type: "FeatureCollection", features: proj });
    map.getSource("flashes").setData({ type: "FeatureCollection", features: flashes });
  }
  strikeAnim.raf = requestAnimationFrame(tickStrikes);
}

function setStrikeVisibility(on) {
  for (const id of ["strike-paths", "strike-impacts", "strike-icons", "projectiles", "flashes"]) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
}

/* ---------- day / night ---------- */
function subsolarPoint(date = new Date()) {
  const rad = Math.PI / 180;
  const d = date.getTime() / 86400000 - 10957.5;                    // days since J2000.0
  const g = ((357.529 + 0.98560028 * d) % 360) * rad;               // mean anomaly
  const q = (280.459 + 0.98564736 * d) % 360;                        // mean longitude (deg)
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad;   // ecliptic longitude
  const e = (23.439 - 0.00000036 * d) * rad;                         // obliquity
  const decl = Math.asin(Math.sin(e) * Math.sin(L));
  let RA = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) / rad; // right ascension (deg)
  let eqt = q - RA; eqt = ((eqt + 540) % 360) - 180;                 // equation of time (deg)
  const utc = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  let lon = -(utc - 12) * 15 - eqt; lon = ((lon + 540) % 360) - 180;
  return { lat: decl / rad, lon };
}
// Darkness from the sun's altitude (deg): 0 at +1°, deepening through civil (-6), nautical (-12)
// and astronomical (-18) twilight. Computed per 2° grid cell, so it is right in every season
// (a single polygon closed over a pole is wrong around the equinoxes).
const NIGHT_MAX = 0.62, NIGHT_CELL = 2;
function darkness(altDeg) {
  const t = Math.min(1, Math.max(0, (1 - altDeg) / 19));      // 0 at +1°, 1 at -18°
  return NIGHT_MAX * t * t * (3 - 2 * t);                      // smoothstep
}
function sunAltitude(lat, lon, sun) {
  const r = Math.PI / 180;
  const s = Math.sin(lat * r) * Math.sin(sun.lat * r) + Math.cos(lat * r) * Math.cos(sun.lat * r) * Math.cos((lon - sun.lon) * r);
  return Math.asin(Math.max(-1, Math.min(1, s))) / r;
}
/* the same altitude as a style expression over a feature's latitude/longitude properties */
function altitudeExpr(sun) {
  const r = Math.PI / 180, sd = Math.sin(sun.lat * r), cd = Math.cos(sun.lat * r);
  const lat = ["*", ["get", "latitude"], r], dlon = ["*", ["-", ["get", "longitude"], sun.lon], r];
  return ["/", ["asin", ["max", -1, ["min", 1, ["+", ["*", ["sin", lat], sd], ["*", ["*", ["cos", lat], cd], ["cos", dlon]]]]]], r];
}
function updateNight() {
  if (!map.getSource("night")) return;
  const empty = { type: "FeatureCollection", features: [] };
  const on = $("#tg-night").checked;
  map.setLayoutProperty("city-lights", "visibility", on ? "visible" : "none");
  if (!on) { for (const id of ["night", "sun", "terminator"]) map.getSource(id).setData(empty); return; }
  const sun = subsolarPoint(), c = NIGHT_CELL;
  const cells = [];
  for (let lat = -90; lat < 90; lat += c) {
    for (let lon = -180; lon < 180; lon += c) {
      const a = darkness(sunAltitude(lat + c / 2, lon + c / 2, sun));
      if (a < 0.004) continue;
      cells.push({ type: "Feature", properties: { a: Math.round(a * 1000) / 1000 },
        geometry: { type: "Polygon", coordinates: [[[lon, lat], [lon + c, lat], [lon + c, lat + c], [lon, lat + c], [lon, lat]]] } });
    }
  }
  map.getSource("night").setData({ type: "FeatureCollection", features: cells });
  // terminator glow: for each longitude, the latitude where the sun sits at -0.8° (bisection, correct any season)
  const segs = [[]];
  for (let lon = -180; lon <= 180; lon += 1) {
    const f = (lat) => sunAltitude(lat, lon, sun) + 0.8;
    let lo = -89.5, hi = 89.5;
    if (Math.sign(f(lo)) === Math.sign(f(hi))) { if (segs[segs.length - 1].length) segs.push([]); continue; }
    for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; (Math.sign(f(m)) === Math.sign(f(lo))) ? lo = m : hi = m; }
    segs[segs.length - 1].push([lon, (lo + hi) / 2]);
  }
  // near the equinoxes the terminator runs almost pole to pole along two meridians; add those as their own lines
  const meridians = [];
  for (const dl of [-90, 90]) {
    const lon = ((sun.lon + dl + 540) % 360) - 180, line = [];
    for (let lat = -89; lat <= 89; lat += 1) {
      const alt = sunAltitude(lat, lon, sun);
      if (Math.abs(alt + 0.8) < 3) line.push([lon, lat]); else if (line.length > 1) { meridians.push(line.splice(0)); } else line.length = 0;
    }
    if (line.length > 1) meridians.push(line);
  }
  const lines = segs.filter(x => x.length > 1).concat(meridians);
  map.getSource("terminator").setData({ type: "FeatureCollection", features: lines.map(l => ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: l } })) });
  // city lights fade in through civil twilight and are gone in daylight
  const alt = altitudeExpr(sun);
  map.setFilter("city-lights", ["<", alt, -1]);
  map.setPaintProperty("city-lights", "circle-opacity", ["*",
    ["interpolate", ["linear"], alt, -8, 1, -1, 0],
    ["interpolate", ["linear"], ["coalesce", ["get", "pop_max"], 0], 0, 0.25, 500000, 0.55, 5000000, 0.85]]);
  map.getSource("sun").setData({ type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [sun.lon, sun.lat] } }] });
}
$("#tg-night").addEventListener("change", updateNight);

/* ---------- globe spin ----------
   Starts the moment Spin is ticked, at any zoom. Dragging or zooming only holds it while your
   hand is on the map (it carries on from wherever you leave the globe); selecting a conflict
   turns Spin off, since the camera then flies to it. */
const autoRotate = { on: false, holding: false };
if (sharedView) $("#tg-rotate").checked = false;
const spinWanted = () => $("#tg-rotate").checked && $("#tg-globe").checked;
function rotateTick() {
  if (autoRotate.on && !autoRotate.holding && !document.hidden && !map.isEasing()) {
    const c = map.getCenter();
    const step = 0.05 * Math.pow(2, -Math.max(0, map.getZoom() - 2));   // same apparent speed at any zoom
    map.jumpTo({ center: [c.lng + step, c.lat] });
  }
  requestAnimationFrame(rotateTick);
}
const hold = () => { autoRotate.holding = true; };
const release = () => { autoRotate.holding = false; };
map.on("mousedown", hold); map.on("touchstart", hold);
map.on("mouseup", release); map.on("touchend", release); map.on("touchcancel", release); map.on("dragend", release);
window.addEventListener("mouseup", release);            // released outside the map
let wheelTimer = null;
map.getCanvas().addEventListener("wheel", () => { hold(); clearTimeout(wheelTimer); wheelTimer = setTimeout(release, 250); }, { passive: true });
function syncSpin() { autoRotate.on = spinWanted(); }
requestAnimationFrame(rotateTick);
$("#tg-globe").addEventListener("change", e => {
  map.setProjection({ type: e.target.checked ? "globe" : "mercator" });
  syncSpin();
});
$("#tg-rotate").addEventListener("change", syncSpin);
syncSpin();

/* ---------- controls ---------- */
$("#tg-strikes").addEventListener("change", e => setStrikeVisibility(e.target.checked));
$("#tg-ships").addEventListener("change", e => {
  for (const id of ["ships", "ships-outline", "ship-trails"]) map.setLayoutProperty(id, "visibility", e.target.checked ? "visible" : "none");
  if (e.target.checked) loadShips();
});
$("#tg-aircraft").addEventListener("change", e => {
  for (const id of ["aircraft", "aircraft-outline", "aircraft-trails", "aircraft-trails-casing"]) map.setLayoutProperty(id, "visibility", e.target.checked ? "visible" : "none");
  if (e.target.checked) loadAircraft();
});
$("#tg-incidents").addEventListener("change", e => map.setLayoutProperty("incidents", "visibility", e.target.checked ? "visible" : "none"));
$("#day").addEventListener("input", () => {
  const d = dayFilter();
  $("#day-label").textContent = d === 0 ? "all 7 days" : d === 1 ? "today" : d === 2 ? "yesterday" : dayString(d).slice(5);
  if (STATE) renderStrikes();
});
$("#tg-heat").addEventListener("change", e => {
  map.setLayoutProperty("heat", "visibility", e.target.checked ? "visible" : "none");
  if (!e.target.checked) for (const iso of Object.keys(COUNTRIES)) map.setFeatureState({ source: "countries", id: iso }, { heat: 0 });
  else renderHeat();
});
$("#tg-arcs").addEventListener("change", e => map.setLayoutProperty("arcs", "visibility", e.target.checked ? "visible" : "none"));
$("#tg-gdelt-arcs").addEventListener("change", e => map.setLayoutProperty("garcs", "visibility", e.target.checked ? "visible" : "none"));
$("#window").addEventListener("change", load);
$("#refresh").addEventListener("click", async () => {
  $("#refresh").disabled = true;
  await fetch("/api/refresh", { method: "POST" });
  setTimeout(load, 1500);
});
map.on("click", (e) => {
  if (document.body.classList.contains("menu-open") || document.body.classList.contains("legend-open")) {
    toggleMenu(false); toggleLegend(false); return;   // first tap on the map just closes an open menu
  }
  if (e.originalEvent._handled || fuzzyTap(e)) return;
  if (selected) select(null);
});

/* ---------- desktop: drag the panel edge to resize ---------- */
(() => {
  const handle = $("#panel-resizer"), panel = $("#panel");
  if (!handle) return;
  const clamp = (w) => Math.max(300, Math.min(window.innerWidth * 0.7, w));
  try { const saved = +localStorage.getItem("panelWidth"); if (saved) panel.style.width = clamp(saved) + "px"; } catch (_) {}
  let dragging = false;
  handle.addEventListener("pointerdown", (e) => {
    if (isMobile()) return;
    dragging = true; handle.setPointerCapture(e.pointerId); document.body.classList.add("resizing"); e.preventDefault();
  });
  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    panel.style.width = clamp(window.innerWidth - e.clientX) + "px";
  });
  const stop = () => {
    if (!dragging) return;
    dragging = false; document.body.classList.remove("resizing");
    try { localStorage.setItem("panelWidth", String(panel.getBoundingClientRect().width | 0)); } catch (_) {}
  };
  handle.addEventListener("pointerup", stop); handle.addEventListener("pointercancel", stop);
  handle.addEventListener("dblclick", () => { panel.style.width = ""; try { localStorage.removeItem("panelWidth"); } catch (_) {} });
})();

/* ---------- mobile: layers menu, legend, bottom sheet ---------- */
function toggleMenu(on = !document.body.classList.contains("menu-open")) {
  document.body.classList.toggle("menu-open", on);
  $("#menu-btn").setAttribute("aria-expanded", on);
  if (on) toggleLegend(false);
}
function toggleLegend(on = !document.body.classList.contains("legend-open")) {
  document.body.classList.toggle("legend-open", on);
  $("#legend-btn").setAttribute("aria-expanded", on);
  if (on) toggleMenu(false);
}
$("#menu-btn").addEventListener("click", () => toggleMenu());
$("#legend-btn").addEventListener("click", () => toggleLegend());

const SHEET = ["min", "peek", "full"];
function setSheet(state) {
  const p = $("#panel");
  if (p.dataset.sheet === state) return;
  p.dataset.sheet = state;
  if (state === "min") p.scrollTop = 0;
}
const sheetStep = (d) => setSheet(SHEET[Math.max(0, Math.min(2, SHEET.indexOf($("#panel").dataset.sheet) + d))]);
/* map padding so flyTo targets land in the part of the map the sheet doesn't cover */
function sheetPadding() {
  if (!isMobile()) return { top: 0, bottom: 0, left: 0, right: 0 };
  const p = $("#panel"), h = p.dataset.sheet === "full" ? 0.42 * $("#main").clientHeight : p.offsetHeight;
  return { top: 0, bottom: Math.round(h), left: 0, right: 0 };
}
{
  const handle = $("#sheet-handle");
  let y0 = null, moved = false;
  handle.addEventListener("touchstart", (e) => { y0 = e.touches[0].clientY; moved = false; }, { passive: true });
  handle.addEventListener("touchmove", (e) => { if (y0 !== null && Math.abs(e.touches[0].clientY - y0) > 8) moved = true; }, { passive: true });
  handle.addEventListener("touchend", (e) => {
    if (y0 === null) return;
    const dy = e.changedTouches[0].clientY - y0; y0 = null;
    if (moved && Math.abs(dy) > 30) { e.preventDefault(); sheetStep(dy < 0 ? 1 : -1); }
  });
  handle.addEventListener("click", () => {
    const s = $("#panel").dataset.sheet;
    setSheet(s === "min" ? "peek" : s === "peek" ? "full" : "min");
  });
}
mobileMQ.addEventListener("change", () => { toggleMenu(false); toggleLegend(false); map.setPadding(sheetPadding()); });
if (isMobile() && !sharedView) map.setPadding(sheetPadding());   // start with the globe above the sheet
$("#weapon-legend").innerHTML = [["missile", "missile"], ["drone", "drone"], ["airstrike", "airstrike"], ["bombing", "bombing"],
  ["artillery", "shelling"], ["ground", "ground"], ["naval", "naval"], ["other", "other"]]
  .map(([w, label]) => `${weaponSvg(w, 13)} ${label}`).join(" ");
