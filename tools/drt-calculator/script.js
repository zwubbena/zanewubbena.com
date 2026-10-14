"use strict";
const DRT = (() => {
  // Unit sizes use exact definitions: 1 ft = 0.3048 m, 1 mi = 1,609.344 m, 1 nmi = 1,852 m.
  const DIST = {
    mi: { name: "miles", base: 1609.344 },
    km: { name: "kilometers", base: 1000 },
    m: { name: "meters", base: 1 },
    ft: { name: "feet", base: 0.3048 },
    nmi: { name: "nautical miles", base: 1852 }
  };
  const TIME = {
    h: { name: "hours", base: 3600 },
    min: { name: "minutes", base: 60 },
    s: { name: "seconds", base: 1 }
  };
  // Each rate unit is one distance unit per one time unit.
  const RATE = {
    "mi/h": { name: "miles per hour", d: "mi", t: "h" },
    "km/h": { name: "kilometers per hour", d: "km", t: "h" },
    "m/s": { name: "meters per second", d: "m", t: "s" },
    "ft/s": { name: "feet per second", d: "ft", t: "s" },
    "kt": { name: "knots", d: "nmi", t: "h" }
  };
  const NAMES = { d: "distance", r: "rate", t: "time" };
  const LABELS = { d: "Distance", r: "Rate", t: "Time" };
  const FORMULA = {
    d: ["d", "=", "r", "×", "t"],
    r: ["r", "=", "d", "÷", "t"],
    t: ["t", "=", "d", "÷", "r"]
  };
  const SIG = 6;
  const FACTOR_SIG = 7;
  const SUP = { "-": "⁻", "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹" };

  // Round to significant figures for display; whole-number digits are never dropped.
  function fmt(x, sig = SIG) {
    if (x === 0) return "0";
    const ax = Math.abs(x);
    if (ax >= 1e15 || ax < 1e-6) {
      const [mant, exp] = x.toExponential(sig - 1).split("e");
      const m = mant.indexOf(".") === -1 ? mant : mant.replace(/0+$/, "").replace(/\.$/, "");
      return m + " × 10" + String(Number(exp)).replace(/[-0-9]/g, c => SUP[c]);
    }
    const mag = Math.floor(Math.log10(ax));
    const dec = Math.min(Math.max(sig - 1 - mag, 0), 15);
    return x.toLocaleString("en-US", { maximumFractionDigits: dec });
  }

  // Show a typed value with every digit the person entered, plus thousands separators.
  function fmtTyped(text) {
    const parts = text.split(".");
    const whole = (parts[0] || "0").replace(/^0+(?=\d)/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return parts.length > 1 && parts[1] !== "" ? whole + "." + parts[1] : whole;
  }

  function parse(raw) {
    let s = String(raw).trim();
    if (s === "") return { state: "empty" };
    if (s === "." || s === ",") return { state: "partial" };
    if (/^\d{1,3}(,\d{3})+(\.\d*)?$/.test(s)) s = s.replace(/,/g, "");
    else if (/^\d*,\d*$/.test(s)) s = s.replace(",", ".");
    if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return { state: "invalid" };
    return { state: "ok", value: parseFloat(s), text: s };
  }

  // Convert between two units of the same kind. The factor shown is always 1 or more.
  function convert(value, from, to, table) {
    if (from === to) return null;
    const a = table[from].base;
    const b = table[to].base;
    if (a > b) {
      const f = a / b;
      return { op: "×", factor: f, factorUnit: to + "/" + from, result: value * f };
    }
    const f = b / a;
    return { op: "÷", factor: f, factorUnit: from + "/" + to, result: value / f };
  }

  function unitText(table, key) {
    return table[key].name + " (" + key + ")";
  }
  function rateText(key) {
    return key === "kt" ? "knots (1 kt = 1 nmi/h)" : unitText(RATE, key);
  }

  function noAnswer(model, v) {
    model.step4 = { ok: false, message: "The " + NAMES[v] + " is 0, and division by 0 has no answer. Enter a " + NAMES[v] + " greater than 0." };
    model.step5 = null;
    model.answer = null;
    model.answerMessage = "Enter a " + NAMES[v] + " greater than 0 to see the answer.";
    return model;
  }

  // unknown: "d", "r" or "t". known: the two parsed values. units: the unit chosen in each row.
  function solve(unknown, known, units) {
    const rate = RATE[units.r];
    const model = { unknown, known: ["d", "r", "t"].filter(v => v !== unknown), formula: FORMULA[unknown] };
    const typed = v => ({ v, num: fmtTyped(known[v].text), unit: units[v] });
    const calc = (v, value, unit) => ({ v, num: fmt(value), unit });
    const convStep = (v, from, c, to) => ({ kind: "conv", lhs: v, from, op: c.op, factor: fmt(c.factor, FACTOR_SIG), factorUnit: c.factorUnit, to });
    // Put a known distance or time into the units the rate uses.
    const match = (v, table, target) => {
      const c = convert(known[v].value, units[v], target, table);
      if (!c) {
        return { value: known[v].value, q: typed(v), item: { kind: "already", text: LABELS[v] + " is already in " + unitText(table, target) + "." } };
      }
      const q = calc(v, c.result, target);
      return { value: c.result, q, item: convStep(v, typed(v), c, q) };
    };

    let work;
    let workUnit;
    if (unknown === "d") {
      const t = match("t", TIME, rate.t);
      model.step2 = { sentence: "Time must be in " + unitText(TIME, rate.t) + " to match the rate in " + rateText(units.r) + ".", items: [t.item] };
      model.step3 = { lhs: "d", a: typed("r"), op: "×", b: t.q };
      work = known.r.value * t.value;
      workUnit = rate.d;
    } else if (unknown === "t") {
      const d = match("d", DIST, rate.d);
      model.step2 = { sentence: "Distance must be in " + unitText(DIST, rate.d) + " to match the rate in " + rateText(units.r) + ".", items: [d.item] };
      model.step3 = { lhs: "t", a: d.q, op: "÷", b: typed("r") };
      if (known.r.value === 0) return noAnswer(model, "r");
      work = d.value / known.r.value;
      workUnit = rate.t;
    } else {
      const d = match("d", DIST, rate.d);
      const t = match("t", TIME, rate.t);
      model.step2 = { sentence: "Distance must be in " + unitText(DIST, rate.d) + " and time in " + unitText(TIME, rate.t) + " to give the rate in " + rateText(units.r) + ".", items: [d.item, t.item] };
      model.step3 = { lhs: "r", a: d.q, op: "÷", b: t.q };
      if (t.value === 0) return noAnswer(model, "t");
      work = d.value / t.value;
      workUnit = units.r;
    }

    model.step4 = { ok: true, lhs: unknown, q: calc(unknown, work, workUnit) };
    const table = unknown === "d" ? DIST : unknown === "t" ? TIME : RATE;
    const c = unknown === "r" ? null : convert(work, workUnit, units[unknown], table);
    const value = c ? c.result : work;
    model.step5 = c
      ? convStep(unknown, model.step4.q, c, calc(unknown, value, units[unknown]))
      : { kind: "already", text: "The answer is already in " + unitText(table, units[unknown]) + "." };
    model.answer = { v: unknown, label: LABELS[unknown], value, num: fmt(value), unit: units[unknown] };
    return model;
  }

  return { DIST, TIME, RATE, NAMES, LABELS, FORMULA, SIG, FACTOR_SIG, fmt, fmtTyped, parse, convert, solve };
})();

"use strict";
(() => {
  const VARS = ["d", "r", "t"];
  const TABLES = { d: DRT.DIST, r: DRT.RATE, t: DRT.TIME };
  const DRAW_MS = 900;
  const RING_PAD = 7;
  const RING_RADIUS = 2;
  const RING_STROKE = 2;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  const ui = {};
  for (const v of VARS) {
    const row = document.querySelector('.row[data-var="' + v + '"]');
    const input = row.querySelector("input");
    const unit = row.querySelector("select");
    for (const [key, info] of Object.entries(TABLES[v])) unit.add(new Option(key + " (" + info.name + ")", key));
    ui[v] = {
      row,
      input,
      unit,
      clear: row.querySelector(".x"),
      err: row.querySelector(".err"),
      tag: row.querySelector(".tag"),
      placeholder: input.placeholder
    };
  }
  const formulas = document.getElementById("formulas");
  const cards = {};
  for (const card of formulas.querySelectorAll(".formula")) cards[card.dataset.solves] = card;
  const say1 = document.getElementById("say-1");
  const later = [2, 3, 4, 5].map(n => ({ li: document.getElementById("step-" + n), body: document.getElementById("body-" + n) }));
  const answer = document.getElementById("answer");

  let locked = null;   // the row that shows the answer
  let picked = null;   // the formula with the line around it
  let pending = null;  // a picked formula whose line waits until the formula is on screen
  let drawEnds = 0;    // when the current line drawing finishes

  const varHTML = v => '<i class="var c-' + v + '">' + v + "</i>";
  const qtyHTML = q => '<span class="c-' + q.v + '">' + q.num + "&nbsp;" + q.unit + "</span>";
  const fracHTML = (top, bottom) => '<span class="frac"><span class="frac-top">' + top +
    '</span><span class="sr"> divided by </span><span class="frac-bot">' + bottom + "</span></span>";
  // A formula is [left, "=", a, operator, b]; division shows a over b with a bar between them.
  const formulaHTML = ([lhs, eq, a, op, b]) => '<span class="nw">' + varHTML(lhs) + " " + eq + " " +
    (op === "÷" ? fracHTML(varHTML(a), varHTML(b)) : varHTML(a) + " " + op + " " + varHTML(b)) + "</span>";
  const sayHTML = text => '<p class="say">' + text + "</p>";
  const convHTML = c => '<p class="eq">' + varHTML(c.lhs) + " = " + qtyHTML(c.from) + " " + c.op +
    ' <span class="k">' + c.factor + "&nbsp;" + c.factorUnit + "</span> = " + qtyHTML(c.to) + "</p>";

  // The line starts at the top-left corner, runs down the left side, then goes around.
  function drawRing(card, mode) {
    const svg = card.querySelector(".ring");
    const path = svg.firstElementChild;
    const w = card.offsetWidth + RING_PAD * 2;
    const h = card.offsetHeight + RING_PAD * 2;
    const a = RING_STROKE / 2;
    const r = RING_RADIUS;
    const x1 = w - a;
    const y1 = h - a;
    svg.setAttribute("width", w);
    svg.setAttribute("height", h);
    svg.setAttribute("viewBox", "0 0 " + w + " " + h);
    path.setAttribute("d",
      "M" + a + " " + (a + r) +
      "V" + (y1 - r) + "A" + r + " " + r + " 0 0 0 " + (a + r) + " " + y1 +
      "H" + (x1 - r) + "A" + r + " " + r + " 0 0 0 " + x1 + " " + (y1 - r) +
      "V" + (a + r) + "A" + r + " " + r + " 0 0 0 " + (x1 - r) + " " + a +
      "H" + (a + r) + "A" + r + " " + r + " 0 0 0 " + a + " " + (a + r));
    const len = Math.ceil(path.getTotalLength()) + 1;
    path.style.transition = "none";
    path.style.strokeDasharray = len + " " + len;
    path.style.strokeDashoffset = mode === "instant" ? "0" : String(len);
    if (mode === "animate") {
      getComputedStyle(path).strokeDashoffset;
      path.style.transition = "stroke-dashoffset " + DRAW_MS + "ms cubic-bezier(0.55, 0, 0.35, 1)";
      path.style.strokeDashoffset = "0";
      drawEnds = performance.now() + DRAW_MS;
    }
  }

  function inView(el) {
    const box = el.getBoundingClientRect();
    const vv = window.visualViewport;
    const top = vv ? vv.offsetTop : 0;
    const bottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
    return box.top >= top && box.bottom <= bottom;
  }

  function showLine(card) {
    if (reduceMotion.matches) {
      pending = null;
      drawRing(card, "instant");
    } else if (inView(card)) {
      pending = null;
      drawRing(card, "animate");
    } else {
      pending = card;
      drawRing(card, "hidden");
    }
  }

  function checkPending() {
    if (pending && inView(pending)) {
      const card = pending;
      pending = null;
      drawRing(card, "animate");
    }
  }

  function setPicked(v) {
    if (v === picked) return;
    if (picked) cards[picked].classList.remove("picked");
    picked = v;
    pending = null;
    formulas.classList.toggle("has-pick", v !== null);
    if (v) {
      cards[v].classList.add("picked");
      showLine(cards[v]);
    }
  }

  function setLocked(v, on) {
    const u = ui[v];
    u.row.classList.toggle("is-answer", on);
    u.row.classList.remove("has-error");
    u.tag.hidden = !on;
    u.clear.hidden = true;
    u.err.hidden = true;
    u.input.readOnly = on;
    u.input.value = "";
    u.input.placeholder = on ? "?" : u.placeholder;
    u.input.setAttribute("aria-invalid", "false");
  }

  function render(m, message) {
    if (!m) {
      say1.textContent = message;
      for (const s of later) {
        s.li.classList.add("idle");
        s.body.innerHTML = "";
      }
      answer.classList.add("is-empty");
      answer.innerHTML = '<p class="answer-empty">Enter two values to see the answer.</p>';
      return;
    }
    const [s2, s3, s4, s5] = later;
    say1.innerHTML = DRT.LABELS[m.known[0]] + " and " + DRT.NAMES[m.known[1]] + " are known, so use " +
      formulaHTML(m.formula) + " to find " + DRT.NAMES[m.unknown] + ".";
    s2.body.innerHTML = sayHTML(m.step2.sentence) +
      m.step2.items.map(item => (item.kind === "conv" ? convHTML(item) : sayHTML(item.text))).join("");
    const sub = m.step3.op === "÷"
      ? fracHTML(qtyHTML(m.step3.a), qtyHTML(m.step3.b))
      : qtyHTML(m.step3.a) + " " + m.step3.op + " " + qtyHTML(m.step3.b);
    s3.body.innerHTML = '<p class="eq">' + formulaHTML(m.formula) + "</p>" +
      '<p class="eq">' + varHTML(m.step3.lhs) + " = " + sub + "</p>";
    s4.body.innerHTML = m.step4.ok
      ? '<p class="eq">' + varHTML(m.step4.lhs) + " = " + qtyHTML(m.step4.q) + "</p>"
      : '<p class="say warn">' + m.step4.message + "</p>";
    s5.body.innerHTML = !m.step5 ? "" : m.step5.kind === "conv" ? convHTML(m.step5) : sayHTML(m.step5.text);
    for (const s of [s2, s3, s4]) s.li.classList.remove("idle");
    s5.li.classList.toggle("idle", !m.step5);
    if (m.answer) {
      answer.classList.remove("is-empty");
      answer.innerHTML = '<p class="answer-label">' + m.answer.label + "</p>" +
        '<p class="answer-big">' + varHTML(m.answer.v) + " = " + qtyHTML(m.answer) + "</p>";
    } else {
      answer.classList.add("is-empty");
      answer.innerHTML = '<p class="answer-empty">' + m.answerMessage + "</p>";
    }
  }

  function update() {
    const filled = VARS.filter(v => v !== locked && ui[v].input.value.trim() !== "");
    const next = filled.length === 2 ? VARS.find(v => !filled.includes(v)) : null;
    if (next !== locked) {
      if (locked) setLocked(locked, false);
      if (next) setLocked(next, true);
      locked = next;
    }

    const known = {};
    let invalid = false;
    let partial = false;
    for (const v of VARS) {
      if (v === locked) continue;
      const p = DRT.parse(ui[v].input.value);
      const bad = p.state === "invalid";
      ui[v].clear.hidden = p.state === "empty";
      ui[v].err.hidden = !bad;
      ui[v].row.classList.toggle("has-error", bad);
      ui[v].input.setAttribute("aria-invalid", bad ? "true" : "false");
      if (bad) invalid = true;
      if (p.state === "partial") partial = true;
      if (p.state === "ok") known[v] = p;
    }

    let model = null;
    let message = "";
    if (locked && !invalid && !partial) {
      model = DRT.solve(locked, known, { d: ui.d.unit.value, r: ui.r.unit.value, t: ui.t.unit.value });
    } else if (invalid) {
      message = "Fix the entry above to continue.";
    } else if (filled.length === 2) {
      message = "Finish entering the values.";
    } else if (filled.length === 1) {
      message = "Enter one more value to choose a formula.";
    } else {
      message = "Enter any two values to choose a formula.";
    }
    if (locked) ui[locked].input.value = model && model.answer ? model.answer.num : "";
    render(model, message);
    setPicked(model ? model.unknown : null);
  }

  for (const v of VARS) {
    ui[v].input.addEventListener("input", update);
    ui[v].unit.addEventListener("change", update);
    ui[v].clear.addEventListener("click", () => {
      ui[v].input.value = "";
      update();
      ui[v].input.focus();
    });
  }
  document.getElementById("clear-all").addEventListener("click", () => {
    for (const v of VARS) ui[v].input.value = "";
    update();
  });

  // Keep the line fitted to its formula when the layout changes size.
  new ResizeObserver(() => {
    if (!picked) return;
    const card = cards[picked];
    if (pending === card) drawRing(card, "hidden");
    else drawRing(card, performance.now() < drawEnds ? "animate" : "instant");
  }).observe(formulas);

  window.addEventListener("scroll", checkPending, { passive: true });
  window.addEventListener("resize", checkPending);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("scroll", checkPending);
    window.visualViewport.addEventListener("resize", checkPending);
  }

  for (const v of VARS) cards[v].querySelector(".fx").innerHTML = formulaHTML(DRT.FORMULA[v]);
  for (const v of VARS) ui[v].input.value = "";
  update();
})();
