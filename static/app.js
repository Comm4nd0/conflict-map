/* Conflict Map — frontend */
const STATUS_COLOR = {
  escalating: "#d03b3b", active: "#ec835a", "de-escalating": "#fab219",
  ceasefire: "#0ca30c", frozen: "#898781",
};
const SIDE_COLOR = { A: "#3987e5", B: "#d95926", other: "#9085e9" };
const LAND = "#3a3a42", HEAT = "#f2a33a";

let COUNTRIES = {};          // iso3 -> {iso3, iso2, name, lat, lon}
let STATE = null;            // last /api/state
let selected = null;         // conflict id
let markers = [];
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

/* ---------- map ---------- */
const map = new maplibregl.Map({
  container: "map",
  style: {
    version: 8,
    sources: {},
    layers: [{ id: "bg", type: "background", paint: { "background-color": "#121214" } }],
  },
  center: [20, 25], zoom: 1.6, minZoom: 1, maxZoom: 8, attributionControl: false, preserveDrawingBuffer: true,
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");

map.on("load", async () => {
  map.addSource("countries", { type: "geojson", data: "/static/data/countries.geojson", promoteId: "ADM0_A3" });
  map.addSource("points", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addSource("arcs", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addSource("garcs", { type: "geojson", data: { type: "FeatureCollection", features: [] } });

  map.addLayer({
    id: "country-fill", type: "fill", source: "countries",
    paint: {
      "fill-color": [
        "case",
        ["==", ["feature-state", "side"], "A"], SIDE_COLOR.A,
        ["==", ["feature-state", "side"], "B"], SIDE_COLOR.B,
        ["==", ["feature-state", "side"], "other"], SIDE_COLOR.other,
        ["interpolate", ["linear"], ["coalesce", ["feature-state", "heat"], 0], 0, LAND, 1, HEAT],
      ],
      "fill-opacity": ["case", ["boolean", ["feature-state", "involved"], false], 0.55, 1],
    },
  });
  map.addLayer({
    id: "country-line", type: "line", source: "countries",
    paint: { "line-color": "rgba(255,255,255,0.12)", "line-width": 0.6 },
  });
  map.addLayer({
    id: "country-involved", type: "line", source: "countries",
    paint: {
      "line-color": ["match", ["feature-state", "side"], "A", SIDE_COLOR.A, "B", SIDE_COLOR.B, SIDE_COLOR.other],
      "line-width": 1.6, "line-opacity": ["case", ["boolean", ["feature-state", "involved"], false], 1, 0],
    },
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
  map.addLayer({
    id: "garcs", type: "line", source: "garcs", layout: { visibility: "none" },
    paint: { "line-color": "#c3c2b7", "line-width": ["interpolate", ["linear"], ["get", "w"], 0, 0.5, 1, 3], "line-opacity": 0.35 },
  });
  map.addLayer({
    id: "arcs", type: "line", source: "arcs",
    paint: {
      "line-color": ["get", "color"],
      "line-width": ["case", ["get", "combat"], 2.2, 1.4],
      "line-opacity": ["case", ["get", "dim"], 0.15, 0.85],
      "line-dasharray": [2, 1.5],
    },
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

  await loadCountries();
  await load();
  setInterval(load, 60000);
});

async function loadCountries() {
  COUNTRIES = await (await fetch("/api/countries")).json();
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
  if (selected && STATE.conflicts.find(c => c.id === selected)) renderDetail(); else { selected = null; renderList(); }
  applyInvolvement();
}

function renderStatus() {
  const m = STATE.meta, g = STATE.gdelt;
  const parts = [];
  parts.push(`${STATE.conflicts.length} conflicts`);
  parts.push(`${g.total.toLocaleString()} GDELT events / ${g.hours}h`);
  parts.push(`extract ${ago(m.last_extract?.at)}`);
  if (m.busy) parts.push(`⟳ refreshing (${m.unprocessed} articles queued)`);
  else if (m.unprocessed) parts.push(`${m.unprocessed} articles queued`);
  $("#status").textContent = parts.join(" · ");
  $("#refresh").disabled = !!m.busy;
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

function renderMarkers() {
  markers.forEach(m => m.remove()); markers = [];
  for (const c of STATE.conflicts) {
    const ep = c.epicenter; if (!ep || typeof ep.lat !== "number") continue;
    const el = document.createElement("div");
    const size = 8 + (c.severity || 1) * 3;
    el.className = "mk" + (selected && selected !== c.id ? " dim" : "");
    el.style.width = el.style.height = size + "px";
    el.style.background = STATUS_COLOR[c.status] || STATUS_COLOR.active;
    el.style.color = STATUS_COLOR[c.status] || STATUS_COLOR.active;
    el.title = c.name;
    const lbl = document.createElement("span"); lbl.className = "mk-label"; lbl.textContent = c.name; lbl.style.left = (size + 2) + "px";
    el.appendChild(lbl);
    el.addEventListener("click", (e) => { e.stopPropagation(); select(c.id); });
    markers.push(new maplibregl.Marker({ element: el }).setLngLat([ep.lon, ep.lat]).addTo(map));
  }
}

function renderArcs() {
  const feats = [];
  for (const c of STATE.conflicts) {
    const ep = c.epicenter; if (!ep) continue;
    const dim = !!(selected && selected !== c.id);
    for (const p of c.parties) {
      const iso = norm(p.country); if (!iso) continue;
      const cc = COUNTRIES[iso];
      // combatants whose own territory hosts the epicenter don't need an arc
      const from = [cc.lon, cc.lat], to = [ep.lon, ep.lat];
      const dist = Math.hypot(from[0] - to[0], from[1] - to[1]);
      if (p.role === "combatant" && dist < 12) continue;
      feats.push({
        type: "Feature", geometry: { type: "LineString", coordinates: arc(from, to) },
        properties: { color: SIDE_COLOR[p.side] || SIDE_COLOR.other, combat: p.role === "combatant", dim, conflict: c.id },
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
  for (const iso of Object.keys(COUNTRIES)) map.setFeatureState({ source: "countries", id: iso }, { side: null, involved: false });
  const c = STATE.conflicts.find(x => x.id === selected); if (!c) return;
  for (const p of c.parties) {
    const iso = norm(p.country); if (!iso) continue;
    map.setFeatureState({ source: "countries", id: iso }, { side: p.side || "other", involved: true });
  }
}

/* ---------- panel ---------- */
function sevbar(n) { return `<span class="sevbar">${[1, 2, 3, 4, 5].map(i => `<i class="${i <= n ? "on" : ""}"></i>`).join("")}</span>`; }

function renderList() {
  $("#detail").hidden = true; $("#list").hidden = false;
  if (!STATE.conflicts.length) {
    $("#list").innerHTML = `<div class="empty">No conflicts extracted yet.<br><br>${STATE.meta.busy ? "The first refresh is running — the local model is reading the news feeds now." : "Press Refresh to fetch the feeds and run extraction."}</div>`;
    return;
  }
  $("#list").innerHTML = STATE.conflicts.map(c => {
    const combat = c.parties.filter(p => p.role === "combatant" && norm(p.country)).map(p => flag(norm(p.country)));
    const others = c.parties.filter(p => p.role !== "combatant" && norm(p.country)).map(p => flag(norm(p.country)));
    return `<div class="card ${c.id === selected ? "selected" : ""}" data-id="${esc(c.id)}">
      <div class="head"><span class="name">${esc(c.name)}</span>${sevbar(c.severity)}<span class="badge st-${esc(c.status)}">${esc(c.status)}</span></div>
      <div class="region">${esc(c.region || "")} · updated ${ago(c.updated)}</div>
      <div class="flags">${[...new Set(combat)].join(" ")}<span style="opacity:.5"> ${[...new Set(others)].join(" ")}</span></div>
    </div>`;
  }).join("");
  document.querySelectorAll(".card").forEach(el => el.addEventListener("click", () => select(el.dataset.id)));
}

function renderDetail() {
  const c = STATE.conflicts.find(x => x.id === selected); if (!c) return renderList();
  $("#list").hidden = true; const d = $("#detail"); d.hidden = false;
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
    <p class="summary">${esc(c.summary)}</p>
    <h3>Who is involved</h3>
    ${sideBlock("A", "Side A")}${sideBlock("B", "Side B")}${sideBlock("other", "Mediators / others")}
    <h3>Consequences</h3>
    <div class="cons">${(c.consequences || []).map(x => `<div class="con"><span class="cat">${esc(x.category)}</span><span>${esc(x.text)}${(x.affects || []).length ? ` <span style="opacity:.6">${x.affects.map(a => flag(norm(a))).join(" ")}</span>` : ""}</span></div>`).join("") || "<div class='empty'>none recorded</div>"}</div>
    <h3>Latest developments</h3>
    ${(c.developments || []).map(x => `<div class="dev"><span class="date">${esc(x.date)}</span><span>${esc(x.text)}${(x.sources || []).map(u => ` <a href="${esc(u)}" target="_blank" title="${esc(u)}">↗</a>`).join("")}</span></div>`).join("")}
    <h3>Sources</h3>
    ${(c.sources || []).slice(0, 12).map(s => `<div class="src"><a href="${esc(s.link)}" target="_blank">${esc(s.title)}</a> <span class="s">— ${esc(s.source)}</span></div>`).join("")}
  `;
  d.querySelector(".back").addEventListener("click", () => select(null));
}

function select(id) {
  selected = id;
  const c = STATE.conflicts.find(x => x.id === id);
  if (c && c.epicenter) map.flyTo({ center: [c.epicenter.lon, c.epicenter.lat], zoom: Math.max(map.getZoom(), 3.2), speed: 0.8 });
  renderMarkers(); renderArcs(); applyInvolvement();
  if (c) renderDetail(); else renderList();
}

/* ---------- controls ---------- */
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
map.on("click", () => { if (selected) select(null); });
