/**
 * Dark Carnival · Pick the Lock
 * Authentic mechanics (Liquipedia / event guides):
 * - Yellow bar: +1000 score
 * - Blue bar: +1.5s time
 * - Successful hit reverses pick direction
 * - Hold RMB: continuous speed boost
 * - Miss: briefly disable pick + slow the pick (not fixed time penalty)
 * - Soft clear target: 6000
 * - Bars spawn after hits; difficulty ramps with score
 * - Starts clockwise; F9 pause
 */

(() => {
  "use strict";

  const LOGICAL = 520;
  const CLEAR_TARGET = 6000;
  const INITIAL_TIME = 15;
  const YELLOW_SCORE = 1000;
  const BLUE_BONUS = 1.5;

  const BASE_SPEED = 95; // deg/s clockwise positive
  const BOOST_MULT = 2.35;
  const MISS_SLOW_MULT = 0.42;
  const MISS_DISABLE_MS = 720;
  const MISS_SLOW_MS = 1100;

  const RING_OUTER = 0.9;
  const RING_INNER = 0.74;
  const PICK_LEN = 0.86;

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

  let running = false;
  let paused = false;
  let score = 0;
  let timeLeft = INITIAL_TIME;
  let pickAngle = 0; // degrees, 0 = 3 o'clock, positive = clockwise
  let direction = 1; // +1 clockwise, -1 counter-clockwise
  let boosting = false;
  let pickDisabledUntil = 0;
  let slowUntil = 0;
  let lastTs = 0;
  let flash = null;
  let floatTexts = [];
  let bars = []; // { type: 'yellow'|'blue', start, span }
  let hits = 0;

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

  /**
   * Spawn 1–2 narrow bars ahead of travel, not under the pick.
   * Higher score → narrower bars, sometimes closer to pick (harder).
   */
  function spawnBars() {
    const hard = difficulty();
    const count = Math.random() < 0.28 + hard * 0.25 ? 2 : 1;
    const out = [];
    const minGap = 18;
    const aheadMin = 55 - hard * 20;
    const aheadMax = 200 - hard * 40;

    for (let n = 0; n < count; n++) {
      let placed = false;
      for (let attempt = 0; attempt < 60 && !placed; attempt++) {
        const isBlue = Math.random() < 0.32;
        const span = isBlue
          ? randomRange(10 - hard * 3, 16 - hard * 4)
          : randomRange(8 - hard * 3, 14 - hard * 4);
        const clampedSpan = Math.max(4.5, span);

        // Prefer bars ahead in current travel direction
        const ahead = randomRange(Math.max(35, aheadMin), Math.max(80, aheadMax));
        const start = normDeg(pickAngle + direction * ahead - clampedSpan / 2);

        // Keep clear of pick tip
        if (inArc(pickAngle, normDeg(start - 8), clampedSpan + 16)) continue;

        let ok = true;
        for (const b of out) {
          const gapOk =
            !inArc(start, normDeg(b.start - minGap), b.span + minGap * 2) &&
            !inArc(b.start, normDeg(start - minGap), clampedSpan + minGap * 2);
          if (!gapOk) {
            ok = false;
            break;
          }
        }
        if (ok) {
          out.push({
            type: isBlue ? "blue" : "yellow",
            start: normDeg(start),
            span: clampedSpan,
          });
          placed = true;
        }
      }
    }

    // Fallback: one yellow ahead
    if (!out.length) {
      const span = 12;
      out.push({
        type: "yellow",
        start: normDeg(pickAngle + direction * 90 - span / 2),
        span,
      });
    }

    // Ensure at least some yellows overall variety: if all blue, flip one
    if (out.every((b) => b.type === "blue")) {
      out[0].type = "yellow";
    }

    bars = out;
  }

  function currentSpeed() {
    const hard = difficulty();
    let spd = BASE_SPEED + hard * 55 + hits * 1.2;
    if (boosting) spd *= BOOST_MULT;
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
    // bright edge
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
      drawBar(cx, cy, inner, outer, b.start, b.span, b.type);
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

    // lock silhouette
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

    // pick tip (lock-pick style wedge)
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

  function hitBar() {
    for (const b of bars) {
      if (inArc(pickAngle, b.start, b.span)) return b;
    }
    return null;
  }

  function attemptPick() {
    if (!running || paused) return;
    const now = performance.now();
    if (now < pickDisabledUntil) return;

    const b = hitBar();
    if (!b) {
      // Miss: disable pick briefly + slow (primary penalty — not fixed time deduct)
      pickDisabledUntil = now + MISS_DISABLE_MS;
      slowUntil = now + MISS_SLOW_MS;
      setFlash("red", 240);
      addFloat("失误", "#e06060");
      return;
    }

    if (b.type === "yellow") {
      score += YELLOW_SCORE;
      setFlash("yellow", 180);
      addFloat("+1000", "#f5c518");
    } else {
      timeLeft += BLUE_BONUS;
      setFlash("blue", 180);
      addFloat("+1.5s", "#3aa0ff");
    }

    hits += 1;
    direction *= -1; // reverse after successful hit
    spawnBars();
    updateHUD();
  }

  function endGame() {
    running = false;
    boosting = false;
    paused = false;
    pausedEl.classList.add("hidden");

    const cleared = score >= CLEAR_TARGET;
    titleEl.textContent = cleared ? "通关成功" : "时间到";
    subtitleEl.textContent = cleared
      ? "已达到通关目标 6000！再冲更高分？"
      : "再试一次，目标 6000 分。";
    finalScoreEl.textContent = `最终分数：${score}`;
    finalScoreEl.classList.toggle("cleared", cleared);
    finalScoreEl.classList.remove("hidden");
    btnStart.textContent = "再来一局";
    overlay.classList.remove("hidden");
    updateHUD();
  }

  function startGame() {
    score = 0;
    timeLeft = INITIAL_TIME;
    pickAngle = -90; // top of dial
    direction = 1; // clockwise
    boosting = false;
    pickDisabledUntil = 0;
    slowUntil = 0;
    flash = null;
    floatTexts = [];
    hits = 0;
    paused = false;
    pausedEl.classList.add("hidden");
    spawnBars();
    running = true;
    lastTs = performance.now();
    overlay.classList.add("hidden");
    finalScoreEl.classList.add("hidden");
    finalScoreEl.classList.remove("cleared");
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
      pickAngle = normDeg(pickAngle + 28 * dt);
    }

    render(dt);
    requestAnimationFrame(tick);
  }

  // Left click = pick; right click hold = boost
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (!running || paused) return;
    if (e.button === 2 || e.buttons === 2) {
      boosting = true;
      return;
    }
    if (e.button === 0) attemptPick();
  });

  canvas.addEventListener("pointerup", (e) => {
    if (e.button === 2) boosting = false;
  });

  canvas.addEventListener("pointerleave", () => {
    boosting = false;
  });

  window.addEventListener("pointerup", (e) => {
    if (e.button === 2) boosting = false;
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "F9") {
      e.preventDefault();
      togglePause();
      return;
    }
    if (e.code === "Space" || e.key === " ") {
      e.preventDefault();
      if (!running) startGame();
      else attemptPick();
    }
  });

  btnStart.addEventListener("click", startGame);

  function fitCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = LOGICAL * dpr;
    canvas.height = LOGICAL * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  spawnBars();
  fitCanvas();
  window.addEventListener("resize", fitCanvas);
  updateHUD();
  requestAnimationFrame(tick);
})();
