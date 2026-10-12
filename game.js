/**
 * Dark Carnival · Pick the Lock
 * Authentic mechanics (Liquipedia / event guides + player corrections):
 * - Yellow bar: +1000 score
 * - Blue bar: +1.5s time
 * - Successful hit reverses pick direction
 * - Hold RMB: continuous speed boost (LMB pick independent via button + buttons edge)
 * - Miss: briefly disable pick + slow the pick (not fixed time penalty)
 * - Soft clear target: 6000
 * - Bars spawn random size (larger early; smaller more likely late); shrink until 0° then despawn
 * - Local leaderboard (localStorage, this browser only)
 * - Initial time 30s; RMB boost = 144°/s (≈2.5s / rev)
 * - Procedural Web Audio SFX + BGM (unlock on first gesture)
 * - Starts clockwise; F9 pause
 */

(() => {
  "use strict";

  const LOGICAL = 520;
  const CLEAR_TARGET = 6000;
  const INITIAL_TIME = 30;
  const YELLOW_SCORE = 1000;
  const BLUE_BONUS = 1.5;

  // Base: readable pace. Boost: one full revolution ≈ 2.5s (144°/s)
  const BASE_SPEED = 48; // deg/s clockwise positive
  const BOOST_SPEED = 144; // deg/s while RMB held — ≈2.5s per revolution
  const MISS_SLOW_MULT = 0.42;
  const MISS_DISABLE_MS = 720;
  const MISS_SLOW_MS = 1100;

  const RING_OUTER = 0.9;
  const RING_INNER = 0.74;
  const PICK_LEN = 0.86;

  // Random spawn + shrink-to-despawn
  const MAX_BARS = 5;
  const SPAWN_INTERVAL_BASE = 1.35; // seconds between spawn attempts early
  const SPAWN_INTERVAL_MIN = 0.45;
  const BAR_LIFE_MIN = 5.8; // slower shrink — bars last longer
  const BAR_LIFE_MAX = 9.5;

  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const scoreEl = document.getElementById("score");
  const timeEl = document.getElementById("time");
  const overlay = document.getElementById("overlay");
  const pausedEl = document.getElementById("paused");
  const titleEl = document.getElementById("title");
  const subtitleEl = document.getElementById("subtitle");
  const finalScoreEl = document.getElementById("final-score");
  const btnStart = document.getElementById("btn-start");

  const btnMute = document.getElementById("btn-mute");
  const lbList = document.getElementById("lb-list");
  const lbEmpty = document.getElementById("lb-empty");
  const nameEntry = document.getElementById("name-entry");
  const playerNameInput = document.getElementById("player-name");
  const btnSaveScore = document.getElementById("btn-save-score");
  const saveHint = document.getElementById("save-hint");

  const LB_KEY = "ptl-leaderboard-v1";
  const LB_NAME_KEY = "ptl-player-name";
  const LB_TOP = 10;
  let pendingScore = null; // score awaiting name save after game over
  let lastSavedId = null;

  // --- Procedural Web Audio (no copyrighted assets) ---
  const AudioFX = (() => {
    let ctx = null;
    let master = null;
    let sfxGain = null;
    let bgmGain = null;
    let muted = false;
    let unlocked = false;
    let bgmNodes = [];
    let bgmRunning = false;
    let pluckTimer = null;

    function ensure() {
      if (ctx) return ctx;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.85;
      master.connect(ctx.destination);
      sfxGain = ctx.createGain();
      sfxGain.gain.value = 0.55;
      sfxGain.connect(master);
      bgmGain = ctx.createGain();
      bgmGain.gain.value = 0.14;
      bgmGain.connect(master);
      return ctx;
    }

    async function unlock() {
      const c = ensure();
      if (!c) return;
      if (c.state === "suspended") {
        try {
          await c.resume();
        } catch (_) {}
      }
      if (!unlocked) {
        unlocked = true;
        // silent blip to warm up some browsers
        const o = c.createOscillator();
        const g = c.createGain();
        g.gain.value = 0.0001;
        o.connect(g);
        g.connect(sfxGain);
        o.start();
        o.stop(c.currentTime + 0.01);
      }
      if (!muted) startBgm();
      syncMuteUi();
    }

    function tone(freq, dur, type, vol, when, dest) {
      const c = ensure();
      if (!c || muted) return;
      const t0 = when != null ? when : c.currentTime;
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = type || "sine";
      o.frequency.setValueAtTime(freq, t0);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.001, vol), t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g);
      g.connect(dest || sfxGain);
      o.start(t0);
      o.stop(t0 + dur + 0.02);
    }

    function noiseBurst(dur, vol, when) {
      const c = ensure();
      if (!c || muted) return;
      const t0 = when != null ? when : c.currentTime;
      const n = Math.max(1, Math.floor(c.sampleRate * dur));
      const buf = c.createBuffer(1, n, c.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n);
      const src = c.createBufferSource();
      src.buffer = buf;
      const g = c.createGain();
      const f = c.createBiquadFilter();
      f.type = "bandpass";
      f.frequency.value = 900;
      f.Q.value = 0.7;
      g.gain.setValueAtTime(vol, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(f);
      f.connect(g);
      g.connect(sfxGain);
      src.start(t0);
      src.stop(t0 + dur + 0.02);
    }

    function hitYellow() {
      const c = ensure();
      if (!c || muted) return;
      const t = c.currentTime;
      tone(660, 0.12, "triangle", 0.35, t);
      tone(990, 0.18, "sine", 0.22, t + 0.04);
      tone(1320, 0.22, "sine", 0.12, t + 0.08);
    }

    function hitBlue() {
      const c = ensure();
      if (!c || muted) return;
      const t = c.currentTime;
      tone(440, 0.14, "sine", 0.28, t);
      tone(554, 0.2, "triangle", 0.2, t + 0.05);
      tone(740, 0.28, "sine", 0.14, t + 0.1);
    }

    function miss() {
      const c = ensure();
      if (!c || muted) return;
      const t = c.currentTime;
      tone(180, 0.22, "sawtooth", 0.18, t);
      tone(120, 0.28, "square", 0.1, t + 0.04);
      noiseBurst(0.12, 0.2, t);
    }

    function gameOver(cleared) {
      const c = ensure();
      if (!c || muted) return;
      const t = c.currentTime;
      if (cleared) {
        tone(523, 0.18, "triangle", 0.28, t);
        tone(659, 0.2, "triangle", 0.24, t + 0.14);
        tone(784, 0.28, "sine", 0.22, t + 0.28);
        tone(1046, 0.4, "sine", 0.16, t + 0.42);
      } else {
        tone(320, 0.25, "triangle", 0.22, t);
        tone(240, 0.35, "sine", 0.18, t + 0.18);
        tone(160, 0.45, "sine", 0.14, t + 0.36);
      }
    }

    function stopBgm() {
      if (pluckTimer) {
        clearTimeout(pluckTimer);
        pluckTimer = null;
      }
      bgmNodes.forEach((n) => {
        try {
          n.stop();
        } catch (_) {}
        try {
          n.disconnect();
        } catch (_) {}
      });
      bgmNodes = [];
      bgmRunning = false;
    }

    function startBgm() {
      const c = ensure();
      if (!c || muted || bgmRunning) return;
      if (c.state === "suspended") return;
      bgmRunning = true;
      const t0 = c.currentTime + 0.05;
      // Low drone + soft fifth pulse — carnival-adjacent, original
      const drone = c.createOscillator();
      drone.type = "sine";
      drone.frequency.value = 55;
      const droneG = c.createGain();
      droneG.gain.value = 0.55;
      drone.connect(droneG);
      droneG.connect(bgmGain);
      drone.start(t0);
      bgmNodes.push(drone);

      const pad = c.createOscillator();
      pad.type = "triangle";
      pad.frequency.value = 82.5;
      const padG = c.createGain();
      padG.gain.value = 0.22;
      pad.connect(padG);
      padG.connect(bgmGain);
      pad.start(t0);
      bgmNodes.push(pad);

      // Slow LFO on a soft harmonic
      const lfo = c.createOscillator();
      lfo.type = "sine";
      lfo.frequency.value = 0.08;
      const lfoG = c.createGain();
      lfoG.gain.value = 0.12;
      const harm = c.createOscillator();
      harm.type = "sine";
      harm.frequency.value = 110;
      const harmG = c.createGain();
      harmG.gain.value = 0.18;
      lfo.connect(lfoG);
      lfoG.connect(harmG.gain);
      harm.connect(harmG);
      harmG.connect(bgmGain);
      lfo.start(t0);
      harm.start(t0);
      bgmNodes.push(lfo, harm);

      // Sparse soft pluck loop via scheduled tones
      let beat = 0;
      function schedulePlucks() {
        if (!bgmRunning || muted || !ctx) return;
        const now = ctx.currentTime;
        const notes = [165, 196, 220, 196, 147, 165, 110, 147];
        for (let i = 0; i < 4; i++) {
          const f = notes[(beat + i) % notes.length];
          tone(f, 0.55, "sine", 0.045, now + i * 0.9, bgmGain);
        }
        beat = (beat + 3) % notes.length;
        pluckTimer = setTimeout(schedulePlucks, 3600);
      }
      schedulePlucks();
    }

    function setMuted(m) {
      muted = !!m;
      if (master) {
        master.gain.value = muted ? 0 : 0.85;
      }
      if (muted) {
        stopBgm();
      } else if (unlocked) {
        startBgm();
      }
      try {
        localStorage.setItem("ptl-mute", muted ? "1" : "0");
      } catch (_) {}
      syncMuteUi();
    }

    function toggleMute() {
      setMuted(!muted);
    }

    function syncMuteUi() {
      if (!btnMute) return;
      btnMute.textContent = muted ? "🔇 音效关" : "🔊 音效开";
      btnMute.setAttribute("aria-pressed", muted ? "true" : "false");
      btnMute.title = muted ? "点击开启音效" : "点击静音";
    }

    try {
      if (localStorage.getItem("ptl-mute") === "1") muted = true;
    } catch (_) {}
    syncMuteUi();

    return {
      unlock,
      hitYellow,
      hitBlue,
      miss,
      gameOver,
      toggleMute,
      setMuted,
      isMuted: () => muted,
    };
  })();


  // --- Leaderboard (localStorage, this browser only) ---
  function loadScores() {
    try {
      const raw = localStorage.getItem(LB_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr
        .filter((e) => e && typeof e.score === "number" && typeof e.name === "string")
        .map((e) => ({
          name: String(e.name).slice(0, 12) || "匿名",
          score: Math.max(0, Math.floor(e.score)),
          at: typeof e.at === "number" ? e.at : 0,
          id: e.id || `${e.at || 0}-${e.score}`,
        }))
        .sort((a, b) => b.score - a.score || a.at - b.at)
        .slice(0, LB_TOP);
    } catch (_) {
      return [];
    }
  }

  function saveScores(list) {
    try {
      localStorage.setItem(LB_KEY, JSON.stringify(list.slice(0, LB_TOP)));
    } catch (_) {}
  }

  function qualifiesForBoard(sc, list) {
    if (sc <= 0) return false;
    if (list.length < LB_TOP) return true;
    return sc > list[list.length - 1].score;
  }

  function addScoreEntry(name, sc) {
    const list = loadScores();
    const entry = {
      name: (name || "匿名").trim().slice(0, 12) || "匿名",
      score: Math.max(0, Math.floor(sc)),
      at: Date.now(),
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };
    list.push(entry);
    list.sort((a, b) => b.score - a.score || a.at - b.at);
    const trimmed = list.slice(0, LB_TOP);
    saveScores(trimmed);
    try {
      localStorage.setItem(LB_NAME_KEY, entry.name);
    } catch (_) {}
    return entry;
  }

  function renderLeaderboard(highlightId) {
    const list = loadScores();
    lbList.innerHTML = "";
    if (!list.length) {
      lbEmpty.classList.remove("hidden");
      return;
    }
    lbEmpty.classList.add("hidden");
    list.forEach((e, i) => {
      const li = document.createElement("li");
      if (highlightId && e.id === highlightId) li.classList.add("me");
      li.innerHTML =
        `<span class="rank">${i + 1}</span>` +
        `<span class="name"></span>` +
        `<span class="score"></span>`;
      li.querySelector(".name").textContent = e.name;
      li.querySelector(".score").textContent = String(e.score);
      lbList.appendChild(li);
    });
  }

  function showNameEntry(sc) {
    pendingScore = sc;
    const list = loadScores();
    if (!qualifiesForBoard(sc, list)) {
      nameEntry.classList.add("hidden");
      pendingScore = null;
      saveHint.textContent = "";
      return;
    }
    nameEntry.classList.remove("hidden");
    btnSaveScore.disabled = false;
    saveHint.textContent = "";
    try {
      const prev = localStorage.getItem(LB_NAME_KEY);
      if (prev) playerNameInput.value = prev;
    } catch (_) {}
  }

  function hideNameEntry() {
    nameEntry.classList.add("hidden");
    pendingScore = null;
    saveHint.textContent = "";
  }

  function submitScore() {
    if (pendingScore == null) return;
    const entry = addScoreEntry(playerNameInput.value, pendingScore);
    lastSavedId = entry.id;
    pendingScore = null;
    btnSaveScore.disabled = true;
    saveHint.textContent = "已保存到本机排行榜";
    renderLeaderboard(lastSavedId);
  }

  let running = false;
  let paused = false;
  let score = 0;
  let timeLeft = INITIAL_TIME;
  let pickAngle = 0; // degrees, 0 = 3 o'clock, positive = clockwise
  let direction = 1; // +1 clockwise, -1 counter-clockwise
  let boosting = false;
  let rmbDown = false;
  let prevButtons = 0;
  let lastPickAt = 0;
  let pickDisabledUntil = 0;
  let slowUntil = 0;
  let lastTs = 0;
  let flash = null;
  let floatTexts = [];
  /** @type {{ type: string, center: number, initialSpan: number, span: number, life: number, maxLife: number }[]} */
  let bars = [];
  let hits = 0;
  let spawnTimer = 0;

  function deg2rad(d) {
    return (d * Math.PI) / 180;
  }

  function normDeg(a) {
    a %= 360;
    return a < 0 ? a + 360 : a;
  }

  function inArc(angle, start, span) {
    return normDeg(angle - start) < span;
  }

  function randomRange(min, max) {
    return min + Math.random() * (max - min);
  }

  /** Difficulty 0..1 from score */
  function difficulty() {
    return Math.min(1, score / 24000);
  }

  function barStart(b) {
    return normDeg(b.center - b.span / 2);
  }

  function barsOverlap(center, span, others, pad) {
    const start = normDeg(center - span / 2);
    for (const o of others) {
      const oStart = barStart(o);
      const gap =
        !inArc(start, normDeg(oStart - pad), o.span + pad * 2) &&
        !inArc(oStart, normDeg(start - pad), span + pad * 2);
      if (!gap) return true;
    }
    return false;
  }

  /**
   * Try to place one random yellow/blue bar anywhere on the ring.
   * Does not clear existing bars — they accumulate until hit or shrunk away.
   */
  /** Random bar width; early ~34–40°, later higher chance of small */
  function randomBarSpan(hard) {
    const roll = Math.random();
    // Chance to roll the "small" tier: ~12% at start → ~70% late
    const smallChance = 0.12 + hard * 0.58;
    if (roll < smallChance) {
      return randomRange(18, 30); // small (more common late)
    }
    // Default / early: roughly 34–40°
    return randomRange(34, 40);
  }

  function trySpawnBar() {
    if (bars.length >= MAX_BARS) return false;
    const hard = difficulty();

    for (let attempt = 0; attempt < 50; attempt++) {
      const isBlue = Math.random() < 0.28 + hard * 0.08;
      const span = randomBarSpan(hard);
      const center = Math.random() * 360;

      // Keep clear of pick tip so a brand-new bar isn't instantly under the needle
      if (inArc(pickAngle, normDeg(center - span / 2 - 14), span + 28)) continue;
      if (barsOverlap(center, span, bars, 10)) continue;

      const maxLife = randomRange(
        BAR_LIFE_MIN - hard * 0.5,
        BAR_LIFE_MAX - hard * 0.9
      );
      bars.push({
        type: isBlue ? "blue" : "yellow",
        center: normDeg(center),
        initialSpan: span,
        span,
        life: maxLife,
        maxLife: Math.max(4.0, maxLife),
      });
      return true;
    }
    return false;
  }

  function spawnInterval() {
    const hard = difficulty();
    return Math.max(
      SPAWN_INTERVAL_MIN,
      SPAWN_INTERVAL_BASE - hard * 0.75 - hits * 0.012
    );
  }

  /** Shrink bars over lifetime; despawn only when span reaches 0° */
  function updateBars(dt) {
    for (let i = bars.length - 1; i >= 0; i--) {
      const b = bars[i];
      b.life -= dt;
      const t = Math.max(0, b.life / b.maxLife);
      // Near-linear shrink so bars stay readable longer (mild ease only at the end)
      const ease = t * 0.75 + t * t * 0.25;
      b.span = Math.max(0, b.initialSpan * ease);
      if (b.span <= 0 || b.life <= 0) {
        bars.splice(i, 1);
      }
    }
  }

  function currentSpeed() {
    const hard = difficulty();
    let spd;
    if (boosting) {
      // RMB boost: one full revolution ≈ 2.5 seconds
      spd = BOOST_SPEED;
    } else {
      spd = BASE_SPEED + hard * 70 + hits * 1.4;
    }
    if (performance.now() < slowUntil) spd *= MISS_SLOW_MULT;
    return spd;
  }

  function setFlash(color, ms) {
    flash = { color, until: performance.now() + ms };
  }

  function addFloat(text, color) {
    floatTexts.push({
      text,
      color,
      life: 0.9,
      y: 0,
    });
  }

  function updateHUD() {
    scoreEl.textContent = String(score);
    timeEl.textContent = Math.max(0, timeLeft).toFixed(1);
    timeEl.style.color = running && timeLeft <= 4 ? "#e06060" : "";
    if (score >= CLEAR_TARGET) {
      scoreEl.style.color = "#7dffb0";
    } else {
      scoreEl.style.color = "";
    }
  }

  function drawBar(cx, cy, inner, outer, startDeg, span, type) {
    if (span < 0.5) return;
    const a0 = deg2rad(startDeg);
    const a1 = deg2rad(startDeg + span);
    const color = type === "yellow" ? "#f5c518" : "#3aa0ff";
    const glow =
      type === "yellow" ? "rgba(245, 197, 24, 0.65)" : "rgba(58, 160, 255, 0.65)";

    ctx.save();
    ctx.shadowColor = glow;
    ctx.shadowBlur = 16;
    ctx.beginPath();
    ctx.arc(cx, cy, outer - 1, a0, a1);
    ctx.arc(cx, cy, inner + 1, a1, a0, true);
    ctx.closePath();
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = type === "yellow" ? "#fff3a0" : "#a8d8ff";
    ctx.stroke();
    ctx.restore();
  }

  function drawRing(cx, cy, r) {
    const outer = r * RING_OUTER;
    const inner = r * RING_INNER;

    ctx.beginPath();
    ctx.arc(cx, cy, outer, 0, Math.PI * 2);
    ctx.arc(cx, cy, inner, 0, Math.PI * 2, true);
    ctx.fillStyle = "#101828";
    ctx.fill();

    ctx.beginPath();
    ctx.arc(cx, cy, outer, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(212, 160, 23, 0.38)";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, inner, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(212, 160, 23, 0.22)";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    for (const b of bars) {
      drawBar(cx, cy, inner, outer, barStart(b), b.span, b.type);
    }

    if (flash && performance.now() < flash.until) {
      const alpha = Math.max(0, (flash.until - performance.now()) / 220) * 0.5;
      const fill =
        flash.color === "red"
          ? `rgba(224, 64, 64, ${alpha})`
          : flash.color === "yellow"
            ? `rgba(245, 197, 24, ${alpha})`
            : `rgba(58, 160, 255, ${alpha})`;
      ctx.beginPath();
      ctx.arc(cx, cy, outer, 0, Math.PI * 2);
      ctx.arc(cx, cy, inner, 0, Math.PI * 2, true);
      ctx.fillStyle = fill;
      ctx.fill();
    } else {
      flash = null;
    }

    for (let i = 0; i < 48; i++) {
      const a = deg2rad(i * 7.5);
      const major = i % 4 === 0;
      const r0 = outer - (major ? 7 : 3.5);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      ctx.lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer);
      ctx.strokeStyle = major
        ? "rgba(212, 160, 23, 0.32)"
        : "rgba(212, 160, 23, 0.1)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  function drawCenter(cx, cy, r) {
    const gr = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 0.55);
    gr.addColorStop(0, "#1a2240");
    gr.addColorStop(1, "#0a0e18");
    ctx.beginPath();
    ctx.arc(cx, cy, r * RING_INNER - 2, 0, Math.PI * 2);
    ctx.fillStyle = gr;
    ctx.fill();

    ctx.fillStyle = "#0c1018";
    ctx.beginPath();
    ctx.arc(cx, cy - r * 0.05, r * 0.065, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(cx - r * 0.032, cy - r * 0.03, r * 0.064, r * 0.15);

    const now = performance.now();
    if (running && now < pickDisabledUntil) {
      ctx.fillStyle = "rgba(224, 80, 80, 0.85)";
      ctx.font = `600 ${Math.floor(r * 0.055)}px "Segoe UI", "PingFang SC", sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("开锁冷却", cx, cy + r * 0.28);
    } else if (running && boosting) {
      ctx.fillStyle = "rgba(240, 200, 80, 0.7)";
      ctx.font = `${Math.floor(r * 0.05)}px "Segoe UI", "PingFang SC", sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("加速中", cx, cy + r * 0.28);
    }
  }

  function drawPick(cx, cy, r) {
    const a = deg2rad(pickAngle);
    const len = r * PICK_LEN;
    const tipX = cx + Math.cos(a) * len;
    const tipY = cy + Math.sin(a) * len;
    const disabled = performance.now() < pickDisabledUntil;
    const shaft = disabled ? "#886868" : boosting ? "#ffe070" : "#e8c860";

    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.055, 0, Math.PI * 2);
    ctx.fillStyle = "#1e1828";
    ctx.fill();
    ctx.strokeStyle = "rgba(212, 160, 23, 0.65)";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.save();
    ctx.shadowColor = disabled
      ? "rgba(180, 60, 60, 0.5)"
      : "rgba(240, 200, 80, 0.75)";
    ctx.shadowBlur = boosting ? 18 : 12;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r * 0.05, cy + Math.sin(a) * r * 0.05);
    ctx.lineTo(tipX, tipY);
    ctx.strokeStyle = shaft;
    ctx.lineWidth = boosting ? 4.2 : 3.4;
    ctx.lineCap = "round";
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.translate(tipX, tipY);
    ctx.rotate(a + Math.PI / 2);
    ctx.shadowColor = "#fff8c0";
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(5, 6);
    ctx.lineTo(-5, 6);
    ctx.closePath();
    ctx.fillStyle = disabled ? "#c08080" : "#fff6a8";
    ctx.fill();
    ctx.restore();
  }

  function drawFloats(cx, cy, r, dt) {
    for (let i = floatTexts.length - 1; i >= 0; i--) {
      const f = floatTexts[i];
      f.life -= dt;
      f.y -= 28 * dt;
      if (f.life <= 0) {
        floatTexts.splice(i, 1);
        continue;
      }
      ctx.save();
      ctx.globalAlpha = Math.min(1, f.life * 1.4);
      ctx.fillStyle = f.color;
      ctx.font = `700 ${Math.floor(r * 0.07)}px "Segoe UI", sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(f.text, cx, cy + r * 0.08 + f.y);
      ctx.restore();
    }
  }

  function render(dt) {
    const cx = LOGICAL / 2;
    const cy = LOGICAL / 2;
    const r = LOGICAL / 2;

    ctx.clearRect(0, 0, LOGICAL, LOGICAL);

    const bg = ctx.createRadialGradient(cx, cy, r * 0.25, cx, cy, r);
    bg.addColorStop(0, "#12182e");
    bg.addColorStop(1, "#080c16");
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();

    drawRing(cx, cy, r);
    drawCenter(cx, cy, r);
    drawPick(cx, cy, r);
    drawFloats(cx, cy, r, dt);
  }

  function hitBarIndex() {
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      if (inArc(pickAngle, barStart(b), b.span)) return i;
    }
    return -1;
  }

  function attemptPick() {
    if (!running || paused) return;
    const now = performance.now();
    if (now < pickDisabledUntil) return;

    const idx = hitBarIndex();
    if (idx < 0) {
      pickDisabledUntil = now + MISS_DISABLE_MS;
      slowUntil = now + MISS_SLOW_MS;
      setFlash("red", 240);
      addFloat("失误", "#e06060");
      AudioFX.miss();
      return;
    }

    const b = bars[idx];
    if (b.type === "yellow") {
      score += YELLOW_SCORE;
      setFlash("yellow", 180);
      addFloat("+1000", "#f5c518");
      AudioFX.hitYellow();
    } else {
      timeLeft += BLUE_BONUS;
      setFlash("blue", 180);
      addFloat("+1.5s", "#3aa0ff");
      AudioFX.hitBlue();
    }

    bars.splice(idx, 1); // only remove the hit bar; others keep shrinking
    hits += 1;
    direction *= -1;
    updateHUD();
  }

  function endGame() {
    running = false;
    boosting = false;
    rmbDown = false;
    prevButtons = 0;
    paused = false;
    pausedEl.classList.add("hidden");

    const cleared = score >= CLEAR_TARGET;
    AudioFX.gameOver(cleared);
    titleEl.textContent = cleared ? "通关成功" : "时间到";
    subtitleEl.textContent = cleared
      ? "已达到通关目标 6000！再冲更高分？"
      : "再试一次，目标 6000 分。";
    finalScoreEl.textContent = `最终分数：${score}`;
    finalScoreEl.classList.toggle("cleared", cleared);
    finalScoreEl.classList.remove("hidden");
    btnStart.textContent = "再来一局";
    lastSavedId = null;
    showNameEntry(score);
    renderLeaderboard(null);
    overlay.classList.remove("hidden");
    updateHUD();
  }

  function startGame() {
    AudioFX.unlock();
    score = 0;
    timeLeft = INITIAL_TIME;
    pickAngle = -90;
    direction = 1;
    boosting = false;
    rmbDown = false;
    prevButtons = 0;
    pickDisabledUntil = 0;
    slowUntil = 0;
    flash = null;
    floatTexts = [];
    hits = 0;
    bars = [];
    spawnTimer = 0.15; // first bar soon after start
    paused = false;
    pausedEl.classList.add("hidden");
    trySpawnBar();
    trySpawnBar();
    running = true;
    lastTs = performance.now();
    overlay.classList.add("hidden");
    finalScoreEl.classList.add("hidden");
    finalScoreEl.classList.remove("cleared");
    hideNameEntry();
    updateHUD();
  }

  function togglePause() {
    if (!running) return;
    paused = !paused;
    pausedEl.classList.toggle("hidden", !paused);
    if (!paused) lastTs = performance.now();
  }

  function tick(ts) {
    const dt = Math.min(0.05, (ts - lastTs) / 1000 || 0.016);
    lastTs = ts;

    if (running && !paused) {
      pickAngle = normDeg(pickAngle + direction * currentSpeed() * dt);
      updateBars(dt);

      spawnTimer -= dt;
      if (spawnTimer <= 0) {
        trySpawnBar();
        spawnTimer = spawnInterval() * randomRange(0.75, 1.25);
      }

      timeLeft -= dt;
      if (timeLeft <= 0) {
        timeLeft = 0;
        updateHUD();
        endGame();
      } else {
        timeEl.textContent = timeLeft.toFixed(1);
        if (timeLeft <= 4) timeEl.style.color = "#e06060";
      }
    } else if (!running) {
      pickAngle = normDeg(pickAngle + 22 * dt);
      updateBars(dt * 0.35);
      if (bars.length < 2 && Math.random() < 0.02) trySpawnBar();
    }

    render(dt);
    requestAnimationFrame(tick);
  }

  // --- Input ---
  // LMB pick and RMB boost are independent. While RMB is held, many browsers
  // do NOT fire a second pointerdown for LMB — they only update `buttons`.
  // So: rmbDown flag for boost; pick on button===0 AND on buttons bit0 edge.
  function setBoost(on) {
    rmbDown = !!on;
    boosting = rmbDown;
  }

  function syncBoostFromButtons(buttons) {
    setBoost((buttons & 2) !== 0);
  }

  function pickFromInput() {
    const now = performance.now();
    // Debounce double-fire from pointerdown + buttons-edge on same press
    if (now - lastPickAt < 40) return;
    lastPickAt = now;
    attemptPick();
  }

  function onButtonDown(button, buttons) {
    if (button === 2) {
      setBoost(true);
    }
    // Left pick always, even if buttons===3 (RMB already held)
    if (button === 0) {
      pickFromInput();
    }
    if (typeof buttons === "number") {
      prevButtons = buttons;
      syncBoostFromButtons(buttons);
    }
  }

  function onButtonUp(button, buttons) {
    if (button === 2) {
      setBoost(false);
    }
    if (typeof buttons === "number") {
      prevButtons = buttons;
      syncBoostFromButtons(buttons);
    } else if (button === 2) {
      setBoost(false);
    }
  }

  // Kill browser context menu so RMB is free for boost
  canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  window.addEventListener("contextmenu", (e) => {
    if (e.target === canvas) {
      e.preventDefault();
      e.stopPropagation();
    }
  });

  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch (_) {}
    if (!running || paused) {
      if (e.button === 2) setBoost(true);
      return;
    }
    onButtonDown(e.button, e.buttons);
  });

  canvas.addEventListener("pointerup", (e) => {
    onButtonUp(e.button, e.buttons);
    // Keep capture while any button still held (RMB boost + LMB pick)
    if (e.buttons === 0) {
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch (_) {}
    }
  });

  canvas.addEventListener("pointercancel", () => {
    setBoost(false);
    prevButtons = 0;
  });

  // mousedown/up backup: some builds fire these for multi-button when pointer events do not
  canvas.addEventListener("mousedown", (e) => {
    e.preventDefault();
    if (!running || paused) {
      if (e.button === 2) setBoost(true);
      return;
    }
    onButtonDown(e.button, e.buttons);
  });

  canvas.addEventListener("mouseup", (e) => {
    onButtonUp(e.button, e.buttons);
  });

  window.addEventListener("mouseup", (e) => {
    if (e.button === 2) setBoost(false);
  });
  window.addEventListener("pointerup", (e) => {
    if (e.button === 2) setBoost(false);
  });
  window.addEventListener("blur", () => {
    setBoost(false);
    prevButtons = 0;
  });

  // Critical path: when RMB is already held, pressing LMB often only flips
  // buttons bit0 on move/raw update — detect rising edge of left button.
  canvas.addEventListener("pointermove", (e) => {
    const buttons = e.buttons;
    syncBoostFromButtons(buttons);
    if (running && !paused) {
      if ((buttons & 1) !== 0 && (prevButtons & 1) === 0) {
        pickFromInput();
      }
    }
    prevButtons = buttons;
  });

  // Touch: one-finger tap = pick; two-finger / hold second contact = boost
  let touchBoostId = null;
  canvas.addEventListener(
    "touchstart",
    (e) => {
      e.preventDefault();
      if (!running || paused) return;
      if (e.touches.length >= 2) {
        setBoost(true);
        touchBoostId = e.touches[1].identifier;
      } else if (e.touches.length === 1) {
        pickFromInput();
      }
    },
    { passive: false }
  );
  canvas.addEventListener(
    "touchend",
    (e) => {
      e.preventDefault();
      if (touchBoostId != null) {
        let still = false;
        for (let i = 0; i < e.touches.length; i++) {
          if (e.touches[i].identifier === touchBoostId) still = true;
        }
        if (!still) {
          touchBoostId = null;
          setBoost(false);
        }
      }
      if (e.touches.length < 2) {
        touchBoostId = null;
        setBoost(false);
      }
    },
    { passive: false }
  );
  canvas.addEventListener(
    "touchcancel",
    () => {
      touchBoostId = null;
      setBoost(false);
    },
    { passive: false }
  );

  window.addEventListener("keydown", (e) => {
    if (e.key === "F9") {
      e.preventDefault();
      togglePause();
      return;
    }
    if (e.code === "Space" || e.key === " ") {
      e.preventDefault();
      if (!running) startGame();
      else pickFromInput();
    }
  });

  btnStart.addEventListener("click", () => {
    AudioFX.unlock();
    startGame();
  });
  if (btnMute) {
    btnMute.addEventListener("click", (e) => {
      e.stopPropagation();
      AudioFX.unlock();
      AudioFX.toggleMute();
    });
  }

  // Unlock AudioContext on first user gesture anywhere
  const unlockOnce = () => {
    AudioFX.unlock();
    window.removeEventListener("pointerdown", unlockOnce, true);
    window.removeEventListener("keydown", unlockOnce, true);
  };
  window.addEventListener("pointerdown", unlockOnce, true);
  window.addEventListener("keydown", unlockOnce, true);

  function fitCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = LOGICAL * dpr;
    canvas.height = LOGICAL * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  if (btnSaveScore) {
    btnSaveScore.addEventListener("click", (e) => {
      e.stopPropagation();
      submitScore();
    });
  }
  if (playerNameInput) {
    playerNameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submitScore();
      }
    });
  }

  trySpawnBar();
  trySpawnBar();
  fitCanvas();
  window.addEventListener("resize", fitCanvas);
  updateHUD();
  hideNameEntry();
  renderLeaderboard(null);
  requestAnimationFrame(tick);
})();
