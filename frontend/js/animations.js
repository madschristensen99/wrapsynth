// Showpiece Animations — Mint celebration & Burn finale
// Canvas-based particle systems inspired by React Bits / Aceternity / Magic UI

const BRAND = {
  xmr: '#ff6a1a',
  teal: '#2fe6c4',
  green: '#37d99a',
  amber: '#f5b945',
  red: '#f4736b',
  purple: '#a855f7',
  blue: '#3b82f6',
};

const COLORS = Object.values(BRAND);

let activeCanvas = null;
let activeCtx = null;
let animationId = null;
let resizeHandler = null;
let cleanupObserver = null;

function setupCanvas() {
  teardownAnimation();

  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) return null;

  const canvas = document.createElement('canvas');
  canvas.id = 'showpiece-canvas';
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:9999;pointer-events:none;touch-action:none;';
  document.body.appendChild(canvas);
  activeCanvas = canvas;

  const ctx = canvas.getContext('2d');
  activeCtx = ctx;

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    ctx.scale(dpr, dpr);
  }
  resize();
  resizeHandler = resize;
  window.addEventListener('resize', resize);

  cleanupObserver = new MutationObserver(() => {
    if (!document.body.contains(canvas)) {
      teardownAnimation();
    }
  });
  cleanupObserver.observe(document.body, { childList: true });

  return { canvas, ctx, w: window.innerWidth, h: window.innerHeight };
}

function teardownAnimation() {
  if (animationId) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }
  if (resizeHandler) {
    window.removeEventListener('resize', resizeHandler);
    resizeHandler = null;
  }
  if (cleanupObserver) {
    cleanupObserver.disconnect();
    cleanupObserver = null;
  }
  if (activeCanvas && activeCanvas.parentNode) {
    activeCanvas.remove();
  }
  activeCanvas = null;
  activeCtx = null;
}

/* ────────────────────────
   MINT CELEBRATION
   Fireworks + Confetti (multi-shape) + Balloons (gradient + ribbon)
   + Shooting Stars + Ring Waves + Spinning Coins + Star Sparkles
   + Screen Flash + Multi-layer Ambient Glow
   ──────────────────────── */

export function launchMintCelebration() {
  const setup = setupCanvas();
  if (!setup) return;
  const { ctx, w, h } = setup;

  const confetti = [];
  const balloons = [];
  const sparkles = [];
  const fireworks = [];
  const shootingStars = [];
  const ringWaves = [];
  const coins = [];

  const balloonColors = [BRAND.xmr, BRAND.teal, BRAND.green, BRAND.amber, BRAND.purple, BRAND.blue];
  const fwColors = [BRAND.teal, BRAND.green, BRAND.amber, BRAND.purple, BRAND.blue, '#ff69b4', '#ffd700'];

  // ── Confetti (350 pieces, 3 shapes) ──────────────────────────
  const SHAPES = ['rect', 'star', 'ribbon'];
  for (let i = 0; i < 350; i++) {
    const shape = SHAPES[Math.floor(Math.random() * SHAPES.length)];
    confetti.push({
      x: Math.random() * w,
      y: -Math.random() * 400 - 20,
      vx: (Math.random() - 0.5) * 6,
      vy: 2 + Math.random() * 6,
      size: 3 + Math.random() * 7,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      rotation: Math.random() * 360,
      rotSpeed: (Math.random() - 0.5) * 12,
      rotSpeedY: (Math.random() - 0.5) * 8,
      drag: 0.985,
      gravity: 0.08 + Math.random() * 0.18,
      opacity: 0,
      fadeIn: 0.02 + Math.random() * 0.03,
      maxOpacity: 0.7 + Math.random() * 0.3,
      phase: 'in',
      decay: 0.002 + Math.random() * 0.004,
      shape,
      flip: Math.random() * Math.PI * 2,
      flipSpeed: 0.03 + Math.random() * 0.06,
      wobble: Math.random() * Math.PI * 2,
      wobbleSpeed: 0.02 + Math.random() * 0.04,
    });
  }

  // ── Balloons (30, gradient + ribbon string) ──────────────────
  for (let i = 0; i < 30; i++) {
    balloons.push({
      x: Math.random() * w,
      y: h + Math.random() * 300 + 50,
      r: 16 + Math.random() * 18,
      color: balloonColors[Math.floor(Math.random() * balloonColors.length)],
      vy: 0.8 + Math.random() * 2.2,
      swayAmp: 12 + Math.random() * 30,
      swayFreq: 0.0015 + Math.random() * 0.003,
      swayOffset: Math.random() * Math.PI * 2,
      opacity: 0,
      fadeIn: 0.012 + Math.random() * 0.025,
      stringLen: 50 + Math.random() * 50,
      stringSegs: 12,
      ribbon: Math.random() > 0.5,
      ribbonColor: balloonColors[Math.floor(Math.random() * balloonColors.length)],
    });
  }

  // ── Star Sparkles (150, 4-point star shape) ──────────────────
  for (let i = 0; i < 150; i++) {
    sparkles.push({
      x: Math.random() * w,
      y: Math.random() * h,
      r: 1 + Math.random() * 3.5,
      phase: Math.random() * Math.PI * 2,
      speed: 0.02 + Math.random() * 0.05,
      color: ['#fff', BRAND.teal, BRAND.xmr, BRAND.amber][Math.floor(Math.random() * 4)],
      maxOpacity: 0.3 + Math.random() * 0.7,
      driftX: (Math.random() - 0.5) * 0.3,
      driftY: (Math.random() - 0.5) * 0.3,
    });
  }

  // ── Shooting Stars (18, diagonal glowing trails) ─────────────
  for (let i = 0; i < 18; i++) {
    shootingStars.push({
      x: -50 + Math.random() * w * 0.4,
      y: Math.random() * h * 0.5,
      vx: 8 + Math.random() * 12,
      vy: 3 + Math.random() * 6,
      len: 40 + Math.random() * 80,
      color: ['#fff', BRAND.teal, BRAND.amber][Math.floor(Math.random() * 3)],
      opacity: 0,
      fadeIn: 0.04,
      delay: Math.random() * 4000,
      life: 0,
      maxLife: 60 + Math.random() * 40,
    });
  }

  // ── Ring Waves (5 expanding from center) ─────────────────────
  for (let i = 0; i < 5; i++) {
    ringWaves.push({
      x: w / 2 + (Math.random() - 0.5) * w * 0.3,
      y: h / 2 + (Math.random() - 0.5) * h * 0.3,
      r: 0,
      maxR: 200 + Math.random() * 300,
      speed: 3 + Math.random() * 4,
      color: fwColors[Math.floor(Math.random() * fwColors.length)],
      opacity: 0,
      delay: i * 600 + Math.random() * 400,
      life: 0,
    });
  }

  // ── Spinning Coins (25, 3D flip) ─────────────────────────────
  for (let i = 0; i < 25; i++) {
    coins.push({
      x: Math.random() * w,
      y: -Math.random() * 300 - 50,
      vx: (Math.random() - 0.5) * 3,
      vy: 1.5 + Math.random() * 3,
      r: 8 + Math.random() * 8,
      rotation: Math.random() * Math.PI * 2,
      rotSpeed: 0.04 + Math.random() * 0.08,
      opacity: 0,
      fadeIn: 0.02,
      gravity: 0.04 + Math.random() * 0.06,
      color: BRAND.amber,
      edgeColor: '#b8860b',
    });
  }

  // ── Firework burst scheduler ─────────────────────────────────
  const fireworkSchedule = [
    { delay: 200, x: w * 0.3, y: h * 0.3 },
    { delay: 600, x: w * 0.7, y: h * 0.25 },
    { delay: 1100, x: w * 0.5, y: h * 0.4 },
    { delay: 1700, x: w * 0.2, y: h * 0.35 },
    { delay: 2200, x: w * 0.8, y: h * 0.4 },
    { delay: 3000, x: w * 0.4, y: h * 0.2 },
    { delay: 3800, x: w * 0.65, y: h * 0.35 },
    { delay: 4800, x: w * 0.15, y: h * 0.25 },
    { delay: 5600, x: w * 0.85, y: h * 0.3 },
    { delay: 6800, x: w * 0.5, y: h * 0.15 },
  ];

  function spawnFirework(fx, fy) {
    const color = fwColors[Math.floor(Math.random() * fwColors.length)];
    const count = 80 + Math.floor(Math.random() * 50);
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.15;
      const speed = 3 + Math.random() * 7;
      fireworks.push({
        x: fx, y: fy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        r: 1.5 + Math.random() * 3,
        color,
        opacity: 1,
        decay: 0.012 + Math.random() * 0.015,
        gravity: 0.06,
        drag: 0.96,
        life: 0,
        trail: [],
        maxTrail: 8,
        flicker: Math.random() * Math.PI * 2,
      });
    }
    // Ring wave from firework center
    ringWaves.push({
      x: fx, y: fy, r: 0, maxR: 80 + Math.random() * 60,
      speed: 5, color, opacity: 0.6, delay: 0, life: 0,
    });
  }

  let startTime = performance.now();
  let glowPulse = 0;
  let flashOpacity = 0.5;

  // ── Draw functions ───────────────────────────────────────────

  function drawStarShape(cx, cy, spikes, outerR, innerR) {
    ctx.beginPath();
    for (let i = 0; i < spikes * 2; i++) {
      const r = i % 2 === 0 ? outerR : innerR;
      const a = (Math.PI * i) / spikes - Math.PI / 2;
      const px = cx + Math.cos(a) * r;
      const py = cy + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  function drawConfettiPiece(p) {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate((p.rotation * Math.PI) / 180);
    const flipScale = Math.cos(p.flip);
    ctx.scale(1, Math.abs(flipScale) * 0.6 + 0.4);
    ctx.globalAlpha = p.opacity;
    ctx.fillStyle = p.color;
    const s = p.size;

    if (p.shape === 'rect') {
      ctx.fillRect(-s / 2, -s / 4, s, s / 2);
    } else if (p.shape === 'circle') {
      ctx.beginPath();
      ctx.arc(0, 0, s / 2, 0, Math.PI * 2);
      ctx.fill();
    } else if (p.shape === 'star') {
      drawStarShape(0, 0, 5, s / 2, s / 4);
      ctx.fill();
    } else if (p.shape === 'ribbon') {
      ctx.beginPath();
      ctx.moveTo(-s / 2, 0);
      ctx.quadraticCurveTo(0, -s * 0.6, s / 2, 0);
      ctx.quadraticCurveTo(0, s * 0.6, -s / 2, 0);
      ctx.fill();
    }

    // Shine streak on rect
    if (p.shape === 'rect' && flipScale > 0) {
      ctx.globalAlpha = p.opacity * 0.3;
      ctx.fillStyle = '#fff';
      ctx.fillRect(-s / 2, -s / 4, s * 0.3, s / 2);
    }
    ctx.restore();
  }

  function drawBalloon(b) {
    const sway = Math.sin((startTime - performance.now()) * b.swayFreq + b.swayOffset) * b.swayAmp;
    const bx = b.x + sway;
    const by = b.y;

    ctx.save();
    ctx.globalAlpha = b.opacity;

    // Balloon body with radial gradient
    const grad = ctx.createRadialGradient(bx - b.r * 0.3, by - b.r * 0.3, 0, bx, by, b.r);
    grad.addColorStop(0, 'rgba(255,255,255,0.4)');
    grad.addColorStop(0.3, b.color);
    grad.addColorStop(1, b.color);
    ctx.beginPath();
    ctx.ellipse(bx, by, b.r * 0.9, b.r, 0, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    // Specular highlight
    ctx.beginPath();
    ctx.ellipse(bx - b.r * 0.28, by - b.r * 0.3, b.r * 0.22, b.r * 0.15, -0.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fill();

    // Knot
    ctx.beginPath();
    ctx.moveTo(bx - 4, by + b.r * 0.95);
    ctx.lineTo(bx + 4, by + b.r * 0.95);
    ctx.lineTo(bx, by + b.r * 0.95 + 6);
    ctx.closePath();
    ctx.fillStyle = b.color;
    ctx.fill();

    // Ribbon string
    ctx.beginPath();
    ctx.moveTo(bx, by + b.r + 6);
    const segs = b.stringSegs;
    for (let s = 1; s <= segs; s++) {
      const t = s / segs;
      const wave = Math.sin(t * 5 + performance.now() * 0.003 + b.swayOffset) * 6 * t;
      const sx = bx + wave;
      const sy = by + b.r + 6 + t * b.stringLen;
      ctx.lineTo(sx, sy);
    }
    ctx.strokeStyle = b.ribbon ? b.ribbonColor : 'rgba(255,255,255,0.3)';
    ctx.lineWidth = b.ribbon ? 1.5 : 1;
    ctx.stroke();

    ctx.restore();
  }

  function drawSparkle(s) {
    const flicker = (Math.sin(s.phase) + 1) / 2;
    const alpha = flicker * s.maxOpacity;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = s.color;

    // 4-point star
    drawStarShape(s.x, s.y, 4, s.r * 2, s.r * 0.4);
    ctx.fill();

    // Glow
    ctx.globalAlpha = alpha * 0.25;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r * 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawFirework(f) {
    // Trail
    for (let i = 0; i < f.trail.length; i++) {
      const t = f.trail[i];
      const trailAlpha = (i / f.trail.length) * f.opacity * 0.5;
      ctx.save();
      ctx.globalAlpha = trailAlpha;
      ctx.fillStyle = f.color;
      ctx.beginPath();
      ctx.arc(t.x, t.y, f.r * (i / f.trail.length), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    // Core
    const flicker = (Math.sin(f.life * 0.3 + f.flicker) + 1) / 2;
    ctx.save();
    ctx.globalAlpha = f.opacity * (0.6 + flicker * 0.4);
    ctx.fillStyle = f.color;
    ctx.beginPath();
    ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
    ctx.fill();
    // Glow
    ctx.globalAlpha = f.opacity * 0.3 * flicker;
    ctx.beginPath();
    ctx.arc(f.x, f.y, f.r * 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawShootingStar(s) {
    if (s.opacity <= 0) return;
    ctx.save();
    // Trail
    const grad = ctx.createLinearGradient(s.x, s.y, s.x - s.len, s.y - s.len * (s.vy / s.vx));
    grad.addColorStop(0, s.color);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2.5;
    ctx.globalAlpha = s.opacity;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(s.x - s.len, s.y - s.len * (s.vy / s.vx));
    ctx.stroke();
    // Head
    ctx.fillStyle = s.color;
    ctx.beginPath();
    ctx.arc(s.x, s.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
    // Head glow
    ctx.globalAlpha = s.opacity * 0.4;
    ctx.beginPath();
    ctx.arc(s.x, s.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawRingWave(r) {
    if (r.opacity <= 0 || r.r <= 0) return;
    ctx.save();
    ctx.globalAlpha = r.opacity;
    ctx.strokeStyle = r.color;
    ctx.lineWidth = 2 + (1 - r.r / r.maxR) * 3;
    ctx.beginPath();
    ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
    ctx.stroke();
    // Inner glow ring
    ctx.globalAlpha = r.opacity * 0.3;
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function drawCoin(c) {
    const flip = Math.cos(c.rotation);
    const scaleX = Math.abs(flip);
    ctx.save();
    ctx.globalAlpha = c.opacity;
    ctx.translate(c.x, c.y);

    // Edge (3D depth when nearly side-on)
    if (scaleX < 0.3) {
      ctx.fillStyle = c.edgeColor;
      ctx.fillRect(-c.r * scaleX, -c.r * 0.15, c.r * 2 * scaleX, c.r * 0.3);
    }

    // Face
    ctx.scale(scaleX, 1);
    const grad = ctx.createRadialGradient(-c.r * 0.3, -c.r * 0.3, 0, 0, 0, c.r);
    grad.addColorStop(0, '#ffe680');
    grad.addColorStop(0.5, c.color);
    grad.addColorStop(1, c.edgeColor);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, c.r, 0, Math.PI * 2);
    ctx.fill();

    // Inner ring
    ctx.strokeStyle = c.edgeColor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, c.r * 0.7, 0, Math.PI * 2);
    ctx.stroke();

    // "W" mark when face is visible
    if (flip > 0) {
      ctx.fillStyle = c.edgeColor;
      ctx.font = `bold ${c.r}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('W', 0, 1);
    }

    // Shine
    ctx.globalAlpha = c.opacity * 0.4;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.ellipse(-c.r * 0.3, -c.r * 0.3, c.r * 0.25, c.r * 0.12, -0.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  // ── Main animate loop ────────────────────────────────────────
  function animate() {
    const now = performance.now();
    const elapsed = now - startTime;
    ctx.clearRect(0, 0, w, h);

    // Screen flash (first 300ms)
    if (flashOpacity > 0) {
      ctx.save();
      ctx.globalAlpha = flashOpacity;
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
      flashOpacity -= 0.02;
    }

    // Multi-layer ambient glow
    glowPulse = (Math.sin(elapsed * 0.0015) + 1) / 2;
    const g1 = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.min(w, h) * 0.7);
    g1.addColorStop(0, `rgba(47, 230, 196, ${0.05 + glowPulse * 0.05})`);
    g1.addColorStop(0.4, `rgba(255, 106, 26, ${0.03 + glowPulse * 0.03})`);
    g1.addColorStop(0.7, `rgba(168, 85, 247, ${0.02 + glowPulse * 0.02})`);
    g1.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g1;
    ctx.fillRect(0, 0, w, h);

    // Second glow layer (warm center)
    const g2 = ctx.createRadialGradient(w / 2, h * 0.4, 0, w / 2, h * 0.4, Math.min(w, h) * 0.4);
    g2.addColorStop(0, `rgba(255, 215, 0, ${0.04 + glowPulse * 0.03})`);
    g2.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g2;
    ctx.fillRect(0, 0, w, h);

    // Schedule fireworks
    for (const fw of fireworkSchedule) {
      if (elapsed >= fw.delay && !fw._fired) {
        fw._fired = true;
        spawnFirework(fw.x, fw.y);
      }
    }

    let active = 0;

    // Ring waves (behind everything)
    for (const r of ringWaves) {
      if (elapsed < r.delay) { active++; continue; }
      r.life++;
      r.r += r.speed;
      r.opacity = Math.max(0, 0.6 * (1 - r.r / r.maxR));
      drawRingWave(r);
      if (r.r < r.maxR) active++;
    }

    // Balloons
    for (const b of balloons) {
      b.y -= b.vy;
      if (b.opacity < 1) b.opacity = Math.min(1, b.opacity + b.fadeIn);
      drawBalloon(b);
      if (b.y > -b.r * 3) active++;
    }

    // Shooting stars
    for (const s of shootingStars) {
      if (elapsed < s.delay) { active++; continue; }
      s.life++;
      if (s.life < 10) s.opacity = Math.min(1, s.opacity + s.fadeIn);
      else if (s.life > s.maxLife - 15) s.opacity = Math.max(0, s.opacity - 0.03);
      s.x += s.vx;
      s.y += s.vy;
      drawShootingStar(s);
      if (s.life < s.maxLife && s.x < w + 100) active++;
    }

    // Fireworks
    for (const f of fireworks) {
      f.trail.push({ x: f.x, y: f.y });
      if (f.trail.length > f.maxTrail) f.trail.shift();
      f.x += f.vx;
      f.y += f.vy;
      f.vx *= f.drag;
      f.vy *= f.drag;
      f.vy += f.gravity;
      f.opacity -= f.decay;
      f.life++;
      drawFirework(f);
      if (f.opacity > 0) active++;
    }

    // Confetti
    for (const p of confetti) {
      if (p.phase === 'out' && p.opacity <= 0) continue;
      active++;
      p.wobble += p.wobbleSpeed;
      p.x += p.vx + Math.sin(p.wobble) * 0.5;
      p.y += p.vy;
      p.vy += p.gravity;
      p.vx *= p.drag;
      p.vy *= p.drag;
      p.rotation += p.rotSpeed;
      p.flip += p.flipSpeed;

      if (p.phase === 'in') {
        p.opacity += p.fadeIn;
        if (p.opacity >= p.maxOpacity) { p.opacity = p.maxOpacity; p.phase = 'falling'; }
      } else if (p.phase === 'falling') {
        p.opacity -= p.decay;
        if (p.opacity <= 0) { p.opacity = 0; p.phase = 'out'; }
      }
      drawConfettiPiece(p);
    }

    // Coins
    for (const c of coins) {
      c.x += c.vx;
      c.y += c.vy;
      c.vy += c.gravity;
      c.rotation += c.rotSpeed;
      if (c.opacity < 1) c.opacity = Math.min(1, c.opacity + c.fadeIn);
      drawCoin(c);
      if (c.y < h + 50) active++;
    }

    // Sparkles (on top)
    for (const s of sparkles) {
      s.phase += s.speed;
      s.x += s.driftX;
      s.y += s.driftY;
      if (s.x < 0) s.x = w; if (s.x > w) s.x = 0;
      if (s.y < 0) s.y = h; if (s.y > h) s.y = 0;
      drawSparkle(s);
      active++;
    }

    if (active > 0 && elapsed < 15000) {
      animationId = requestAnimationFrame(animate);
    } else {
      teardownAnimation();
    }
  }

  animate();
}

/* ────────────────────────
   BURN ANIMATION
   Fireballs + Fire Rain + Fire Vortex + Molten Blobs + Fissure Cracks
   + Trailing Embers + Smoke Plumes + Spark Showers + Burning Debris
   + Multi-layer Heat Shimmer + Edge Vignette + Triple-layer Fire Glow
   ──────────────────────── */

export function launchBurnAnimation() {
  const setup = setupCanvas();
  if (!setup) return;
  const { ctx, w, h } = setup;

  const embers = [];
  const smoke = [];
  const ash = [];
  const fireballs = [];
  const fireRain = [];
  const moltenBlobs = [];
  const sparks = [];
  const debris = [];
  const fissures = [];

  const fireColors = ['#ff6a1a', '#ff4500', '#ff8c00', '#ff6347', '#ffd700', '#ff1744', '#ff5722'];
  const smokeColors = ['rgba(80,80,80,', 'rgba(60,60,60,', 'rgba(100,100,100,', 'rgba(50,50,50,'];

  // ── Trailing Embers (350) ────────────────────────────────────
  for (let i = 0; i < 350; i++) {
    embers.push({
      x: w / 2 + (Math.random() - 0.5) * w * 0.9,
      y: h + Math.random() * 150,
      vx: (Math.random() - 0.5) * 3,
      vy: -(1.5 + Math.random() * 6),
      r: 1 + Math.random() * 4,
      color: fireColors[Math.floor(Math.random() * fireColors.length)],
      flickerSpeed: 0.04 + Math.random() * 0.12,
      flickerPhase: Math.random() * Math.PI * 2,
      maxOpacity: 0.5 + Math.random() * 0.5,
      heatRise: 0.02 + Math.random() * 0.06,
      life: 0,
      maxLife: 200 + Math.random() * 400,
      trail: [],
      maxTrail: 5 + Math.floor(Math.random() * 8),
    });
  }

  // ── Smoke Plumes (45) ────────────────────────────────────────
  for (let i = 0; i < 45; i++) {
    smoke.push({
      x: w / 2 + (Math.random() - 0.5) * w * 0.6,
      y: h - Math.random() * 250,
      vx: (Math.random() - 0.5) * 1.2,
      vy: -(0.4 + Math.random() * 1.8),
      r: 25 + Math.random() * 55,
      opacity: 0,
      fadeIn: 0.004 + Math.random() * 0.012,
      maxOpacity: 0.06 + Math.random() * 0.14,
      life: 0,
      maxLife: 400 + Math.random() * 400,
      smokeColor: smokeColors[Math.floor(Math.random() * smokeColors.length)],
      turbulence: 0.2 + Math.random() * 0.5,
    });
  }

  // ── Burning Debris (80, spinning glowing chunks) ─────────────
  for (let i = 0; i < 80; i++) {
    debris.push({
      x: w / 2 + (Math.random() - 0.5) * w * 0.9,
      y: h - Math.random() * h * 0.3,
      vx: (Math.random() - 0.5) * 2.5,
      vy: -(0.5 + Math.random() * 2.5),
      size: 1.5 + Math.random() * 4,
      rotation: Math.random() * 360,
      rotSpeed: (Math.random() - 0.5) * 5,
      opacity: 0.3 + Math.random() * 0.5,
      life: 0,
      maxLife: 250 + Math.random() * 450,
      glowColor: fireColors[Math.floor(Math.random() * fireColors.length)],
    });
  }

  // ── Molten Lava Blobs (20, large dripping) ───────────────────
  for (let i = 0; i < 20; i++) {
    moltenBlobs.push({
      x: w / 2 + (Math.random() - 0.5) * w * 0.7,
      y: h + Math.random() * 100,
      vx: (Math.random() - 0.5) * 1.5,
      vy: -(1 + Math.random() * 3),
      r: 6 + Math.random() * 14,
      life: 0,
      maxLife: 150 + Math.random() * 250,
      wobble: Math.random() * Math.PI * 2,
      wobbleSpeed: 0.02 + Math.random() * 0.04,
      stretch: 0.6 + Math.random() * 0.5,
    });
  }

  // ── Fire Rain Streams (40, falling from top) ─────────────────
  for (let i = 0; i < 40; i++) {
    fireRain.push({
      x: Math.random() * w,
      y: -Math.random() * h * 0.5 - 20,
      vx: (Math.random() - 0.5) * 1,
      vy: 3 + Math.random() * 6,
      len: 15 + Math.random() * 40,
      color: fireColors[Math.floor(Math.random() * fireColors.length)],
      opacity: 0,
      fadeIn: 0.03,
      delay: Math.random() * 3000,
      life: 0,
      maxLife: 120 + Math.random() * 80,
    });
  }

  // ── Fissure Cracks (8, branching from bottom) ────────────────
  for (let i = 0; i < 8; i++) {
    const startX = w * (0.1 + Math.random() * 0.8);
    const segments = [];
    let cx = startX, cy = h;
    const segCount = 5 + Math.floor(Math.random() * 5);
    for (let s = 0; s < segCount; s++) {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.2;
      const len = 30 + Math.random() * 80;
      const nx = cx + Math.cos(angle) * len;
      const ny = cy + Math.sin(angle) * len;
      segments.push({ x1: cx, y1: cy, x2: nx, y2: ny, width: 3 - s * 0.3 });
      cx = nx; cy = ny;
      if (cy < h * 0.2) break;
    }
    fissures.push({
      segments,
      opacity: 0,
      fadeIn: 0.015 + Math.random() * 0.02,
      delay: Math.random() * 1500,
      flicker: Math.random() * Math.PI * 2,
    });
  }

  // ── Fireball explosion schedule ──────────────────────────────
  const fireballSchedule = [
    { delay: 300, x: w * 0.5, y: h * 0.65 },
    { delay: 900, x: w * 0.3, y: h * 0.55 },
    { delay: 1600, x: w * 0.7, y: h * 0.6 },
    { delay: 2500, x: w * 0.5, y: h * 0.45 },
    { delay: 3500, x: w * 0.2, y: h * 0.5 },
    { delay: 4500, x: w * 0.8, y: h * 0.55 },
    { delay: 5800, x: w * 0.4, y: h * 0.4 },
    { delay: 7200, x: w * 0.6, y: h * 0.5 },
    { delay: 9000, x: w * 0.5, y: h * 0.35 },
  ];

  function spawnFireball(fx, fy) {
    const color = fireColors[Math.floor(Math.random() * fireColors.length)];
    const count = 60 + Math.floor(Math.random() * 40);
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.2;
      const speed = 2 + Math.random() * 8;
      fireballs.push({
        x: fx, y: fy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 1,
        r: 2 + Math.random() * 5,
        color,
        opacity: 1,
        decay: 0.01 + Math.random() * 0.018,
        gravity: 0.08,
        drag: 0.95,
        life: 0,
        trail: [],
        maxTrail: 10,
        flicker: Math.random() * Math.PI * 2,
      });
    }
    // Spark shower from explosion
    for (let i = 0; i < 30; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 1 + Math.random() * 5;
      sparks.push({
        x: fx, y: fy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 2,
        r: 0.8 + Math.random() * 1.5,
        color: ['#fff', '#ffd700', color][Math.floor(Math.random() * 3)],
        opacity: 1,
        decay: 0.02 + Math.random() * 0.03,
        gravity: 0.1,
        life: 0,
        maxLife: 60 + Math.random() * 40,
      });
    }
  }

  let startTime = performance.now();
  let glowPulse = 0;
  let flashOpacity = 0.4;
  let vortexAngle = 0;

  // ── Draw functions ───────────────────────────────────────────

  function drawEmber(e) {
    const flicker = (Math.sin(e.life * e.flickerSpeed + e.flickerPhase) + 1) / 2;
    const alpha = Math.max(0, (1 - e.life / e.maxLife) * e.maxOpacity * flicker);

    // Trail
    for (let i = 0; i < e.trail.length; i++) {
      const t = e.trail[i];
      const ta = (i / e.trail.length) * alpha * 0.4;
      ctx.save();
      ctx.globalAlpha = ta;
      ctx.fillStyle = e.color;
      ctx.beginPath();
      ctx.arc(t.x, t.y, e.r * (i / e.trail.length) * 0.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = e.color;
    ctx.beginPath();
    ctx.arc(e.x, e.y, e.r, 0, Math.PI * 2);
    ctx.fill();

    // Glow
    ctx.globalAlpha = alpha * 0.35;
    ctx.beginPath();
    ctx.arc(e.x, e.y, e.r * 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawSmoke(s) {
    const alpha = Math.max(0, Math.min(s.opacity, (1 - s.life / s.maxLife) * s.maxOpacity));
    ctx.save();
    ctx.globalAlpha = alpha;
    const grad = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r);
    grad.addColorStop(0, s.smokeColor + '0.5)');
    grad.addColorStop(0.5, s.smokeColor + '0.2)');
    grad.addColorStop(1, s.smokeColor + '0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawDebris(a) {
    const alpha = Math.max(0, a.opacity * (1 - a.life / a.maxLife));
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(a.x, a.y);
    ctx.rotate((a.rotation * Math.PI) / 180);
    // Glowing edge
    ctx.shadowColor = a.glowColor;
    ctx.shadowBlur = 8;
    ctx.fillStyle = '#666';
    ctx.fillRect(-a.size / 2, -a.size / 2, a.size, a.size);
    ctx.shadowBlur = 0;
    // Hot core
    ctx.globalAlpha = alpha * 0.6;
    ctx.fillStyle = a.glowColor;
    ctx.fillRect(-a.size / 4, -a.size / 4, a.size / 2, a.size / 2);
    ctx.restore();
  }

  function drawMoltenBlob(m) {
    const alpha = Math.max(0, 1 - m.life / m.maxLife);
    const flicker = (Math.sin(m.life * 0.08) + 1) / 2;
    ctx.save();
    ctx.globalAlpha = alpha * (0.7 + flicker * 0.3);
    ctx.translate(m.x, m.y);

    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, m.r);
    grad.addColorStop(0, '#fff8e0');
    grad.addColorStop(0.2, '#ffd700');
    grad.addColorStop(0.5, '#ff6a1a');
    grad.addColorStop(0.8, '#ff2200');
    grad.addColorStop(1, '#8b0000');
    ctx.fillStyle = grad;

    ctx.beginPath();
    ctx.ellipse(0, 0, m.r, m.r * m.stretch, 0, 0, Math.PI * 2);
    ctx.fill();

    // Drip trail
    ctx.globalAlpha = alpha * 0.3;
    ctx.fillStyle = '#ff6a1a';
    ctx.beginPath();
    ctx.ellipse(0, m.r * m.stretch * 0.8, m.r * 0.3, m.r * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  function drawFireRain(f) {
    if (f.opacity <= 0) return;
    ctx.save();
    const grad = ctx.createLinearGradient(f.x, f.y, f.x - f.vx * 2, f.y - f.len);
    grad.addColorStop(0, f.color);
    grad.addColorStop(0.5, f.color);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2;
    ctx.globalAlpha = f.opacity;
    ctx.beginPath();
    ctx.moveTo(f.x, f.y);
    ctx.lineTo(f.x - f.vx * 2, f.y - f.len);
    ctx.stroke();
    // Glow
    ctx.globalAlpha = f.opacity * 0.3;
    ctx.lineWidth = 6;
    ctx.stroke();
    // Head
    ctx.globalAlpha = f.opacity;
    ctx.fillStyle = f.color;
    ctx.beginPath();
    ctx.arc(f.x, f.y, 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawFireball(f) {
    // Trail
    for (let i = 0; i < f.trail.length; i++) {
      const t = f.trail[i];
      const ta = (i / f.trail.length) * f.opacity * 0.5;
      ctx.save();
      ctx.globalAlpha = ta;
      ctx.fillStyle = f.color;
      ctx.beginPath();
      ctx.arc(t.x, t.y, f.r * (i / f.trail.length), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    const flicker = (Math.sin(f.life * 0.3 + f.flicker) + 1) / 2;
    ctx.save();
    ctx.globalAlpha = f.opacity * (0.6 + flicker * 0.4);
    const grad = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, f.r);
    grad.addColorStop(0, '#fff');
    grad.addColorStop(0.3, f.color);
    grad.addColorStop(1, 'rgba(139,0,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
    ctx.fill();
    // Outer glow
    ctx.globalAlpha = f.opacity * 0.3 * flicker;
    ctx.beginPath();
    ctx.arc(f.x, f.y, f.r * 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawSpark(s) {
    const alpha = s.opacity * Math.max(0, 1 - s.life / s.maxLife);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = s.color;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = alpha * 0.4;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r * 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawFissure(f) {
    if (f.opacity <= 0) return;
    const flicker = (Math.sin(performance.now() * 0.005 + f.flicker) + 1) / 2;
    ctx.save();
    for (const seg of f.segments) {
      ctx.globalAlpha = f.opacity * (0.6 + flicker * 0.4);
      // Outer glow
      ctx.strokeStyle = '#ff4500';
      ctx.lineWidth = seg.width + 6;
      ctx.globalAlpha = f.opacity * 0.15 * flicker;
      ctx.beginPath();
      ctx.moveTo(seg.x1, seg.y1);
      ctx.lineTo(seg.x2, seg.y2);
      ctx.stroke();
      // Core
      ctx.globalAlpha = f.opacity * (0.7 + flicker * 0.3);
      ctx.strokeStyle = '#ffaa00';
      ctx.lineWidth = seg.width;
      ctx.beginPath();
      ctx.moveTo(seg.x1, seg.y1);
      ctx.lineTo(seg.x2, seg.y2);
      ctx.stroke();
      // White hot center
      ctx.globalAlpha = f.opacity * flicker * 0.8;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = seg.width * 0.4;
      ctx.beginPath();
      ctx.moveTo(seg.x1, seg.y1);
      ctx.lineTo(seg.x2, seg.y2);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawFireVortex() {
    const t = (performance.now() - startTime) * 0.001;
    const cx = w / 2;
    const cy = h * 0.55;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (let i = 0; i < 40; i++) {
      const angle = vortexAngle + i * 0.3;
      const radius = 20 + i * 8;
      const vx = cx + Math.cos(angle) * radius;
      const vy = cy - i * 12 + Math.sin(angle * 2) * 10;
      const size = 8 + Math.sin(t * 3 + i * 0.5) * 4;
      const alpha = Math.max(0, 0.15 - i * 0.003) * (0.5 + Math.sin(t * 2 + i) * 0.5);
      const grad = ctx.createRadialGradient(vx, vy, 0, vx, vy, size);
      const hue = i < 15 ? '#ff6a1a' : i < 30 ? '#ff4500' : '#ff2200';
      grad.addColorStop(0, `rgba(255,200,100,${alpha})`);
      grad.addColorStop(0.4, hue + Math.floor(alpha * 255).toString(16).padStart(2, '0'));
      grad.addColorStop(1, 'rgba(139,0,0,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(vx, vy, size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawHeatShimmer() {
    const t = (performance.now() - startTime) * 0.001;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (let i = 0; i < 8; i++) {
      const hx = w / 2 + Math.sin(t * 0.5 + i * 1.2) * w * 0.2;
      const hy = h * 0.7 - i * 50;
      const hr = 50 + Math.sin(t + i) * 25;
      const grad = ctx.createRadialGradient(hx, hy, 0, hx, hy, hr);
      grad.addColorStop(0, `rgba(255, 100, 20, ${0.04 + Math.sin(t * 2 + i) * 0.02})`);
      grad.addColorStop(1, 'rgba(255,60,0,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(hx, hy, hr, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawEdgeVignette() {
    const t = (performance.now() - startTime) * 0.001;
    const pulse = (Math.sin(t * 1.5) + 1) / 2;
    ctx.save();
    const grad = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.7);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(0.7, 'rgba(0,0,0,0)');
    grad.addColorStop(1, `rgba(255, 60, 0, ${0.08 + pulse * 0.06})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  // ── Main animate loop ────────────────────────────────────────
  function animate() {
    const now = performance.now();
    const elapsed = now - startTime;
    ctx.clearRect(0, 0, w, h);

    // Screen flash (first 200ms)
    if (flashOpacity > 0) {
      ctx.save();
      ctx.globalAlpha = flashOpacity;
      ctx.fillStyle = 'rgba(255, 120, 20, 0.9)';
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
      flashOpacity -= 0.025;
    }

    // Burst phase
    let burstPhase = 0;
    if (elapsed < 600) burstPhase = 0;
    else if (elapsed < 5000) burstPhase = 1;
    else burstPhase = 2;

    // Triple-layer fire glow
    glowPulse = (Math.sin(elapsed * 0.002) + 1) / 2;
    const glowMul = burstPhase === 1 ? 1.5 : burstPhase === 0 ? 0.6 : 0.4;

    // Bottom fire glow
    const g1 = ctx.createRadialGradient(w / 2, h, 0, w / 2, h, w * 0.7);
    g1.addColorStop(0, `rgba(255,80,0,${0.12 * glowMul + glowPulse * 0.04})`);
    g1.addColorStop(0.4, `rgba(200,50,0,${0.06 * glowMul})`);
    g1.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g1;
    ctx.fillRect(0, 0, w, h);

    // Center inferno glow
    const g2 = ctx.createRadialGradient(w / 2, h * 0.5, 0, w / 2, h * 0.5, Math.min(w, h) * 0.5);
    g2.addColorStop(0, `rgba(255,140,0,${0.06 * glowMul + glowPulse * 0.03})`);
    g2.addColorStop(0.5, `rgba(255,60,0,${0.03 * glowMul})`);
    g2.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g2;
    ctx.fillRect(0, 0, w, h);

    // Top heat glow
    const g3 = ctx.createRadialGradient(w / 2, 0, 0, w / 2, 0, w * 0.4);
    g3.addColorStop(0, `rgba(255,100,0,${0.04 * glowMul})`);
    g3.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g3;
    ctx.fillRect(0, 0, w, h);

    drawHeatShimmer();
    drawEdgeVignette();

    // Schedule fireballs
    for (const fb of fireballSchedule) {
      if (elapsed >= fb.delay && !fb._fired) {
        fb._fired = true;
        spawnFireball(fb.x, fb.y);
      }
    }

    // Fissure cracks
    for (const f of fissures) {
      if (elapsed < f.delay) continue;
      if (f.opacity < 1) f.opacity = Math.min(1, f.opacity + f.fadeIn);
      drawFissure(f);
    }

    // Fire vortex (visible during peak)
    if (burstPhase >= 1) {
      vortexAngle += 0.04;
      drawFireVortex();
    }

    let active = 0;

    // Smoke (behind everything)
    for (const s of smoke) {
      s.x += s.vx + Math.sin(s.life * 0.01) * s.turbulence;
      s.y += s.vy;
      s.r += 0.06;
      if (s.opacity < s.maxOpacity) s.opacity += s.fadeIn;
      s.life++;
      drawSmoke(s);
      if (s.life < s.maxLife) active++;
    }

    // Molten blobs
    for (const m of moltenBlobs) {
      m.wobble += m.wobbleSpeed;
      m.x += m.vx + Math.sin(m.wobble) * 0.8;
      m.y += m.vy;
      m.vy += 0.02;
      m.life++;
      drawMoltenBlob(m);
      if (m.life < m.maxLife) active++;
    }

    // Fire rain
    for (const f of fireRain) {
      if (elapsed < f.delay) { active++; continue; }
      f.life++;
      if (f.life < 10) f.opacity = Math.min(1, f.opacity + f.fadeIn);
      else if (f.life > f.maxLife - 15) f.opacity = Math.max(0, f.opacity - 0.04);
      f.x += f.vx;
      f.y += f.vy;
      drawFireRain(f);
      if (f.life < f.maxLife && f.y < h + 50) active++;
    }

    // Fireballs (explosions)
    for (const f of fireballs) {
      f.trail.push({ x: f.x, y: f.y });
      if (f.trail.length > f.maxTrail) f.trail.shift();
      f.x += f.vx;
      f.y += f.vy;
      f.vx *= f.drag;
      f.vy *= f.drag;
      f.vy += f.gravity;
      f.opacity -= f.decay;
      f.life++;
      drawFireball(f);
      if (f.opacity > 0) active++;
    }

    // Embers
    for (const e of embers) {
      e.trail.push({ x: e.x, y: e.y });
      if (e.trail.length > e.maxTrail) e.trail.shift();
      e.x += e.vx + Math.sin(e.life * 0.02 + e.flickerPhase) * 0.6;
      e.y += e.vy;
      e.vy += e.heatRise;
      e.life++;
      drawEmber(e);
      if (e.life < e.maxLife) active++;
    }

    // Burning debris
    for (const a of debris) {
      a.x += a.vx + Math.sin(a.life * 0.015) * 0.5;
      a.y += a.vy;
      a.vy += 0.01;
      a.rotation += a.rotSpeed;
      a.life++;
      drawDebris(a);
      if (a.life < a.maxLife) active++;
    }

    // Spark showers (on top)
    for (const s of sparks) {
      s.x += s.vx;
      s.y += s.vy;
      s.vy += s.gravity;
      s.opacity -= s.decay;
      s.life++;
      drawSpark(s);
      if (s.opacity > 0) active++;
    }

    if (active > 0 && elapsed < 15000) {
      animationId = requestAnimationFrame(animate);
    } else {
      teardownAnimation();
    }
  }

  animate();
}
