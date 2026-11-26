import { Analyzer } from './analyzer.js';
import { Visuals } from './visuals.js';
import { DemoBand, PRESETS } from './demo.js';
import { GENRES, midiName } from './analysis.js';

const $ = (id) => document.getElementById(id);
const visuals = new Visuals($('stage'));
let ctx = null, analyzer = null, session = null;

// Idle animation behind the start panel.
const idleState = () => ({
  t: 0, level: 0.15, bpm: 0, bpmConfidence: 0, beatPhase: 0, barPos: 0,
  key: { name: '—', tonic: 0, mode: 'major', confidence: 0 }, genre: [{ genre: 'Ambient', p: 1 }],
  rhythm: { kick: 0, snare: 0, hat: 0, sync: 0, density: 0 },
  melody: { voiced: false, inPhrase: false, contour: 0, tension: 0, progress: 0, midi: 0 },
  features: { bass: 0.3 }, spectrum: new Float32Array(64), events: [],
});

for (const p of PRESETS) {
  const b = document.createElement('button');
  b.textContent = p.label;
  b.onclick = () => start('demo', p);
  $('presets').append(b);
}
for (const g of Object.keys(GENRES)) $('genre-lock').append(new Option(g, g));

$('btn-mic').onclick = () => start('mic');
$('file').onchange = (e) => e.target.files[0] && start('file', e.target.files[0]);
$('btn-stop').onclick = stop;
$('genre-lock').onchange = (e) => { if (analyzer) analyzer.genreOverride = e.target.value || null; };
$('sens').oninput = (e) => analyzer?.setSensitivity(+e.target.value);
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === 'h' || e.key === 'H') { if (analyzer) $('hud').hidden = !$('hud').hidden; }
  if (e.key === 'f' || e.key === 'F') document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.();
});

async function start(kind, arg) {
  $('error').textContent = '';
  try {
    ctx ??= new AudioContext({ latencyHint: 'interactive' });
    await ctx.resume();
    stopSource();
    let node;
    if (kind === 'mic') {
      // Turn off speech processing: it eats music (gates quiet parts, removes "noise" like hi-hats).
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      node = ctx.createMediaStreamSource(stream);
      session = { stop: () => stream.getTracks().forEach((t) => t.stop()) };
    } else if (kind === 'file') {
      const el = $('player');
      el.src = URL.createObjectURL(arg);
      el.loop = true;
      node = (el._node ??= ctx.createMediaElementSource(el));
      node.connect(ctx.destination);
      await el.play();
      session = { stop: () => { el.pause(); node.disconnect(); URL.revokeObjectURL(el.src); } };
    } else {
      const band = new DemoBand(ctx, arg);
      node = ctx.createGain();
      band.connect(node);
      node.connect(ctx.destination);
      session = { stop: () => { band.stop(); setTimeout(() => node.disconnect(), 500); } };
    }
    analyzer = new Analyzer(ctx, node);
    analyzer.setSensitivity(+$('sens').value);
    analyzer.genreOverride = $('genre-lock').value || null;
    window.__analyzer = analyzer; // handy for debugging in the console
    $('start').hidden = true;
    $('hud').hidden = false;
  } catch (err) {
    console.error(err);
    $('error').textContent = kind === 'mic'
      ? `Couldn't open the microphone (${err.name || err.message}). Allow mic access for this page and try again.`
      : `Couldn't start: ${err.message || err}`;
  }
}

function stopSource() {
  session?.stop(); session = null;
  analyzer?.dispose(); analyzer = null;
}

function stop() {
  stopSource();
  $('hud').hidden = true;
  $('start').hidden = false;
}

// ---- HUD ---------------------------------------------------------------------
const beatDots = [...$('h-beats').children];
beatDots[0].classList.add('down');
let hudTimer = 0;
function updateHud(s) {
  $('h-bpm').textContent = s.bpm ? Math.round(s.bpm) : 'listening…';
  $('h-bpmc').style.width = `${Math.round(s.bpmConfidence * 100)}%`;
  beatDots.forEach((d, i) => d.classList.toggle('on', !!s.bpm && i === s.barPos && s.beatPhase < 0.5));
  $('h-key').textContent = s.key.name === '—' ? 'listening…' : s.key.name;
  $('h-keyc').style.width = `${Math.round(s.key.confidence * 100)}%`;
  $('h-genre').innerHTML = s.genre.slice(0, 3).map((g) => `<div>${g.genre}<span class="g" style="width:${Math.max(2, g.p * 100).toFixed(0)}%"></span></div>`).join('');
  for (const k of ['kick', 'snare', 'hat']) $(`h-${k}`).style.setProperty('--v', `${Math.round(s.rhythm[k] * 100)}%`);
  $('h-sync').style.setProperty('--v', `${Math.round(Math.min(1, s.rhythm.sync * 2) * 100)}%`);
  const m = s.melody;
  $('h-note').textContent = m.voiced ? midiName(m.midi) : '—';
  $('h-contour').textContent = !m.voiced ? '' : m.contour > 2 ? '↗' : m.contour < -2 ? '↘' : '→';
  $('h-phrase').textContent = m.inPhrase ? `phrase ${m.phraseIndex}` : 'breath';
  $('h-phrasep').style.width = `${Math.round(Math.min(1, m.progress) * 100)}%`;
}

let last = performance.now();
function loop(now) {
  const dt = (now - last) / 1000; last = now;
  const s = analyzer ? analyzer.read() : idleState();
  visuals.frame(s, dt);
  if (analyzer && (hudTimer += dt) > 0.05) { hudTimer = 0; updateHud(s); window.__state = s; }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
