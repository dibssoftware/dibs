'use strict';
// The backdrop: a slow field of interfering waves, ordered-dithered (8x8 Bayer)
// onto a coarse grid and drawn faintly. The pointer lifts the field where it
// rests and a click sends a ring out; the dots it lifts take the logo's yellow.
//
// Two speeds. The waves move slowly, so they're computed 24 times a second into
// a buffer. The pointer's lift is drawn on every frame the pointer moves, right
// where it is with no easing, so it never trails the cursor: a frame is one cheap
// pass copying the buffer plus the trig only in the square the pointer reaches.
(() => {
  const canvas = document.getElementById('dither');
  if (!canvas) return;
  const ctx = canvas.getContext('2d', { alpha: true });
  const CELL = 4;                 // CSS pixels per dither cell
  const WAVE_FPS = 24;
  const REACH = 26;               // cells the pointer's lift spreads over
  const RING_LIFE = 2.4, RING_SPEED = 70;
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  const BAYER = [0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
    3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21].map(v => (v + 0.5) / 64);

  let w = 0, h = 0, img = null, wave = null, ink = [0, 0, 0, 18], hot = [255, 176, 0, 110];
  let px = -1e4, py = -1e4, moved = false;
  const rings = [];

  function readInk() {
    const css = getComputedStyle(document.documentElement);
    const read = name => { const v = css.getPropertyValue(name).trim().split(/[\s,]+/).map(Number); return v.length === 4 && v.every(n => !Number.isNaN(n)) ? v : null; };
    ink = read('--dither-ink') || ink;
    hot = read('--dither-hot') || hot;
  }
  function size() {
    w = Math.ceil(innerWidth / CELL);
    h = Math.ceil(innerHeight / CELL);
    canvas.width = w;
    canvas.height = h;
    img = ctx.createImageData(w, h);
    wave = new Float32Array(w * h);
    readInk();
    waves(performance.now());
    paint(performance.now());
  }

  // Three slow waves at odd angles: interference without a visible tile.
  function waves(t) {
    const s = t / 1000;
    for (let y = 0, i = 0; y < h; y++) {
      for (let x = 0; x < w; x++, i++) {
        const v = 0.5 * Math.sin(x * 0.045 + s * 0.31) * Math.cos(y * 0.052 - s * 0.23)
          + 0.32 * Math.sin((x + y) * 0.023 + s * 0.17)
          + 0.18 * Math.sin(Math.hypot(x - w * 0.7, y - h * 0.2) * 0.06 - s * 0.4);
        wave[i] = v * 0.26 + 0.22;
      }
    }
  }

  function put(i, x, y, lift) {
    const d = img.data, o = i * 4;
    if (wave[i] + lift > BAYER[((y & 7) << 3) + (x & 7)]) {
      const c = lift > 0.09 ? hot : ink;
      d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = c[3];
    } else d[o + 3] = 0;
  }

  function paint(t) {
    const s = t / 1000;
    const live = rings.filter(r => s - r.at < RING_LIFE);
    rings.length = 0; rings.push(...live);
    // The whole field from the wave buffer when a ring is out (a ring crosses
    // the screen); otherwise the base plus the square around the pointer.
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) put(i, x, y, live.length ? ringLift(x, y, s, live) : 0);
    const cx = px / CELL, cy = py / CELL, r = REACH * 3;
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx, dy = y - cy;
        const lift = 0.34 * Math.exp(-(dx * dx + dy * dy) / (2 * REACH * REACH)) + (live.length ? ringLift(x, y, s, live) : 0);
        put(y * w + x, x, y, lift);
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  function ringLift(x, y, s, live) {
    let lift = 0;
    for (const r of live) {
      const age = s - r.at, dist = Math.hypot(x - r.x, y - r.y) - age * RING_SPEED;
      if (dist > -6 && dist < 6) lift += 0.32 * (1 - age / RING_LIFE) * Math.cos(dist * 0.5);
    }
    return lift;
  }

  let lastWave = 0, raf = 0;
  function frame(t) {
    raf = 0;
    if (document.hidden) return;
    const waveDue = t - lastWave >= 1000 / WAVE_FPS;
    if (waveDue) { lastWave = t; waves(t); }
    if (waveDue || moved || rings.length) { moved = false; paint(t); }
    if (!still.matches) raf = requestAnimationFrame(frame);
  }
  const go = () => { if (!raf && !still.matches) raf = requestAnimationFrame(frame); };

  addEventListener('pointermove', e => { px = e.clientX; py = e.clientY; moved = true; }, { passive: true });
  document.addEventListener('pointerleave', () => { px = py = -1e4; moved = true; });
  addEventListener('pointerdown', e => { if (!still.matches) rings.push({ x: e.clientX / CELL, y: e.clientY / CELL, at: performance.now() / 1000 }); }, { passive: true });
  addEventListener('resize', size);
  document.addEventListener('visibilitychange', go);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { readInk(); paint(performance.now()); });
  still.addEventListener('change', () => (still.matches ? paint(performance.now()) : go()));
  size();
  go();
})();
