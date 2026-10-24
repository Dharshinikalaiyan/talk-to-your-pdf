// The dream scene: the logo, a glittering 3D ribbon "L's" ("Let's") made of particles, floating above a lake.
//
// ~16,000 points live in a GPU shader. Each point knows two positions: one inside the
// letter (sampled from the real Instrument Serif italic "p", given depth) and one on a sphere.
//   idle       the letter floats, twinkles, with a halo of loose glitter around it
//   listening  the letter ripples with your voice and beats on each syllable  (setLevel, beat)
//   thinking   it dissolves into a swirling sphere
//   speaking   it beats in a speech-like rhythm, each beat a sparkle flash      (beat)
//   burst()    puffs outward and re-forms: an answer just arrived
//   the mouse  particles near the cursor splash away and sparkle, then flow back
// A mirrored copy is drawn faintly below the horizon as the lake reflection (only while the
// logo is big; when it shrinks to sit above the conversation, the reflection fades out).
// No WebGL -> the CSS scene still shows; "reduce motion" -> one still frame.

(function () {
  const COUNT = 16000;
  // The logo: an original ribbon monogram, an "L" whose foot sweeps up into an "s" ("Let's"),
  // drawn like a calligraphy pen stroke (thick on the down-strokes, thin on the cross-strokes).
  // If web/logo.png exists, that image is used instead (anything brighter than its corner
  // colour becomes glitter).
  const LOGO_IMAGE = window.LOCAL_MODE ? "logo.png" : "/static/logo.png";
  const RIBBON = [
    [[140, 78], [132, 30], [214, 14], [206, 84]],      // the curl at the top of the L
    [[206, 84], [200, 170], [178, 250], [142, 300]],   // the stem
    [[142, 300], [110, 342], [150, 368], [214, 352]],  // the foot
    [[214, 352], [282, 336], [326, 300], [322, 268]],  // sweeping up into the s
    [[322, 268], [318, 238], [288, 232], [270, 226]],
    [[270, 226], [232, 214], [232, 176], [270, 168]],
    [[270, 168], [302, 160], [322, 140], [314, 112]],  // the flick at the end
  ];

  function drawRibbon(g, { pen = -0.6, wMax = 46, wMin = 8 } = {}) {
    const pts = [];
    for (const [a, b, c, d] of RIBBON) {
      for (let i = pts.length ? 1 : 0; i <= 80; i++) {
        const t = i / 80, u = 1 - t;
        pts.push([u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0],
                  u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1]]);
      }
    }
    g.strokeStyle = "#fff";
    g.lineCap = "round";
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      if (x0 === x1 && y0 === y1) continue;
      const taper = Math.min(1, i / 30, (pts.length - i) / 30);   // pointed ends
      g.lineWidth = (wMin + (wMax - wMin) * Math.abs(Math.sin(Math.atan2(y1 - y0, x1 - x0) - pen))) * taper + 1;
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
    }
  }

  async function loadLogoImage() {
    try {
      const res = await fetch(LOGO_IMAGE, { method: "HEAD" });
      if (!res.ok) return null;
      const img = new Image();
      img.src = LOGO_IMAGE;
      await img.decode();
      return img;
    } catch { return null; }
  }
  const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---- shapes ---------------------------------------------------------------------

  // Draw the logo on a hidden canvas, then pick random points inside it. Points on the
  // edge are flagged "bright" so the outline reads clearly.
  function letterShape(n, image) {
    const S = 400, W = 400;
    const c = Object.assign(document.createElement("canvas"), { width: W, height: S });
    const g = c.getContext("2d", { willReadFrequently: true });
    let inside;
    if (image) {
      const k = Math.min(W / image.naturalWidth, S / image.naturalHeight);
      const w = image.naturalWidth * k, h = image.naturalHeight * k;
      g.drawImage(image, (W - w) / 2, (S - h) / 2, w, h);
      const img = g.getImageData(0, 0, W, S).data;
      const at = (x, y) => (y * W + x) * 4;
      const bg = img.slice(at(Math.round((W - w) / 2) + 1, Math.round((S - h) / 2) + 1), at(Math.round((W - w) / 2) + 1, Math.round((S - h) / 2) + 1) + 4);
      inside = (x, y) => {
        if (x < 0 || y < 0 || x >= W || y >= S) return false;
        const i = at(x, y);
        if (img[i + 3] < 128) return false;
        return Math.abs(img[i] - bg[0]) + Math.abs(img[i + 1] - bg[1]) + Math.abs(img[i + 2] - bg[2]) > 120;
      };
    } else {
      drawRibbon(g);
      const img = g.getImageData(0, 0, W, S).data;
      inside = (x, y) => x >= 0 && y >= 0 && x < W && y < S && img[(y * W + x) * 4 + 3] > 128;
    }

    const filled = [], edges = [];
    let minX = W, maxX = 0, minY = S, maxY = 0;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < W; x++) {
        if (!inside(x, y)) continue;
        filled.push([x, y]);
        if (!inside(x - 2, y) || !inside(x + 2, y) || !inside(x, y - 2) || !inside(x, y + 2)) edges.push([x, y]);
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
    if (!filled.length) return null;

    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, scale = 2.5 / (maxY - minY);
    const out = new Float32Array(n * 3), bright = new Float32Array(n);
    const D = 0.42;
    for (let k = 0; k < n; k++) {
      const onEdge = Math.random() < 0.3;
      const [px, py] = (onEdge ? edges : filled)[Math.floor(Math.random() * (onEdge ? edges.length : filled.length))];
      out[k * 3] = (px + Math.random() - cx) * scale;
      out[k * 3 + 1] = -(py + Math.random() - cy) * scale;
      out[k * 3 + 2] = (Math.random() - 0.5) * D * (onEdge ? 1 : 0.85);
      bright[k] = onEdge ? 1 : 0;
    }
    return { positions: out, bright };
  }

  function sphereShape(n, radius) {
    const out = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) {
      const u = Math.random() * 2 - 1, phi = Math.random() * Math.PI * 2, r = radius * (0.9 + Math.random() * 0.12);
      const s = Math.sqrt(1 - u * u);
      out[k * 3] = r * s * Math.cos(phi); out[k * 3 + 1] = r * u; out[k * 3 + 2] = r * s * Math.sin(phi);
    }
    return out;
  }

  // ---- shaders --------------------------------------------------------------------
  const VERTEX = `
    attribute vec3 posB; attribute float seed; attribute float bright;
    uniform float uTime; uniform float uMix; uniform float uLevel; uniform float uBurst; uniform float uSwirl; uniform float uPulse;
    uniform float uPixel; uniform float uSize; uniform vec2 uMouse; uniform float uStir;
    varying float vSeed; varying float vGlow; varying float vCore; varying float vBright; varying float vSpark;
    void main(){
      vec3 p = mix(position, posB, uMix);
      // the glowing core sits in the letter's middle
      vCore = 1.0 - smoothstep(0.0, 1.15, length(p.xy * vec2(1.1, 0.75)));
      vBright = bright * (1.0 - uMix);
      // swirl around the vertical axis while thinking
      float a = uSwirl * (uTime * 1.6 + length(p.xz) * 2.0);
      p.xz = mat2(cos(a), -sin(a), sin(a), cos(a)) * p.xz;
      vec3 dir = normalize(p + 0.0001);
      // a halo of loose glitter: ~10% of the points drift just outside the letter
      float halo = step(0.9, seed);
      float drift = halo * (0.08 + fract(seed * 37.0) * 0.32) * (0.75 + 0.25 * sin(uTime * 1.3 + seed * 30.0));
      // life + voice ripple + answer burst
      float wave = sin(uTime * 2.0 + seed * 40.0) * 0.015;
      float voice = uLevel * (0.06 + 0.16 * sin(seed * 90.0 + uTime * 12.0));
      p += dir * (drift + wave + voice + uBurst * (0.5 + seed));
      p.y += sin(uTime * 0.8 + seed * 6.0) * 0.012;
      // the beat: the letter swells a touch, its halo sprays out, and sparkles flash
      p += dir * uPulse * (0.04 + halo * (0.25 + fract(seed * 53.0) * 0.6) + pow(seed, 9.0) * 0.5);
      p *= 1.0 + uPulse * 0.045;
      // splash: points near the cursor are pushed away (more when the mouse moves fast)
      vec2 away = p.xy - uMouse;
      float near = exp(-dot(away, away) / 0.16) * uStir;
      p.xy += normalize(away + 0.0001) * near * (0.25 + seed * 0.7);
      p.z += near * (seed - 0.5) * 0.9;
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_Position = projectionMatrix * mv;
      // sparkle: on a beat, a random third of the points flash bright and big
      float sparkPick = step(0.66, fract(seed * 113.0 + floor(uTime * 6.0) * 0.37));
      vSpark = max(uPulse * sparkPick, near * 0.9);
      gl_PointSize = uSize * uPixel * (0.55 + seed * 0.75) * (3.0 / -mv.z) * (1.0 + vSpark * 1.6 - halo * 0.25);
      vSeed = seed;
      vGlow = 0.85 + 0.35 * pow(abs(sin(uTime * 2.2 + seed * 70.0)), 8.0);
    }`;
  const FRAGMENT = `
    uniform vec3 uA; uniform vec3 uB; uniform vec3 uC; uniform float uOpacity;
    varying float vSeed; varying float vGlow; varying float vCore; varying float vBright; varying float vSpark;
    void main(){
      float d = length(gl_PointCoord - 0.5);
      if (d > 0.5) discard;
      float soft = smoothstep(0.5, 0.0, d);
      // vivid magenta/violet glitter, a hot pink-white core, brighter outline, white sparkles
      vec3 col = mix(uC, uB, vSeed);
      col = mix(col, uA, clamp(pow(vCore, 1.25) * 0.95 + vBright * 0.3, 0.0, 1.0));
      col = mix(col, vec3(1.0), vSpark * 0.85);
      gl_FragColor = vec4(min(col * vGlow, vec3(1.0)), soft * uOpacity);
    }`;

  class DreamScene {
    constructor(canvas) {
      this.canvas = canvas;
      this.level = 0; this.target = 0; this.mode = "idle"; this.t = 0; this.pulse = 0;
      this.mix = 1; this.swirl = 0; this.burstT = -10; this.stir = 0; this.pointer = { x: 0, y: 0, active: false };
      this.ok = !!window.THREE && this._init();
      document.documentElement.classList.toggle("no-webgl", !this.ok);
      if (!this.ok) return;
      addEventListener("resize", () => this._resize());
      addEventListener("pointermove", (e) => {
        this.pointer.x = (e.clientX / innerWidth) * 2 - 1;
        this.pointer.y = (e.clientY / innerHeight) * 2 - 1;
        this.pointer.active = true;
      }, { passive: true });
      document.addEventListener("pointerleave", () => (this.pointer.active = false));
      addEventListener("blur", () => (this.pointer.active = false));
      this._resize();
      this._loop = this._loop.bind(this);
      requestAnimationFrame(this._loop);
      this._loadLetter();
    }

    _init() {
      try {
        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, alpha: true });
      } catch {
        return false;
      }
      this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 60);
      this.camera.position.set(0, 0, 7);

      // Until the font has loaded, both shapes are the sphere; the letter forms from it.
      const geo = new THREE.BufferGeometry();
      const sphere = sphereShape(COUNT, 1.15);
      geo.setAttribute("position", new THREE.BufferAttribute(sphere.slice(), 3));
      geo.setAttribute("posB", new THREE.BufferAttribute(sphere, 3));
      geo.setAttribute("bright", new THREE.BufferAttribute(new Float32Array(COUNT), 1));
      const seeds = new Float32Array(COUNT);
      for (let k = 0; k < COUNT; k++) seeds[k] = Math.random();
      geo.setAttribute("seed", new THREE.BufferAttribute(seeds, 1));
      this.geo = geo;

      this.uniforms = {
        uTime: { value: 0 }, uMix: { value: 1 }, uLevel: { value: 0 }, uBurst: { value: 0 }, uSwirl: { value: 0 }, uPulse: { value: 0 },
        uMouse: { value: new THREE.Vector2(99, 99) }, uStir: { value: 0 },
        uPixel: { value: this.renderer.getPixelRatio() }, uSize: { value: 4.2 }, uOpacity: { value: 0.95 },
        uA: { value: new THREE.Color("#FFE6FC") }, uB: { value: new THREE.Color("#D23CF7") }, uC: { value: new THREE.Color("#8F26EC") },
      };
      // Normal blending paints the colour on top of the light sky, so the magenta stays vivid.
      const material = (uniforms) => new THREE.ShaderMaterial({
        vertexShader: VERTEX, fragmentShader: FRAGMENT, uniforms,
        transparent: true, depthWrite: false, blending: THREE.NormalBlending,
      });
      this.group = new THREE.Group();
      this.points = new THREE.Points(geo, material(this.uniforms));
      this.group.add(this.points);
      // the lake reflection: same particles, mirrored and faint
      this.reflectOpacity = { value: 0.16 };
      this.reflection = new THREE.Points(geo, material({ ...this.uniforms, uOpacity: this.reflectOpacity }));
      this.scene.add(this.group, this.reflection);

      // drifting dust specks, like in a dream sky
      const dustN = 260, dust = new Float32Array(dustN * 3);
      for (let k = 0; k < dustN; k++) {
        dust[k * 3] = (Math.random() - 0.5) * 14; dust[k * 3 + 1] = (Math.random() - 0.2) * 7; dust[k * 3 + 2] = (Math.random() - 0.5) * 4;
      }
      const dg = new THREE.BufferGeometry();
      dg.setAttribute("position", new THREE.BufferAttribute(dust, 3));
      this.dust = new THREE.Points(dg, new THREE.PointsMaterial({ color: 0x3a1d6e, size: 0.035, transparent: true, opacity: 0.55, depthWrite: false }));
      this.scene.add(this.dust);

      return true;
    }

    async _loadLetter() {
      const shape = letterShape(COUNT, await loadLogoImage());
      if (!shape) return;
      this.geo.attributes.position.array.set(shape.positions);
      this.geo.attributes.position.needsUpdate = true;
      this.geo.attributes.bright.array.set(shape.bright);
      this.geo.attributes.bright.needsUpdate = true;
      this.letterReady = true;   // the mix now eases from sphere to letter
      if (reduceMotion()) this._draw(0, true);
    }

    /** Where the logo sits, in screen fractions (set by the page layout). */
    place(xFrac, yFrac, scale) {
      this.anchor = { x: xFrac, y: yFrac, s: scale };
      this._resize();
    }

    _resize() {
      if (!this.ok) return;
      const w = innerWidth, h = innerHeight;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      const a = this.anchor || { x: 0.5, y: 0.42, s: 1 };
      const viewH = 2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * this.camera.position.z;
      const viewW = viewH * this.camera.aspect;
      const s = a.s * Math.min(1, this.camera.aspect * 0.9 + 0.25);
      this.targetPos = { x: (a.x - 0.5) * viewW, y: (0.5 - a.y) * viewH, s };
      this.view = { w: viewW, h: viewH };
      if (!this.curPos || reduceMotion()) this.curPos = { ...this.targetPos };
      if (reduceMotion()) this._draw(0, true);
    }

    setLevel(v) { this.target = Math.max(0, Math.min(1, v)); }
    setMode(mode) { this.mode = ["idle", "listening", "thinking", "speaking"].includes(mode) ? mode : "idle"; if (this.ok && reduceMotion()) this._draw(0, true); }
    burst() { this.burstT = this.t; }
    setPaused(on) { this.paused = on; }
    /** 0 = the full logo; 1 = a faint watermark (drawn over the chat card, so kept very light). */
    setFade(f) { this.fadeTarget = f; document.documentElement.classList.toggle("logo-watermark", f > 0.5); if (this.ok && reduceMotion()) this._draw(0, true); }
    beat(strength = 0.7) { this.pulse = Math.max(this.pulse, Math.min(1, strength)); }

    _draw(dt, still = false) {
      this.t += dt;
      const t = this.t, m = this.mode, u = this.uniforms;
      this.level += (this.target - this.level) * 0.2;
      const ease = still ? 1 : 0.05;
      const sphere = !this.letterReady || m === "thinking" ? 1 : 0;
      this.mix += (sphere - this.mix) * ease;
      this.swirl += ((m === "thinking" ? 1 : 0) - this.swirl) * ease;
      const b = t - this.burstT;
      u.uBurst.value = b >= 0 && b < 1.2 ? Math.sin(Math.min(1, b / 1.2) * Math.PI) * 0.3 : 0;
      u.uTime.value = t; u.uMix.value = this.mix; u.uLevel.value = this.level; u.uSwirl.value = this.swirl;
      // each beat jumps up instantly and decays like a drum hit (~0.3 s)
      this.pulse *= Math.pow(0.0008, dt);
      u.uPulse.value = this.pulse;

      // glide smoothly to a new layout position (e.g. when the PDF opens)
      const k = still ? 1 : 1 - Math.pow(0.02, dt);
      for (const key of ["x", "y", "s"]) this.curPos[key] += (this.targetPos[key] - this.curPos[key]) * k;
      const { x, y, s } = this.curPos;
      this.group.position.set(x, y + (still ? 0 : Math.sin(t * 0.9) * 0.05 * s), 0);
      this.group.scale.setScalar(s);
      const waterY = y - 1.6 * s;   // mirror around a water line just below the logo
      this.reflection.position.set(x, 2 * waterY - y, 0);
      this.reflection.scale.set(s, -s, s);
      // the reflection belongs to the big logo above the lake; it fades as the logo shrinks
      this.fade = (this.fade || 0) + ((this.fadeTarget || 0) - (this.fade || 0)) * (still ? 1 : 0.06);
      u.uOpacity.value = 0.95 * (1 - 0.86 * this.fade);
      this.dust.material.opacity = 0.55 * (1 - this.fade);
      this.reflectOpacity.value = 0.16 * Math.max(0, Math.min(1, (s - 0.45) / 0.25)) * (1 - this.fade);
      this.reflection.visible = this.reflectOpacity.value > 0.005;

      // splash: where is the cursor in the letter's own coordinates, and how fast is it moving?
      const mx = this.pointer.x * this.view.w / 2, my = -this.pointer.y * this.view.h / 2;
      const speed = this._lastMouse ? Math.hypot(mx - this._lastMouse.x, my - this._lastMouse.y) / Math.max(dt, 0.001) : 0;
      this._lastMouse = { x: mx, y: my };
      this.stir += (Math.min(1.3, this.pointer.active ? 0.45 + speed * 0.12 : 0) - this.stir) * (still ? 1 : 0.12);
      u.uMouse.value.set((mx - x) / s, (my - y) / s);
      u.uStir.value = this.stir;

      // gentle sway + follow the pointer a little
      const targetY = still ? -0.3 : -0.3 + Math.sin(t * 0.3) * 0.2 + this.pointer.x * 0.25;
      const targetX = still ? 0.06 : 0.06 + this.pointer.y * 0.12;
      this.points.rotation.y += (targetY - this.points.rotation.y) * 0.05;
      this.points.rotation.x += (targetX - this.points.rotation.x) * 0.05;
      this.reflection.rotation.copy(this.points.rotation);
      if (!still) this.dust.rotation.y = t * 0.01;
      this.renderer.render(this.scene, this.camera);
    }

    _loop(now) {
      requestAnimationFrame(this._loop);
      const dt = Math.min(0.05, (now - (this._last || now)) / 1000);
      this._last = now;
      if (document.hidden || reduceMotion()) return;
      if (this.paused) { if (!this._stillDrawn) { this._draw(0, true); this._stillDrawn = true; } return; }
      this._stillDrawn = false;
      this._draw(dt);
    }
  }

  window.DreamScene = DreamScene;
})();
