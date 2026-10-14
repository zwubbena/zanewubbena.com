"use strict";
(() => {
  const SUP = { "-": "⁻", "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹" };
  // Round to 6 significant figures for display; whole-number digits are never dropped.
  function fmt(x) {
    if (x === 0) return "0";
    const ax = Math.abs(x);
    if (ax >= 1e15 || ax < 1e-6) {
      const [mant, exp] = x.toExponential(5).split("e");
      return mant.replace(/0+$/, "").replace(/\.$/, "").replace("-", "−") + " × 10" + String(Number(exp)).replace(/[-0-9]/g, c => SUP[c]);
    }
    const dec = Math.min(Math.max(5 - Math.floor(Math.log10(ax)), 0), 15);
    return x.toLocaleString("en-US", { maximumFractionDigits: dec }).replace("-", "−");
  }
  function parse(raw) {
    let s = String(raw).trim().replace(/%$/, "").trim();
    if (s === "") return { state: "empty" };
    if (s === ".") return { state: "partial" };
    if (/^\d{1,3}(,\d{3})+(\.\d*)?$/.test(s)) s = s.replace(/,/g, "");
    if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return { state: "invalid" };
    return { state: "ok", value: parseFloat(s) };
  }

  const el = id => document.getElementById(id);
  const rows = {};
  for (const v of ["a", "b"]) {
    const row = document.querySelector('.row[data-var="' + v + '"]');
    rows[v] = { row, input: row.querySelector("input"), err: row.querySelector(".err"), suffix: row.querySelector(".suffix") };
  }
  const isRate = el("is-rate");
  const steps = [1, 2, 3, 4, 5, 6].map(n => ({ li: el("step-" + n), body: el("body-" + n) }));
  const answer = el("answer");
  const say = el("say");
  const mix = el("mix");

  const span = (cls, text) => '<span class="' + cls + '">' + text + "</span>";
  const frac = (top, bot) => '<span class="frac"><span class="frac-top">' + top +
    '</span><span class="sr"> divided by </span><span class="frac-bot">' + bot + "</span></span>";
  const eq = html => '<p class="eq">' + html + "</p>";
  const p = (html, cls) => '<p class="' + (cls || "say") + '">' + html + "</p>";

  const FORMULA = "Percent difference = " +
    frac("|" + span("c-a", "A") + " − " + span("c-b", "B") + "|", frac(span("c-a", "A") + " + " + span("c-b", "B"), "2")) + " × 100";

  function render() {
    const rate = isRate.checked;
    const unit = rate ? "%" : "";
    const known = {};
    let invalid = false;
    let partial = false;
    for (const v of ["a", "b"]) {
      const r = rows[v];
      const q = parse(r.input.value);
      const bad = q.state === "invalid";
      r.err.hidden = !bad;
      r.row.classList.toggle("has-error", bad);
      r.input.setAttribute("aria-invalid", bad ? "true" : "false");
      r.suffix.hidden = !rate;
      if (bad) invalid = true;
      if (q.state === "partial") partial = true;
      if (q.state === "ok") known[v] = q.value;
    }

    steps[0].body.innerHTML = eq(FORMULA) +
      p("The bars mean “distance between,” so the order of A and B does not matter. The bottom is the average of the two values, so neither value is treated as the starting point.");
    const ready = !invalid && !partial && "a" in known && "b" in known;
    if (!ready) {
      steps[0].body.innerHTML += p(invalid ? "Fix the entry above to continue." :
        Object.keys(known).length === 1 ? "Enter one more value to fill in the formula." : "Enter both values to fill in the formula.");
      for (const s of steps.slice(1)) { s.li.classList.add("idle"); s.body.innerHTML = ""; }
      answer.classList.add("is-empty");
      answer.innerHTML = '<p class="answer-empty">Enter both values to see the answer.</p>';
      say.innerHTML = '<p class="answer-empty">Enter both values to see how to phrase the result.</p>';
      mix.innerHTML = '<p class="answer-empty">Enter both values to see the common mix-ups for your numbers.</p>';
      return;
    }

    const a = known.a;
    const b = known.b;
    const A = span("c-a", fmt(a) + unit);
    const B = span("c-b", fmt(b) + unit);
    const dist = Math.abs(a - b);
    const avg = (a + b) / 2;
    const pts = n => fmt(n) + " percentage " + (n === 1 ? "point" : "points");
    const DIST = rate ? pts(dist) : fmt(dist);
    for (const s of steps.slice(1)) s.li.classList.remove("idle");
    steps[1].body.innerHTML = eq("Percent difference = " + frac("|" + A + " − " + B + "|", frac(A + " + " + B, "2")) + " × 100");
    steps[2].body.innerHTML = eq("|" + A + " − " + B + "| = " + DIST) +
      p("The distance is always 0 or more." + (rate && dist !== 0 ? " The distance between two percentages is measured in percentage points, not percent." : ""));
    steps[3].body.innerHTML = eq(frac(A + " + " + B, "2") + " = " + fmt(avg) + unit);

    if (avg === 0) {
      steps[4].body.innerHTML = p("Both values are 0, so the average is 0, and division by 0 has no answer.", "say warn");
      steps[5].li.classList.add("idle");
      steps[5].body.innerHTML = "";
      answer.classList.add("is-empty");
      answer.innerHTML = '<p class="answer-empty">Enter at least one value greater than 0 to see the answer.</p>';
      say.innerHTML = p("Both values are 0, so there is no difference to describe.");
      mix.innerHTML = '<p class="answer-empty">Enter at least one value greater than 0.</p>';
      return;
    }

    const ratio = dist / avg;
    const pct = ratio * 100;
    const P = fmt(pct) + "%";
    steps[4].body.innerHTML = eq(frac(rate ? fmt(dist) : DIST, fmt(avg)) + " = " + fmt(ratio)) +
      (rate ? p("Points divided by the average rate gives a ratio with no unit, so the % signs drop out here.") : "");
    steps[5].body.innerHTML = eq(fmt(ratio) + " × 100 = " + span("c-p", P));

    answer.classList.remove("is-empty");
    answer.innerHTML = '<p class="answer-label">Percent difference</p><p class="answer-big">' + span("c-p", P) + "</p>";

    const thing = rate ? "rates" : "values";
    if (dist === 0) {
      say.innerHTML = '<p class="quote">The two ' + thing + " are the same, " + A + ". There is no difference.</p>";
      mix.innerHTML = p("With no difference, there is nothing to mix up: the percent difference is 0%" + (rate ? " and the distance is 0 percentage points." : "."));
      return;
    }
    let s = "";
    if (rate) {
      s = p("For two percentages, report the distance in percentage points first, then the relative difference, and name the method:") +
        '<p class="quote">The rates differ by ' + pts(dist) + " (" + A + " and " + B + ").</p>" +
        '<p class="quote">The percent difference between the rates is ' + span("c-p", P) + ", relative to their average of " + fmt(avg) + "%.</p>";
    } else {
      s = '<p class="quote">' + A + " and " + B + " differ by " + span("c-p", P) + " (percent difference, relative to their average of " + fmt(avg) + ").</p>" +
        p("Name the method. Most readers assume a percent is a percent change from a starting value, so “percent difference” and “relative to their average” tell them it is not.");
    }
    say.innerHTML = s;

    const hi = Math.max(a, b);
    const lo = Math.min(a, b);
    const HI = a >= b ? A : B;
    const LO = a >= b ? B : A;
    const items = [];
    if (lo > 0) {
      const up = (hi - lo) / lo * 100;
      const down = (hi - lo) / hi * 100;
      items.push("<strong>Percent difference versus percent change.</strong> Percent change depends on which value is the starting point: from " +
        LO + " to " + HI + " is a " + fmt(up) + "% increase, and from " + HI + " to " + LO + " is a " + fmt(down) +
        "% decrease. Percent difference gives " + P + " in either order, because it divides by the average.");
      items.push("<strong>“Higher than” is a percent change claim.</strong> Do not say " + HI + " is " + P + " higher than " + LO +
        ". Measured from " + LO + ", it is " + fmt(up) + "% higher. If one value is the starting point, use the <a href=\"../percent-change-calculator/\">Percent Change Calculator</a>.");
    } else {
      items.push("<strong>Percent difference versus percent change.</strong> Percent change from 0 has no answer, because it divides by the starting value. Percent difference still works here because it divides by the average, " +
        fmt(avg) + unit + ". When one value is 0, the percent difference is always 200%.");
    }
    if (rate) {
      items.unshift("<strong>Percentage points versus percent.</strong> The rates are " + pts(dist) + " apart. Saying they differ by “" +
        fmt(dist) + "%” mixes the subtraction with the relative measure. The relative measure here is " + P + ".");
    }
    mix.innerHTML = '<ul class="mixups">' + items.map(i => "<li>" + i + "</li>").join("") + "</ul>";
  }

  for (const v of ["a", "b"]) rows[v].input.addEventListener("input", render);
  isRate.addEventListener("change", render);
  el("clear-all").addEventListener("click", () => {
    for (const v of ["a", "b"]) rows[v].input.value = "";
    render();
    rows.a.input.focus();
  });
  for (const v of ["a", "b"]) rows[v].input.value = "";
  render();
})();
