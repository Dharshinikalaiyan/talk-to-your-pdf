// The scenery behind everything: a calm pond at dusk.
//   far shore   a row of standing stones (generated, slightly different shapes each)
//   meadow      a dark purple strip of grass between the stones and the water
//   pond        the sky and the stones mirrored in still water, rippling gently
//   foreground  grass and reeds swaying in the air
// Plain SVG + CSS (style.css "pond"), so it costs nothing on phones.

(function () {
  const sky = document.querySelector(".sky");
  if (!sky) return;
  const NS = "http://www.w3.org/2000/svg";
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);   // same scene every visit
  const el = (tag, attrs, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    parent?.append(e);
    return e;
  };

  // ---- standing stones: blocky pillars with slanted tops and a lit face
  const W = 1440, H = 160;
  function stones() {
    const svg = el("svg", { class: "stones", viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "xMidYMax slice", "aria-hidden": "true" });
    const back = el("g", { class: "stones-back" }, svg), front = el("g", { class: "stones-front" }, svg);
    for (let x = -20; x < W + 20;) {
      const w = 34 + rand() * 70;
      // taller stones towards the edges, a lower gap in the middle for the logo
      const edge = Math.abs(x + w / 2 - W / 2) / (W / 2);
      const h = (36 + rand() * 54) * (0.55 + edge * 0.75);
      const lean = (rand() - 0.5) * 18, tilt = (rand() - 0.5) * h * 0.35;
      const l = x, r = x + w, b = H, t1 = H - h + tilt, t2 = H - h - tilt;
      const g = rand() < 0.35 ? back : front;
      el("path", { d: `M${l} ${b}L${l + 4 + lean} ${t1 + 6}L${l + w * 0.35 + lean} ${t1}L${r - 6 + lean} ${t2}L${r} ${b}Z` }, g);
      // lit face on the left of each stone
      el("path", { class: "face", d: `M${l} ${b}L${l + 4 + lean} ${t1 + 6}L${l + w * 0.35 + lean} ${t1}L${l + w * 0.42} ${b}Z` }, g);
      x += w * (0.55 + rand() * 0.55);
    }
    // meadow: grass edge along the bottom
    let d = `M0 ${H}`;
    for (let x = 0; x <= W; x += 6) d += `L${x} ${H - 10 - rand() * 8}L${x + 3} ${H - 6}`;
    el("path", { class: "meadow-edge", d: d + `L${W} ${H}Z` }, svg);
    return svg;
  }

  // ---- foreground grass and reeds, in groups that sway like gusts of wind
  function grass() {
    const svg = el("svg", { class: "grass", viewBox: "0 0 1440 140", preserveAspectRatio: "none", "aria-hidden": "true" });
    for (let gi = 0; gi < 9; gi++) {
      const g = el("g", { class: `blades b${gi % 4}` }, svg);
      g.style.setProperty("--d", `${(rand() * -6).toFixed(2)}s`);
      for (let k = 0; k < 26; k++) {
        const x = rand() * 1440;
        // denser and taller at the sides, so the chat in the middle stays clear
        const side = Math.abs(x - 720) / 720;
        const h = (24 + rand() * 60) * (0.35 + side * 1.1);
        const bend = (rand() - 0.4) * h * 0.5, w = 2 + rand() * 4;
        el("path", { d: `M${x - w} 140Q${x - w + bend * 0.4} ${140 - h * 0.55} ${x + bend} ${140 - h}Q${x + w + bend * 0.4} ${140 - h * 0.5} ${x + w} 140Z` }, g);
      }
    }
    // a few reeds with seed heads
    for (const x of [70, 150, 1290, 1385]) {
      const g = el("g", { class: "blades reed" }, svg);
      g.style.setProperty("--d", `${(rand() * -5).toFixed(2)}s`);
      const h = 110 + rand() * 25;
      el("path", { d: `M${x} 140Q${x + 6} ${140 - h / 2} ${x + 14} ${140 - h}`, fill: "none", "stroke-width": "2.5" }, g);
      el("ellipse", { cx: x + 15, cy: 140 - h + 8, rx: 3.5, ry: 11, transform: `rotate(12 ${x + 15} ${140 - h + 8})` }, g);
    }
    return svg;
  }

  // replace the old ridge with the new shore, and mirror it in the pond
  sky.querySelectorAll(".ridge").forEach((r) => r.remove());
  const shore = stones();
  const mirror = shore.cloneNode(true);
  mirror.setAttribute("class", "stones reflect");
  sky.querySelector(".lake")?.before(shore);
  sky.querySelector(".lake")?.append(mirror);
  sky.append(grass());
})();
