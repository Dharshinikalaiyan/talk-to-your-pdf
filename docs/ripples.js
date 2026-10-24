// Small ripples that follow the cursor, like a fingertip trailing across water.
// Each mouse movement drops a few soft rings that spread and fade. Over the pond they're
// flattened into ellipses (perspective); above it, in the air, they stay round.
// One small 2D canvas, drawn only while rings are alive.

(function () {
  const canvas = document.createElement("canvas");
  canvas.className = "ripples";
  canvas.setAttribute("aria-hidden", "true");
  document.querySelector("#scene")?.after(canvas);
  const g = canvas.getContext("2d");
  const rings = [];
  let dpr = 1, raf = 0, lastX = -1e4, lastY = -1e4;
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches || document.body.classList.contains("calm");

  function resize() {
    dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
  }
  addEventListener("resize", resize);
  resize();

  // where the water starts (the shore line, --shore in style.css)
  const shoreY = () => innerHeight * (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--shore")) || 61) / 100;

  addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse" || reduced()) return;
    const dist = Math.hypot(e.clientX - lastX, e.clientY - lastY);
    if (dist < 26) return;                 // a new ring every ~26 px of movement
    lastX = e.clientX; lastY = e.clientY;
    const speed = Math.min(1, dist / 80);
    rings.push({ x: e.clientX, y: e.clientY, t: 0, max: 26 + speed * 30, water: e.clientY > shoreY() });
    if (rings.length > 40) rings.shift();
    if (!raf) raf = requestAnimationFrame(draw);
  }, { passive: true });

  let last = 0;
  function draw(now) {
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
    last = now;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, innerWidth, innerHeight);
    for (let i = rings.length - 1; i >= 0; i--) {
      const r = rings[i];
      r.t += dt / 1.3;                       // each ring lives ~1.3 s
      if (r.t >= 1) { rings.splice(i, 1); continue; }
      const ease = 1 - Math.pow(1 - r.t, 3);
      const squash = r.water ? 0.38 : 1;
      // two thin rings, the inner one a little behind
      for (const [lag, alpha] of [[0, 0.5], [0.22, 0.32]]) {
        const p = Math.max(0, ease - lag);
        if (p <= 0) continue;
        const rad = 3 + p * r.max;
        g.beginPath();
        g.ellipse(r.x, r.y, rad, rad * squash, 0, 0, Math.PI * 2);
        g.strokeStyle = `rgba(255, 240, 255, ${(alpha * (1 - r.t)).toFixed(3)})`;
        g.lineWidth = 1.3 * (1 - r.t) + 0.3;
        g.stroke();
      }
    }
    if (rings.length) raf = requestAnimationFrame(draw);
    else { raf = 0; last = 0; g.clearRect(0, 0, innerWidth, innerHeight); }
  }
})();
