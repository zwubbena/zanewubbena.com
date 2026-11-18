(function () {
  "use strict";

  // Audio settings: the defaults in sound_therapy.ipynb.
  var SAMPLE_RATE = 44100;       // samples per second
  var VOLUME = 0.25;             // peak loudness, 0 to 1
  var FADE_MS = 20;              // linear fade in and out, in milliseconds
  var CHANNELS = 2;              // stereo, with the tone in both ears
  var MAX_FREQ = SAMPLE_RATE / 2;
  var MAX_FILE_BYTES = 0xFFFFFFFF;
  var CHUNK = 1 << 20;           // samples per step while building a file

  // ==== FILE BUILDING ====

  function sampleCount(seconds) {
    return Math.floor(SAMPLE_RATE * seconds);
  }

  // Samples in each fade; 0 (no fade) when the two fades would overlap.
  function fadeLength(n) {
    var k = Math.floor(SAMPLE_RATE * (FADE_MS / 1000));
    return (k === 0 || k * 2 >= n) ? 0 : k;
  }

  function wavSize(n) {
    return 44 + n * CHANNELS * 2;
  }

  function pause() {
    return new Promise(function (resolve) { setTimeout(resolve, 0); });
  }

  function writeAscii(view, offset, text) {
    for (var i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  }

  // Each sample is s[n] = A sin(2 pi f n / Fs). The tone is scaled so the loudest
  // sample equals VOLUME, faded at each end, and stored as 16-bit integers.
  async function buildWav(freq, n, progress) {
    var dataBytes = n * CHANNELS * 2;
    var buffer = new ArrayBuffer(44 + dataBytes);
    var view = new DataView(buffer);
    writeAscii(view, 0, "RIFF");
    view.setUint32(4, 36 + dataBytes, true);
    writeAscii(view, 8, "WAVE");
    writeAscii(view, 12, "fmt ");
    view.setUint32(16, 16, true);                          // format block size
    view.setUint16(20, 1, true);                           // PCM
    view.setUint16(22, CHANNELS, true);
    view.setUint32(24, SAMPLE_RATE, true);
    view.setUint32(28, SAMPLE_RATE * CHANNELS * 2, true);  // bytes per second
    view.setUint16(32, CHANNELS * 2, true);                // bytes per frame
    view.setUint16(34, 16, true);                          // bits per sample
    writeAscii(view, 36, "data");
    view.setUint32(40, dataBytes, true);

    var step = (n / SAMPLE_RATE) / n;   // seconds between samples
    var omega = 2 * Math.PI * freq;
    var start, end, i;

    // First pass: the loudest sample of the plain sine wave.
    var peak = 0;
    for (start = 0; start < n; start = end) {
      end = Math.min(n, start + CHUNK);
      for (i = start; i < end; i++) {
        var size = Math.abs(Math.sin(omega * (i * step)));
        if (size > peak) peak = size;
      }
      progress(end / n / 2);
      await pause();
    }
    var scale = VOLUME / Math.max(peak, 1e-12);

    // Second pass: scale, fade, and store each sample in both channels.
    var k = fadeLength(n);
    var rampStep = k > 1 ? 1 / (k - 1) : 0;
    var fadeOutStart = n - k;
    var samples = new Int16Array(buffer, 44, n * CHANNELS);
    for (start = 0; start < n; start = end) {
      end = Math.min(n, start + CHUNK);
      for (i = start; i < end; i++) {
        var value = Math.sin(omega * (i * step)) * scale;
        if (k > 0) {
          if (i < k) {
            value *= (i === k - 1) ? 1 : i * rampStep;
          } else if (i >= fadeOutStart) {
            var j = i - fadeOutStart;
            value *= (j === k - 1) ? 0 : 1 + j * -rampStep;
          }
        }
        var whole = Math.trunc(Math.fround(Math.fround(value) * 32767));
        samples[2 * i] = whole;
        samples[2 * i + 1] = whole;
      }
      progress(0.5 + end / n / 2);
      await pause();
    }
    return buffer;
  }

  // ==== PAGE ====

  var form = document.getElementById("tone-form");
  var freqInput = document.getElementById("freq");
  var minutesInput = document.getElementById("minutes");
  var playButton = document.getElementById("play");
  var downloadButton = document.getElementById("download");
  var statusLine = document.getElementById("status");
  var fileLine = document.getElementById("file-line");

  var building = false;
  var starting = false;
  var statusKind = "";

  var audio = null;    // the audio context, made on the first Play
  var tone = null;     // the tone playing now
  var ticker = null;

  function readSettings() {
    var freqText = freqInput.value.trim();
    var freq = Number(freqText);
    if (freqInput.validity.badInput || freqText === "" || !isFinite(freq) || freq <= 0 || freq > MAX_FREQ) {
      return { error: "Enter a frequency above 0 Hz and up to 22,050 Hz." };
    }
    var minutesText = minutesInput.value.trim();
    var minutes = Number(minutesText);
    var total = minutes * 60;
    var n = sampleCount(total);
    if (minutesInput.validity.badInput || minutesText === "" || !isFinite(minutes) || n < 1) {
      return { error: "Enter a time above 0 minutes." };
    }
    var stem = "tone_" + freq + "Hz_" + total + "s";
    var bytes = wavSize(n);
    if (bytes > MAX_FILE_BYTES) {
      return { error: "Enter a time of 405 minutes or less." };
    }
    return { freq: freq, total: total, n: n, stem: stem, bytes: bytes };
  }

  // Date and time as YYYYMMDD_HHMMSS in local time, the same stamp sound_therapy.ipynb puts in its file names.
  function timeStamp(date) {
    function two(n) { return (n < 10 ? "0" : "") + n; }
    return date.getFullYear() + two(date.getMonth() + 1) + two(date.getDate()) + "_" +
      two(date.getHours()) + two(date.getMinutes()) + two(date.getSeconds());
  }

  function formatSize(bytes) {
    if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + " MB";
    return Math.max(1, Math.round(bytes / 1e3)) + " KB";
  }

  function formatClock(secondsLeft) {
    var t = Math.ceil(Math.max(0, secondsLeft));
    var h = Math.floor(t / 3600);
    var m = Math.floor((t % 3600) / 60);
    var s = t % 60;
    var ss = (s < 10 ? "0" : "") + s;
    return h > 0 ? h + ":" + (m < 10 ? "0" : "") + m + ":" + ss : m + ":" + ss;
  }

  function setStatus(text, kind) {
    statusLine.textContent = text;
    statusKind = kind || "";
    statusLine.className = statusKind === "" ? "" : "error";
  }

  function refresh() {
    var s = readSettings();
    var playing = tone !== null;
    freqInput.disabled = playing;
    minutesInput.disabled = playing;
    playButton.textContent = playing ? "Stop" : "Play";
    playButton.disabled = !playing && Boolean(s.error);
    downloadButton.disabled = building || Boolean(s.error);
    downloadButton.textContent = building ? "Building…" :
      s.error ? "Download" : "Download (" + formatSize(s.bytes) + ")";
    fileLine.textContent = "";
    if (!s.error) {
      var name = document.createElement("code");
      name.textContent = s.stem + "_YYYYMMDD_HHMMSS.wav";
      fileLine.append("File: ", name,
        " (16-bit stereo WAV, 44,100 samples per second, peak volume 0.25 on a 0 to 1 scale, 20 ms fade in and out)." +
        " The name ends with the date and time of the download.");
    }
    if (!playing && !building) {
      if (s.error) setStatus(s.error, "input");
      else if (statusKind === "input") setStatus("", "");
    }
    updateFormulas();
  }

  // ---- Play ----

  async function startTone() {
    if (starting) return;
    var s = readSettings();
    if (s.error) { setStatus(s.error, "input"); return; }
    starting = true;
    try {
      if (navigator.audioSession) navigator.audioSession.type = "playback";
    } catch (ignore) {}
    try {
      if (!audio) {
        var Context = window.AudioContext || window.webkitAudioContext;
        audio = new Context();
      }
      if (audio.state !== "running") await audio.resume();
    } catch (err) {
      starting = false;
      setStatus("This browser could not start the audio. Tap Play again.", "error");
      return;
    }
    var seconds = s.n / SAMPLE_RATE;
    var fade = fadeLength(s.n) / SAMPLE_RATE;
    var t0 = audio.currentTime + 0.05;
    var osc = audio.createOscillator();
    var gain = audio.createGain();
    osc.type = "sine";
    osc.frequency.value = s.freq;
    if (fade > 0) {
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(VOLUME, t0 + fade);
      gain.gain.setValueAtTime(VOLUME, t0 + seconds - fade);
      gain.gain.linearRampToValueAtTime(0, t0 + seconds);
    } else {
      gain.gain.setValueAtTime(VOLUME, t0);
    }
    osc.connect(gain);
    gain.connect(audio.destination);
    var current = { osc: osc, gain: gain, endAt: t0 + seconds, seconds: seconds, freq: s.freq, stoppedByUser: false };
    osc.onended = function () { finishTone(current); };
    osc.start(t0);
    osc.stop(t0 + seconds);
    tone = current;
    starting = false;
    ticker = setInterval(showRemaining, 200);
    showRemaining();
    refresh();
  }

  function showRemaining() {
    if (!tone) return;
    var left = Math.min(tone.seconds, tone.endAt - audio.currentTime);
    setStatus("Playing " + tone.freq + " Hz, " + formatClock(left) + " left", "");
  }

  function stopTone() {
    if (!tone) return;
    var current = tone;
    var now = audio.currentTime;
    var ramp = FADE_MS / 1000;
    current.stoppedByUser = true;
    try {
      var param = current.gain.gain;
      if (param.cancelAndHoldAtTime) {
        param.cancelAndHoldAtTime(now);
      } else {
        var level = param.value;
        param.cancelScheduledValues(now);
        param.setValueAtTime(level, now);
      }
      param.linearRampToValueAtTime(0, now + ramp);
      current.osc.stop(now + ramp + 0.01);
    } catch (ignore) {}
    setTimeout(function () { finishTone(current); }, (ramp + 0.1) * 1000);
  }

  function finishTone(current) {
    if (tone !== current) return;
    try { current.osc.disconnect(); current.gain.disconnect(); } catch (ignore) {}
    tone = null;
    clearInterval(ticker);
    ticker = null;
    setStatus(current.stoppedByUser ? "Stopped." : "Finished.", "");
    refresh();
  }

  // ---- Visualizations ----
  // Each visualization shows the frequency in the Frequency field. While the tone plays,
  // the views move 1,000 times slower than the sound; otherwise they hold still.

  var vizCanvas = document.getElementById("viz");
  var vizCaption = document.getElementById("viz-caption");
  var vizChoices = document.querySelectorAll('input[name="viz"]');
  var SLOW = 1000;         // slow-motion factor
  var vizKind = "waveform";
  var vizTime = 0;         // seconds of slow-motion time so far
  var vizLast = null;
  var vizDrawn = "";
  var stillMotion = Boolean(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  function currentFrequency() {
    if (tone) return tone.freq;
    var text = freqInput.value.trim();
    var freq = Number(text);
    return text !== "" && isFinite(freq) && freq > 0 && freq <= MAX_FREQ ? freq : 0;
  }

  // Waveform: 5 milliseconds of the wave.
  function drawWaveform(ctx, w, h, freq, t, dt, k) {
    ctx.fillStyle = k.paper;
    ctx.fillRect(0, 0, w, h);
    var top = 8, bottom = h - 24, mid = (top + bottom) / 2, amp = (bottom - top) / 2 * 0.85;
    ctx.strokeStyle = k.rule;
    ctx.lineWidth = 1;
    for (var g = 0; g <= 5; g++) {
      var gx = Math.round(g / 5 * (w - 1)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(gx, top);
      ctx.lineTo(gx, bottom);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(0, Math.round(mid) + 0.5);
    ctx.lineTo(w, Math.round(mid) + 0.5);
    ctx.stroke();
    ctx.fillStyle = k.muted;
    ctx.font = "12px Quicksand, Ubuntu, Calibri, Tahoma, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("0 ms", 4, h - 7);
    ctx.textAlign = "center";
    ctx.fillText("time", w / 2, h - 7);
    ctx.textAlign = "right";
    ctx.fillText("5 ms", w - 4, h - 7);
    if (!(freq > 0)) return;
    var span = 0.005, tau = t / SLOW;
    var steps = Math.max(w * 2, Math.ceil(freq * span * 24));
    ctx.strokeStyle = k.accent;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = "round";
    ctx.beginPath();
    for (var i = 0; i <= steps; i++) {
      var x = i / steps * w;
      var y = mid - amp * Math.sin(2 * Math.PI * freq * (tau + i / steps * span));
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // Ripples: sound spreading from a speaker on a 6-meter-wide view. The rings sit one
  // wavelength apart, using the speed of sound from the Formulas section.
  function drawRipples(ctx, w, h, freq, t, dt, k) {
    ctx.fillStyle = k.paper;
    ctx.fillRect(0, 0, w, h);
    var pxPerMeter = w / 6;
    var cx = w / 2, cy = (h - 22) / 2;
    var rMax = Math.hypot(w / 2, Math.max(cy, h - cy));
    if (freq > 0 && k.speed > 0) {
      var spacing = Math.max(3, k.speed / freq * pxPerMeter);
      var phase = (freq * (t / SLOW)) % 1;
      ctx.strokeStyle = k.accent;
      ctx.lineWidth = Math.max(1, Math.min(4, spacing * 0.18));
      for (var r = phase * spacing; r < rMax; r += spacing) {
        if (r < 2) continue;
        ctx.globalAlpha = Math.max(0, 1 - r / rMax) * 0.95;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, 2 * Math.PI);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = k.ink;
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, 2 * Math.PI);
    ctx.fill();
    ctx.fillStyle = k.paper;
    ctx.fillRect(0, h - 22, w, 22);
    var barX = 10, barY = h - 10;
    ctx.strokeStyle = k.muted;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(barX, barY);
    ctx.lineTo(barX + pxPerMeter, barY);
    ctx.moveTo(barX, barY - 4);
    ctx.lineTo(barX, barY + 4);
    ctx.moveTo(barX + pxPerMeter, barY - 4);
    ctx.lineTo(barX + pxPerMeter, barY + 4);
    ctx.stroke();
    ctx.fillStyle = k.muted;
    ctx.font = "12px Quicksand, Ubuntu, Calibri, Tahoma, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("1 meter", barX + pxPerMeter + 6, barY + 4);
  }

  // Sand pattern: an example plate that fills the canvas. The pattern (n, m) is the pair whose
  // n squared plus m squared is closest to the frequency divided by 10 Hz. The square pattern
  // sits in the middle of the canvas and continues out to the sides. Each grain jumps in
  // proportion to how much the plate moves under it, so grains gather on the lines that stay still.
  var SAND_PER_SQUARE = 3200;   // grains for each square of canvas height by canvas height
  var SAND_MAX = 9600;
  var sandU = new Float32Array(SAND_MAX);   // across the canvas, 0 to 1
  var sandV = new Float32Array(SAND_MAX);   // down the canvas, 0 to 1
  for (var g0 = 0; g0 < SAND_MAX; g0++) {
    sandU[g0] = Math.random();
    sandV[g0] = Math.random();
  }
  var sandSettled = "";

  function sandMode(freq) {
    var target = freq / 10, best = [1, 2], bestGap = Infinity;
    for (var n = 1; n <= 12; n++) {
      for (var m = n + 1; m <= 13; m++) {
        var gap = Math.abs(n * n + m * m - target);
        if (gap < bestGap) {
          bestGap = gap;
          best = [n, m];
        }
      }
    }
    return best;
  }

  // aspect is the canvas width divided by its height; count is how many grains are in use.
  function shakeSand(n, m, aspect, count, dt) {
    var shake = 4.2 * dt, left = (1 - aspect) / 2;
    for (var i = 0; i < count; i++) {
      var u = sandU[i], v = sandV[i];
      var x = left + u * aspect, y = v;
      var z = Math.cos(n * Math.PI * x) * Math.cos(m * Math.PI * y) -
              Math.cos(m * Math.PI * x) * Math.cos(n * Math.PI * y);
      var move = shake * (Math.abs(z) * 0.5 + 0.006);
      u += (Math.random() - 0.5) * move / aspect;
      v += (Math.random() - 0.5) * move;
      if (u < 0) u = -u; else if (u > 1) u = 2 - u;
      if (v < 0) v = -v; else if (v > 1) v = 2 - v;
      sandU[i] = u;
      sandV[i] = v;
    }
  }

  // At rest, the sand settles at once into the pattern for the frequency; while the tone plays, it keeps moving.
  function drawSand(ctx, w, h, freq, t, dt, k) {
    var aspect = w / h;
    var count = Math.min(SAND_MAX, Math.round(SAND_PER_SQUARE * aspect));
    ctx.fillStyle = "#141212";
    ctx.fillRect(0, 0, w, h);
    if (freq > 0) {
      var mode = sandMode(freq), settledKey = mode.join("x") + "|" + count;
      if (dt > 0) {
        shakeSand(mode[0], mode[1], aspect, count, dt);
        sandSettled = settledKey;
      } else if (sandSettled !== settledKey) {
        for (var s = 0; s < 240; s++) shakeSand(mode[0], mode[1], aspect, count, 1 / 60);
        sandSettled = settledKey;
      }
    }
    ctx.fillStyle = "#efe6d6";
    for (var i = 0; i < count; i++) {
      ctx.fillRect(sandU[i] * w - 0.8, sandV[i] * h - 0.8, 1.6, 1.6);
    }
  }

  // Air molecules: dots on a 6-meter-wide view. Each dot moves back and forth around its resting
  // spot, and the wave travels right at the speed of sound from the Formulas section, 1,000 times
  // slower. Red dots mark a few molecules to show they stay in place. The movement is exaggerated.
  var airDots = null, airSized = "";

  function drawAir(ctx, w, h, freq, t, dt, k) {
    var sized = w + "x" + h;
    if (sized !== airSized) {
      airSized = sized;
      airDots = [];
      var seed = 7;
      var rand = function () {
        seed |= 0;
        seed = seed + 0x6D2B79F5 | 0;
        var r = Math.imul(seed ^ seed >>> 15, 1 | seed);
        r = r + Math.imul(r ^ r >>> 7, 61 | r) ^ r;
        return ((r ^ r >>> 14) >>> 0) / 4294967296;
      };
      for (var gy = 9; gy < h - 34; gy += 7) {
        for (var gx = 20; gx < w - 4; gx += 6) {
          airDots.push({ x: gx + (rand() - 0.5) * 3, y: gy + (rand() - 0.5) * 3, mark: false });
        }
      }
      for (var j = 0; j < 7; j++) airDots.push({ x: w * 0.42, y: 14 + j * (h - 56) / 6, mark: true });
    }
    ctx.fillStyle = k.paper;
    ctx.fillRect(0, 0, w, h);
    var pxPerMeter = w / 6;
    var moving = freq > 0 && k.speed > 0;
    var lambda = moving ? k.speed / freq * pxPerMeter : 1;
    var amp = moving ? Math.min(9, lambda * 0.14) : 0;
    var wt = 2 * Math.PI * freq * (t / SLOW);
    ctx.fillStyle = k.ink;
    ctx.fillRect(0, 4, 12 + amp * Math.sin(wt), h - 36);
    for (var d = 0; d < airDots.length; d++) {
      var dot = airDots[d];
      var x = dot.x + amp * Math.sin(wt - 2 * Math.PI * (dot.x - 12) / lambda);
      if (dot.mark) {
        ctx.fillStyle = k.accent;
        ctx.beginPath();
        ctx.arc(x, dot.y, 3.2, 0, 2 * Math.PI);
        ctx.fill();
      } else {
        ctx.fillStyle = k.ink;
        ctx.fillRect(x - 1.3, dot.y - 1.3, 2.6, 2.6);
      }
    }
    var barX = 10, barY = h - 10;
    ctx.strokeStyle = k.muted;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(barX, barY);
    ctx.lineTo(barX + pxPerMeter, barY);
    ctx.moveTo(barX, barY - 4);
    ctx.lineTo(barX, barY + 4);
    ctx.moveTo(barX + pxPerMeter, barY - 4);
    ctx.lineTo(barX + pxPerMeter, barY + 4);
    ctx.stroke();
    ctx.fillStyle = k.muted;
    ctx.font = "12px Quicksand, Ubuntu, Calibri, Tahoma, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("1 meter", barX + pxPerMeter + 6, barY + 4);
  }

  // Spinning circle: a point turns once per cycle of the tone, 1,000 times slower. The trace to
  // the right is the point's height over the last 5 milliseconds of sound, newest at the left.
  function drawSpinning(ctx, w, h, freq, t, dt, k) {
    ctx.fillStyle = k.paper;
    ctx.fillRect(0, 0, w, h);
    var cy = (h - 24) / 2 + 4, R = Math.min((h - 40) / 2, w * 0.18), cx = 14 + R;
    var waveLeft = cx + R + 28, waveRight = w - 8, span = 0.005;
    ctx.strokeStyle = k.rule;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - R - 6, cy);
    ctx.lineTo(waveRight, cy);
    ctx.stroke();
    ctx.fillStyle = k.muted;
    ctx.font = "12px Quicksand, Ubuntu, Calibri, Tahoma, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("now", waveLeft - 2, h - 7);
    ctx.textAlign = "right";
    ctx.fillText("5 ms earlier", waveRight, h - 7);
    if (!(freq > 0)) return;
    var a = 2 * Math.PI * freq * (t / SLOW);
    var px = cx + R * Math.cos(a), py = cy - R * Math.sin(a);
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = k.muted;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(waveLeft, py);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = k.accent;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(px, py);
    ctx.stroke();
    var steps = Math.max((waveRight - waveLeft) * 2, Math.ceil(freq * span * 24));
    ctx.lineJoin = "round";
    ctx.beginPath();
    for (var i = 0; i <= steps; i++) {
      var x = waveLeft + i / steps * (waveRight - waveLeft);
      var y = cy - R * Math.sin(a - 2 * Math.PI * freq * (i / steps * span));
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = k.accent;
    ctx.beginPath();
    ctx.arc(px, py, 5, 0, 2 * Math.PI);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(waveLeft, py, 4, 0, 2 * Math.PI);
    ctx.fill();
  }

  var VIZ = {
    waveform: {
      draw: drawWaveform,
      aria: "Waveform of the tone, moving in slow motion while the tone plays",
      caption: "A slow-motion view of the wave itself: 5 milliseconds of it, slowed down 1,000 times. Higher frequency: More cycles across the screen."
    },
    ripples: {
      draw: drawRipples,
      aria: "Sound rings spreading from a speaker, moving in slow motion while the tone plays",
      caption: "Sound spreading through the air from a speaker, slowed down 1,000 times. The rings sit one wavelength apart. Higher frequency: Rings closer together."
    },
    sand: {
      draw: drawSand,
      aria: "Sand gathered into a pattern on a vibrating plate",
      caption: "Sand on a vibrating plate gathers on the lines that stay still. Higher frequency: A busier pattern. The plate is an example; real plates differ."
    },
    air: {
      draw: drawAir,
      aria: "Dots for air molecules moving back and forth as the sound passes, in slow motion while the tone plays",
      caption: "Air molecules pushed by a speaker, slowed down 1,000 times. Each dot moves back and forth in place, and the crowded bands of higher pressure travel outward. Higher frequency: Bands closer together. The movement is exaggerated so you can see it."
    },
    spinning: {
      draw: drawSpinning,
      aria: "A point spinning around a circle and tracing the sine wave, moving in slow motion while the tone plays",
      caption: "A point spinning around a circle, slowed down 1,000 times. Its height traces the sine wave. Higher frequency: A faster spin and more cycles in the trace."
    }
  };

  function chooseViz(kind) {
    vizKind = VIZ[kind] ? kind : "waveform";
    vizCanvas.setAttribute("aria-label", VIZ[vizKind].aria);
    vizCaption.textContent = VIZ[vizKind].caption;
    vizDrawn = "";
  }

  function drawViz(ms) {
    var dt = vizLast === null ? 0 : Math.min(0.05, Math.max(0, (ms - vizLast) / 1000));
    vizLast = ms;
    var step = tone && !stillMotion ? dt : 0;
    vizTime += step;

    var ratio = window.devicePixelRatio || 1;
    var w = vizCanvas.clientWidth, h = vizCanvas.clientHeight;
    var style = getComputedStyle(vizCanvas);
    var k = {
      paper: style.getPropertyValue("--paper").trim() || "#ffffff",
      ink: style.getPropertyValue("--ink").trim() || "#000000",
      muted: style.getPropertyValue("--muted").trim() || "#555555",
      rule: style.getPropertyValue("--rule").trim() || "#c0c0c0",
      accent: style.getPropertyValue("--accent").trim() || "#8b0000",
      speed: speedOfSound()
    };
    var freq = currentFrequency();
    var key = [vizKind, freq, w, h, ratio, vizTime, k.paper, k.accent, k.speed].join("|");

    if (w > 0 && h > 0 && key !== vizDrawn) {
      vizDrawn = key;
      var pw = Math.round(w * ratio), ph = Math.round(h * ratio);
      if (vizCanvas.width !== pw || vizCanvas.height !== ph) {
        vizCanvas.width = pw;
        vizCanvas.height = ph;
      }
      var ctx = vizCanvas.getContext("2d");
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      VIZ[vizKind].draw(ctx, w, h, freq, vizTime, step, k);
    }
    window.requestAnimationFrame(drawViz);
  }

  // ---- Formulas ----
  // Step 1 is the frequency of the tone. Step 2 shows the speed of sound in dry air,
  // 331.3 x sqrt(1 + temperature / 273.15), worked out in order with eight decimals in steps a to c,
  // enough that step d matches the formula worked in one go; the speed itself keeps two decimals.
  // Step 3 divides that speed by the frequency, keeping four significant digits.

  function byId(id) { return document.getElementById(id); }
  var tempInput = byId("temp");
  var formulaNote = byId("formula-note");
  var freqValues = byId("freq-values");
  var freqSource = byId("freq-source");
  var speedWork = byId("speed-work");
  var waveValues = byId("wave-values");
  var mFreq1 = byId("m-freq1"), mSpeed = byId("m-speed"), mTemp = byId("m-temp");
  var sTemp = byId("s-temp"), sQ = byId("s-q"), sOp = byId("s-op"), sQ2 = byId("s-q2");
  var sS = byId("s-s"), sS2 = byId("s-s2"), sR = byId("s-r"), sR2 = byId("s-r2"), sV = byId("s-v");
  var mWave = byId("m-wave"), mSpeed2 = byId("m-speed2"), mFreq = byId("m-freq");

  function roundTo(x, places) {
    var factor = Math.pow(10, places);
    return Math.round(x * factor) / factor;
  }

  // The speed of sound for the Air temperature field, rounded to two decimals; 0 when the field is not a valid temperature.
  function speedOfSound() {
    var tempText = tempInput.value.trim();
    var temp = Number(tempText);
    if (tempInput.validity.badInput || tempText === "" || !isFinite(temp) || temp <= -273.15) return 0;
    return Math.round(331.3 * Math.sqrt(1 + temp / 273.15) * 100) / 100;
  }

  // The values shown in step 2 for the Air temperature field; null when the field is not a valid temperature.
  function speedSteps() {
    var speed = speedOfSound();
    if (speed === 0) return null;
    var temp = Number(tempInput.value.trim());
    var q = roundTo(temp / 273.15, 8);
    var s = roundTo(1 + q, 8);
    var r = roundTo(Math.sqrt(s), 8);
    return { temp: temp, q: q, s: s, r: r, speed: speed };
  }

  function updateFormulas() {
    var freq = currentFrequency();
    if (freq > 0) {
      mFreq1.textContent = String(freq);
      freqValues.hidden = false;
      freqSource.textContent = tone ? "The tone playing now." : "The tone the Play button plays, from the Frequency field.";
    } else {
      freqValues.hidden = true;
      freqSource.textContent = "Enter a frequency in the Frequency field.";
    }

    var steps = speedSteps();
    if (!steps) {
      formulaNote.textContent = "Enter an air temperature above −273.15 °C.";
      speedWork.hidden = true;
      waveValues.hidden = true;
      return;
    }
    formulaNote.textContent = "";
    var speedText = steps.speed.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    var tempText = String(steps.temp);
    mTemp.textContent = tempText;
    mSpeed.textContent = speedText;
    sTemp.textContent = tempText;
    sQ.textContent = steps.q.toFixed(8);
    sOp.textContent = steps.q < 0 ? "−" : "+";
    sQ2.textContent = Math.abs(steps.q).toFixed(8);
    sS.textContent = steps.s.toFixed(8);
    sS2.textContent = steps.s.toFixed(8);
    sR.textContent = steps.r.toFixed(8);
    sR2.textContent = steps.r.toFixed(8);
    sV.textContent = speedText;
    speedWork.hidden = false;

    if (freq > 0) {
      mWave.textContent = (steps.speed / freq).toLocaleString("en-US", { minimumSignificantDigits: 4, maximumSignificantDigits: 4 });
      mSpeed2.textContent = speedText;
      mFreq.textContent = String(freq);
      waveValues.hidden = false;
    } else {
      waveValues.hidden = true;
    }
  }

  // ---- Download ----

  async function download() {
    if (building) return;
    var s = readSettings();
    if (s.error) { setStatus(s.error, "input"); return; }
    var wavName = s.stem + "_" + timeStamp(new Date()) + ".wav";
    building = true;
    refresh();
    try {
      var wav = await buildWav(s.freq, s.n, function (part) {
        setStatus("Building the file, " + Math.floor(part * 100) + "%", "");
      });
      var url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
      var link = document.createElement("a");
      link.href = url;
      link.download = wavName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
      setStatus("Downloaded " + wavName + ".", "");
    } catch (err) {
      if (err instanceof RangeError) {
        setStatus("The browser could not build a file this large. Enter a shorter time.", "error");
      } else {
        setStatus("The browser could not save the file.", "error");
      }
    } finally {
      building = false;
      refresh();
    }
  }

  // ---- Start ----

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    if (tone) stopTone(); else startTone();
  });
  form.addEventListener("input", refresh);
  tempInput.addEventListener("input", updateFormulas);
  downloadButton.addEventListener("click", function () { download(); });
  Array.prototype.forEach.call(vizChoices, function (choice) {
    choice.addEventListener("change", function () {
      if (choice.checked) chooseViz(choice.value);
    });
  });
  var checkedViz = document.querySelector('input[name="viz"]:checked');
  chooseViz(checkedViz ? checkedViz.value : "waveform");

  refresh();
  window.requestAnimationFrame(drawViz);
})();
