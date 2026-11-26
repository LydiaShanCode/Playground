# Room Visuals

Full-screen visuals that listen to the music playing in the room, through the microphone,
and change with the music. No build step and no dependencies: just Web Audio and Canvas.

Open `/room-visuals/`, press **Listen with microphone** and allow mic access. You can also
play an audio file, or try the built-in **demo band** (five styles with different tempos and keys).
The mic needs a secure page: `https://` or `localhost`.

## What drives what

| Music parameter | How it's heard | What it does to the picture |
|---|---|---|
| **BPM** | Onset envelope, then autocorrelation with a beat comb and an 8th-note check, averaged over time | Overall speed of everything. **Slower music is calmer**: slower motion, longer trails, softer pulses and gentler flashes. Faster music is sharper and busier. A beat clock locks to the onsets and pulses the core on every beat. |
| **Key** | Chroma (12 pitch classes) from spectral peaks, with bass notes and phrase endings weighted, matched to Krumhansl key profiles | Colour palette. The tonic walks the circle of fifths around the colour wheel, so related keys get related colours. Minor keys are darker and cooler. A key change fades the palette across. |
| **Genre** | Soft classifier over tempo, bass weight, brightness, noisiness, onset density, beat regularity, hi-hat energy, dynamics and swing | Which scene is drawn, cross-faded by probability: **Electronic** tunnel, **Drum & Bass** tunnel plus shards, **Hip-Hop/Rock** radial shards, **Pop/Jazz** orbits, **Classical/Ambient** drifting particle field. You can lock a genre in the panel. |
| **Rhythm** | Separate onset detectors for kick (30–150 Hz), snare (180–3500 Hz) and hats (6–15 kHz); downbeat found from where kicks land in the bar; syncopation from off-beat onsets | Kicks send shockwaves and bump the zoom, snares flash and throw shards, hats sparkle. The downbeat spawns a hexagon and zooms. Syncopation and swing make orbits lurch. |
| **Melodic phrasing** | Dominant pitch (harmonic product spectrum, 180–1500 Hz), debounced into notes; a phrase starts when a moving line appears and ends on a breath (the melody stops or just holds for about a beat), capped at 4 bars | A glowing ribbon traces the melody across the screen over the phrase. Rising lines warm the hue and falling ones cool it; out-of-key notes take the accent colour. At the end the ribbon lifts away. If the phrase comes home to the tonic it **blooms**; if it's left hanging it just fades. |

The panel (press **H** to hide it, **F** for full screen) shows what the analyzer currently hears.

## Files

- `src/analysis.js`: pure functions for key, tempo, genre, tension and colour (unit-tested in Node)
- `src/analyzer.js`: live Web Audio analysis (100 Hz onsets and beat clock, 20 Hz chroma, features and melody)
- `src/visuals.js`: Canvas renderer, with the parameter-to-visual mapping documented at the top
- `src/demo.js`: generative demo band (ambient 72, house 124, hip-hop 88, rock 140, drum & bass 172)
- `src/main.js`: page wiring and HUD

## Tests

```sh
node --test room-visuals/test/analysis.test.mjs   # unit tests for the analysis maths
node room-visuals/test/e2e.cjs                    # plays each demo preset in headless Chromium, prints what was detected
node room-visuals/test/mic.cjs                    # microphone path with Chromium's fake capture device
```

The browser tests need Playwright, and serve the files from disk themselves.

## Honest limits

- **Genre is a heuristic.** It uses hand-set feature prototypes, not a trained model, and it's
  tuned against the demo band. Real rooms and mics vary, so use the genre lock if it guesses wrong.
- **Key** can confuse relative major and minor (they share every note), and needs about 5–15 s to settle.
- **Tempo** is limited to 60–190 BPM. Half or double time is always ambiguous; drum & bass is
  shown at double time once it's recognised.
- **Melody** tracking in a full mix is approximate: it follows the most prominent pitched line.
  Phrase ends fall back to 4-bar boundaries when no breath is heard.
