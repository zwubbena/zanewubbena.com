"use strict";
(() => {
  // The relay (a Cloudflare Worker) asks FlyItalyADSB for the aircraft within a radius, in kilometers, of a point.
  const API = "https://flight-radar.zwubbena.workers.dev/";
  const POLL_MS = 10000;
  const MOVE_WAIT_MS = 800;
  const MIN_GAP_MS = 3000;
  const MAX_BACKOFF_MS = 60000;
  const LIMIT_WAIT_MS = 60000;
  const FETCH_TIMEOUT_MS = 15000;
  const MAX_KM = 200;
  const TRAIL_MS = 180000;
  const TRAIL_MAX = 19;
  const EARTH_NM = 3440.065;
  const EARTH_KM = 6371.0088;
  const MIN_ZOOM = 6;
  const MAX_ZOOM = 16;
  const START_ZOOM = 9;
  // Austin-Bergstrom International Airport (KAUS). Location from OurAirports.
  const KAUS = { label: "KAUS", lat: 30.197535, lon: -97.662015 };

  const SQUAWK_NOTE = { "7500": "hijack", "7600": "radio failure", "7700": "emergency", "1200": "VFR" };
  const EMERGENCY = new Set(["7500", "7600", "7700"]);
  // Trail colors by altitude: [upper limit in feet, color]. The caption under the map lists the same bands.
  const BANDS = [[3000, "#f28c28"], [10000, "#e6c619"], [18000, "#36b37e"], [Infinity, "#3d8bfd"]];
  const NO_ALT_COLOR = "#8c8c8c";
  const PLANE = "M0,-6.5 L1,-4.5 L1,-1.2 L6.5,1.2 L6.5,2.4 L1,1.2 L0.8,4 L2.6,5.6 L2.6,6.4 L0,5.8 L-2.6,6.4 L-2.6,5.6 L-0.8,4 L-1,1.2 L-6.5,2.4 L-6.5,1.2 L-1,-1.2 L-1,-4.5 Z";

  const $ = (id) => document.getElementById(id);
  const ui = {
    wrap: $("mapwrap"), status: $("status"), zoomIn: $("zoom-in"), zoomOut: $("zoom-out"), locate: $("locate"),
    card: $("card"), cardCallsign: $("card-callsign"), cardSub: $("card-sub"), cardGone: $("card-gone"),
    cardGrid: $("card-grid"), cardLink: $("card-link"), cardClose: $("card-close"),
    listNote: $("list-note"), list: $("list"), listBody: $("list-body"), listRef: $("list-ref")
  };
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (typeof L === "undefined") {
    ui.status.textContent = "The map did not load. Reload the page to try again.";
    ui.status.classList.add("error");
    return;
  }

  const state = {
    aircraft: [], markers: new Map(), trails: new Map(), selected: null, selectedLast: null, ref: KAUS, me: null,
    time: null, error: "", notice: "", timer: 0, moveTimer: 0, request: null, lastFetch: 0, holdUntil: 0,
    backoff: POLL_MS, lastQuery: null
  };

  const store = {
    get(k) { try { return localStorage.getItem("flight-radar-" + k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem("flight-radar-" + k, v); } catch (e) { /* storage unavailable */ } }
  };

  // Geometry: great-circle distance and initial true bearing.
  const rad = (d) => d * Math.PI / 180;
  function arc(lat1, lon1, lat2, lon2) {
    const h = Math.sin(rad(lat2 - lat1) / 2) ** 2 +
      Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
    return 2 * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  const distNm = (lat1, lon1, lat2, lon2) => EARTH_NM * arc(lat1, lon1, lat2, lon2);
  const distKm = (lat1, lon1, lat2, lon2) => EARTH_KM * arc(lat1, lon1, lat2, lon2);
  function bearing(lat1, lon1, lat2, lon2) {
    const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
    const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) -
      Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  const compass = (b) => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(b / 45) % 8];

  // Formatting.
  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  const fmtInt = (n) => Math.round(n).toLocaleString("en-US");
  const pad2 = (n) => String(n).padStart(2, "0");
  const deg3 = (x) => { const v = Math.round(x) % 360; return String(v === 0 ? 360 : v).padStart(3, "0"); };
  const callsignOf = (a) => a.callsign || a.hex.toUpperCase();
  const zulu = (t) => { const d = new Date(t * 1000); return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}Z`; };
  const local = (t) => new Date(t * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });
  const altCell = (a) => (a.ground ? "Ground" : a.alt == null ? "–" : fmtInt(a.alt));
  function vsText(vr) {
    const v = Math.round(vr / 10) * 10;
    if (Math.abs(v) < 100) return "Level";
    return `${v > 0 ? "+" : "−"}${fmtInt(Math.abs(v))} ft/min`;
  }
  function bandColor(p) {
    if (p.ground) return BANDS[0][1];
    if (p.alt == null) return NO_ALT_COLOR;
    return BANDS.find(([top]) => p.alt < top)[1];
  }
  function setStatus(text, isError) {
    ui.status.textContent = text;
    ui.status.classList.toggle("error", Boolean(isError));
  }

  // The map. Map images are OpenStreetMap's standard tiles.
  const map = L.map("map", {
    zoomControl: false, minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM,
    zoomAnimation: !reduceMotion, fadeAnimation: !reduceMotion, markerZoomAnimation: !reduceMotion
  });
  map.attributionControl.setPrefix('<a href="https://leafletjs.com/">Leaflet</a>');
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);
  const trailLayer = L.layerGroup().addTo(map);
  const planeLayer = L.layerGroup().addTo(map);

  function savedView() {
    try {
      const v = JSON.parse(store.get("view"));
      if (v && Math.abs(v.lat) <= 85 && Math.abs(v.lon) <= 180 && v.zoom >= MIN_ZOOM && v.zoom <= MAX_ZOOM) return v;
    } catch (e) { /* no saved view */ }
    return null;
  }
  function saveView() {
    const c = map.getCenter().wrap();
    store.set("view", JSON.stringify({ lat: Number(c.lat.toFixed(4)), lon: Number(c.lng.toFixed(4)), zoom: map.getZoom() }));
  }

  // Airplane markers: an airplane icon turned to the aircraft's track. Selected, emergency, and
  // airborne aircraft draw above aircraft on the ground.
  function classOf(a) {
    return "plane" + (a.ground ? " ground" : "") + (EMERGENCY.has(a.squawk) ? " emergency" : "") +
      (a.hex === state.selected ? " on" : "");
  }
  function zOf(a) {
    return a.hex === state.selected ? 30000 : EMERGENCY.has(a.squawk) ? 20000 : a.ground ? -20000 : 0;
  }
  function makeIcon(cls, rot) {
    const size = cls.includes("ground") ? 18 : 26;
    return L.divIcon({
      className: cls, iconSize: [size, size], iconAnchor: [size / 2, size / 2],
      html: `<svg width="${size}" height="${size}" viewBox="-7 -7 14 14" aria-hidden="true" style="transform: rotate(${rot}deg)"><path d="${PLANE}"></path></svg>`
    });
  }
  // Turn the shorter way, so a track change from 350° to 10° turns 20°, not 340°.
  function turn(rec, track) {
    if (track == null) return rec.rot;
    rec.rot += ((track - rec.rot) % 360 + 540) % 360 - 180;
    return rec.rot;
  }
  function bindTag(rec) {
    rec.marker.unbindTooltip();
    rec.marker.bindTooltip(callsignOf(rec.a), { permanent: true, direction: "right", offset: [14, 0], className: "tag" });
  }
  function refreshMarker(rec) {
    const cls = classOf(rec.a);
    if (cls !== rec.cls) {
      rec.cls = cls;
      rec.marker.setIcon(makeIcon(cls, rec.rot));
      rec.marker.setZIndexOffset(zOf(rec.a));
    }
  }

  function updateMarkers(list) {
    const seen = new Set();
    for (const a of list) {
      seen.add(a.hex);
      let rec = state.markers.get(a.hex);
      if (!rec) {
        const cls = classOf(a);
        const rot = a.track ?? 0;
        // Kept out of the tab order: the list under the map selects the same airplanes from the keyboard.
        const marker = L.marker([a.lat, a.lon], { icon: makeIcon(cls, rot), title: callsignOf(a), zIndexOffset: zOf(a), keyboard: false });
        marker.on("click", () => select(a.hex));
        rec = { marker, a, cls, rot };
        state.markers.set(a.hex, rec);
        marker.addTo(planeLayer);
        if (a.hex === state.selected) bindTag(rec);
        continue;
      }
      const renamed = callsignOf(a) !== callsignOf(rec.a);
      rec.a = a;
      rec.marker.setLatLng([a.lat, a.lon]);
      turn(rec, a.track);
      const cls = classOf(a);
      if (cls !== rec.cls) {
        refreshMarker(rec);
      } else {
        const svg = rec.marker.getElement() && rec.marker.getElement().firstElementChild;
        if (svg) svg.style.transform = `rotate(${rec.rot}deg)`;
      }
      if (renamed) {
        rec.marker.options.title = callsignOf(a);
        if (rec.marker.getElement()) rec.marker.getElement().title = callsignOf(a);
        if (a.hex === state.selected) rec.marker.setTooltipContent(callsignOf(a));
      }
    }
    for (const [hex, rec] of state.markers) {
      if (!seen.has(hex)) { planeLayer.removeLayer(rec.marker); state.markers.delete(hex); }
    }
  }

  // The selected aircraft's trail: one line per run of points in the same altitude band, over a white edge.
  function drawTrail() {
    trailLayer.clearLayers();
    const pts = state.selected ? state.trails.get(state.selected) : null;
    if (!pts || pts.length < 2 || !state.markers.has(state.selected)) return;
    const line = (run, color, weight, opacity) =>
      L.polyline(run.map((p) => [p.lat, p.lon]), { color, weight, opacity, interactive: false, lineCap: "round", lineJoin: "round" }).addTo(trailLayer);
    line(pts, "#ffffff", 7, 0.85);
    let run = [pts[0]];
    let color = bandColor(pts[1]);
    for (let i = 1; i < pts.length; i++) {
      const c = bandColor(pts[i]);
      if (c !== color) { line(run, color, 4, 1); run = [pts[i - 1]]; color = c; }
      run.push(pts[i]);
    }
    line(run, color, 4, 1);
  }

  // Text views.
  const ref = () => state.ref;
  function onMap() {
    const b = map.getBounds();
    return state.aircraft.filter((a) => b.contains([a.lat, a.lon]));
  }

  function renderStatus() {
    const notice = state.notice;
    state.notice = "";
    if (state.error) { setStatus(notice + state.error, true); return; }
    if (state.time == null) { setStatus(notice + "Loading live aircraft.", false); return; }
    let t = `${onMap().length} aircraft on the map, updated ${zulu(state.time)} (${local(state.time)} local).`;
    if (want().need > MAX_KM) t += ` The feed covers ${MAX_KM} km (108 nm) around the center of the map, so zoom in to see aircraft near the edges.`;
    setStatus(notice + t, false);
  }

  function renderList() {
    const r = ref();
    ui.listRef.textContent = `From ${r.label} (nm)`;
    if (state.time == null) { ui.listNote.textContent = "Waiting for the first update."; ui.list.hidden = true; return; }
    const rows = onMap().map((a) => ({ a, d: distNm(r.lat, r.lon, a.lat, a.lon) }))
      .sort((p, q) => (p.a.ground - q.a.ground) || (p.d - q.d));
    const n = rows.length;
    const order = rows.some((x) => x.a.ground) ? `: airborne aircraft closest to ${r.label} first, then aircraft on the ground.` : `, closest to ${r.label} first.`;
    ui.listNote.textContent = n ? `${n} aircraft on the map${order}` : "No aircraft with a position on the map right now.";
    ui.list.hidden = !n;
    ui.listBody.innerHTML = rows.map(({ a, d }) =>
      `<tr${a.hex === state.selected ? ' class="on"' : ""}>` +
      `<td><button type="button" class="pick${a.callsign ? "" : " hex"}" data-hex="${esc(a.hex)}">${esc(callsignOf(a))}</button></td>` +
      `<td class="num">${altCell(a)}</td><td class="num">${a.gs == null ? "–" : Math.round(a.gs)}</td>` +
      `<td class="num">${d.toFixed(1)}</td></tr>`).join("");
  }

  function renderCard() {
    const a = state.selectedLast;
    ui.card.hidden = !a;
    ui.wrap.classList.toggle("card-open", Boolean(a));
    if (!a) return;
    const r = ref();
    ui.cardGone.hidden = state.aircraft.some((x) => x.hex === a.hex);
    ui.cardCallsign.textContent = callsignOf(a);
    ui.cardSub.textContent = [a.type, a.reg].filter(Boolean).join(" · ") || `ICAO address ${a.hex.toUpperCase()}`;
    const squawk = a.squawk ? (SQUAWK_NOTE[a.squawk] ? `${a.squawk} (${SQUAWK_NOTE[a.squawk]})` : a.squawk) : "Not reported";
    const cells = [
      ["Altitude", a.ground ? "Ground" : a.alt == null ? "Not reported" : `${fmtInt(a.alt)} ft`],
      ["Vertical speed", a.vr == null ? "Not reported" : vsText(a.vr)],
      ["Ground speed", a.gs == null ? "Not reported" : `${Math.round(a.gs)} kt`],
      ["Track", a.track == null ? "Not reported" : `${deg3(a.track)}° true`],
      ["Squawk", squawk, EMERGENCY.has(a.squawk)],
      [`From ${r.label}`, `${distNm(r.lat, r.lon, a.lat, a.lon).toFixed(1)} nm ${compass(bearing(r.lat, r.lon, a.lat, a.lon))}`]
    ];
    ui.cardGrid.innerHTML = cells.map(([k, v, warn]) => `<div><dt>${esc(k)}</dt><dd${warn ? ' class="warn"' : ""}>${esc(v)}</dd></div>`).join("");
    ui.cardLink.href = `https://globe.adsb.lol/?icao=${encodeURIComponent(a.hex)}`;
    ui.wrap.style.setProperty("--card-h", `${ui.card.offsetHeight}px`);
  }

  // When a newly selected airplane sits under the details card or at the edge of the map, move the
  // map so the airplane shows in the open part of the map.
  function keepClear(hex) {
    const rec = state.markers.get(hex);
    if (!rec) return;
    const size = map.getSize();
    const p = map.latLngToContainerPoint(rec.marker.getLatLng());
    const box = map.getContainer().getBoundingClientRect();
    const cb = ui.card.getBoundingClientRect();
    const c = { l: cb.left - box.left, t: cb.top - box.top, r: cb.right - box.left, b: cb.bottom - box.top };
    const pad = 28;
    const under = p.x > c.l - pad && p.x < c.r + pad && p.y > c.t - pad && p.y < c.b + pad;
    const edge = p.x < pad || p.y < pad || p.x > size.x - pad || p.y > size.y - pad;
    if (!under && !edge) return;
    const sheet = c.r - c.l > size.x * 0.6;
    const target = sheet ? L.point(size.x / 2, Math.max(pad, c.t / 2)) : L.point((c.r + size.x) / 2, size.y / 2);
    map.panBy(p.subtract(target), { animate: !reduceMotion });
  }

  function select(hex) {
    const prev = state.selected;
    const rec = hex ? state.markers.get(hex) : null;
    state.selected = rec ? hex : null;
    const old = prev && state.markers.get(prev);
    if (old) { old.marker.unbindTooltip(); refreshMarker(old); }
    if (rec) { refreshMarker(rec); bindTag(rec); }
    state.selectedLast = rec ? rec.a : null;
    renderCard(); renderList(); drawTrail();
    if (rec) keepClear(hex);
  }

  // Data.
  // One record per aircraft, in the aircraft.json format: feet, knots, and feet per minute.
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  function ingest(data) {
    let now = Number(data.now) || Date.now() / 1000;
    if (now > 1e12) now /= 1000;
    now = Math.floor(now);
    const t = Date.now();
    const out = [];
    const seen = new Set();
    for (const s of data.ac || data.aircraft || []) {
      const lat = num(s.lat);
      const lon = num(s.lon);
      const age = num(s.seen_pos) ?? 0;
      if (lat == null || lon == null || age > 60) continue;
      // Categories C1 to C5 are ground vehicles and obstacles, not aircraft.
      if (String(s.category || "").startsWith("C")) continue;
      const hex = String(s.hex || "").toLowerCase();
      if (!hex || seen.has(hex)) continue;
      seen.add(hex);
      const a = {
        hex, callsign: String(s.flight || "").trim(), reg: s.r || "", type: s.t || "", lat, lon,
        alt: num(s.alt_baro), ground: s.alt_baro === "ground", gs: num(s.gs),
        track: num(s.track) ?? num(s.true_heading), vr: num(s.baro_rate) ?? num(s.geom_rate), squawk: s.squawk || ""
      };
      out.push(a);
      const trail = state.trails.get(hex) || [];
      const last = trail[trail.length - 1];
      if (last && last.lat === lat && last.lon === lon) last.t = t;
      else trail.push({ lat, lon, alt: a.alt, ground: a.ground, t });
      while (trail.length > TRAIL_MAX || (trail.length && t - trail[0].t > TRAIL_MS)) trail.shift();
      state.trails.set(hex, trail);
    }
    for (const hex of [...state.trails.keys()]) if (!seen.has(hex)) state.trails.delete(hex);
    state.aircraft = out;
    state.time = now;
    updateMarkers(out);
    const sel = out.find((a) => a.hex === state.selected);
    if (sel) state.selectedLast = sel;
    renderStatus(); renderList(); renderCard(); drawTrail();
  }

  // The circle to ask for: centered on the map, reaching its farthest corner, up to the feed's limit.
  // The center is rounded to 0.01°, so viewers of the same view share the relay's cache.
  function want() {
    const c = map.getCenter().wrap();
    const lat = Math.round(c.lat * 100) / 100;
    const lon = Math.round(c.lng * 100) / 100;
    const b = map.getBounds();
    const need = Math.max(...[b.getNorthEast(), b.getNorthWest(), b.getSouthEast(), b.getSouthWest()]
      .map((p) => distKm(lat, lon, p.lat, p.lng)));
    return { lat, lon, need, km: Math.min(MAX_KM, Math.ceil(need) + 1) };
  }
  // True when the last answer already covers the whole map, as after zooming in.
  function covered(q) {
    const last = state.lastQuery;
    if (!last) return false;
    return distKm(q.lat, q.lon, last.lat, last.lon) + Math.min(q.need, MAX_KM) <= last.km;
  }

  function schedule(ms) { clearTimeout(state.timer); state.timer = setTimeout(poll, ms); }
  function pollSoon() {
    const wait = Math.max(state.lastFetch + MIN_GAP_MS, state.holdUntil) - Date.now();
    if (wait > 0) schedule(wait); else poll();
  }

  async function poll() {
    clearTimeout(state.timer);
    clearTimeout(state.moveTimer);
    if (document.hidden) return;
    if (state.request) state.request.abort();
    const q = want();
    const request = new AbortController();
    state.request = request;
    state.lastFetch = Date.now();
    const timeout = setTimeout(() => request.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`${API}?lat=${q.lat.toFixed(2)}&lon=${q.lon.toFixed(2)}&km=${q.km}`, { cache: "no-store", signal: request.signal });
      if (state.request !== request) return;
      if (res.status === 429) {
        state.holdUntil = Date.now() + LIMIT_WAIT_MS;
        state.error = `The data feed's request limit was reached. Trying again in ${LIMIT_WAIT_MS / 1000} seconds.`;
        renderStatus();
        schedule(LIMIT_WAIT_MS);
        return;
      }
      if (!res.ok) throw new Error(`Relay status ${res.status}`);
      const data = await res.json();
      if (state.request !== request) return;
      state.backoff = POLL_MS;
      state.error = "";
      state.lastQuery = q;
      ingest(data);
      schedule(POLL_MS);
    } catch (err) {
      if (state.request !== request) return;
      state.error = `Live data did not load. Trying again in ${Math.round(state.backoff / 1000)} seconds.`;
      renderStatus();
      schedule(state.backoff);
      state.backoff = Math.min(state.backoff * 2, MAX_BACKOFF_MS);
    } finally {
      clearTimeout(timeout);
      if (state.request === request) state.request = null;
    }
  }

  // Controls.
  function syncZoom() {
    ui.zoomIn.disabled = map.getZoom() >= map.getMaxZoom();
    ui.zoomOut.disabled = map.getZoom() <= map.getMinZoom();
  }
  ui.zoomIn.addEventListener("click", () => map.zoomIn());
  ui.zoomOut.addEventListener("click", () => map.zoomOut());

  ui.locate.addEventListener("click", () => {
    if (!navigator.geolocation) { state.notice = "This browser does not share its location. "; renderStatus(); return; }
    setStatus("Finding your location.", false);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const ll = [p.coords.latitude, p.coords.longitude];
        state.ref = { label: "you", lat: ll[0], lon: ll[1] };
        if (state.me) state.me.setLatLng(ll);
        else state.me = L.circleMarker(ll, { radius: 7, color: "#ffffff", weight: 2, fillColor: "#1a73e8", fillOpacity: 1, interactive: false }).addTo(map);
        map.setView(ll, Math.max(map.getZoom(), 10), { animate: !reduceMotion });
        renderList(); renderCard(); renderStatus();
      },
      (err) => {
        state.notice = err.code === 1 ? "Location permission was denied. " : "Your location is not available right now. ";
        renderStatus();
      },
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 }
    );
  });

  ui.cardClose.addEventListener("click", () => {
    map.getContainer().focus({ preventScroll: true });
    select(null);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.selected) select(null); });
  map.on("click", () => { if (state.selected) select(null); });

  ui.listBody.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-hex]");
    if (!b) return;
    $("map-h").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    select(b.dataset.hex);
  });

  new ResizeObserver(() => { if (!ui.card.hidden) ui.wrap.style.setProperty("--card-h", `${ui.card.offsetHeight}px`); }).observe(ui.card);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      clearTimeout(state.timer);
      clearTimeout(state.moveTimer);
      if (state.request) { const r = state.request; state.request = null; r.abort(); }
      return;
    }
    const since = Date.now() - state.lastFetch;
    if (since >= POLL_MS) pollSoon(); else schedule(POLL_MS - since);
  });

  const v = savedView();
  map.setView(v ? [v.lat, v.lon] : [KAUS.lat, KAUS.lon], v ? v.zoom : START_ZOOM);
  map.on("zoomend", syncZoom);
  map.on("moveend", () => {
    saveView();
    renderList(); renderStatus();
    if (!covered(want())) { clearTimeout(state.moveTimer); state.moveTimer = setTimeout(pollSoon, MOVE_WAIT_MS); }
  });
  syncZoom();
  poll();
})();
