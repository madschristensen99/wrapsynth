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
   Balloons + Confetti + Sparkles
   ──────────────────────── */

export function launchMintCelebration() {
  const setup = setupCanvas();
  if (!setup) return;
  const { ctx, w, h } = setup;

  const particles = [];
  const balloons = [];
  const sparkles = [];

  // Balloons
  const balloonColors = [BRAND.xmr, BRAND.teal, BRAND.green, BRAND.amber, BRAND.purple, BRAND.blue];
  for (let i = 0; i < 14; i++) {
    balloons.push({
      x: Math.random() * w,
      y: h + Math.random() * 200 + 50,
      r: 18 + Math.random() * 14,
      color: balloonColors[Math.floor(Math.random() * balloonColors.length)],
      vy: 1.2 + Math.random() * 1.8,
      swayAmp: 15 + Math.random() * 25,
      swayFreq: 0.002 + Math.random() * 0.003,
      swayOffset: Math.random() * Math.PI * 2,
      opacity: 0,
      fadeIn: 0.015 + Math.random() * 0.02,
      stringLen: 40 + Math.random() * 30,
    });
  }

  // Confetti
  for (let i = 0; i < 300; i++) {
    particles.push({
      x: Math.random() * w,
      y: -Math.random() * 300 - 20,
      vx: (Math.random() - 0.5) * 4,
      vy: 3 + Math.random() * 5,
      size: 3 + Math.random() * 5,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      rotation: Math.random() * 360,
      rotSpeed: (Math.random() - 0.5) * 10,
      drag: 0.99,
      gravity: 0.1 + Math.random() * 0.15,
      opacity: 0,
      fadeIn: 0.02 + Math.random() * 0.02,
      maxOpacity: 0.6 + Math.random() * 0.4,
      phase: 'in',
      decay: 0.003 + Math.random() * 0.005,
    });
  }

  // Sparkles
  for (let i = 0; i < 80; i++) {
    sparkles.push({
      x: Math.random() * w,
      y: Math.random() * h,
      r: 1 + Math.random() * 2.5,
      phase: Math.random() * Math.PI * 2,
      speed: 0.03 + Math.random() * 0.04,
      color: ['#fff', BRAND.teal, BRAND.xmr][Math.floor(Math.random() * 3)],
      maxOpacity: 0.4 + Math.random() * 0.6,
    });
  }

  let startTime = performance.now();
  let glowPulse = 0;

  function drawBalloon(b) {
    const sway = Math.sin((startTime - performance.now()) * b.swayFreq + b.swayOffset) * b.swayAmp;
    const bx = b.x + sway;
    const by = b.y;

    ctx.save();
    ctx.globalAlpha = b.opacity;

    // Balloon body (elliptical with highlight)
    ctx.beginPath();
    ctx.ellipse(bx, by, b.r * 0.9, b.r, 0, 0, Math.PI * 2);
    ctx.fillStyle = b.color;
    ctx.fill();

    // Specular highlight
    ctx.beginPath();
    ctx.ellipse(bx - b.r * 0.25, by - b.r * 0.25, b.r * 0.25, b.r * 0.18, -0.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fill();

    // String
    ctx.beginPath();
    ctx.moveTo(bx, by + b.r);
    const segs = 8;
    for (let s = 1; s <= segs; s++) {
      const t = s / segs;
      const sx = bx + Math.sin(t * 4 + performance.now() * 0.003 + b.swayOffset) * 4;
      const sy = by + b.r + t * b.stringLen;
      ctx.lineTo(sx, sy);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.restore();
  }

  function drawConfetti(p) {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate((p.rotation * Math.PI) / 180);
    ctx.globalAlpha = p.opacity;
    ctx.fillStyle = p.color;

    // Draw confetti strip
    const s = p.size;
    ctx.beginPath();
    ctx.rect(-s / 2, -s / 4, s, s / 2);
    ctx.fill();

    ctx.restore();
  }

  function drawSparkle(s) {
    const flicker = (Math.sin(s.phase) + 1) / 2;
    ctx.save();
    ctx.globalAlpha = flicker * s.maxOpacity;
    ctx.fillStyle = s.color;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
    // Glow
    ctx.globalAlpha = flicker * s.maxOpacity * 0.3;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r * 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function animate() {
    const now = performance.now();
    const elapsed = now - startTime;
    ctx.clearRect(0, 0, w, h);

    // Radial glow pulse behind everything
    glowPulse = (Math.sin(elapsed * 0.002) + 1) / 2;
    const gradient = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.min(w, h) * 0.6);
    gradient.addColorStop(0, `rgba(47, 230, 196, ${0.04 + glowPulse * 0.04})`);
    gradient.addColorStop(0.5, `rgba(255, 106, 26, ${0.02 + glowPulse * 0.02})`);
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);

    let active = 0;

    // Update & draw balloons
    for (const b of balloons) {
      b.y -= b.vy;
      if (b.opacity < 1) b.opacity = Math.min(1, b.opacity + b.fadeIn);
      drawBalloon(b);
      if (b.y > -b.r * 2) active++;
    }

    // Update & draw confetti
    for (const p of particles) {
      if (p.phase === 'out' && p.opacity <= 0) continue;
      active++;

      p.x += p.vx;
      p.y += p.vy;
      p.vy += p.gravity;
      p.vx *= p.drag;
      p.vy *= p.drag;
      p.rotation += p.rotSpeed;

      if (p.phase === 'in') {
        p.opacity += p.fadeIn;
        if (p.opacity >= p.maxOpacity) {
          p.opacity = p.maxOpacity;
          p.phase = 'falling';
        }
      } else if (p.phase === 'falling') {
        p.opacity -= p.decay;
        if (p.opacity <= 0) {
          p.opacity = 0;
          p.phase = 'out';
        }
      }

      drawConfetti(p);
    }

    // Update & draw sparkles
    for (const s of sparkles) {
      s.phase += s.speed;
      drawSparkle(s);
      active++;
    }

    if (active > 0 && elapsed < 12000) {
      animationId = requestAnimationFrame(animate);
    } else {
      teardownAnimation();
    }
  }

  animate();
}

/* ────────────────────────
   BURN ANIMATION
   Rising fire embers + smoke + heat shimmer
   ──────────────────────── */

export function launchBurnAnimation() {
  const setup = setupCanvas();
  if (!setup) return;
  const { ctx, w, h } = setup;

  const embers = [];
  const smoke = [];
  const ash = [];

  // Fire embers
  for (let i = 0; i < 180; i++) {
    embers.push({
      x: w / 2 + (Math.random() - 0.5) * w * 0.8,
      y: h + Math.random() * 100,
      vx: (Math.random() - 0.5) * 2,
      vy: -(2 + Math.random() * 5),
      r: 1.5 + Math.random() * 4,
      color: ['#ff6a1a', '#ff4500', '#ff8c00', '#ff6347', '#ffd700'][Math.floor(Math.random() * 5)],
      flickerSpeed: 0.05 + Math.random() * 0.1,
      flickerPhase: Math.random() * Math.PI * 2,
      maxOpacity: 0.6 + Math.random() * 0.4,
      heatRise: 0.03 + Math.random() * 0.05,
      life: 0,
      maxLife: 200 + Math.random() * 300,
    });
  }

  // Smoke wisps
  for (let i = 0; i < 25; i++) {
    smoke.push({
      x: w / 2 + (Math.random() - 0.5) * w * 0.5,
      y: h - Math.random() * 200,
      vx: (Math.random() - 0.5) * 0.8,
      vy: -(0.5 + Math.random() * 1.2),
      r: 20 + Math.random() * 40,
      opacity: 0,
      fadeIn: 0.005 + Math.random() * 0.01,
      maxOpacity: 0.08 + Math.random() * 0.12,
      life: 0,
      maxLife: 400 + Math.random() * 300,
    });
  }

  // Ash particles
  for (let i = 0; i < 60; i++) {
    ash.push({
      x: w / 2 + (Math.random() - 0.5) * w * 0.9,
      y: h - Math.random() * h * 0.3,
      vx: (Math.random() - 0.5) * 1.5,
      vy: -(0.3 + Math.random() * 1.5),
      size: 1 + Math.random() * 2.5,
      rotation: Math.random() * 360,
      rotSpeed: (Math.random() - 0.5) * 3,
      opacity: 0.3 + Math.random() * 0.4,
      life: 0,
      maxLife: 300 + Math.random() * 400,
    });
  }

  let startTime = performance.now();
  let burstPhase = 0; // 0 = build up, 1 = peak, 2 = fade

  function drawEmber(e) {
    const flicker = (Math.sin(e.life * e.flickerSpeed + e.flickerPhase) + 1) / 2;
    const alpha = Math.max(0, (1 - e.life / e.maxLife) * e.maxOpacity * flicker);

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = e.color;
    ctx.beginPath();
    ctx.arc(e.x, e.y, e.r, 0, Math.PI * 2);
    ctx.fill();

    // Ember glow
    ctx.globalAlpha = alpha * 0.3;
    ctx.beginPath();
    ctx.arc(e.x, e.y, e.r * 3, 0, Math.PI * 2);
    ctx.fillStyle = e.color;
    ctx.fill();

    ctx.restore();
  }

  function drawSmoke(s) {
    const alpha = Math.max(0, Math.min(s.opacity, (1 - s.life / s.maxLife) * s.maxOpacity));
    ctx.save();
    ctx.globalAlpha = alpha;
    const grad = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r);
    grad.addColorStop(0, 'rgba(120,120,120,0.5)');
    grad.addColorStop(1, 'rgba(60,60,60,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawAsh(a) {
    const alpha = Math.max(0, a.opacity * (1 - a.life / a.maxLife));
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(a.x, a.y);
    ctx.rotate((a.rotation * Math.PI) / 180);
    ctx.fillStyle = '#888';
    ctx.fillRect(-a.size / 2, -a.size / 2, a.size, a.size);
    ctx.restore();
  }

  function drawHeatShimmer() {
    const t = (performance.now() - startTime) * 0.001;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (let i = 0; i < 5; i++) {
      const hx = w / 2 + Math.sin(t * 0.5 + i * 1.2) * w * 0.15;
      const hy = h * 0.7 - i * 60;
      const hr = 60 + Math.sin(t + i) * 20;
      const grad = ctx.createRadialGradient(hx, hy, 0, hx, hy, hr);
      grad.addColorStop(0, `rgba(255, 100, 20, ${0.03 + Math.sin(t * 2 + i) * 0.015})`);
      grad.addColorStop(1, 'rgba(255,60,0,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(hx, hy, hr, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function animate() {
    const now = performance.now();
    const elapsed = now - startTime;
    ctx.clearRect(0, 0, w, h);

    // Bottom fire glow
    const fireGlow = ctx.createRadialGradient(w / 2, h, 0, w / 2, h, w * 0.6);
    const glowIntensity = burstPhase === 1 ? 0.15 : 0.08;
    fireGlow.addColorStop(0, `rgba(255,80,0,${glowIntensity})`);
    fireGlow.addColorStop(0.5, `rgba(200,50,0,${glowIntensity * 0.5})`);
    fireGlow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = fireGlow;
    ctx.fillRect(0, 0, w, h);

    drawHeatShimmer();

    let active = 0;

    // Update & draw smoke (behind embers)
    for (const s of smoke) {
      s.x += s.vx + Math.sin(s.life * 0.01) * 0.3;
      s.y += s.vy;
      s.r += 0.05;
      if (s.opacity < s.maxOpacity) s.opacity += s.fadeIn;
      s.life++;
      drawSmoke(s);
      if (s.life < s.maxLife) active++;
    }

    // Update & draw embers
    for (const e of embers) {
      e.x += e.vx + Math.sin(e.life * 0.02 + e.flickerPhase) * 0.5;
      e.y += e.vy;
      e.vy += e.heatRise; // heat rises
      e.life++;
      drawEmber(e);
      if (e.life < e.maxLife) active++;
    }

    // Update & draw ash
    for (const a of ash) {
      a.x += a.vx + Math.sin(a.life * 0.015) * 0.4;
      a.y += a.vy;
      a.rotation += a.rotSpeed;
      a.life++;
      drawAsh(a);
      if (a.life < a.maxLife) active++;
    }

    // Burst phase management
    if (elapsed < 800) burstPhase = 0;
    else if (elapsed < 4000) burstPhase = 1;
    else burstPhase = 2;

    if (active > 0 && elapsed < 10000) {
      animationId = requestAnimationFrame(animate);
    } else {
      teardownAnimation();
    }
  }

  animate();
}
