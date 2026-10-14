"use strict";
(() => {
  const ZONES = [
    { id: "UTC", key: "utc", name: "UTC (Zulu)", region: "UTC", fixed: true },
    { id: "America/Puerto_Rico", key: "atl", name: "Atlantic (Puerto Rico, U.S. Virgin Islands)", region: "Atlantic Time", fixed: true },
    { id: "America/New_York", key: "est", name: "Eastern", region: "Eastern Time" },
    { id: "America/Chicago", key: "cst", name: "Central", region: "Central Time" },
    { id: "America/Denver", key: "mst", name: "Mountain", region: "Mountain Time" },
    { id: "America/Phoenix", key: "az", name: "Mountain (most of Arizona, no daylight saving)", region: "Arizona time", fixed: true },
    { id: "America/Los_Angeles", key: "pst", name: "Pacific", region: "Pacific Time" },
    { id: "America/Anchorage", key: "ak", name: "Alaska", region: "Alaska Time" },
    { id: "America/Adak", key: "hia", name: "Hawaii-Aleutian (Aleutian Islands west of 169°30′ W)", region: "Hawaii-Aleutian Time in the Aleutian Islands", abbr: ["HST", "HDT"] },
    { id: "Pacific/Honolulu", key: "hi", name: "Hawaii-Aleutian (Hawaii)", region: "Hawaii time", fixed: true },
    { id: "Pacific/Pago_Pago", key: "sam", name: "Samoa (American Samoa)", region: "Samoa Time", fixed: true, abbr: ["SST", "SST"] },
    { id: "Pacific/Guam", key: "cha", name: "Chamorro (Guam, Northern Mariana Islands)", region: "Chamorro Time", fixed: true, abbr: ["ChST", "ChST"] }
  ];
  const byId = Object.fromEntries(ZONES.map(z => [z.id, z]));
  const HOUR = 3600000;
  const el = id => document.getElementById(id);
  const dateIn = el("in-date"), timeIn = el("in-time"), fromSel = el("from"), toSel = el("to");
  for (const z of ZONES) { fromSel.add(new Option(z.name, z.id)); toSel.add(new Option(z.name, z.id)); }
  fromSel.value = "America/New_York";
  toSel.value = "America/Los_Angeles";

  const fmtCache = {};
  function parts(zone, ms) {
    const f = fmtCache[zone] || (fmtCache[zone] = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    const o = {};
    for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
    return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second };
  }
  // Offset from UTC in minutes for a zone at an instant (negative west of Greenwich).
  function offset(zone, ms) {
    const p = parts(zone, ms);
    return Math.round((Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000) / 60000);
  }
  function label(zone, ms, style) {
    if (zone === "UTC") return style === "long" ? "Coordinated Universal Time" : "UTC";
    const z = byId[zone];
    if (style === "short" && z.abbr) {
      const jan = offset(zone, Date.UTC(new Date(ms).getUTCFullYear(), 0, 15));
      return offset(zone, ms) === jan ? z.abbr[0] : z.abbr[1];
    }
    const f = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: style });
    const t = f.formatToParts(new Date(ms)).find(x => x.type === "timeZoneName");
    return t ? t.value : zone;
  }
  // The instant for a wall-clock time in a zone, with notes for the daylight saving changeover hours.
  function toInstant(zone, wall) {
    const oA = offset(zone, wall - 12 * HOUR), oB = offset(zone, wall + 12 * HOUR);
    const cands = [...new Set([oA, oB])].map(o => wall - o * 60000).filter(c => offset(zone, c) * 60000 === wall - c);
    if (cands.length === 0) return { ms: wall - oA * 60000, gap: true };
    cands.sort((a, b) => a - b);
    return { ms: cands[0], overlap: cands.length > 1 };
  }

  const pad = n => String(n).padStart(2, "0");
  const t24 = (h, m) => pad(h) + ":" + pad(m);
  const t12 = (h, m) => (h % 12 === 0 ? 12 : h % 12) + ":" + pad(m) + (h < 12 ? " AM" : " PM");
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dstr = p => DAYS[new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay()] + ", " + MONTHS[p.mo - 1] + " " + p.d + ", " + p.y;
  const offStr = m => "UTC" + (m === 0 ? "+0" : (m < 0 ? "−" : "+") + Math.floor(Math.abs(m) / 60) + (Math.abs(m) % 60 ? ":" + pad(Math.abs(m) % 60) : ""));
  const hm = m => (m < 0 ? "−" : "") + Math.floor(Math.abs(m) / 60) + ":" + pad(Math.abs(m) % 60);
  const hrs = m => { const h = Math.floor(m / 60), r = m % 60; return (h ? h + (h === 1 ? " hour" : " hours") : "") + (h && r ? " " : "") + (r ? r + " minutes" : ""); };
  const span = (cls, text) => '<span class="' + cls + '">' + text + "</span>";
  const eq = html => '<p class="eq">' + html + "</p>";
  const p = (html, cls) => '<p class="' + (cls || "say") + '">' + html + "</p>";

  function parseTime(raw) {
    const s = raw.trim().toLowerCase().replace(/\s+/g, "").replace(/\./g, "");
    if (s === "") return { state: "empty" };
    let m = s.match(/^(\d{1,2})(?::?(\d{2}))?(am|pm|a|p)$/);
    if (m) {
      let h = +m[1]; const mi = m[2] ? +m[2] : 0;
      if (h < 1 || h > 12 || mi > 59) return { state: "invalid" };
      const pm = m[3][0] === "p";
      h = h % 12 + (pm ? 12 : 0);
      return { state: "ok", h, mi };
    }
    m = s.match(/^(\d{1,2}):(\d{2})$/) || s.match(/^(\d{2})(\d{2})$/);
    if (m) {
      const h = +m[1], mi = +m[2];
      if (h > 23 || mi > 59) return { state: "invalid" };
      return { state: "ok", h, mi };
    }
    return /^\d{1,3}$|^\d{1,2}:\d?$/.test(s) ? { state: "partial" } : { state: "invalid" };
  }

  const steps = [1, 2, 3, 4, 5].map(n => ({ li: el("step-" + n), body: el("body-" + n) }));
  const answer = el("answer"), say = el("say"), mix = el("mix");

  function mixups(fromZ, toZ, ms) {
    const items = [];
    const z = [fromZ, toZ].find(x => !byId[x].fixed);
    if (z) {
      const jan = Date.UTC(new Date(ms).getUTCFullYear(), 0, 15), jul = Date.UTC(new Date(ms).getUTCFullYear(), 6, 15);
      items.push("<strong>Standard versus daylight time.</strong> " + byId[z].region + " is " + label(z, jan, "short") + " (" + offStr(offset(z, jan)) +
        ") in winter and " + label(z, jul, "short") + " (" + offStr(offset(z, jul)) + ") in summer. On this date it is " + label(z, ms, "short") +
        ". Writing " + label(z, jan, "short") + " in July names the wrong offset by an hour. When unsure, write “" + byId[z].region + ".”");
    }
    if (fromZ === "America/Phoenix" || toZ === "America/Phoenix") {
      items.push("<strong>Arizona does not change its clocks.</strong> Most of Arizona stays on Mountain Standard Time (UTC−7) all year, so in summer it matches Pacific Time, and in winter it matches Mountain Time. The Navajo Nation in Arizona does observe daylight saving.");
    } else {
      items.push("<strong>Not every place changes its clocks.</strong> UTC, Puerto Rico, the U.S. Virgin Islands, most of Arizona, Hawaii, American Samoa, Guam, and the Northern Mariana Islands never change for daylight saving, so their difference from the other zones changes during the year.");
    }
    items.push("<strong>Midnight and noon.</strong> 12:00 AM is midnight (00:00), the start of the day. 12:00 PM is noon (12:00). Writing “12:00 midnight” or “12:00 noon” removes the doubt.");
    items.push("<strong>Crossing midnight changes the date.</strong> A conversion that passes 00:00 lands on the next day or the day before, so give the date with the time.");
    return '<ul class="mixups">' + items.map(i => "<li>" + i + "</li>").join("") + "</ul>";
  }

  function paintMap(ms, fromZ, toZ) {
    const picks = ms === null ? [] : [byId[fromZ].key, byId[toZ].key];
    const keyZone = Object.fromEntries(ZONES.map(z => [z.key, z.id]));
    for (const svg of document.querySelectorAll("svg.map, .insets")) svg.classList.toggle("has-pick", picks.length > 0);
    for (const path of document.querySelectorAll(".states path[data-zone], .insets path[data-zone]")) {
      const zs = path.dataset.zone.split("|");
      path.classList.toggle("dim", picks.length > 0 && !zs.some(z => picks.includes(z)));
    }
    for (const t of document.querySelectorAll("text.zl")) {
      const k = t.dataset.zone;
      t.classList.toggle("pick", picks.includes(k));
      let v = "";
      if (ms !== null) { const q = parts(keyZone[k], ms); v = t12(q.h, q.mi) + " " + label(keyZone[k], ms, "short"); }
      t.querySelector(".zt").textContent = v;
    }
  }

  function idle(msg) {
    paintMap(null);
    steps.forEach((s, i) => { s.li.classList.add("idle"); s.body.innerHTML = i === 0 ? p(msg) : ""; });
    answer.classList.add("is-empty");
    answer.innerHTML = '<p class="answer-empty">Enter a date and a time to see the answer.</p>';
    say.innerHTML = '<p class="answer-empty">Enter a date and a time to see how to write the result.</p>';
    el("all").innerHTML = '<p class="answer-empty">Enter a date and a time to see every zone.</p>';
  }

  function render() {
    const fromZ = fromSel.value, toZ = toSel.value;
    const t = parseTime(timeIn.value);
    const bad = t.state === "invalid";
    el("err-time").hidden = !bad;
    el("row-when").classList.toggle("has-error", bad);
    timeIn.setAttribute("aria-invalid", bad ? "true" : "false");
    const dm = dateIn.value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    mix.innerHTML = mixups(fromZ, toZ, dm ? Date.UTC(+dm[1], +dm[2] - 1, +dm[3], 12) : Date.now());
    if (bad) return idle("Fix the time above to continue.");
    if (!dm || t.state !== "ok") return idle("Enter a date and a time to start.");

    const wall = Date.UTC(+dm[1], +dm[2] - 1, +dm[3], t.h, t.mi);
    const inst = toInstant(fromZ, wall);
    const ms = inst.ms;
    const oF = offset(fromZ, ms), oT = offset(toZ, ms);
    const u = parts("UTC", ms), r = parts(toZ, ms), f = parts(fromZ, ms);
    const F = byId[fromZ], T = byId[toZ];
    const fromTime = span("c-f", t24(f.h, f.mi)), utcTime = t24(u.h, u.mi) + " UTC", toTime = span("c-p", t24(r.h, r.mi));
    for (const s of steps) s.li.classList.remove("idle");

    let warn = "";
    if (inst.gap) warn = p("On this date the clocks in " + F.region + " jump forward, so " + t24(t.h, t.mi) + " never happens there. This page uses " + t24(f.h, f.mi) + ", the same moment after the jump.", "warn-box");
    if (inst.overlap) warn = p("On this date the clocks in " + F.region + " fall back, so " + t24(t.h, t.mi) + " happens twice. This page uses the first one, on daylight time.", "warn-box");

    const longF = label(fromZ, ms, "long"), longT = label(toZ, ms, "long");
    steps[0].body.innerHTML = warn + eq(span("c-f", F.name) + " on " + dstr(f) + ": " + longF + " = " + span("c-f", offStr(oF))) +
      p(fromZ === "UTC" ? "UTC is the reference, so its offset is 0." :
        "The offset says how far the zone is from UTC. A minus sign means the zone is behind UTC." +
        (!F.fixed ? " The offset depends on the date because of daylight saving." : " This zone does not change for daylight saving, so the offset is the same all year."));
    steps[1].body.innerHTML = eq("UTC = local time − offset = " + fromTime + " − (" + span("c-f", hm(oF)) + ") = " + utcTime) +
      p(oF < 0 ? "Subtracting a negative offset means adding " + hrs(-oF) + "." : oF > 0 ? "Subtract " + hrs(oF) + "." : "No change, since the offset is 0.") +
      (u.d !== f.d ? p("This passes midnight, so in UTC it is " + dstr(u) + ".") : "");
    steps[2].body.innerHTML = eq(span("c-t", T.name) + " on " + dstr(u) + ": " + longT + " = " + span("c-t", offStr(oT)));
    steps[3].body.innerHTML = eq(T.name + " time = UTC + offset = " + utcTime + " + (" + span("c-t", hm(oT)) + ") = " + toTime) +
      p(oT < 0 ? "Adding a negative offset means subtracting " + hrs(-oT) + "." : oT > 0 ? "Add " + hrs(oT) + "." : "No change, since the offset is 0.");
    const dayDiff = Math.round((Date.UTC(r.y, r.mo - 1, r.d) - Date.UTC(f.y, f.mo - 1, f.d)) / 86400000);
    steps[4].body.innerHTML = p(dayDiff === 0 ? "The time stays on the same date, " + dstr(r) + "." :
      "The conversion crosses midnight, so the date moves " + (dayDiff > 0 ? "forward" : "back") + " a day, from " + dstr(f) + " to " + dstr(r) + ".");

    const diff = oT - oF;
    answer.classList.remove("is-empty");
    answer.innerHTML = '<p class="answer-label">' + (toZ === "UTC" ? "UTC (Zulu)" : T.name + " (" + label(toZ, ms, "short") + ")") + "</p>" +
      '<p class="answer-big">' + span("c-p", t12(r.h, r.mi)) + " · " + t24(r.h, r.mi) + "</p>" +
      '<p class="say">' + dstr(r) + (dayDiff ? " (" + (dayDiff > 0 ? "next day" : "previous day") + ")" : "") + ". " +
      (diff === 0 ? T.name + " and " + F.name + " show the same time on this date." :
        T.name + " is " + hrs(Math.abs(diff)) + " " + (diff > 0 ? "ahead of " : "behind ") + F.name + " on this date.") + "</p>";

    const rowsHTML = ZONES.map(z => {
      const q = parts(z.id, ms);
      const dd = Math.round((Date.UTC(q.y, q.mo - 1, q.d) - Date.UTC(f.y, f.mo - 1, f.d)) / 86400000);
      const cls = z.id === fromZ ? ' class="is-from"' : z.id === toZ ? ' class="is-to"' : "";
      return "<tr" + cls + "><td>" + z.name + "</td><td class=\"tnum\">" + label(z.id, ms, "short") + "</td><td class=\"tnum\">" + offStr(offset(z.id, ms)) +
        "</td><td class=\"tnum\">" + t12(q.h, q.mi) + "</td><td class=\"tnum\">" + t24(q.h, q.mi) + "</td><td class=\"tnum\">" + dstr(q) +
        (dd ? " (" + (dd > 0 ? "next day" : "previous day") + ")" : "") + "</td></tr>";
    }).join("");
    paintMap(ms, fromZ, toZ);
    el("all").innerHTML = p("Blue is the From zone and orange is the To zone. Every row is the same moment.") +
      '<div class="tbl-wrap"><table class="zones"><thead><tr><th>Time zone</th><th>Abbreviation</th><th>Offset</th><th>12-hour</th><th>24-hour</th><th>Date</th></tr></thead><tbody>' +
      rowsHTML + "</tbody></table></div>";

    const sF = label(fromZ, ms, "short"), sT = label(toZ, ms, "short");
    say.innerHTML = '<p class="quote">' + t12(f.h, f.mi) + " " + sF + " on " + dstr(f) + " is " + t12(r.h, r.mi) + " " + sT +
      (dayDiff ? " on " + dstr(r) : "") + (fromZ !== "UTC" && toZ !== "UTC" ? " (" + t24(u.h, u.mi) + " UTC)" : "") + ".</p>" +
      p("Give the zone with every time, and add the UTC time when people in several zones will read it, so everyone converts from the same clock.");
  }

  function fillNow() {
    const n = parts(fromSel.value, Date.now());
    dateIn.value = n.y + "-" + pad(n.mo) + "-" + pad(n.d);
    timeIn.value = t24(n.h, n.mi);
    render();
  }
  for (const i of [dateIn, timeIn]) i.addEventListener("input", render);
  for (const s of [fromSel, toSel]) s.addEventListener("change", render);
  el("swap").addEventListener("click", () => { const a = fromSel.value; fromSel.value = toSel.value; toSel.value = a; render(); });
  el("now").addEventListener("click", fillNow);
  el("clear-all").addEventListener("click", () => { timeIn.value = ""; render(); timeIn.focus(); });
  const n0 = parts(fromSel.value, Date.now());
  dateIn.value = n0.y + "-" + pad(n0.mo) + "-" + pad(n0.d);
  timeIn.value = "";
  render();
})();
