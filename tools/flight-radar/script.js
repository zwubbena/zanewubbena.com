"use strict";
(() => {
  // The relay (a Cloudflare Worker) asks FlyItalyADSB for the aircraft within a radius, in kilometers, of a point.
  const API = "https://flight-radar.zwubbena.workers.dev/";
  const POLL_MS = 10000;
  const MAX_BACKOFF_MS = 60000;
  const LIMIT_WAIT_MS = 60000;
  const SWEEP_MS = 10000;
  const EARTH_NM = 3440.065;
  const KM_PER_NM = 1.852;
  const RANGES = [10, 20, 40, 80];

  // Airports drawn on the scope, by FAA identifier. Locations from OurAirports.
  const AIRPORTS = [
    ["AUS", 30.197535, -97.662015], ["EDC", 30.398049, -97.566909], ["GTU", 30.677543, -97.678524],
    ["HYI", 29.8927, -97.862999], ["50R", 29.8503, -97.672401], ["RYW", 30.4986, -97.969498],
    ["T74", 30.572599, -97.443199], ["BAZ", 29.7045, -98.042198], ["BMQ", 30.738899, -98.238602],
    ["DZB", 30.5271, -98.3587], ["GYB", 30.1693, -96.980003], ["3T5", 29.908001, -96.949997],
    ["T20", 29.52915, -97.464345], ["GRK", 31.0672, -97.828903], ["TPL", 31.1525, -97.407799],
    ["LZZ", 31.106199, -98.1959], ["T35", 30.8794, -96.9711], ["SAT", 29.533701, -98.469803],
    ["RND", 29.529699, -98.2789], ["SSF", 29.337, -98.4711], ["SKF", 29.3842, -98.5811],
    ["CLL", 30.5886, -96.3638], ["T82", 30.2432, -98.909203], ["AQO", 30.7837, -98.662003],
    ["ERV", 29.9767, -99.085701], ["ACT", 31.6113, -97.2305]
  ].map(([id, lat, lon]) => ({ id, lat, lon }));
  const CENTER_LABEL = { AUS: "KAUS", GTU: "KGTU", EDC: "KEDC", HYI: "KHYI", "50R": "50R" };

  // ADS-B emitter categories, and the position sources the feed reports.
  const CATEGORY = {
    A1: "Light (under 15,500 lb)", A2: "Small (15,500 to 75,000 lb)", A3: "Large (75,000 to 300,000 lb)",
    A4: "High vortex large (such as a Boeing 757)", A5: "Heavy (over 300,000 lb)",
    A6: "High performance (over 5 g and 400 kt)", A7: "Rotorcraft", B1: "Glider or sailplane",
    B2: "Lighter than air", B3: "Parachutist or skydiver", B4: "Ultralight, hang glider, or paraglider",
    B6: "Unmanned aerial vehicle", B7: "Space or trans-atmospheric vehicle",
    C1: "Surface vehicle, emergency", C2: "Surface vehicle, service", C3: "Point obstacle",
    C4: "Cluster obstacle", C5: "Line obstacle"
  };
  const SOURCE = {
    adsb_icao: "ADS-B", adsb_icao_nt: "ADS-B", adsb_other: "ADS-B", adsr_icao: "ADS-R", adsr_other: "ADS-R",
    tisb_icao: "TIS-B", tisb_trackfile: "TIS-B", tisb_other: "TIS-B", mlat: "MLAT", adsc: "ADS-C",
    mode_s: "Mode S", other: "Other"
  };
  const SQUAWK_NOTE = { "7500": "hijack", "7600": "radio failure", "7700": "emergency", "1200": "VFR" };
  const EMERGENCY = new Set(["7500", "7600", "7700"]);

  const COLOR = {
    outside: "#020503", face: "#04110a", ring: "rgba(70, 190, 110, 0.35)", edge: "rgba(90, 210, 130, 0.7)",
    text: "rgba(130, 220, 160, 0.85)", airport: "rgba(180, 200, 190, 0.8)", target: "#7dffa8",
    ground: "rgba(125, 255, 168, 0.45)", select: "#ffffff", emergency: "#ff5f5f"
  };
  const UI_FONT = "Quicksand, Ubuntu, Calibri, Tahoma, sans-serif";
  const MONO_FONT = "ui-monospace, Menlo, Consolas, 'Courier New', monospace";

  const $ = (id) => document.getElementById(id);
  const canvas = $("scope");
  const ctx = canvas.getContext("2d");
  const ui = {
    center: $("center"), range: $("range"), labels: $("labels"), ringStep: $("ring-step"), status: $("status"),
    selEmpty: $("sel-empty"), selGone: $("sel-gone"), selTable: $("sel-table"), selBody: $("sel-body"),
    listNote: $("list-note"), list: $("list"), listBody: $("list-body")
  };
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const bg = document.createElement("canvas");
  const fg = document.createElement("canvas");

  const state = {
    center: null, range: 40, aircraft: [], trails: new Map(), selected: null, selectedLast: null,
    time: null, notice: "", timer: 0, request: null, lastFetch: 0, backoff: POLL_MS
  };
  const view = { w: 0, dpr: 1, cx: 0, cy: 0, r: 0, scale: 1, boxes: [] };
  let animating = false;
  let frame = 0;

  const store = {
    get(k) { try { return localStorage.getItem("flight-radar-" + k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem("flight-radar-" + k, v); } catch (e) { /* storage unavailable */ } }
  };

  // Geometry: great-circle distance in nautical miles and initial true bearing.
  const rad = (d) => d * Math.PI / 180;
  function distNm(lat1, lon1, lat2, lon2) {
    const h = Math.sin(rad(lat2 - lat1) / 2) ** 2 +
      Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
    return 2 * EARTH_NM * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function bearing(lat1, lon1, lat2, lon2) {
    const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
    const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) -
      Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  // Scope position: distance and bearing from the center, so the rings measure true distance.
  function toXY(dist, brg) {
    const a = rad(brg);
    const d = dist * view.scale;
    return [view.cx + d * Math.sin(a), view.cy - d * Math.cos(a)];
  }

  // Formatting.
  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  const fmtInt = (n) => Math.round(n).toLocaleString("en-US");
  const fmtStep = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
  const pad2 = (n) => String(n).padStart(2, "0");
  const pad3 = (n) => String(Math.max(0, Math.round(n))).padStart(3, "0");
  const deg3 = (x) => { const v = Math.round(x) % 360; return pad3(v === 0 ? 360 : v); };
  const callsignOf = (a) => a.callsign || a.hex.toUpperCase();
  const zulu = (t) => { const d = new Date(t * 1000); return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}Z`; };
  const local = (t) => new Date(t * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });
  const altCell = (a) => (a.ground ? "Ground" : a.alt == null ? "–" : fmtInt(a.alt));
  function vsText(vr) {
    const v = Math.round(vr / 10) * 10;
    if (Math.abs(v) < 100) return "Level";
    return `${v > 0 ? "+" : "−"}${fmtInt(Math.abs(v))} ft/min (${v > 0 ? "climbing" : "descending"})`;
  }
  function setStatus(text, isError) {
    ui.status.textContent = text;
    ui.status.classList.toggle("error", Boolean(isError));
  }

  // Drawing: a static background layer, a target layer, and the sweep between them.
  function sizeLayers() {
    const w = Math.round(canvas.clientWidth);
    if (!w) return false;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    Object.assign(view, { w, dpr, cx: w / 2, cy: w / 2, r: w / 2 - 22 });
    view.scale = view.r / state.range;
    for (const c of [canvas, bg, fg]) { c.width = Math.round(w * dpr); c.height = Math.round(w * dpr); }
    return true;
  }

  function drawBackground() {
    const c = bg.getContext("2d");
    const { w, dpr, cx, cy, r } = view;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = COLOR.outside;
    c.fillRect(0, 0, w, w);
    c.beginPath(); c.arc(cx, cy, r, 0, 2 * Math.PI); c.fillStyle = COLOR.face; c.fill();

    // Boxes around fixed text, so aircraft labels can avoid covering it.
    view.boxes = [];
    const step = state.range / 4;
    c.font = `11px ${UI_FONT}`; c.textAlign = "left"; c.textBaseline = "top"; c.lineWidth = 1;
    for (let i = 1; i <= 4; i++) {
      const rr = r * i / 4;
      const label = i === 4 ? `${fmtStep(step * i)} nm` : fmtStep(step * i);
      c.beginPath(); c.arc(cx, cy, rr, 0, 2 * Math.PI);
      c.strokeStyle = i === 4 ? COLOR.edge : COLOR.ring; c.stroke();
      c.fillStyle = COLOR.text;
      c.fillText(label, cx + 4, cy - rr + 3);
      view.boxes.push([cx + 3, cy - rr + 2, cx + 5 + c.measureText(label).width, cy - rr + 16]);
    }

    c.strokeStyle = COLOR.edge;
    for (let b = 0; b < 360; b += 10) {
      const a = rad(b);
      const len = b % 30 === 0 ? 9 : 5;
      c.beginPath();
      c.moveTo(cx + (r - len) * Math.sin(a), cy - (r - len) * Math.cos(a));
      c.lineTo(cx + r * Math.sin(a), cy - r * Math.cos(a));
      c.stroke();
    }
    c.font = `bold 12px ${UI_FONT}`; c.textAlign = "center"; c.textBaseline = "middle"; c.fillStyle = COLOR.text;
    for (const [t, b] of [["N", 0], ["E", 90], ["S", 180], ["W", 270]]) {
      c.fillText(t, cx + (r + 12) * Math.sin(rad(b)), cy - (r + 12) * Math.cos(rad(b)));
    }

    c.save();
    c.beginPath(); c.arc(cx, cy, r, 0, 2 * Math.PI); c.clip();
    c.font = `11px ${UI_FONT}`; c.textAlign = "left"; c.textBaseline = "middle";
    c.strokeStyle = COLOR.airport; c.fillStyle = COLOR.airport;
    const { lat, lon } = state.center;
    for (const ap of AIRPORTS) {
      const d = distNm(lat, lon, ap.lat, ap.lon);
      if (d > state.range) continue;
      const [x, y] = toXY(d, bearing(lat, lon, ap.lat, ap.lon));
      c.beginPath(); c.arc(x, y, 3, 0, 2 * Math.PI); c.stroke();
      c.fillText(ap.id, x + 6, y + 1);
      view.boxes.push([x - 4, y - 7, x + 7 + c.measureText(ap.id).width, y + 7]);
    }
    c.strokeStyle = COLOR.edge;
    c.beginPath(); c.moveTo(cx - 5, cy); c.lineTo(cx + 5, cy); c.moveTo(cx, cy - 5); c.lineTo(cx, cy + 5); c.stroke();
    c.restore();
  }

  // A two-line label in the first of four spots around the target that covers no other label.
  // Spots clear of the airport and ring text are tried first. Returns false, and draws nothing,
  // when every spot would cover another aircraft's label.
  function placeLabel(c, a, x, y, color, placed) {
    const line1 = callsignOf(a);
    const alt = a.ground ? "GND" : a.alt == null ? "---" : pad3(a.alt / 100);
    const arrow = a.vr > 300 ? "↑" : a.vr < -300 ? "↓" : " ";
    const line2 = `${alt}${arrow} ${a.gs == null ? "" : Math.round(a.gs)}`;
    c.font = `bold 11px ${MONO_FONT}`;
    const tw = Math.max(c.measureText(line1).width, c.measureText(line2).width);
    const hits = (box, list) => list.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]);
    for (const avoid of [view.boxes.concat(placed), placed]) {
      for (const [dx, dy] of [[1, -1], [1, 1], [-1, -1], [-1, 1]]) {
        const x1 = dx > 0 ? x + 11 : x - 11 - tw;
        const top = dy < 0 ? y - 22 : y + 4;
        const box = [x1 - 1, top - 1, x1 + tw + 1, top + 26];
        if (box[0] < 0 || box[1] < 0 || box[2] > view.w || box[3] > view.w || hits(box, avoid)) continue;
        c.strokeStyle = color; c.lineWidth = 1;
        c.beginPath(); c.moveTo(x + 3 * dx, y + 3 * dy); c.lineTo(x + 9 * dx, y + 9 * dy); c.stroke();
        c.fillStyle = color; c.textAlign = "left"; c.textBaseline = "alphabetic";
        c.fillText(line1, x1, top + 10);
        c.fillText(line2, x1, top + 22);
        placed.push(box);
        return true;
      }
    }
    return false;
  }

  function drawTargets() {
    const c = fg.getContext("2d");
    const { w, dpr, cx, cy, r } = view;
    if (!w) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, w);
    const { lat, lon } = state.center;
    const colorOf = (a) => (a.hex === state.selected ? COLOR.select : EMERGENCY.has(a.squawk) ? COLOR.emergency : a.ground ? COLOR.ground : COLOR.target);

    // Pass 1: history dots, 1-minute lines, and targets. Aircraft on the ground get a dim dot only.
    c.save();
    c.beginPath(); c.arc(cx, cy, r, 0, 2 * Math.PI); c.clip();
    c.lineWidth = 1;
    const drawOrder = state.aircraft.slice().sort((p, q) => (q.ground - p.ground) || ((p.hex === state.selected) - (q.hex === state.selected)));
    for (const a of drawOrder) {
      const [x, y] = toXY(a.dist, a.brg);
      a.px = x; a.py = y;
      const sel = a.hex === state.selected;
      const color = colorOf(a);
      c.fillStyle = color; c.strokeStyle = color;
      if (!a.ground) {
        const past = (state.trails.get(a.hex) || []).slice(0, -1);
        past.forEach((p, i) => {
          const [tx, ty] = toXY(distNm(lat, lon, p.lat, p.lon), bearing(lat, lon, p.lat, p.lon));
          c.globalAlpha = 0.15 + 0.45 * (i + 1) / past.length;
          c.beginPath(); c.arc(tx, ty, 1.6, 0, 2 * Math.PI); c.fill();
        });
        c.globalAlpha = 1;
        if (a.gs != null && a.track != null) {
          const len = Math.min(a.gs / 60 * view.scale, r * 0.4);
          const t = rad(a.track);
          c.beginPath(); c.moveTo(x, y); c.lineTo(x + len * Math.sin(t), y - len * Math.cos(t)); c.stroke();
        }
      }
      c.beginPath(); c.arc(x, y, sel ? 4.5 : a.ground ? 2.5 : 3.5, 0, 2 * Math.PI); c.fill();
      if (sel) { c.beginPath(); c.arc(x, y, 10, 0, 2 * Math.PI); c.stroke(); }
    }
    c.restore();

    // Pass 2: labels, most important first: the selected aircraft, emergencies, then airborne aircraft by distance.
    const placed = [];
    const rank = (a) => (a.hex === state.selected ? 0 : EMERGENCY.has(a.squawk) ? 1 : 2);
    const labeled = state.aircraft
      .filter((a) => a.hex === state.selected || (ui.labels.checked && !a.ground))
      .sort((p, q) => rank(p) - rank(q) || p.dist - q.dist);
    for (const a of labeled) placeLabel(c, a, a.px, a.py, colorOf(a), placed);
  }

  function drawSweep(now) {
    const { dpr, cx, cy, r } = view;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const a = (now % SWEEP_MS) / SWEEP_MS * 2 * Math.PI - Math.PI / 2;
    const span = Math.PI / 4;
    const n = 18;
    for (let i = 0; i < n; i++) {
      ctx.beginPath(); ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, a - span * (i + 1) / n, a - span * i / n);
      ctx.closePath();
      ctx.fillStyle = `rgba(90, 255, 150, ${(0.14 * (1 - i / n)).toFixed(3)})`;
      ctx.fill();
    }
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
    ctx.strokeStyle = "rgba(120, 255, 170, 0.6)"; ctx.lineWidth = 1.5; ctx.stroke();
  }

  function compose(now) {
    if (!view.w) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(bg, 0, 0);
    if (animating) drawSweep(now);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(fg, 0, 0);
  }
  function loop(now) { compose(now); frame = requestAnimationFrame(loop); }
  function startAnim() {
    if (!animating && !reduceMotion.matches && !document.hidden) { animating = true; frame = requestAnimationFrame(loop); }
    compose(performance.now());
  }
  function stopAnim() { animating = false; cancelAnimationFrame(frame); compose(performance.now()); }
  function redraw() {
    if (!state.center || !sizeLayers()) return;
    drawBackground(); drawTargets(); compose(performance.now());
  }
  function render() { drawTargets(); compose(performance.now()); }

  // Text views. The list puts airborne aircraft first, closest first, then aircraft on the ground.
  const byListOrder = (p, q) => (p.ground - q.ground) || (p.dist - q.dist);

  function renderStatus() {
    const n = state.aircraft.length;
    const t = `${state.notice}${n} aircraft, updated ${zulu(state.time)} (${local(state.time)} local).`;
    state.notice = "";
    setStatus(t, false);
  }

  function renderList() {
    const n = state.aircraft.length;
    const where = `within ${state.range} nm of ${state.center.label}`;
    const order = state.aircraft.some((a) => a.ground) ? ": airborne aircraft closest first, then aircraft on the ground." : ", closest first.";
    if (state.time == null) ui.listNote.textContent = "Waiting for the first update.";
    else ui.listNote.textContent = n ? `${n} aircraft ${where}${order}` : `No aircraft with a position ${where} right now.`;
    ui.list.hidden = !n;
    ui.listBody.innerHTML = state.aircraft.map((a) =>
      `<tr${a.hex === state.selected ? ' class="on"' : ""}>` +
      `<td><button type="button" class="pick${a.callsign ? "" : " hex"}" data-hex="${esc(a.hex)}">${esc(callsignOf(a))}</button></td>` +
      `<td class="num">${altCell(a)}</td><td class="num">${a.gs == null ? "–" : Math.round(a.gs)}</td>` +
      `<td class="num">${a.dist.toFixed(1)}</td></tr>`).join("");
  }

  function renderSelected() {
    const a = state.selectedLast;
    const live = Boolean(a) && state.aircraft.some((x) => x.hex === a.hex);
    ui.selEmpty.hidden = Boolean(a);
    ui.selGone.hidden = !a || live;
    ui.selTable.hidden = !a;
    if (!a) { ui.selBody.innerHTML = ""; return; }
    const squawk = a.squawk ? (SQUAWK_NOTE[a.squawk] ? `${a.squawk} (${SQUAWK_NOTE[a.squawk]})` : a.squawk) : "Not reported";
    const type = a.type ? (a.desc ? `${a.type} (${a.desc})` : a.type) : "Not reported";
    const rows = [
      ["Callsign", a.callsign || "Not reported"],
      ["Registration", a.reg || "Not reported"],
      ["Aircraft type", type],
      ["ICAO address", a.hex.toUpperCase()],
      ["Category", CATEGORY[a.category] || "Not reported"],
      ["Altitude", a.ground ? "On the ground" : a.alt == null ? "Not reported" : `${fmtInt(a.alt)} ft`],
      ["Vertical speed", a.vr == null ? "Not reported" : vsText(a.vr)],
      ["Ground speed", a.gs == null ? "Not reported" : `${Math.round(a.gs)} kt`],
      ["Track", a.track == null ? "Not reported" : `${deg3(a.track)}° true`],
      ["Squawk", squawk],
      [`From ${state.center.label}`, `${a.dist.toFixed(1)} nm, bearing ${deg3(a.brg)}° true`],
      ["Position source", SOURCE[a.source] || "Not reported"],
      ["Position age", `${a.age} ${a.age === 1 ? "second" : "seconds"}`]
    ];
    ui.selBody.innerHTML = rows.map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${esc(v)}</td></tr>`).join("") +
      `<tr><th scope="row">More</th><td><a href="https://globe.adsb.lol/?icao=${encodeURIComponent(a.hex)}" target="_blank" rel="noopener noreferrer">This aircraft on globe.adsb.lol</a></td></tr>`;
  }

  // Data.
  // One record per aircraft, in the aircraft.json format: feet, knots, and feet per minute.
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  function ingest(data) {
    let now = Number(data.now) || Date.now() / 1000;
    if (now > 1e12) now /= 1000;
    now = Math.floor(now);
    const { lat: clat, lon: clon } = state.center;
    const out = [];
    const seen = new Set();
    for (const s of data.ac || data.aircraft || []) {
      const lat = num(s.lat);
      const lon = num(s.lon);
      const age = num(s.seen_pos) ?? 0;
      if (lat == null || lon == null || age > 60) continue;
      const dist = distNm(clat, clon, lat, lon);
      if (dist > state.range) continue;
      const hex = String(s.hex || "").toLowerCase();
      if (!hex) continue;
      out.push({
        hex, callsign: String(s.flight || "").trim(), reg: s.r || "", type: s.t || "", desc: s.desc || "",
        age: Math.round(age), lat, lon, dist, brg: bearing(clat, clon, lat, lon),
        alt: num(s.alt_baro),
        ground: s.alt_baro === "ground",
        gs: num(s.gs),
        track: num(s.track) ?? num(s.true_heading),
        vr: num(s.baro_rate) ?? num(s.geom_rate),
        squawk: s.squawk || "", source: s.type || "", category: s.category || ""
      });
      const trail = state.trails.get(hex) || [];
      const last = trail[trail.length - 1];
      if (!last || last.lat !== lat || last.lon !== lon) trail.push({ lat, lon });
      if (trail.length > 6) trail.shift();
      state.trails.set(hex, trail);
      seen.add(hex);
    }
    for (const hex of [...state.trails.keys()]) if (!seen.has(hex)) state.trails.delete(hex);
    out.sort(byListOrder);
    state.aircraft = out;
    state.time = now;
    const sel = out.find((a) => a.hex === state.selected);
    if (sel) state.selectedLast = sel;
    canvas.setAttribute("aria-label", `Radar scope showing ${out.length} aircraft within ${state.range} nm of ${state.center.label}`);
    renderStatus(); renderList(); renderSelected(); render();
  }

  function query() {
    const { lat, lon } = state.center;
    return `lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&km=${Math.ceil(state.range * KM_PER_NM)}`;
  }

  function schedule(ms) { clearTimeout(state.timer); state.timer = setTimeout(poll, ms); }

  async function poll() {
    clearTimeout(state.timer);
    if (document.hidden || !state.center) return;
    if (state.request) state.request.abort();
    const request = new AbortController();
    state.request = request;
    state.lastFetch = Date.now();
    const timeout = setTimeout(() => request.abort(), 15000);
    try {
      const res = await fetch(`${API}?${query()}`, { cache: "no-store", signal: request.signal });
      if (state.request !== request) return;
      if (res.status === 429) {
        setStatus(`The data feed's request limit was reached. Trying again in ${LIMIT_WAIT_MS / 1000} seconds.`, true);
        schedule(LIMIT_WAIT_MS);
        return;
      }
      if (!res.ok) throw new Error(`Relay status ${res.status}`);
      const data = await res.json();
      if (state.request !== request) return;
      state.backoff = POLL_MS;
      ingest(data);
      schedule(POLL_MS);
    } catch (err) {
      if (state.request !== request) return;
      setStatus(`Live data did not load. Trying again in ${Math.round(state.backoff / 1000)} seconds.`, true);
      schedule(state.backoff);
      state.backoff = Math.min(state.backoff * 2, MAX_BACKOFF_MS);
    } finally {
      clearTimeout(timeout);
      if (state.request === request) state.request = null;
    }
  }

  // Controls.
  function restart() {
    const { lat, lon } = state.center;
    state.aircraft = state.aircraft
      .map((a) => ({ ...a, dist: distNm(lat, lon, a.lat, a.lon), brg: bearing(lat, lon, a.lat, a.lon) }))
      .filter((a) => a.dist <= state.range)
      .sort(byListOrder);
    if (state.selectedLast) state.selectedLast = state.aircraft.find((a) => a.hex === state.selected) || state.selectedLast;
    state.backoff = POLL_MS;
    ui.ringStep.textContent = fmtStep(state.range / 4);
    redraw();
    renderList(); renderSelected();
    setStatus("Loading live aircraft.", false);
    poll();
  }

  function applyCenter(c) {
    state.center = c;
    ui.center.value = c.key;
    store.set("center", c.key);
    restart();
  }

  function setCenter(key) {
    if (key === "HERE") { locate(); return; }
    const ap = AIRPORTS.find((a) => a.id === key && CENTER_LABEL[a.id]) || AIRPORTS[0];
    applyCenter({ key: ap.id, label: CENTER_LABEL[ap.id], lat: ap.lat, lon: ap.lon });
  }

  function locate() {
    const prev = state.center && state.center.key !== "HERE" ? state.center : null;
    const fail = (msg) => {
      if (prev) { ui.center.value = prev.key; setStatus(`${msg} Still showing ${prev.label}.`, true); return; }
      state.notice = `${msg} Showing KAUS. `;
      setCenter("AUS");
    };
    if (!navigator.geolocation) { fail("This browser does not share its location."); return; }
    setStatus("Finding your location.", false);
    navigator.geolocation.getCurrentPosition(
      (p) => applyCenter({ key: "HERE", label: "your location", lat: p.coords.latitude, lon: p.coords.longitude }),
      (err) => fail(err.code === 1 ? "Location permission was denied." : "Your location is not available right now."),
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 }
    );
  }

  function select(hex) {
    state.selected = hex;
    state.selectedLast = hex ? state.aircraft.find((a) => a.hex === hex) || null : null;
    renderSelected(); renderList(); render();
  }

  canvas.addEventListener("click", (e) => {
    const box = canvas.getBoundingClientRect();
    const x = e.clientX - box.left - canvas.clientLeft;
    const y = e.clientY - box.top - canvas.clientTop;
    let best = null;
    let bestD = 24;
    for (const a of state.aircraft) {
      if (a.px == null) continue;
      const d = Math.hypot(a.px - x, a.py - y);
      if (d < bestD) { best = a; bestD = d; }
    }
    select(best ? best.hex : null);
  });

  ui.listBody.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-hex]");
    if (!b) return;
    select(b.dataset.hex);
    $("radar-h").scrollIntoView({ behavior: reduceMotion.matches ? "auto" : "smooth", block: "start" });
  });

  ui.center.addEventListener("change", () => setCenter(ui.center.value));
  ui.range.addEventListener("change", () => {
    state.range = Number(ui.range.value);
    store.set("range", ui.range.value);
    restart();
  });
  ui.labels.addEventListener("change", () => {
    store.set("labels", ui.labels.checked ? "on" : "off");
    render();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      clearTimeout(state.timer);
      if (state.request) { state.request.abort(); state.request = null; }
      stopAnim();
      return;
    }
    startAnim();
    const since = Date.now() - state.lastFetch;
    if (since >= POLL_MS) poll(); else schedule(POLL_MS - since);
  });

  if (reduceMotion.addEventListener) reduceMotion.addEventListener("change", () => (reduceMotion.matches ? stopAnim() : startAnim()));
  new ResizeObserver(() => redraw()).observe(canvas);

  const savedRange = Number(store.get("range"));
  if (RANGES.includes(savedRange)) state.range = savedRange;
  ui.range.value = String(state.range);
  ui.labels.checked = store.get("labels") !== "off";
  setCenter(store.get("center") || "AUS");
  startAnim();
})();
