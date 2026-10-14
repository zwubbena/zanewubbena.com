"use strict";
(() => {
  const SUP = { "-": "⁻", "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹" };
  // Round to 6 significant figures for display; whole-number digits are never dropped.
  function fmt(x) {
    if (x === 0) return "0";
    const ax = Math.abs(x);
    if (ax >= 1e15 || ax < 1e-6) {
      const [mant, exp] = x.toExponential(5).split("e");
      return mant.replace(/0+$/, "").replace(/\.$/, "") + " × 10" + String(Number(exp)).replace(/[-0-9]/g, c => SUP[c]);
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
  for (const v of ["o", "n"]) {
    const row = document.querySelector('.row[data-var="' + v + '"]');
    rows[v] = { row, input: row.querySelector("input"), err: row.querySelector(".err"), suffix: row.querySelector(".suffix") };
  }
  const isRate = el("is-rate");
  const steps = [1, 2, 3, 4, 5].map(n => ({ li: el("step-" + n), body: el("body-" + n) }));
  const answer = el("answer");
  const say = el("say");
  const mix = el("mix");

  const span = (cls, text) => '<span class="' + cls + '">' + text + "</span>";
  const frac = (top, bot) => '<span class="frac"><span class="frac-top">' + top +
    '</span><span class="sr"> divided by </span><span class="frac-bot">' + bot + "</span></span>";
  const eq = html => '<p class="eq">' + html + "</p>";
  const p = (html, cls) => '<p class="' + (cls || "say") + '">' + html + "</p>";

  const FORMULA = "Percent change = " +
    frac(span("c-n", "New") + " − " + span("c-o", "Original"), span("c-o", "Original")) + " × 100";

  function render() {
    const rate = isRate.checked;
    const unit = rate ? "%" : "";
    const known = {};
    let invalid = false;
    let partial = false;
    for (const v of ["o", "n"]) {
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
      p("This one formula covers increases and decreases. Some books write a decrease as " +
        frac(span("c-o", "Original") + " − " + span("c-n", "New"), span("c-o", "Original")) +
        " × 100 so the answer comes out positive. It is the same formula with the subtraction flipped, and the word “decrease” carries the direction instead of the minus sign.");
    const ready = !invalid && !partial && "o" in known && "n" in known;
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

    const o = known.o;
    const n = known.n;
    const O = span("c-o", fmt(o) + unit);
    const N = span("c-n", fmt(n) + unit);
    const diff = n - o;
    const D = rate ? fmt(diff) + " percentage " + (Math.abs(diff) === 1 ? "point" : "points") : fmt(diff);
    const thing = rate ? "rate" : "value";
    for (const s of steps.slice(1)) s.li.classList.remove("idle");
    steps[0].body.innerHTML += p("The original value is the base, so it goes on the bottom.");
    steps[1].body.innerHTML = eq("Percent change = " + frac(N + " − " + O, O) + " × 100");
    steps[2].body.innerHTML = eq(N + " − " + O + " = " + D) +
      p((diff > 0 ? "The " + thing + " went up, so the change is positive." : diff < 0 ? "The " + thing + " went down, so the change is negative." : "The " + thing + " did not change.") +
        (rate && diff !== 0 ? " The difference between two percentages is measured in percentage points, not percent." : ""));

    if (o === 0) {
      steps[3].body.innerHTML = p("The original value is 0, and division by 0 has no answer. Percent change needs a starting value greater than 0.", "say warn");
      steps[4].li.classList.add("idle");
      steps[4].body.innerHTML = "";
      answer.classList.add("is-empty");
      answer.innerHTML = '<p class="answer-empty">Enter an original value greater than 0 to see the answer.</p>';
      say.innerHTML = p("A change from 0 has no percent change. Describe it as the change itself: the value went from " + O + " to " + N + ".");
      mix.innerHTML = '<p class="answer-empty">Enter an original value greater than 0.</p>';
      return;
    }

    const ratio = diff / o;
    const pct = ratio * 100;
    const P = fmt(Math.abs(pct)) + "%";
    steps[3].body.innerHTML = eq(frac(rate ? fmt(diff) : D, rate ? span("c-o", fmt(o)) : O) + " = " + fmt(ratio).replace("-", "−")) +
      (rate ? p("Points divided by the original rate gives a ratio with no unit, so the % signs drop out here.") : "");
    steps[4].body.innerHTML = eq(fmt(ratio).replace("-", "−") + " × 100 = " + span("c-p", fmt(pct).replace("-", "−") + "%"));

    const dir = diff > 0 ? "increase" : diff < 0 ? "decrease" : "no change";
    answer.classList.remove("is-empty");
    answer.innerHTML = '<p class="answer-label">Percent change</p>' +
      '<p class="answer-big">' + span("c-p", (pct > 0 ? "+" : "") + fmt(pct).replace("-", "−") + "%") + " (" + dir + ")</p>";

    const verb = diff > 0 ? "increased" : "decreased";
    let s = "";
    if (diff === 0) {
      s = '<p class="quote">The ' + thing + " did not change. It stayed at " + O + ".</p>";
    } else if (rate) {
      const pts = fmt(Math.abs(diff));
      s = p("For two percentages, report the change both ways, and name the unit each time:") +
        '<p class="quote">The rate ' + verb + " by " + pts + (Math.abs(diff) === 1 ? " percentage point" : " percentage points") +
        ", from " + O + " to " + N + ".</p>" +
        '<p class="quote">That is a ' + span("c-p", P) + " " + dir + " in the rate.</p>" +
        p("Use “percentage points” for the subtraction (" + N + " − " + O + ") and “percent” for the relative change (step 5).");
    } else {
      s = '<p class="quote">The value ' + verb + " by " + span("c-p", P) + ", from " + O + " to " + N + ".</p>" +
        p("Name both the starting value and the ending value, so the reader knows what the percent is relative to.");
    }
    say.innerHTML = s;

    if (diff === 0) {
      mix.innerHTML = p("With no change, there is nothing to mix up: the percent change is 0%" + (rate ? " and the difference is 0 percentage points." : "."));
      return;
    }
    const items = [];
    if (rate) {
      const wrong = o * (1 + diff / 100);
      items.push("<strong>Percentage points versus percent.</strong> The rates differ by " + fmt(Math.abs(diff)) +
        " percentage points. Saying the rate “" + verb + " by " + fmt(Math.abs(diff)) + "%” would mean " +
        O + " × (1 " + (diff > 0 ? "+" : "−") + " " + fmt(Math.abs(diff)) + "/100) = " + fmt(wrong) + "%, not " + N + ".");
    }
    const of = n / o * 100;
    items.push("<strong>“" + (diff > 0 ? "Increased by" : "Decreased by") + "” versus “of.”</strong> " + N + " is " + fmt(of) + "% of " + O +
      ", which is " + P + (diff > 0 ? " more" : " less") + " than " + O + "." +
      (diff > 0 ? " Saying it “increased by " + fmt(of) + "%” would mean " + fmt(o * (1 + of / 100)) + unit + "." : ""));
    if (n > 0) {
      const back = (o - n) / n * 100;
      items.push("<strong>Going back is not the same percent.</strong> Returning from " + N + " to " + O + " is a " +
        fmt(Math.abs(back)) + "% " + (back > 0 ? "increase" : "decrease") + ", not " + P + ", because the base is now " + N + ".");
    }
    mix.innerHTML = '<ul class="mixups">' + items.map(i => "<li>" + i + "</li>").join("") + "</ul>";
  }

  for (const v of ["o", "n"]) rows[v].input.addEventListener("input", render);
  isRate.addEventListener("change", render);
  el("clear-all").addEventListener("click", () => {
    for (const v of ["o", "n"]) rows[v].input.value = "";
    render();
    rows.o.input.focus();
  });
  for (const v of ["o", "n"]) rows[v].input.value = "";
  render();
})();
