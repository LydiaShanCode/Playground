// Run: node --test room-visuals/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectKey, estimateTempo, classifyGenre, scaleTension, keyColour, slope, freqToMidi } from '../src/analysis.js';

const chromaFor = (tonic, intervals, weights) => {
  const c = new Array(12).fill(0.05);
  intervals.forEach((iv, i) => { c[(tonic + iv) % 12] += weights[i]; });
  return c;
};
const MAJOR = [0, 2, 4, 5, 7, 9, 11], MINOR = [0, 2, 3, 5, 7, 8, 10];
const W = [1, 0.5, 0.8, 0.5, 0.9, 0.5, 0.4];

test('detectKey finds major keys', () => {
  for (const tonic of [0, 5, 7, 10]) {
    const k = detectKey(chromaFor(tonic, MAJOR, W));
    assert.equal(k.tonic, tonic);
    assert.equal(k.mode, 'major');
  }
});

test('detectKey finds minor keys', () => {
  for (const tonic of [9, 2, 4]) {
    const k = detectKey(chromaFor(tonic, MINOR, W));
    assert.equal(k.tonic, tonic, `tonic ${tonic}`);
    assert.equal(k.mode, 'minor');
  }
});

const pulses = (bpm, seconds, rate, { offbeats = false, jitter = 0 } = {}) => {
  const env = new Float32Array(seconds * rate);
  const period = (60 / bpm) * rate;
  for (let b = 0; b * period < env.length; b++) {
    const i = Math.round(b * period + (Math.random() - 0.5) * jitter);
    if (i >= 0 && i < env.length) env[i] += 1;
    if (offbeats) { const j = Math.round(b * period + period / 2); if (j < env.length) env[j] += 0.4; }
  }
  for (let i = 0; i < env.length; i++) env[i] += Math.random() * 0.05;
  return env;
};

test('estimateTempo recovers common tempos', () => {
  for (const bpm of [72, 90, 110, 124, 140]) {
    const r = estimateTempo(pulses(bpm, 8, 100, { offbeats: true, jitter: 1 }), 100);
    assert.ok(Math.abs(r.bpm - bpm) < 2.5, `${bpm} -> ${r.bpm.toFixed(1)}`);
    assert.ok(r.confidence > 0.2);
  }
});

test('estimateTempo returns null on silence', () => {
  assert.equal(estimateTempo(new Float32Array(800), 100), null);
});

test('classifyGenre separates archetypes', () => {
  const house = classifyGenre({ bpm: 124, bass: 0.4, bright: -0.6, noisy: 0.05, density: 3.5, regularity: 0.9, hats: -2.4, dyn: 4, sync: 0.05 });
  assert.equal(house[0].genre, 'Electronic');
  const ambient = classifyGenre({ bpm: 70, bass: 0.1, bright: -0.9, noisy: 0.02, density: 1.5, regularity: 0.4, hats: -3.6, dyn: 4, sync: 0.2 });
  assert.equal(ambient[0].genre, 'Ambient');
  const hiphop = classifyGenre({ bpm: 88, bass: 0.4, bright: -0.8, noisy: 0.04, density: 3, regularity: 0.85, hats: -2.5, dyn: 5.5, sync: 0.1 });
  assert.equal(hiphop[0].genre, 'Hip-Hop');
  const sum = house.reduce((a, g) => a + g.p, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

test('helpers', () => {
  assert.equal(scaleTension(0, 0, 'major'), 0);
  assert.equal(scaleTension(1, 0, 'major'), 1);
  assert.ok(keyColour(9, 'minor').light < keyColour(0, 'major').light);
  assert.ok(Math.abs(slope([0, 1, 2], [1, 3, 5]) - 2) < 1e-9);
  assert.ok(Math.abs(freqToMidi(440) - 69) < 1e-9);
});
