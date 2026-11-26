// A small generative band for trying the visuals without a microphone.
// Each preset has a tempo, key, groove and phrase structure (4-bar phrases, last bar breathes).

export const PRESETS = [
  { id: 'ambient', label: 'Ambient · 72 BPM · A minor', bpm: 72, tonic: 57, mode: 'minor', style: 'ambient' },
  { id: 'house', label: 'House · 124 BPM · F major', bpm: 124, tonic: 53, mode: 'major', style: 'house' },
  { id: 'hiphop', label: 'Hip-Hop · 88 BPM · D minor', bpm: 88, tonic: 50, mode: 'minor', style: 'hiphop' },
  { id: 'rock', label: 'Rock · 140 BPM · G major', bpm: 140, tonic: 55, mode: 'major', style: 'rock' },
  { id: 'dnb', label: 'Drum & Bass · 172 BPM · E minor', bpm: 172, tonic: 52, mode: 'minor', style: 'dnb' },
];

const SCALES = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] };
const PROGRESSIONS = { major: [0, 4, 5, 3], minor: [0, 5, 3, 4] }; // I V vi IV / i VI iv V (harmonic-minor V)
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

function rng(seed) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
}

// 16-step drum patterns: k = kick, s = snare, h = closed hat, o = open hat
const GROOVES = {
  ambient: { k: [0], s: [], h: [], o: [] },
  house: { k: [0, 4, 8, 12], s: [4, 12], h: [2, 6, 10, 14], o: [2, 6, 10, 14] },
  hiphop: { k: [0, 7, 10], s: [4, 12], h: [0, 2, 4, 6, 8, 10, 12, 14], o: [] },
  rock: { k: [0, 8, 10], s: [4, 12], h: [0, 2, 4, 6, 8, 10, 12, 14], o: [] },
  dnb: { k: [0, 10], s: [4, 12], h: [0, 2, 4, 6, 8, 10, 12, 14], o: [] },
};

export class DemoBand {
  constructor(ctx, preset) {
    this.ctx = ctx; this.p = preset;
    this.out = ctx.createGain(); this.out.gain.value = 0.7;
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.dist = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = i / 512 - 1; curve[i] = Math.tanh(x * 6); }
    this.dist.curve = curve;
    const distOut = ctx.createGain(); distOut.gain.value = 0.18;
    this.dist.connect(distOut).connect(this.out);
    this.rand = rng(7);
    this.step = 0;
    this.nextTime = ctx.currentTime + 0.1;
    this.melodyDeg = 4;
    this.timer = setInterval(() => this.schedule(), 25);
  }

  connect(node) { this.out.connect(node); return this; }
  stop() { clearInterval(this.timer); this.out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05); setTimeout(() => this.out.disconnect(), 400); }

  get sixteenth() { return 60 / this.p.bpm / 4; }

  schedule() {
    while (this.nextTime < this.ctx.currentTime + 0.12) {
      this.playStep(this.step, this.nextTime);
      this.step++;
      this.nextTime += this.sixteenth;
    }
  }

  // `leading` raises the 7th in minor (harmonic minor), used over the V chord.
  degreeToMidi(deg, octave = 0, leading = false) {
    const sc = SCALES[this.p.mode];
    const o = Math.floor(deg / 7), d = ((deg % 7) + 7) % 7;
    const raise = leading && this.p.mode === 'minor' && d === 6 ? 1 : 0;
    return this.p.tonic + sc[d] + raise + 12 * (o + octave);
  }

  playStep(step, t) {
    const p = this.p, st = p.style;
    const s16 = step % 16, bar = Math.floor(step / 16), barInPhrase = bar % 4;
    const phraseNo = Math.floor(bar / 4);
    const chordRoot = PROGRESSIONS[p.mode][barInPhrase];
    const onV = chordRoot === 4;
    const g = GROOVES[st];
    // Swing the hip-hop hats a little.
    const sw = st === 'hiphop' && s16 % 2 ? this.sixteenth * 0.18 : 0;

    if (g.k.includes(s16)) this.kick(t, st === 'ambient' ? 0.35 : 1);
    if (g.s.includes(s16)) this.snare(t, st === 'rock' ? 1 : 0.8);
    if (g.h.includes(s16)) this.hat(t + sw, 0.045, st === 'house' ? 0.25 : 0.35);
    if (st === 'house' && g.o.includes(s16)) this.hat(t, 0.16, 0.12);
    if (st === 'dnb' && s16 % 2 === 1 && this.rand() < 0.4) this.hat(t, 0.03, 0.2);

    // Bass
    const bassMidi = this.degreeToMidi(chordRoot, -1) - (st === 'ambient' ? 12 : 0);
    if (st === 'house' && s16 % 4 === 2) this.bass(t, bassMidi, this.sixteenth * 1.6);
    if ((st === 'hiphop' || st === 'dnb') && (s16 === 0 || s16 === 10)) this.bass(t, bassMidi - 12, this.sixteenth * 5, true);
    if (st === 'rock' && s16 % 2 === 0) this.bass(t, bassMidi, this.sixteenth * 1.8);

    // Harmony
    if (s16 === 0) {
      const chord = [0, 2, 4].map((d) => this.degreeToMidi(chordRoot + d, 0, onV));
      if (st === 'ambient' || st === 'house' || st === 'hiphop') this.pad(t, chord, this.sixteenth * 16, st === 'ambient' ? 0.08 : 0.04);
    }
    if (st === 'rock' && s16 % 4 === 0) this.guitar(t, [0, 2, 4].map((d) => this.degreeToMidi(chordRoot + d, -1, onV)), this.sixteenth * 3.5);
    if (st === 'ambient' && s16 % 2 === 0) {
      const arp = [0, 2, 4, 7][(s16 / 2) % 4];
      this.pluck(t, this.degreeToMidi(chordRoot + arp, 1, onV), 0.06);
    }

    // Melody: 4-bar phrases. Bars 1–3 sing, bar 4 breathes; even phrases resolve to the tonic.
    const rhythm = st === 'ambient' ? [0, 6, 8, 12] : st === 'dnb' ? [0, 3, 6, 8, 11, 14] : [0, 3, 6, 8, 10, 12, 14];
    if (barInPhrase < 3 && rhythm.includes(s16)) {
      if (barInPhrase === 0 && s16 === 0) this.melodyDeg = 7 + Math.floor(this.rand() * 3);
      const strong = s16 % 8 === 0;
      if (strong) {
        // Land on a chord tone near the current note.
        const tones = [0, 2, 4].map((d) => chordRoot + d + 7);
        this.melodyDeg = tones.reduce((a, b) => (Math.abs(b - this.melodyDeg) < Math.abs(a - this.melodyDeg) ? b : a));
      } else {
        this.melodyDeg += [-2, -1, -1, 1, 1, 2][Math.floor(this.rand() * 6)];
      }
      this.melodyDeg = Math.max(4, Math.min(13, this.melodyDeg));
      let deg = this.melodyDeg;
      const lastNote = barInPhrase === 2 && s16 === rhythm[rhythm.length - 1];
      if (lastNote) deg = phraseNo % 2 ? 7 : 11; // answer phrase lands on the tonic; question hangs on the 5th
      const len = this.sixteenth * (lastNote ? 6 : st === 'ambient' ? 5 : 1.8);
      this.lead(t, this.degreeToMidi(deg, 0, onV), len, st);
    }
  }

  env(gain, t, a, d, peak) {
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(peak, t + a);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }

  kick(t, v) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    this.env(g, t, 0.002, 0.4, 0.9 * v);
    o.connect(g).connect(this.out); o.start(t); o.stop(t + 0.45);
  }

  noiseHit(t, type, freq, q, dur, v) {
    const src = this.ctx.createBufferSource(); src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = this.ctx.createGain(); this.env(g, t, 0.001, dur, v);
    src.connect(f).connect(g).connect(this.out);
    src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.05);
  }

  snare(t, v) {
    this.noiseHit(t, 'bandpass', 1800, 0.8, 0.18, 0.5 * v);
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.frequency.value = 190; this.env(g, t, 0.001, 0.1, 0.3 * v);
    o.connect(g).connect(this.out); o.start(t); o.stop(t + 0.15);
  }

  hat(t, dur, v) { this.noiseHit(t, 'highpass', 8000, 0.7, dur, v); }

  bass(t, midi, dur, sub = false) {
    const o = this.ctx.createOscillator(), f = this.ctx.createBiquadFilter(), g = this.ctx.createGain();
    o.type = sub ? 'sine' : 'sawtooth'; o.frequency.value = mtof(midi);
    f.type = 'lowpass'; f.frequency.value = sub ? 400 : 500;
    this.env(g, t, 0.005, dur, sub ? 0.55 : 0.3);
    o.connect(f).connect(g).connect(this.out); o.start(t); o.stop(t + dur + 0.05);
  }

  pad(t, notes, dur, v) {
    for (const m of notes) {
      for (const det of [-6, 6]) {
        const o = this.ctx.createOscillator(), f = this.ctx.createBiquadFilter(), g = this.ctx.createGain();
        o.type = 'sawtooth'; o.frequency.value = mtof(m); o.detune.value = det;
        f.type = 'lowpass'; f.frequency.value = 900;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(v, t + dur * 0.3);
        g.gain.linearRampToValueAtTime(0, t + dur);
        o.connect(f).connect(g).connect(this.out); o.start(t); o.stop(t + dur + 0.05);
      }
    }
  }

  pluck(t, midi, v) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = 'triangle'; o.frequency.value = mtof(midi);
    this.env(g, t, 0.003, 0.6, v);
    o.connect(g).connect(this.out); o.start(t); o.stop(t + 0.65);
  }

  guitar(t, notes, dur) {
    for (const m of notes) {
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = 'sawtooth'; o.frequency.value = mtof(m);
      this.env(g, t, 0.003, dur, 0.5);
      o.connect(g).connect(this.dist); o.start(t); o.stop(t + dur + 0.05);
    }
  }

  lead(t, midi, dur, style) {
    const o = this.ctx.createOscillator(), f = this.ctx.createBiquadFilter(), g = this.ctx.createGain();
    o.type = style === 'ambient' ? 'sine' : 'square'; o.frequency.value = mtof(midi);
    f.type = 'lowpass'; f.frequency.value = 3000;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(style === 'ambient' ? 0.22 : 0.12, t + 0.01);
    g.gain.setValueAtTime(style === 'ambient' ? 0.18 : 0.1, t + dur * 0.8);
    g.gain.linearRampToValueAtTime(0, t + dur);
    o.connect(f).connect(g).connect(this.out); o.start(t); o.stop(t + dur + 0.05);
  }
}
