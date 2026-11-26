# Playground

Static experiments, no build step.

- `texture-lab/` — Texture Lab: photo → tileable height/normal/colour maps, previews, texture-pack export.
- `texture-gallery/` — Skins gallery: folder and envelope UI with configurable skins.
- `room-visuals/` — Room Visuals: listens through the mic and drives visuals from BPM, key, genre, rhythm and melodic phrasing.

## Run locally

Open any `index.html` in a browser, or serve the folder: `npx serve .`

## Deploy (Vercel)

`vercel.json` deploys the repo root as a static site (no build). Import the repo at
vercel.com/new, or from a machine logged in to Vercel run `npx vercel --prod`.
