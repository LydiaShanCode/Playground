// Live analysis: turns an audio node into BPM, key, genre, rhythm and phrasing state.
import { detectKey, estimateTempo, classifyGenre, scaleTension, freqToMidi, slope, NOTE_NAMES } from './analysis.js';

const ENV_RATE = 100;            // onset envelope grid, Hz
const ENV_SECONDS = 10;
const TEMPO_WINDOW = 8;          // seconds of envelope used for tempo
const TEMPO_MEMORY = 6;          // seconds, averaging of tempo evidence
const KEY_TAU = 20;              // seconds, chroma memory
const FEATURE_TAU = 8;           // seconds, genre feature memory

const ema = (prev, v, dt, tau) => prev + (v - prev) * (1 - Math.exp(-dt / tau));

class OnsetDetector {
  constructor(minGap, k = 1.6, floor = 0.002) {
    this.hist = new Float32Array(40); this.i = 0; this.filled = 0;
    this.prev1 = 0; this.prev2 = 0; this.lastT = -1; this.minGap = minGap; this.k = k; this.floor = floor;
  }
  // Returns onset strength 0..1 for a peak one tick ago, else 0.
  push(v, t) {
    let mean = 0, sq = 0;
    const n = Math.max(1, this.filled);
    for (let j = 0; j < this.filled; j++) { mean += this.hist[j]; sq += this.hist[j] ** 2; }
    mean /= n;
    const sd = Math.sqrt(Math.max(0, sq / n - mean * mean));
    const thr = mean + this.k * sd + this.floor;
    let out = 0;
    const p = this.prev1;
    if (p > thr && p >= this.prev2 && p > v && t - this.lastT > this.minGap) {
      out = 1 - Math.exp(-(p - mean) / (sd * 3 + this.floor * 4));
      this.lastT = t;
    }
    this.hist[this.i] = v; this.i = (this.i + 1) % this.hist.length; this.filled = Math.min(this.filled + 1, this.hist.length);
    this.prev2 = this.prev1; this.prev1 = v;
    return out;
  }
}

export class Analyzer {
  constructor(ctx, input) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    input.connect(this.input);

    this.fast = ctx.createAnalyser();
    this.fast.fftSize = 1024; this.fast.smoothingTimeConstant = 0;
    this.slow = ctx.createAnalyser();
    this.slow.fftSize = 8192; this.slow.smoothingTimeConstant = 0;
    this.input.connect(this.fast); this.input.connect(this.slow);

    this.fFreq = new Float32Array(this.fast.frequencyBinCount);
    this.fPrev = new Float32Array(this.fast.frequencyBinCount);
    this.fTime = new Float32Array(this.fast.fftSize);
    this.sFreq = new Float32Array(this.slow.frequencyBinCount);
    this.sAmp = new Float32Array(this.slow.frequencyBinCount);
    this.spectrum = new Float32Array(64); // log-spaced, 0..1, for visuals

    const sr = ctx.sampleRate;
    this.fBin = sr / this.fast.fftSize;
    this.sBin = sr / this.slow.fftSize;
    // Pitch class for each slow bin in the chroma range.
    this.pcOfBin = new Int8Array(this.slow.frequencyBinCount).fill(-1);
    for (let i = 1; i < this.pcOfBin.length; i++) {
      const f = i * this.sBin;
      if (f >= 65 && f <= 4200) this.pcOfBin[i] = ((Math.round(freqToMidi(f)) % 12) + 12) % 12;
    }

    this.onset = { total: new OnsetDetector(0.08, 1.5), kick: new OnsetDetector(0.12, 1.6), snare: new OnsetDetector(0.1, 1.8), hat: new OnsetDetector(0.06, 1.6, 0.001) };
    this.env = new Float32Array(ENV_RATE * ENV_SECONDS);
    this.lastSlot = -1;

    this.events = [];
    this.chroma = new Float64Array(12);
    this.keyEvidence = 0;
    this.rms = 0; this.rmsShort = 0; this.rmsLong = 0.01; this.rmsPeak = 0.02;
    this.rmsDbHist = [];

    this.tempo = { bpm: 0, confidence: 0, candidate: 0, candidateCount: 0, curve: null };
    this.beat = { next: 0, last: 0, index: 0, kickSlots: new Float64Array(4), snareSlots: new Float64Array(4), downbeatSlot: 0 };
    this.key = { tonic: 0, mode: 'major', name: '—', confidence: 0, pending: null, pendingSince: 0 };
    this.features = { bpm: 120, bass: 0.35, bright: 0.8, noisy: 0.2, density: 2, regularity: 0.3, hats: -2, dyn: 3, sync: 0.25 };
    this.genre = [{ genre: 'Ambient', p: 1 }];
    this.genreOverride = null;
    this.onsetTimes = [];
    this.rhythm = { kick: 0, snare: 0, hat: 0, sync: 0.25, density: 0 };
    this.melody = { midi: 0, voiced: false, note: '', contour: 0, tension: 0, history: [], stableNote: 0, candNote: 0, candTicks: 0 };
    this.phrase = { active: false, start: 0, lastVoiced: 0, breathSince: 0, notes: [], pending: [], pendingStart: 0, lastNoteT: 0, index: 0, lastEnd: 0 };

    this.lastFast = ctx.currentTime;
    this.lastSlow = ctx.currentTime;
    this.timers = [
      setInterval(() => this.tickFast(), 10),
      setInterval(() => this.tickSlow(), 50),
      setInterval(() => this.updateTempo(), 500),
      setInterval(() => this.updateGenre(), 1000),
    ];
  }

  setSensitivity(g) { this.input.gain.value = g; }

  dispose() {
    this.timers.forEach(clearInterval);
    try { this.input.disconnect(); } catch { /* already gone */ }
  }

  emit(type, data = {}) {
    this.events.push({ type, t: this.ctx.currentTime, ...data });
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
  }

  // ---- 100 Hz: onsets, rhythm bands, beat clock --------------------------------
  tickFast() {
    const t = this.ctx.currentTime;
    const dt = Math.max(0.001, t - this.lastFast); this.lastFast = t;
    this.fast.getFloatFrequencyData(this.fFreq);
    this.fast.getFloatTimeDomainData(this.fTime);

    let sq = 0;
    for (let i = 0; i < this.fTime.length; i++) sq += this.fTime[i] ** 2;
    this.rms = Math.sqrt(sq / this.fTime.length);
    this.rmsShort = ema(this.rmsShort, this.rms, dt, 0.08);
    this.rmsPeak = Math.max(this.rmsPeak * Math.exp(-dt / 20), this.rms, 0.004);
    const gate = this.rms > 0.002;

    const bands = { total: 0, kick: 0, snare: 0, hat: 0 };
    const counts = { total: 0, kick: 0, snare: 0, hat: 0 };
    const B = this.fBin;
    for (let i = 1; i < this.fFreq.length; i++) {
      const db = this.fFreq[i];
      const lm = Math.log1p(1000 * (Number.isFinite(db) ? Math.pow(10, db / 20) : 0));
      const d = lm - this.fPrev[i];
      this.fPrev[i] = lm;
      const f = i * B, pos = d > 0 ? d : 0;
      bands.total += pos; counts.total++;
      if (f >= 30 && f < 150) { bands.kick += pos; counts.kick++; }
      else if (f >= 180 && f < 3500) { bands.snare += pos; counts.snare++; }
      else if (f >= 6000 && f < 15000) { bands.hat += pos; counts.hat++; }
    }
    for (const k in bands) bands[k] /= Math.max(1, counts[k]);

    // Onset envelope on a fixed 100 Hz grid for tempo.
    const slot = Math.floor(t * ENV_RATE);
    if (this.lastSlot < 0) this.lastSlot = slot - 1;
    // Kicks anchor the pulse, so they count extra.
    const envV = bands.total + bands.kick * 0.2;
    for (let s = this.lastSlot + 1; s <= slot; s++) this.env[s % this.env.length] = envV;
    if (slot === this.lastSlot) this.env[slot % this.env.length] = Math.max(this.env[slot % this.env.length], envV);
    this.lastSlot = slot;

    const decay = Math.exp(-dt / 0.12);
    this.rhythm.kick *= decay; this.rhythm.snare *= decay; this.rhythm.hat *= Math.exp(-dt / 0.06);
    for (const band of ['kick', 'snare', 'hat', 'total']) {
      const s = this.onset[band].push(bands[band], t);
      if (!s || !gate) continue;
      if (band === 'total') this.onTotalOnset(t - 0.01, s);
      else {
        this.rhythm[band] = Math.max(this.rhythm[band], s);
        this.emit(band, { strength: s });
        if (this.tempo.bpm && band !== 'hat') {
          const slotIdx = this.beatSlotAt(t - 0.01);
          if (slotIdx != null) (band === 'kick' ? this.beat.kickSlots : this.beat.snareSlots)[slotIdx] += s;
        }
      }
    }
    this.advanceBeatClock(t);
  }

  beatSlotAt(t) {
    const P = 60 / this.tempo.bpm, b = this.beat;
    const sinceLast = t - b.last;
    const nearNext = b.next - t < P * 0.2, nearLast = sinceLast < P * 0.2;
    if (!nearNext && !nearLast) return null;
    const idx = nearLast && sinceLast <= b.next - t ? b.index - 1 : b.index;
    return ((idx % 4) + 4) % 4;
  }

  onTotalOnset(t, s) {
    this.onsetTimes.push(t);
    while (this.onsetTimes.length && t - this.onsetTimes[0] > 4) this.onsetTimes.shift();
    this.rhythm.density = this.onsetTimes.length / 4;
    this.emit('onset', { strength: s });
    if (!this.tempo.bpm) return;
    const P = 60 / this.tempo.bpm, b = this.beat;
    // Syncopation: how much onset energy falls away from beats and 8ths.
    const phase = (((t - b.last) / P) % 1 + 1) % 1;
    const d8 = Math.min(Math.abs(phase), Math.abs(phase - 0.5), Math.abs(phase - 1));
    this.rhythm.sync = ema(this.rhythm.sync, d8 > 0.1 ? 1 : 0, s * 0.5, 4);
    // Phase-lock the beat clock towards strong onsets near a beat.
    const toNext = b.next - t, toLast = t - b.last;
    if (s > 0.25) {
      if (toNext < P * 0.25 && toNext < toLast) b.next -= toNext * 0.2;
      else if (toLast < P * 0.25) b.next += toLast * 0.2;
    }
  }

  advanceBeatClock(t) {
    if (!this.tempo.bpm) return;
    const P = 60 / this.tempo.bpm, b = this.beat;
    if (b.next < t - P) b.next = t; // fell far behind (e.g. after tempo change)
    if (t >= b.next) {
      // Decay slot evidence slowly so downbeat follows the song.
      for (let i = 0; i < 4; i++) { b.kickSlots[i] *= 0.985; b.snareSlots[i] *= 0.985; }
      let best = 0, bestScore = -Infinity;
      for (let i = 0; i < 4; i++) {
        const sc = b.kickSlots[i] - 0.6 * b.snareSlots[i];
        if (sc > bestScore) { bestScore = sc; best = i; }
      }
      b.downbeatSlot = best;
      const barPos = (((b.index - b.downbeatSlot) % 4) + 4) % 4;
      this.emit(barPos === 0 ? 'downbeat' : 'beat', { barPos, strength: this.rmsShort / this.rmsPeak });
      b.last = b.next; b.next += P; b.index++;
      this.beat.barPos = barPos;
    }
  }

  // ---- 2 Hz: tempo ------------------------------------------------------------
  updateTempo() {
    const n = ENV_RATE * TEMPO_WINDOW;
    if (this.lastSlot < n) return;
    const arr = new Float32Array(n);
    for (let i = 0; i < n; i++) arr[i] = this.env[(this.lastSlot - n + 1 + i) % this.env.length];
    const est = this.rmsLong > 0.002 ? estimateTempo(arr, ENV_RATE) : null;
    const tp = this.tempo;
    if (!est || est.confidence < 0.12) { tp.confidence = ema(tp.confidence, 0, 0.5, 3); return; }
    tp.confidence = ema(tp.confidence, est.confidence, 0.5, 2);

    // Average the whole tempo-score curve over time and take its peak: ambiguous grooves
    // settle on whichever tempo wins most consistently instead of flip-flopping.
    if (!tp.curve) tp.curve = Float32Array.from(est.curve);
    else {
      const k = 1 - Math.exp(-0.5 / TEMPO_MEMORY);
      for (let i = 0; i < tp.curve.length; i++) tp.curve[i] += (est.curve[i] - tp.curve[i]) * k;
    }
    let bi = 0;
    for (let i = 1; i < tp.curve.length; i++) if (tp.curve[i] > tp.curve[bi]) bi = i;
    let off = 0;
    if (bi > 0 && bi < tp.curve.length - 1) {
      const a = tp.curve[bi - 1], b = tp.curve[bi], c = tp.curve[bi + 1], d = a - 2 * b + c;
      if (d < 0) off = (0.5 * (a - c)) / d;
    }
    let bpm = est.minBpm + (bi + off) * est.step;
    // Genre-aware octave choice for drum & bass, which is usually heard at double time.
    if (this.topGenre() === 'Drum & Bass' && bpm < 100) bpm *= 2;

    if (!tp.bpm) { tp.bpm = bpm; this.beat.next = this.ctx.currentTime; this.emit('tempo', { bpm }); return; }
    if (Math.abs(bpm / tp.bpm - 1) < 0.03) { tp.bpm = ema(tp.bpm, bpm, 0.5, 1.5); tp.candidateCount = 0; return; }
    // A different peak must hold for two updates (1 s) before the beat clock jumps.
    if (tp.candidate && Math.abs(bpm / tp.candidate - 1) < 0.03) tp.candidateCount++;
    else { tp.candidate = bpm; tp.candidateCount = 1; }
    if (tp.candidateCount >= 2) { tp.bpm = bpm; tp.candidateCount = 0; this.emit('tempo', { bpm }); }
  }

  // ---- 20 Hz: chroma/key, spectrum features, melody and phrasing --------------
  tickSlow() {
    const t = this.ctx.currentTime;
    const dt = Math.max(0.001, t - this.lastSlow); this.lastSlow = t;
    this.slow.getFloatFrequencyData(this.sFreq);
    const amp = this.sAmp, B = this.sBin;
    for (let i = 0; i < amp.length; i++) {
      const db = this.sFreq[i];
      amp[i] = Number.isFinite(db) ? Math.pow(10, db / 20) : 0;
    }
    this.rmsLong = ema(this.rmsLong, this.rms, dt, 3);
    const loud = Math.min(1, this.rmsShort / 0.01);

    // Chroma from spectral peaks.
    const frame = new Float64Array(12);
    let fsum = 0;
    for (let i = 2; i < amp.length - 1; i++) {
      const pc = this.pcOfBin[i];
      if (pc < 0 || amp[i] < amp[i - 1] || amp[i] < amp[i + 1]) continue;
      // Bass notes usually spell chord roots, which helps tell relative major/minor apart.
      const wgt = i * B < 260 ? 1.8 : 1;
      frame[pc] += amp[i] * wgt; fsum += amp[i] * wgt;
    }
    if (fsum > 0 && loud > 0.15) {
      const k = 1 - Math.exp(-dt / KEY_TAU);
      for (let i = 0; i < 12; i++) this.chroma[i] = this.chroma[i] * (1 - k) + (frame[i] / fsum) * k * loud;
      this.keyEvidence += dt * loud;
      if (this.keyEvidence > 4) this.updateKey(t); // name a key only after ~4 s of music
    }

    // Spectral shape features.
    let eTot = 0, eBass = 0, eHat = 0, cNum = 0, logSum = 0, linSum = 0, nFlat = 0;
    for (let i = 1; i < amp.length; i++) {
      const f = i * B;
      if (f < 20 || f > 15000) continue;
      const p = amp[i] * amp[i];
      eTot += p; cNum += p * f;
      if (f < 150) eBass += p;
      if (f >= 5000) eHat += p;
      if (f >= 100 && f <= 8000) { logSum += Math.log(p + 1e-20); linSum += p; nFlat++; }
    }
    if (eTot > 1e-9 && loud > 0.2) {
      const F = this.features, tau = FEATURE_TAU;
      F.bass = ema(F.bass, eBass / eTot, dt, tau);
      F.hats = ema(F.hats, Math.log10(eHat / eTot + 1e-4), dt, tau);
      F.bright = ema(F.bright, Math.log2(Math.max(50, cNum / eTot) / 1000), dt, tau);
      F.noisy = ema(F.noisy, Math.exp(logSum / nFlat) / (linSum / nFlat + 1e-20), dt, tau);
      F.density = ema(F.density, this.rhythm.density, dt, tau);
      F.regularity = ema(F.regularity, this.tempo.confidence, dt, tau);
      F.sync = this.rhythm.sync;
      if (this.tempo.bpm) F.bpm = this.tempo.bpm;
      const db = 20 * Math.log10(this.rmsShort + 1e-6);
      this.rmsDbHist.push(db);
      if (this.rmsDbHist.length > 200) this.rmsDbHist.shift();
      const m = this.rmsDbHist.reduce((a, b) => a + b, 0) / this.rmsDbHist.length;
      const sd = Math.sqrt(this.rmsDbHist.reduce((a, b) => a + (b - m) ** 2, 0) / this.rmsDbHist.length);
      F.dyn = ema(F.dyn, sd, dt, tau);
    }

    // Log-spaced spectrum for visuals (normalised against a slow peak).
    const bins = this.spectrum.length;
    for (let j = 0; j < bins; j++) {
      const f0 = 40 * Math.pow(16000 / 40, j / bins), f1 = 40 * Math.pow(16000 / 40, (j + 1) / bins);
      let m = 0;
      for (let i = Math.floor(f0 / B); i <= Math.ceil(f1 / B) && i < amp.length; i++) m = Math.max(m, amp[i]);
      const v = Math.max(0, Math.min(1, (20 * Math.log10(m + 1e-9) + 80) / 60));
      this.spectrum[j] = Math.max(v, this.spectrum[j] * Math.exp(-dt / 0.15));
    }

    this.updateMelody(t, dt, amp, B);
  }

  updateKey(t) {
    const k = detectKey(this.chroma);
    const cur = this.key;
    if (cur.name === '—' || (k.tonic === cur.tonic && k.mode === cur.mode)) {
      const changed = cur.name === '—';
      Object.assign(cur, { tonic: k.tonic, mode: k.mode, name: k.name, confidence: k.confidence, pending: null });
      if (changed) this.emit('key', { name: k.name });
      return;
    }
    // A new key must win continuously for 5 s before we switch.
    if (!cur.pending || cur.pending.name !== k.name) { cur.pending = k; cur.pendingSince = t; }
    else if (t - cur.pendingSince > 5) {
      Object.assign(cur, { tonic: k.tonic, mode: k.mode, name: k.name, confidence: k.confidence, pending: null });
      this.emit('key', { name: k.name });
    }
  }

  // Melody: dominant pitch by harmonic product in 180–1500 Hz, then phrase segmentation.
  updateMelody(t, dt, amp, B) {
    const lo = Math.ceil(180 / B), hi = Math.floor(1500 / B);
    let best = -Infinity, bestI = -1, mean = 0, cnt = 0;
    for (let i = lo; i <= hi && 3 * i < amp.length; i++) {
      const s = Math.log(amp[i] + 1e-7) + Math.log(amp[2 * i] + 1e-7) * 0.8 + Math.log(amp[3 * i] + 1e-7) * 0.6;
      mean += s; cnt++;
      if (s > best) { best = s; bestI = i; }
    }
    mean /= Math.max(1, cnt);
    const clarity = best - mean;
    const voiced = bestI > 0 && clarity > 6 && this.rmsShort > 0.004;
    const M = this.melody, P = this.phrase;
    const beatLen = this.tempo.bpm ? 60 / this.tempo.bpm : 0.5;
    const noteGap = Math.max(0.8, beatLen * 2); // no new note for this long = a held chord, not a line

    if (voiced) {
      const a = amp[bestI - 1], b = amp[bestI], c = amp[bestI + 1];
      const off = (a - c) / (2 * (a - 2 * b + c) || 1);
      let midi = freqToMidi((bestI + Math.max(-0.5, Math.min(0.5, off))) * B);
      // Pitch trackers love octave mistakes: fold big jumps back toward the current line.
      if (M.voiced) {
        while (midi - M.midi > 9) midi -= 12;
        while (M.midi - midi > 9) midi += 12;
      }
      M.history.push({ t, midi });
      M.midi = M.voiced ? M.midi + (midi - M.midi) * 0.5 : midi;
      // A note change only counts once the new pitch has lasted ~100 ms (debounces flicker
      // between a lead line and the chords under it).
      const rounded = Math.round(M.midi);
      if (rounded !== M.stableNote) {
        if (rounded === M.candNote) M.candTicks++; else { M.candNote = rounded; M.candTicks = 1; }
        if (M.candTicks >= 2) {
          this.emit('note', { midi: M.midi, leap: M.stableNote ? rounded - M.stableNote : 0 });
          M.stableNote = rounded; P.lastNoteT = t;
        }
      } else M.candTicks = 0;
      M.voiced = true;
      M.note = NOTE_NAMES[((Math.round(M.midi) % 12) + 12) % 12];
      M.tension = scaleTension(Math.round(M.midi), this.key.tonic, this.key.mode);
      P.lastVoiced = t;
      if (P.active) P.notes.push(M.midi);
      else if (t - P.lastNoteT < noteGap) {
        // Only call it a phrase once a moving melody has held for a moment; blips and
        // sustained chords don't count.
        P.pending.push(M.midi);
        if (!P.pendingStart) P.pendingStart = t;
        if (t - P.pendingStart > 0.25) {
          P.active = true; P.start = P.pendingStart; P.notes = P.pending;
          P.pending = []; P.pendingStart = 0; P.index++;
          this.emit('phraseStart', { midi: P.notes[0], index: P.index });
        }
      }
    } else {
      M.voiced = false;
    }
    if (!P.active && t - P.lastVoiced > 0.1) { P.pendingStart = 0; P.pending = []; }
    while (M.history.length && t - M.history[0].t > 1.2) M.history.shift();
    M.contour = M.history.length > 3 ? slope(M.history.map((h) => h.t), M.history.map((h) => h.midi)) : M.contour * 0.9;

    // Phrase ends on a breath: the melody stops (or just holds) for about a beat, or the
    // music drops out. Gaps between drum hits are not breaths, so only a deep drop-out counts.
    const dropout = this.rmsShort < this.rmsLong * 0.2;
    P.breathSince = dropout || !voiced ? (P.breathSince || t) : 0;
    const silent = P.breathSince && t - P.breathSince > Math.max(0.35, beatLen);
    const held = t - P.lastNoteT > noteGap;
    const tooLong = t - P.start > beatLen * 16; // 4 bars: the most common phrase length
    const minLen = t - P.start > beatLen * 4; // phrases are at least a bar long
    if (P.active && ((minLen && (silent || held)) || tooLong)) {
      const dur = t - P.start;
      P.active = false; P.lastEnd = t;
      if (dur > 0.6 && P.notes.length > 3) {
        const last = P.notes[P.notes.length - 1];
        const resolved = scaleTension(Math.round(last), this.key.tonic, this.key.mode) <= 0.15;
        // Phrases tend to come to rest on the tonic: count where they land as key evidence.
        const pcEnd = ((Math.round(last) % 12) + 12) % 12;
        const total = this.chroma.reduce((a, b) => a + b, 0) || 1;
        this.chroma[pcEnd] += total * 0.03;
        const shape = Math.sign(Math.round(last - P.notes[0]));
        this.emit('phraseEnd', { duration: dur, resolved, shape, range: Math.max(...P.notes) - Math.min(...P.notes) });
      }
    }
  }

  updateGenre() {
    if (this.rmsLong < 0.002) return;
    const probs = classifyGenre(this.features);
    // Smooth so the scene doesn't flicker.
    const prev = new Map(this.genre.map((g) => [g.genre, g.p]));
    this.genre = probs.map((g) => ({ genre: g.genre, p: (prev.get(g.genre) ?? 0) * 0.7 + g.p * 0.3 })).sort((a, b) => b.p - a.p);
  }

  topGenre() { return this.genreOverride || this.genre[0].genre; }

  /** Snapshot for the renderer; drains queued events. */
  read() {
    const t = this.ctx.currentTime;
    const P = this.tempo.bpm ? 60 / this.tempo.bpm : 0;
    const beatPhase = P ? Math.max(0, Math.min(1, (t - this.beat.last) / P)) : 0;
    const events = this.events; this.events = [];
    const genre = this.genreOverride ? [{ genre: this.genreOverride, p: 1 }] : this.genre;
    const beatLen = P || 0.5;
    return {
      t,
      level: Math.min(1, this.rmsShort / this.rmsPeak),
      bpm: this.tempo.bpm, bpmConfidence: this.tempo.confidence,
      beatPhase, barPos: this.beat.barPos ?? 0,
      key: { ...this.key, pending: undefined },
      genre,
      rhythm: { ...this.rhythm },
      melody: {
        midi: this.melody.midi, line: this.melody.stableNote || this.melody.midi,
        voiced: this.melody.voiced, note: this.melody.note,
        contour: this.melody.contour, tension: this.melody.tension,
        inPhrase: this.phrase.active, phraseIndex: this.phrase.index,
        progress: this.phrase.active ? (t - this.phrase.start) / (beatLen * 16) : 0,
      },
      features: { ...this.features },
      spectrum: this.spectrum,
      events,
    };
  }
}
