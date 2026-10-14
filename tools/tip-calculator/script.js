"use strict";
(() => {
  const money = x => "$" + x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const cents = x => Math.round(x * 100) / 100;
  const num = x => x.toLocaleString("en-US", { maximumFractionDigits: 4 });
  function parse(raw, whole) {
    let s = String(raw).trim().replace(/^\$/, "").replace(/%$/, "").trim();
    if (s === "") return { state: "empty" };
    if (s === ".") return { state: "partial" };
    if (/^\d{1,3}(,\d{3})+(\.\d*)?$/.test(s)) s = s.replace(/,/g, "");
    const re = whole ? /^\d+$/ : /^(\d+\.?\d*|\.\d+)$/;
    if (!re.test(s)) return { state: "invalid" };
    return { state: "ok", value: parseFloat(s) };
  }

  const el = id => document.getElementById(id);
  const bill = el("in-bill");
  const pctIn = el("in-pct");
  const people = el("in-people");
  const picks = [...document.querySelectorAll(".pick")];
  const steps = [1, 2, 3, 4, 5].map(n => ({ li: el("step-" + n), body: el("body-" + n) }));
  const answer = el("answer");
  const head = el("head");
  let quick = 20;

  const span = (cls, text) => '<span class="' + cls + '">' + text + "</span>";
  const frac = (top, bot) => '<span class="frac"><span class="frac-top">' + top +
    '</span><span class="sr"> divided by </span><span class="frac-bot">' + bot + "</span></span>";
  const eq = html => '<p class="eq">' + html + "</p>";
  const p = (html, cls) => '<p class="' + (cls || "say") + '">' + html + "</p>";
  function flag(input, errId, rowId, bad) {
    el(errId).hidden = !bad;
    el(rowId).classList.toggle("has-error", bad);
    input.setAttribute("aria-invalid", bad ? "true" : "false");
  }

  function render() {
    const b = parse(bill.value, false);
    const c = parse(pctIn.value, false);
    const n = parse(people.value, true);
    flag(bill, "err-bill", "row-bill", b.state === "invalid");
    flag(pctIn, "err-pct", "row-pct", c.state === "invalid");
    const badPeople = n.state === "invalid" || (n.state === "ok" && n.value < 1);
    flag(people, "err-people", "row-people", badPeople);
    for (const btn of picks) btn.setAttribute("aria-pressed", c.state === "empty" && Number(btn.dataset.pct) === quick ? "true" : "false");

    const pct = c.state === "ok" ? c.value : c.state === "empty" ? quick : null;
    const split = n.state === "ok" && n.value >= 1 ? n.value : n.state === "empty" ? 1 : null;
    steps[0].body.innerHTML = eq(span("c-t", "Tip") + " = " + span("c-b", "Bill") + " × " + frac("Tip percent", "100")) +
      p("Dividing the percent by 100 turns it into a decimal: 20% becomes 0.20.");
    const ready = b.state === "ok" && pct !== null && split !== null && c.state !== "partial";
    if (!ready) {
      steps[0].body.innerHTML += p(b.state === "invalid" || c.state === "invalid" || badPeople ? "Fix the entry above to continue." : "Enter the bill to fill in the formula.");
      for (const s of steps.slice(1)) { s.li.classList.add("idle"); s.body.innerHTML = ""; }
      answer.classList.add("is-empty");
      answer.innerHTML = '<p class="answer-empty">Enter the bill to see the answer.</p>';
      head.innerHTML = '<p class="answer-empty">Enter the bill to see the shortcut for your numbers.</p>';
      return;
    }

    const B = span("c-b", money(b.value));
    const tip = cents(b.value * pct / 100);
    const total = cents(b.value + tip);
    for (const s of steps.slice(1, 4)) s.li.classList.remove("idle");
    steps[1].body.innerHTML = eq(span("c-t", "Tip") + " = " + B + " × " + frac(num(pct), "100"));
    steps[2].body.innerHTML = eq(B + " × " + num(pct / 100) + " = " + span("c-t", money(tip)));
    steps[3].body.innerHTML = eq(B + " + " + span("c-t", money(tip)) + " = " + span("c-p", money(total)));

    let per = null;
    if (split > 1) {
      per = cents(total / split);
      steps[4].li.classList.remove("idle");
      const gap = cents(total - per * split);
      steps[4].body.innerHTML = eq(frac(span("c-p", money(total)), num(split) + " people") + " = " + money(per) + " each") +
        (gap !== 0 ? p("Rounded to the cent, " + num(split) + " shares of " + money(per) + " come to " + money(cents(per * split)) +
          ", which is " + money(Math.abs(gap)) + (gap > 0 ? " short of" : " over") + " the total. One person covers the difference.") : "");
    } else {
      steps[4].li.classList.add("idle");
      steps[4].body.innerHTML = p("One person pays the whole total. Enter more than 1 person to split it.");
    }

    answer.classList.remove("is-empty");
    answer.innerHTML = '<p class="answer-label">Tip at ' + num(pct) + '%</p><p class="answer-big">' + span("c-t", money(tip)) + "</p>" +
      '<p class="answer-label" style="margin-top: 8px">Total</p><p class="answer-big">' + span("c-p", money(total)) + "</p>" +
      (per !== null ? '<p class="answer-label" style="margin-top: 8px">Each of ' + num(split) + ' people</p><p class="answer-big">' + money(per) + "</p>" : "");

    // Exact amounts for the shortcuts, so each line adds up as written.
    const exact = x => "$" + (Math.round(x * 10000) / 10000).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
    const result = x => exact(x) + (cents(x) !== Math.round(x * 10000) / 10000 ? ", or " + money(cents(x)) + " rounded to the cent" : "");
    const ten = b.value / 10;
    const T = exact(ten);
    const items = ["<strong>10%:</strong> move the decimal point one place left. " + B + " becomes " + T + "."];
    items.push("<strong>20%:</strong> double the 10%. " + T + " × 2 = " + result(ten * 2) + ".");
    items.push("<strong>15%:</strong> take the 10%, then add half of it. " + T + " + " + exact(ten / 2) + " = " + result(ten * 1.5) + ".");
    head.innerHTML = '<ul class="mixups">' + items.map(i => "<li>" + i + "</li>").join("") + "</ul>" +
      p("Every shortcut starts from the 10%, so find that first.");
  }

  for (const btn of picks) btn.addEventListener("click", () => {
    quick = Number(btn.dataset.pct);
    pctIn.value = "";
    render();
  });
  for (const i of [bill, pctIn, people]) i.addEventListener("input", render);
  el("clear-all").addEventListener("click", () => {
    bill.value = ""; pctIn.value = ""; people.value = "1"; quick = 20;
    render();
    bill.focus();
  });
  bill.value = ""; pctIn.value = ""; people.value = "1";
  render();
})();
