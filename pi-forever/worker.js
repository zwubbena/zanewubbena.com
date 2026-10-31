// ---------- Pure logic shared by the page, the background worker, and the tests ----------

// Milestones run 1,000; 2,500; 5,000; 10,000; 25,000; 50,000; 100,000; and so on.
function nextMilestone(x) {
  let base = 1000;
  for (;;) {
    for (const f of [1, 2.5, 5]) {
      const v = f * base;
      if (v > x) return v;
    }
    base *= 10;
  }
}

// Jeremy Gibbons's unbounded spigot (American Mathematical Monthly, 2006).
// State: the transformation x -> (q*x + r) / t, where x, the part of the series
// not yet taken in, always lies between 3 and 4. A digit is known once
// (3q + r) / t and (4q + r) / t share the same whole-number part.
// Each call to run() works for about budgetMs milliseconds and returns the new
// decimal places as a string, the time the batch ended, and any milestones
// reached in the batch with the time each was reached.
function createSpigot() {
  let q = 1n, r = 0n, t = 1n;
  let j = 0;        // index of the last series term taken in
  let log2t = 0;    // running estimate of log2(t), used to read the leading bits
  let count = -1;   // -1 until the 3 before the decimal point has been skipped
  let next = nextMilestone(0);
  const absNow = () => performance.timeOrigin + performance.now();

  // Take in the next several terms at once. Term j is x -> (j*x + 4j + 2) / (2j + 1).
  // The combined block [A B; 0 C] stays below 2^60 so each multiply uses one machine word.
  function absorb() {
    let A = 1n, B = 0n, C = 1n, c = 1;
    do {
      j++;
      const J = BigInt(j), L = BigInt(2 * j + 1);
      B = A * (4n * J + 2n) + B * L;
      A *= J;
      C *= L;
      c *= 2 * j + 1;
    } while (c * (2 * j + 3) * 4 < 2 ** 60);
    r = q * B + r * C;
    q *= A;
    t *= C;
    log2t += Math.log2(c);
  }

  // The next digit if it is known, otherwise -1. Reads the leading bits in floating
  // point and divides exactly only when a value sits near a whole-number boundary.
  function knownDigit() {
    if (q >= t) return -1; // the interval is at least 1 wide
    const sh = log2t > 72 ? BigInt(Math.floor(log2t) - 70) : 0n;
    const Q = Number(q >> sh), R = Number(r >> sh), T = Number(t >> sh);
    const lo = (3 * Q + R) / T, hi = (4 * Q + R) / T;
    const d = Math.floor(lo);
    const nearEdge = lo - d < 1e-9 || d + 1 - lo < 1e-9 || Math.abs(hi - Math.round(hi)) < 1e-9;
    if (!nearEdge) return hi < d + 1 ? d : -1;
    const a = 3n * q + r;   // never negative, so BigInt division here is the floor
    const D = a / t;
    return a + q < (D + 1n) * t ? Number(D) : -1;
  }

  return function run(budgetMs) {
    const stop = performance.now() + budgetMs;
    let digits = '';
    const marks = [];
    do {
      const d = knownDigit();
      if (d < 0) { absorb(); continue; }
      r = 10n * (r - BigInt(d) * t);
      q *= 10n;
      if (count < 0) {
        count = 0;
      } else {
        digits += d;
        count++;
        if (count === next) {
          marks.push([count, absNow()]);
          next = nextMilestone(count);
        }
      }
    } while (performance.now() < stop);
    // k: series terms used so far; bits: estimate of log2(t), the size of the denominator
    return { d: digits, t: absNow(), m: marks, k: j, bits: log2t };
  };
}

// Runs inside the background worker: calculates without stopping and posts each batch.
function workerMain() {
  const run = createSpigot();
  function tick() {
    let batch;
    try {
      batch = run(60);
    } catch (err) {
      self.postMessage({ error: String((err && err.message) || err) });
      return;
    }
    self.postMessage(batch);
    setTimeout(tick, 0);
  }
  setTimeout(tick, 0);
}

// Running counts, sums, and the longest run of one repeated digit.
function createTally() {
  const counts = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  let n = 0, sum = 0, sumSq = 0;
  let runDigit = -1, runLen = 0, runStart = 0;
  let bestLen = 0, bestDigit = -1, bestStart = 0;
  return {
    add(s) {
      for (let i = 0; i < s.length; i++) {
        const d = s.charCodeAt(i) - 48;
        n++;
        counts[d]++;
        sum += d;
        sumSq += d * d;
        if (d === runDigit) runLen++;
        else { runDigit = d; runLen = 1; runStart = n; }
        if (runLen > bestLen) { bestLen = runLen; bestDigit = d; bestStart = runStart; }
      }
    },
    snapshot() {
      const expected = n / 10;
      const parts = counts.map(c => (n ? (c - expected) * (c - expected) / expected : 0));
      let chi = 0;
      for (const p of parts) chi += p;
      return {
        n, counts: counts.slice(), sum, sumSq, expected, parts, chi,
        p: n ? chiSquareP(chi, 9) : 1,
        bestLen, bestDigit, bestStart
      };
    }
  };
}

// Natural log of the gamma function (Lanczos approximation, g = 7).
function lnGamma(z) {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  z -= 1;
  let x = c[0];
  for (let i = 1; i < 9; i++) x += c[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

// Upper regularized incomplete gamma function Q(a, x): series below a + 1, continued fraction above.
function gammaQ(a, x) {
  if (x <= 0) return 1;
  const lead = Math.exp(-x + a * Math.log(x) - lnGamma(a));
  if (x < a + 1) {
    let ap = a, del = 1 / a, s = del;
    for (let i = 0; i < 1000; i++) {
      ap += 1;
      del *= x / ap;
      s += del;
      if (Math.abs(del) < Math.abs(s) * 1e-15) break;
    }
    return Math.max(0, 1 - s * lead);
  }
  const tiny = 1e-300;
  let b = x + 1 - a, c = 1 / tiny, d = 1 / b, h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c; if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return lead * h;
}

// Probability of a chi-squared value at least x with df degrees of freedom.
function chiSquareP(x, df) {
  return gammaQ(df / 2, x / 2);
}

// ---------- Number formatting ----------
const NUMBER_FORMATS = {};
function fmt(x, decimals) {
  const f = NUMBER_FORMATS[decimals] || (NUMBER_FORMATS[decimals] =
    new Intl.NumberFormat('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }));
  return f.format(x).replace('-', '−');
}
function parseNum(str) {
  return Number(str.replace(/,/g, '').replace('−', '-'));
}
function fmtSigned(x, decimals) {
  const s = fmt(Math.abs(x), decimals);
  if (parseNum(s) === 0) return s;
  return (x > 0 ? '+' : '−') + s;
}
// Seconds: three decimals under 10 seconds, two under 100, then one.
function fmtSec(sec) {
  return fmt(sec, sec < 10 ? 3 : sec < 100 ? 2 : 1);
}
// Whole seconds as hours:minutes:seconds.
function fmtClock(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

workerMain();
