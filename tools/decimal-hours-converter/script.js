"use strict";
(() => {
  const el = id => document.getElementById(id);
  const inH = el("in-h"), inM = el("in-m"), inD = el("in-d");
  const steps = [1, 2, 3, 4].map(n => ({ li: el("step-" + n), body: el("body-" + n), h: el("h-" + n) }));
  const answer = el("answer"), mix = el("mix");
  let side = null; // "hm" or "dec": the side the person typed in

  const span = (cls, text) => '<span class="' + cls + '">' + text + "</span>";
  const frac = (top, bot) => '<span class="frac"><span class="frac-top">' + top +
    '</span><span class="sr"> divided by </span><span class="frac-bot">' + bot + "</span></span>";
  const eq = html => '<p class="eq">' + html + "</p>";
  const p = (html, cls) => '<p class="' + (cls || "say") + '">' + html + "</p>";
  const d4 = x => (Math.round(x * 10000) / 10000).toLocaleString("en-US", { maximumFractionDigits: 4 });
  const exactly = x => Math.abs(Math.round(x * 10000) / 10000 - x) < 1e-12;
  const plural = (n, one, many) => n + " " + (n === 1 ? one : many);
  const gcd = (a, b) => b ? gcd(b, a % b) : a;
  function fracText(min) {
    if (!Number.isInteger(min)) return null;
    const g = gcd(min, 60);
    return (min / g) + "/" + (60 / g);
  }
  // Minutes as words, with seconds when the minutes are not whole.
  function minWords(m) {
    const totalSec = Math.round(m * 60);
    const mm = Math.floor(totalSec / 60), ss = totalSec % 60;
    return plural(mm, "minute", "minutes") + (ss ? " " + plural(ss, "second", "seconds") : "");
  }
  function hmWords(h, m) {
    if (h === 0) return minWords(m);
    if (Math.round(m * 60) === 0) return plural(h, "hour", "hours");
    return plural(h, "hour", "hours") + " " + minWords(m);
  }
  function parse(raw, whole) {
    const s = String(raw).trim();
    if (s === "") return { state: "empty" };
    if (s === ".") return { state: "partial" };
    const re = whole ? /^\d+$/ : /^(\d+\.?\d*|\.\d+)$/;
    if (!re.test(s)) return { state: "invalid" };
    return { state: "ok", value: parseFloat(s) };
  }

  function setAnswerSide(ans) {
    el("row-hm").classList.toggle("is-answer", ans === "hm");
    el("row-dec").classList.toggle("is-answer", ans === "dec");
    el("tag-hm").hidden = ans !== "hm";
    el("tag-dec").hidden = ans !== "dec";
  }

  function mixups(h, m, dec) {
    const items = [];
    if (dec !== null) {
      // Read the decimal digits as if they were minutes after a colon.
      const parts = String(Math.round(dec * 100) / 100).split(".");
      const wh = Math.floor(dec);
      const two = parts[1] ? (parts[1] + "0").slice(0, 2) : "00";
      const wrongMin = +two;
      if (wrongMin < 60 && Math.abs(wrongMin / 60 - (dec - wh)) > 1e-9 && exactly(dec * 100 / 100)) {
        items.push("<strong>A decimal point is not a colon.</strong> " + span("c-dec", d4(dec) + " hours") + " is " + span("c-hm", hmWords(h, m)) +
          ", not " + wh + ":" + two + ". In decimal hours, the digits after the point are parts of an hour, not minutes.");
      }
    }
    if (items.length === 0) items.push("<strong>1.30 hours is not 1 hour 30 minutes.</strong> 1.30 hours is 1 hour 18 minutes (0.3 × 60 = 18). One hour 30 minutes is 1.5 hours (30 ÷ 60 = 0.5).");
    items.push("<strong>Some minutes never end as decimals.</strong> 20 minutes is 0.3333… hours, which repeats forever. Rounded to two places it is 0.33 hours, which is 19.8 minutes, so a rounded decimal can be a few seconds off.");
    return '<ul class="mixups">' + items.map(i => "<li>" + i + "</li>").join("") + "</ul>";
  }

  function render() {
    const ph = parse(inH.value, true), pm = parse(inM.value, false), pd = parse(inD.value, false);
    const badHM = side === "hm" && (ph.state === "invalid" || pm.state === "invalid");
    const badD = side === "dec" && pd.state === "invalid";
    el("err-hm").hidden = !badHM; el("row-hm").classList.toggle("has-error", badHM);
    el("err-dec").hidden = !badD; el("row-dec").classList.toggle("has-error", badD);

    const f1 = side === "dec"
      ? eq(span("c-hm", "Hours") + " = the whole-number part") + eq(span("c-hm", "Minutes") + " = the decimal part × 60")
      : eq(span("c-dec", "Decimal hours") + " = " + span("c-hm", "Hours") + " + " + frac(span("c-hm", "Minutes"), "60"));
    steps[0].body.innerHTML = f1 + p(side === "dec" ? "An hour has 60 minutes, so multiplying the part of an hour by 60 turns it into minutes." :
      "An hour has 60 minutes, so dividing the minutes by 60 turns them into a part of an hour.");

    let h = null, m = null, dec = null;
    if (side === "hm" && !badHM && (ph.state === "ok" || pm.state === "ok") && ph.state !== "partial" && pm.state !== "partial") {
      h = ph.state === "ok" ? ph.value : 0;
      m = pm.state === "ok" ? pm.value : 0;
      const carry = Math.floor(m / 60);
      const mRest = m - carry * 60;
      dec = h + m / 60;
      inD.value = d4(dec);
      setAnswerSide("dec");
      steps[1].h.textContent = "Substitute the values";
      steps[1].body.innerHTML = eq(span("c-dec", "Decimal hours") + " = " + span("c-hm", h) + " + " + frac(span("c-hm", d4(m)), "60"));
      steps[2].h.textContent = "Divide the minutes by 60";
      steps[2].body.innerHTML = eq(frac(span("c-hm", d4(m)), "60") + " = " + (exactly(m / 60) ? d4(m / 60) : d4(m / 60) + "…")) +
        (fracText(m) && m < 60 && m > 0 ? p(d4(m) + " minutes is " + fracText(m) + " of an hour.") : "") +
        (carry ? p(d4(m) + " minutes is more than an hour: it is " + plural(carry, "hour", "hours") + " and " + d4(mRest) + " minutes.") : "");
      steps[3].h.textContent = "Add the hours";
      steps[3].body.innerHTML = eq(span("c-hm", h) + " + " + d4(m / 60) + " = " + span("c-p", d4(dec) + " hours"));
      h = h + carry; m = mRest;
    } else if (side === "dec" && !badD && pd.state === "ok") {
      dec = pd.value;
      h = Math.floor(dec);
      const part = dec - h;
      m = part * 60;
      inH.value = String(h);
      inM.value = d4(m);
      setAnswerSide("hm");
      steps[1].h.textContent = "Split the decimal";
      steps[1].body.innerHTML = eq(span("c-dec", d4(dec)) + " = " + span("c-hm", h) + " + " + d4(part)) + p(span("c-hm", h) + " is the whole hours, and " + d4(part) + " is the part of an hour left over.");
      steps[2].h.textContent = "Multiply the part by 60";
      steps[2].body.innerHTML = eq(d4(part) + " × 60 = " + span("c-hm", d4(m) + " minutes")) +
        (!Number.isInteger(Math.round(m * 1e6) / 1e6) ? p(d4(m) + " minutes is " + minWords(m) + ".") : "");
      steps[3].h.textContent = "Combine";
      steps[3].body.innerHTML = eq(span("c-dec", d4(dec) + " hours") + " = " + span("c-p", hmWords(h, m)));
    } else {
      setAnswerSide(null);
      for (const s of steps.slice(1)) { s.li.classList.add("idle"); s.body.innerHTML = ""; }
      steps[0].body.innerHTML += p(badHM || badD ? "Fix the entry above to continue." : "Type in either side to fill in the formula.");
      answer.classList.add("is-empty");
      answer.innerHTML = '<p class="answer-empty">Enter a time to see the answer.</p>';
      mix.innerHTML = mixups(null, null, null);
      paintRef(null);
      return;
    }
    for (const s of steps.slice(1)) s.li.classList.remove("idle");
    answer.classList.remove("is-empty");
    answer.innerHTML = '<p class="answer-big">' + span("c-hm", hmWords(h, m)) + " = " + span("c-dec", d4(dec) + " hours") + "</p>" +
      p("Written as a clock time, that is " + h + ":" + String(Math.floor(Math.round(m * 60) / 60)).padStart(2, "0") +
        (Math.round(m * 60) % 60 ? ":" + String(Math.round(m * 60) % 60).padStart(2, "0") : "") + ".");
    mix.innerHTML = mixups(h, m, dec);
    paintRef(m);
  }

  const REF = [6, 12, 15, 18, 20, 24, 30, 36, 40, 42, 45, 48, 54, 60];
  function paintRef(m) {
    el("ref").innerHTML = REF.map(x => "<tr" + (m !== null && Math.abs(m - x) < 1e-9 ? ' class="hit"' : "") + "><td>" + x + "</td><td>" + fracText(x) +
      "</td><td>" + d4(x / 60) + (exactly(x / 60) ? "" : "…") + "</td></tr>").join("");
  }

  inH.addEventListener("input", () => { side = "hm"; render(); });
  inM.addEventListener("input", () => { side = "hm"; render(); });
  inD.addEventListener("input", () => { side = "dec"; render(); });
  el("clear-all").addEventListener("click", () => { inH.value = ""; inM.value = ""; inD.value = ""; side = null; render(); inH.focus(); });
  inH.value = ""; inM.value = ""; inD.value = "";
  render();
})();
