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

// Number formatting
const NUMBER_FORMATS = {};
function fmt(x, decimals) {
  const f = NUMBER_FORMATS[decimals] || (NUMBER_FORMATS[decimals] =
    new Intl.NumberFormat('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }));
  return f.format(x).replace('-', '−');
}
// Whole seconds as hours:minutes:seconds.
function fmtClock(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const CHUNK = 10000;           // decimal places per block of text in the digits window
  const absNow = () => performance.timeOrigin + performance.now();
  const startAbs = absNow();
  let N = 0;                     // decimal places calculated
  let pending = '';              // digits received but not yet shown in the window
  let dirty = false;

  // ---------- Calculation: a background worker, or this thread if workers are unavailable ----------
  function startEngine(onBatch, onError) {
    let received = false;
    function onThisThread() {
      const run = createSpigot();
      const tick = () => {
        let b;
        try { b = run(12); } catch (e) { onError(String((e && e.message) || e)); return; }
        onBatch(b);
        setTimeout(tick, 0);
      };
      setTimeout(tick, 0);
    }
    try {
      const w = new Worker('worker.js');
      w.onmessage = (e) => {
        received = true;
        if (e.data && e.data.error) onError(e.data.error); else onBatch(e.data);
      };
      w.onerror = (e) => {
        if (e && e.preventDefault) e.preventDefault();
        w.terminate();
        if (!received) onThisThread();
        else onError('The background calculation stopped unexpectedly.');
      };
    } catch (e) {
      onThisThread();
    }
  }

  startEngine(function (b) {
    if (b.d.length) { N += b.d.length; pending += b.d; dirty = true; }
  }, function (message) {
    $('stopped').textContent = 'The calculation stopped: ' + message;
    $('stopped').hidden = false;
  });

  // ---------- Digits window ----------
  const win = $('win');
  let chunk = win.firstElementChild;
  let textNode = document.createTextNode('');
  chunk.appendChild(textNode);
  let inChunk = 0;               // decimal places in the current block
  let follow = true;             // keep the newest digits in view unless the reader scrolls up
  win.addEventListener('scroll', () => {
    follow = win.scrollTop + win.clientHeight >= win.scrollHeight - 8;
  }, { passive: true });

  function flushDigits() {
    if (!pending) return;
    let buf = '';
    for (let i = 0; i < pending.length; i++) {
      if (inChunk === CHUNK) {
        if (buf) { textNode.appendData(buf); buf = ''; }
        chunk = document.createElement('div');
        chunk.className = 'chunk';
        textNode = document.createTextNode('');
        chunk.appendChild(textNode);
        win.appendChild(chunk);
        inChunk = 0;
      }
      if (inChunk > 0 && inChunk % 10 === 0) buf += ' ';
      buf += pending[i];
      inChunk++;
    }
    if (buf) textNode.appendData(buf);
    pending = '';
    if (follow) win.scrollTop = win.scrollHeight;
  }

  function render() {
    $('mT').textContent = fmtClock(Math.floor((absNow() - startAbs) / 1000));
    if (!dirty) return;
    dirty = false;
    flushDigits();
    $('mN').textContent = fmt(N, 0);
  }

  render();
  setInterval(render, 250);
})();
