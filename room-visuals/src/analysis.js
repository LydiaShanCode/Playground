// Pure music-analysis helpers. No Web Audio here, so they can be tested in Node.

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Krumhansl–Kessler key profiles (tonic first).
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

export const freqToMidi = (f) => 69 + 12 * Math.log2(f / 440);
export const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);
export const midiName = (m) => NOTE_NAMES[((Math.round(m) % 12) + 12) % 12] + (Math.floor(Math.round(m) / 12) - 1);

function pearson(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/**
 * Key from a 12-bin chroma vector (index 0 = C).
 * Returns { tonic, mode: 'major'|'minor', name, confidence (0..1), score }.
 */
export function detectKey(chroma) {
  let best = { score: -Infinity }, second = -Infinity;
  const rotated = new Array(12);
  for (const [mode, profile] of [['major', MAJOR_PROFILE], ['minor', MINOR_PROFILE]]) {
    for (let tonic = 0; tonic < 12; tonic++) {
      for (let i = 0; i < 12; i++) rotated[i] = profile[(i - tonic + 12) % 12];
      const score = pearson(chroma, rotated);
      if (score > best.score) { second = best.score; best = { tonic, mode, score }; }
      else if (score > second) second = score;
    }
  }
  const margin = Number.isFinite(second) ? best.score - second : 0;
  return {
    ...best,
    name: `${NOTE_NAMES[best.tonic]} ${best.mode}`,
    // Strong correlation and a clear margin over the runner-up both raise confidence.
    confidence: Math.max(0, Math.min(1, best.score * 0.6 + margin * 4)),
  };
}

/**
 * Tempo from an onset-strength envelope sampled at `rate` Hz.
 * Autocorrelation plus a comb over beat multiples, with a mild prior around 120 BPM.
 * Returns { bpm, confidence (0..1) } or null if the envelope is flat.
 */
export function estimateTempo(env, rate, { minBpm = 60, maxBpm = 190 } = {}) {
  const n = env.length;
  if (n < rate * 3) return null;

  // Emphasise peaks: subtract a ~0.4 s moving average, half-wave rectify.
  const win = Math.max(1, Math.round(rate * 0.4));
  const x = new Float32Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += env[i];
    if (i >= win) acc -= env[i - win];
    const avg = acc / Math.min(i + 1, win);
    x[i] = Math.max(0, env[i] - avg);
  }
  // Light blur (~40 ms) so sharp onsets don't favour whole-sample lags.
  for (let pass = 0; pass < 2; pass++) {
    const src = Float32Array.from(x);
    for (let i = 0; i < n; i++) {
      const a = src[Math.max(0, i - 2)], b = src[Math.max(0, i - 1)], c = src[i];
      const d = src[Math.min(n - 1, i + 1)], e = src[Math.min(n - 1, i + 2)];
      x[i] = (a + 4 * b + 6 * c + 4 * d + e) / 16;
    }
  }

  const maxLag = Math.min(n - 1, Math.floor(n * 0.6));
  const ac = new Float32Array(maxLag + 1);
  for (let lag = 0; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += x[i] * x[i + lag];
    ac[lag] = s / (n - lag);
  }
  if (ac[0] <= 1e-12) return null;
  const acAt = (l) => {
    if (l >= maxLag) return 0;
    const i = Math.floor(l), f = l - i;
    return ac[i] * (1 - f) + ac[i + 1] * f;
  };

  const scoreFor = (bpm) => {
    const lag = (60 * rate) / bpm;
    let s = 0, w = 0;
    for (let k = 1; k <= 4; k++) {
      if (k * lag >= maxLag) break;
      s += acAt(k * lag) / k;
      w += 1 / k;
    }
    if (!w) return -Infinity;
    // A real beat usually has its 8th-note subdivision present too. This separates
    // 72 from 144 (arpeggiated 8ths) and 172 from 115 (drum & bass two-step).
    s += acAt(lag / 2) * 0.6;
    w += 0.6;
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
    return (s / w) * (0.55 + 0.45 * prior);
  };

  let bestBpm = minBpm, bestScore = -Infinity;
  const step = 0.25;
  const curve = new Float32Array(Math.floor((maxBpm - minBpm) / step) + 1);
  for (let j = 0; j < curve.length; j++) {
    const bpm = minBpm + j * step;
    const s = scoreFor(bpm);
    curve[j] = Math.max(0, s / ac[0]);
    if (s > bestScore) { bestScore = s; bestBpm = bpm; }
  }
  // Parabolic refinement around the grid peak.
  const sl = scoreFor(bestBpm - step), sr = scoreFor(bestBpm + step);
  const denom = sl - 2 * bestScore + sr;
  if (Number.isFinite(denom) && denom < 0) bestBpm += (step * 0.5 * (sl - sr)) / denom;

  return {
    bpm: bestBpm,
    confidence: Math.max(0, Math.min(1, (bestScore / ac[0]) * 1.6)),
    // Score for every tempo on the grid (minBpm + i * step), so callers can average over time.
    curve, minBpm, step,
  };
}

/** Musical tension of a pitch class relative to a key, 0 (tonic) .. 1 (outside the scale). */
export function scaleTension(pc, tonic, mode) {
  const deg = (((pc - tonic) % 12) + 12) % 12;
  const major = { 0: 0, 7: 0.15, 4: 0.25, 9: 0.4, 2: 0.45, 5: 0.5, 11: 0.75 };
  const minor = { 0: 0, 7: 0.15, 3: 0.25, 8: 0.4, 2: 0.45, 5: 0.5, 10: 0.6, 11: 0.75 };
  const table = mode === 'minor' ? minor : major;
  return deg in table ? table[deg] : 1;
}

/** Hue (degrees) for a key: walk the circle of fifths; minor keys sit cooler and darker. */
export function keyColour(tonic, mode) {
  const fifths = (tonic * 7) % 12; // C=0, G=1, D=2 ...
  const hue = (fifths * 30 + 20) % 360;
  return mode === 'minor'
    ? { hue: (hue + 340) % 360, sat: 62, light: 50 }
    : { hue, sat: 85, light: 62 };
}

// --- Genre (heuristic) ------------------------------------------------------
// Feature prototypes: [mean, spread]. These are rough, hand-tuned guesses from
// what each style tends to look like through this analyser (checked against the demo band),
// not a trained model. Spreads are wide on purpose: rooms and mics vary a lot.
export const GENRES = {
  'Electronic': { bpm: [124, 8], bass: [0.4, 0.2], bright: [-0.5, 0.7], noisy: [0.08, 0.1], density: [4, 2], regularity: [0.8, 0.2], hats: [-2.2, 0.7], dyn: [3.5, 2], sync: [0.15, 0.15] },
  'Drum & Bass': { bpm: [172, 8], bass: [0.35, 0.2], bright: [-0.2, 0.7], noisy: [0.1, 0.1], density: [6, 2.5], regularity: [0.7, 0.25], hats: [-1.7, 0.7], dyn: [5, 2.5], sync: [0.45, 0.2] },
  'Hip-Hop': { bpm: [88, 8], bass: [0.45, 0.2], bright: [-0.8, 0.7], noisy: [0.06, 0.08], density: [3, 1.5], regularity: [0.6, 0.25], hats: [-2.3, 0.7], dyn: [5, 2.5], sync: [0.25, 0.2] },
  'Rock': { bpm: [135, 20], bass: [0.25, 0.15], bright: [-0.3, 0.6], noisy: [0.15, 0.12], density: [4.5, 2], regularity: [0.7, 0.25], hats: [-1.9, 0.6], dyn: [4.5, 2], sync: [0.15, 0.15] },
  'Pop': { bpm: [110, 14], bass: [0.3, 0.15], bright: [-0.5, 0.6], noisy: [0.08, 0.08], density: [3.5, 1.5], regularity: [0.7, 0.25], hats: [-2.3, 0.7], dyn: [4, 2], sync: [0.2, 0.15] },
  'Jazz': { bpm: [140, 30], bass: [0.2, 0.15], bright: [-0.6, 0.6], noisy: [0.05, 0.06], density: [4, 2], regularity: [0.4, 0.2], hats: [-2.2, 0.7], dyn: [6, 2.5], sync: [0.5, 0.15] },
  'Classical': { bpm: [100, 35], bass: [0.1, 0.1], bright: [-0.8, 0.7], noisy: [0.02, 0.03], density: [2, 1.5], regularity: [0.25, 0.2], hats: [-3.3, 0.7], dyn: [8, 3], sync: [0.3, 0.2] },
  'Ambient': { bpm: [75, 25], bass: [0.08, 0.1], bright: [-0.9, 0.7], noisy: [0.03, 0.05], density: [1.8, 1.5], regularity: [0.25, 0.2], hats: [-3.5, 0.6], dyn: [4, 2.5], sync: [0.25, 0.2] },
};
const FEATURE_WEIGHTS = { bpm: 1.5, bass: 1, bright: 0.7, noisy: 0.8, density: 1, regularity: 0.9, hats: 0.6, dyn: 0.6, sync: 0.7 };

/**
 * Soft genre classification. `f` holds the features named in GENRES.
 * Tempo is octave-tolerant (half/double time count for a bit less).
 * Returns [{ genre, p }] sorted by probability.
 */
export function classifyGenre(f) {
  const logits = [];
  for (const [genre, proto] of Object.entries(GENRES)) {
    let ll = 0;
    for (const [key, [mu, sd]] of Object.entries(proto)) {
      const v = f[key];
      if (v == null || !Number.isFinite(v)) continue;
      let z2;
      if (key === 'bpm') {
        const z = (b) => ((b - mu) / sd) ** 2;
        z2 = Math.min(z(v), z(v * 2) + 1.2, z(v / 2) + 1.2);
      } else {
        z2 = ((v - mu) / sd) ** 2;
      }
      ll += -0.5 * Math.min(z2, 9) * FEATURE_WEIGHTS[key];
    }
    logits.push([genre, ll]);
  }
  const max = Math.max(...logits.map((l) => l[1]));
  const exps = logits.map(([g, l]) => [g, Math.exp((l - max) / 1.5)]);
  const sum = exps.reduce((a, [, e]) => a + e, 0);
  return exps.map(([genre, e]) => ({ genre, p: e / sum })).sort((a, b) => b.p - a.p);
}

/** Least-squares slope of y over x. */
export function slope(xs, ys) {
  const n = xs.length;
  if (n < 2) return 0;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return den ? num / den : 0;
}
