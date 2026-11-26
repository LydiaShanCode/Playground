// Canvas renderer. Each musical parameter owns one visual job:
//   BPM            -> overall speed, trail length, how soft or sharp everything is (slower = calmer, longer trails)
//   Key            -> colour palette (circle of fifths -> hue; minor darker and cooler)
//   Genre          -> which scene is drawn (tunnel, shards, orbits, flow field), cross-faded
//   Rhythm         -> kick shockwaves, snare flashes, hi-hat sparkles, beat/downbeat pulses, swing wobble
//   Melodic phrase -> a light ribbon that follows pitch across the phrase, detaches and blooms at the end
import { keyColour } from './analysis.js';

const TAU = Math.PI * 2;
const lerp = (a, b, k) => a + (b - a) * k;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerpHue = (a, b, k) => { const d = ((b - a + 540) % 360) - 180; return (a + d * k + 360) % 360; };
const hsl = (h, s, l, a = 1) => `hsla(${h.toFixed(1)},${s.toFixed(1)}%,${l.toFixed(1)}%,${a.toFixed(3)})`;

const SCENES_FOR = {
  'Electronic': { tunnel: 1 },
  'Drum & Bass': { tunnel: 0.65, shards: 0.35 },
  'Hip-Hop': { shards: 0.8, orbits: 0.2 },
  'Rock': { shards: 1 },
  'Pop': { orbits: 0.65, tunnel: 0.35 },
  'Jazz': { orbits: 0.8, flow: 0.2 },
  'Classical': { flow: 0.75, orbits: 0.25 },
  'Ambient': { flow: 1 },
};

export class Visuals {
  constructor(canvas) {
    this.c = canvas;
    this.g = canvas.getContext('2d');
    this.pal = { hue: 210, sat: 30, light: 55 };
    this.scene = { tunnel: 0, shards: 0, orbits: 0, flow: 1 };
    this.speed = 1; this.calm = 0.5;
    this.rot = 0; this.time = 0;
    this.rings = []; this.waves = []; this.sparks = []; this.flash = 0; this.zoom = 0;
    this.ribbon = []; this.oldRibbons = []; this.blooms = [];
    this.particles = Array.from({ length: 700 }, () => ({ x: Math.random(), y: Math.random(), v: Math.random() }));
    this.orbiters = Array.from({ length: 36 }, (_, i) => ({ ring: i % 4, a: Math.random() * TAU, s: 0.6 + Math.random() * 0.8 }));
    this.pulse = 0;
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.w = this.c.width = Math.floor(innerWidth * dpr);
    this.h = this.c.height = Math.floor(innerHeight * dpr);
    this.c.style.width = innerWidth + 'px'; this.c.style.height = innerHeight + 'px';
    this.dpr = dpr;
    this.g.fillStyle = '#000'; this.g.fillRect(0, 0, this.w, this.h);
  }

  frame(s, dt) {
    dt = Math.min(dt, 0.05);
    this.time += dt;
    const { g, w, h } = this;
    const R = Math.min(w, h) * 0.5;

    // --- BPM: speed and calm. Slower music -> slower motion, longer trails, softer shapes.
    const bpm = s.bpm || 90;
    this.speed = lerp(this.speed, clamp(bpm / 120, 0.4, 1.6), dt * 0.8);
    this.calm = lerp(this.calm, clamp((130 - bpm) / 60, 0, 1), dt * 0.8);

    // --- Key: palette.
    const target = s.key.name === '—' ? { hue: 210, sat: 25, light: 55 } : keyColour(s.key.tonic, s.key.mode);
    const kconf = s.key.name === '—' ? 0 : clamp(0.4 + s.key.confidence, 0, 1);
    this.pal.hue = lerpHue(this.pal.hue, target.hue, dt * 0.6);
    this.pal.sat = lerp(this.pal.sat, target.sat * kconf + 25 * (1 - kconf), dt * 0.6);
    this.pal.light = lerp(this.pal.light, target.light, dt * 0.6);
    const melodyShift = clamp(s.melody.contour, -12, 12) * 1.5; // rising lines warm the hue
    const H = (this.pal.hue + melodyShift + 360) % 360, S = this.pal.sat, L = this.pal.light;
    const C = {
      primary: (a) => hsl(H, S, L, a),
      second: (a) => hsl((H + 30) % 360, S, L, a),       // the dominant, one fifth up
      accent: (a) => hsl((H + 180) % 360, S * 0.9, L + 8, a),
      bg: (a) => hsl(H, S * 0.5, 4 + s.level * 4, a),
    };

    // --- Genre: scene weights.
    const want = { tunnel: 0, shards: 0, orbits: 0, flow: 0 };
    for (const { genre, p } of s.genre) for (const [k, v] of Object.entries(SCENES_FOR[genre] || {})) want[k] += p * v;
    for (const k in this.scene) this.scene[k] = lerp(this.scene[k], want[k], dt * 0.7);

    // --- Rhythm & phrase events.
    for (const e of s.events) this.handle(e, s, R);

    // Trails: fade amount scales with tempo.
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = C.bg(lerp(0.32, 0.07, this.calm));
    g.fillRect(0, 0, w, h);

    const swing = Math.sin(this.time * this.speed * TAU * 0.5) * s.rhythm.sync * 0.15;
    this.rot += dt * this.speed * (0.15 + s.level * 0.25) + swing * dt;
    this.zoom *= Math.exp(-dt * 5);
    const beatPulse = Math.exp(-s.beatPhase * lerp(7, 3, this.calm)) * (s.bpm ? 1 : 0);
    this.pulse = lerp(this.pulse, beatPulse, 0.5);

    g.save();
    g.translate(w / 2, h / 2);
    g.scale(1 + this.zoom * 0.06 + s.rhythm.kick * 0.02, 1 + this.zoom * 0.06 + s.rhythm.kick * 0.02);
    g.globalCompositeOperation = 'lighter';

    if (this.scene.flow > 0.03) this.drawFlow(s, dt, R, C, this.scene.flow);
    if (this.scene.orbits > 0.03) this.drawOrbits(s, dt, R, C, this.scene.orbits);
    if (this.scene.shards > 0.03) this.drawShards(s, dt, R, C, this.scene.shards);
    if (this.scene.tunnel > 0.03) this.drawTunnel(s, dt, R, C, this.scene.tunnel);

    this.drawCore(s, R, C);
    this.drawRhythm(s, dt, R, C);
    this.drawMelody(s, dt, R, C);
    g.restore();

    if (this.flash > 0.005) {
      g.globalCompositeOperation = 'lighter';
      g.fillStyle = C.accent(this.flash * 0.18);
      g.fillRect(0, 0, w, h);
      this.flash *= Math.exp(-dt * 14);
    }
    g.globalCompositeOperation = 'source-over';
  }

  handle(e, s, R) {
    switch (e.type) {
      case 'kick':
        this.waves.push({ r: R * 0.12, a: 0.25 + e.strength * 0.6, w: 2 + e.strength * 10 });
        break;
      case 'snare':
        this.flash = Math.max(this.flash, e.strength * (1 - this.calm * 0.7)); // slow music: gentler flashes
        for (let i = 0; i < 10; i++) this.sparks.push({ a: Math.random() * TAU, r: R * 0.2, v: R * (0.8 + Math.random()), life: 0.5, kind: 'shard' });
        break;
      case 'hat':
        for (let i = 0; i < 2 + e.strength * 4; i++) this.sparks.push({ x: (Math.random() - 0.5) * this.w, y: (Math.random() - 0.5) * this.h, life: 0.25, kind: 'dot' });
        break;
      case 'downbeat':
        this.zoom = 1;
        this.rings.push({ r: R * 0.05, sides: 6, a: 0.9, spin: this.rot });
        break;
      case 'beat':
        this.rings.push({ r: R * 0.05, sides: 4, a: 0.55, spin: this.rot });
        break;
      case 'phraseStart':
        if (this.ribbon.length) this.retireRibbon(false);
        this.blooms.push({ x: -0.55, y: this.pitchY(e.midi), r: 0, a: 0.5, big: false });
        break;
      case 'phraseEnd':
        this.retireRibbon(e.resolved, e.shape);
        break;
    }
    if (this.waves.length > 30) this.waves.shift();
    if (this.rings.length > 40) this.rings.shift();
    if (this.sparks.length > 400) this.sparks.splice(0, this.sparks.length - 400);
  }

  pitchY(midi) { return clamp(-((midi - 72) / 24), -0.8, 0.8); } // -1..1 relative to R

  retireRibbon(resolved, shape = 0) {
    if (this.ribbon.length < 2) { this.ribbon = []; return; }
    const end = this.ribbon[this.ribbon.length - 1];
    this.oldRibbons.push({ pts: this.ribbon, a: 1, drift: shape || 0 });
    // A phrase that comes home to the tonic blooms; one left hanging just fades.
    this.blooms.push({ x: end.x, y: end.y, r: 0, a: resolved ? 1 : 0.35, big: resolved });
    this.ribbon = [];
    if (this.oldRibbons.length > 6) this.oldRibbons.shift();
  }

  // ---- Scenes -----------------------------------------------------------------
  drawTunnel(s, dt, R, C, wgt) {
    const g = this.g;
    for (const ring of this.rings) {
      ring.r += dt * R * (0.35 + this.speed * 0.5);
      ring.a *= Math.exp(-dt * lerp(1.6, 0.6, this.calm));
    }
    this.rings = this.rings.filter((r) => r.r < R * 2.2 && r.a > 0.01);
    g.lineWidth = 2 * this.dpr;
    for (const [i, ring] of this.rings.entries()) {
      g.strokeStyle = (i % 2 ? C.second : C.primary)(ring.a * wgt);
      polygon(g, ring.sides, ring.r, ring.spin + this.rot * (i % 2 ? -1 : 1));
      g.stroke();
    }
    // Spectrum-driven inner lattice.
    const n = 12;
    g.strokeStyle = C.primary(0.25 * wgt);
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + this.rot;
      const r1 = R * (0.15 + s.spectrum[i * 4] * 0.5);
      g.moveTo(Math.cos(a) * R * 0.1, Math.sin(a) * R * 0.1);
      g.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
    }
    g.stroke();
  }

  drawShards(s, dt, R, C, wgt) {
    const g = this.g, n = s.spectrum.length;
    const base = R * (0.28 + s.rhythm.kick * 0.12);
    for (let i = 0; i < n; i++) {
      const v = s.spectrum[i];
      const a = (i / n) * TAU - this.rot * 0.6;
      const len = R * v * v * 0.9;
      const wdt = (TAU / n) * lerp(0.45, 0.8, s.features.bass);
      g.fillStyle = (i < n * 0.25 ? C.second : i > n * 0.7 ? C.accent : C.primary)((0.25 + v * 0.6) * wgt);
      g.beginPath();
      g.moveTo(Math.cos(a - wdt / 2) * base, Math.sin(a - wdt / 2) * base);
      g.lineTo(Math.cos(a) * (base + len), Math.sin(a) * (base + len));
      g.lineTo(Math.cos(a + wdt / 2) * base, Math.sin(a + wdt / 2) * base);
      g.fill();
    }
  }

  drawOrbits(s, dt, R, C, wgt) {
    const g = this.g;
    for (let ring = 0; ring < 4; ring++) {
      const lit = s.barPos === ring ? this.pulse : 0;
      g.strokeStyle = C.second((0.1 + lit * 0.5) * wgt);
      g.lineWidth = (1 + lit * 3) * this.dpr;
      g.beginPath(); g.arc(0, 0, R * (0.3 + ring * 0.17), 0, TAU); g.stroke();
    }
    const active = Math.round(clamp(s.rhythm.density * 5, 8, this.orbiters.length));
    for (let i = 0; i < active; i++) {
      const o = this.orbiters[i];
      // Swing: syncopated music makes orbiters lurch rather than glide.
      const lurch = 1 + Math.sin(this.time * this.speed * TAU) * s.rhythm.sync * 0.8;
      o.a += dt * this.speed * o.s * lurch * (o.ring % 2 ? -0.6 : 0.6);
      const r = R * (0.3 + o.ring * 0.17);
      const size = (3 + s.level * 8 + (s.barPos === o.ring ? this.pulse * 8 : 0)) * this.dpr;
      g.fillStyle = (i % 3 ? C.primary : C.accent)(0.7 * wgt);
      g.beginPath(); g.arc(Math.cos(o.a) * r, Math.sin(o.a) * r, size, 0, TAU); g.fill();
    }
  }

  drawFlow(s, dt, R, C, wgt) {
    const g = this.g, w = this.w, h = this.h;
    const sp = dt * this.speed * (0.03 + s.level * 0.08);
    const pull = s.melody.voiced ? this.pitchY(s.melody.midi) : 0;
    const tm = this.time * 0.15 * this.speed;
    g.fillStyle = C.primary(0.55 * wgt);
    for (const p of this.particles) {
      const ang = Math.sin(p.x * 3.1 + tm) * 2 + Math.cos(p.y * 2.7 - tm * 1.3) * 2 + this.pal.hue * 0.01;
      p.x += Math.cos(ang) * sp * (0.5 + p.v);
      p.y += Math.sin(ang) * sp * (0.5 + p.v) + (0.5 + pull * 0.4 - p.y) * sp * 0.3;
      if (p.x < 0) p.x += 1; if (p.x > 1) p.x -= 1;
      if (p.y < 0) p.y += 1; if (p.y > 1) p.y -= 1;
      const size = (1 + p.v * 2 + s.level * 2) * this.dpr;
      g.fillRect((p.x - 0.5) * w, (p.y - 0.5) * h, size, size);
    }
  }

  drawCore(s, R, C) {
    const g = this.g;
    const r = R * (0.06 + s.level * 0.05) * (1 + this.pulse * lerp(0.6, 0.25, this.calm));
    const grad = g.createRadialGradient(0, 0, 0, 0, 0, r * 3);
    grad.addColorStop(0, C.primary(0.9));
    grad.addColorStop(0.35, C.second(0.35));
    grad.addColorStop(1, C.second(0));
    g.fillStyle = grad;
    g.beginPath(); g.arc(0, 0, r * 3, 0, TAU); g.fill();
  }

  drawRhythm(s, dt, R, C) {
    const g = this.g;
    for (const wv of this.waves) {
      wv.r += dt * R * (1.2 + this.speed);
      wv.a *= Math.exp(-dt * 3);
      g.strokeStyle = C.primary(wv.a);
      g.lineWidth = wv.w * this.dpr;
      g.beginPath(); g.arc(0, 0, wv.r, 0, TAU); g.stroke();
    }
    this.waves = this.waves.filter((wv) => wv.a > 0.01 && wv.r < R * 2.5);
    for (const sp of this.sparks) {
      sp.life -= dt;
      if (sp.kind === 'dot') {
        g.fillStyle = C.accent(clamp(sp.life * 4, 0, 1));
        g.fillRect(sp.x, sp.y, 2.5 * this.dpr, 2.5 * this.dpr);
      } else {
        sp.r += sp.v * dt;
        g.strokeStyle = C.accent(clamp(sp.life * 2, 0, 1));
        g.lineWidth = 2 * this.dpr;
        g.beginPath();
        g.moveTo(Math.cos(sp.a) * sp.r, Math.sin(sp.a) * sp.r);
        g.lineTo(Math.cos(sp.a) * (sp.r + R * 0.08), Math.sin(sp.a) * (sp.r + R * 0.08));
        g.stroke();
      }
    }
    this.sparks = this.sparks.filter((sp) => sp.life > 0);
  }

  drawMelody(s, dt, R, C) {
    const g = this.g, m = s.melody;
    const W = this.w / 2;
    if (m.inPhrase && m.voiced) {
      // x walks across the screen over ~4 bars; y follows pitch.
      const x = -0.55 + clamp(m.progress, 0, 1.4) * 1.0;
      const y = this.pitchY(m.line);
      const last = this.ribbon[this.ribbon.length - 1];
      // Glide between notes so the line sings rather than jitters.
      const glide = 1 - Math.exp(-dt * 14);
      const pt = last ? { x: lerp(last.x, x, 0.5), y: lerp(last.y, y, glide), tn: m.tension, l: s.level } : { x, y, tn: m.tension, l: s.level };
      this.ribbon.push(pt);
      if (this.ribbon.length > 300) this.ribbon.shift();
    }
    const stroke = (pts, alpha, dy) => {
      if (pts.length < 2) return;
      g.lineCap = 'round'; g.lineJoin = 'round';
      for (const [width, a] of [[14, 0.08], [6, 0.25]]) {
        g.lineWidth = width * this.dpr;
        g.strokeStyle = C.primary(a * alpha);
        g.beginPath();
        pts.forEach((p, i) => (i ? g.lineTo(p.x * W, (p.y + dy) * R) : g.moveTo(p.x * W, (p.y + dy) * R)));
        g.stroke();
      }
      // Core line: stable notes take the key's colour; tense, out-of-key notes the accent.
      g.lineWidth = 2 * this.dpr;
      let i = 1;
      while (i < pts.length) {
        const tense = pts[i].tn > 0.6;
        g.strokeStyle = tense ? C.accent(0.9 * alpha) : C.primary(0.9 * alpha);
        g.beginPath();
        g.moveTo(pts[i - 1].x * W, (pts[i - 1].y + dy) * R);
        while (i < pts.length && (pts[i].tn > 0.6) === tense) { g.lineTo(pts[i].x * W, (pts[i].y + dy) * R); i++; }
        g.stroke();
      }
    };
    for (const old of this.oldRibbons) {
      old.a *= Math.exp(-dt * lerp(1.2, 0.4, this.calm));
      old.dy = (old.dy || 0) - dt * 0.05 * (1 + old.drift);
      stroke(old.pts, old.a * 0.6, old.dy);
    }
    this.oldRibbons = this.oldRibbons.filter((o) => o.a > 0.02);
    stroke(this.ribbon, 1, 0);

    for (const b of this.blooms) {
      b.r += dt * R * (b.big ? 0.6 : 0.3);
      b.a *= Math.exp(-dt * (b.big ? 1.2 : 2.5));
      const grad = g.createRadialGradient(b.x * W, b.y * R, 0, b.x * W, b.y * R, b.r + 1);
      grad.addColorStop(0, C.second(b.a * 0.6));
      grad.addColorStop(1, C.second(0));
      g.fillStyle = grad;
      g.beginPath(); g.arc(b.x * W, b.y * R, b.r + 1, 0, TAU); g.fill();
    }
    this.blooms = this.blooms.filter((b) => b.a > 0.02);
  }

}

function polygon(g, sides, r, rot) {
  g.beginPath();
  for (let i = 0; i <= sides; i++) {
    const a = rot + (i / sides) * TAU;
    i ? g.lineTo(Math.cos(a) * r, Math.sin(a) * r) : g.moveTo(Math.cos(a) * r, Math.sin(a) * r);
  }
}
