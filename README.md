# Reskin Mockups

A browser-based mockup tool for [reskin.in](https://reskin.in). Drop in PSD mockups, add your designs, recolor the
product, and export one image or hundreds of variations as a zip. Everything runs in the browser: PSD files and designs
are never uploaded to a server.

## What it does

- **Library:** up to 10 PSD/PSB mockups at once, shown in a bento grid. Files are parsed in a Web Worker and stored
  compressed in the browser (a 105 MB mockup becomes about 2 MB). Guests' files are deleted after 24 hours; signed-in
  users' files are kept.
- **Designs:** one or many PNG/JPG/WebP/SVG designs. The design replaces the mockup's smart object, with the PSD's own
  shading, masks and blend modes reproduced by a WebGL renderer.
- **Edit:** click a mockup to recolor the product with a HEX value, switch layers on and off, and choose how the design
  sits on the fabric. Export as PNG, JPG or WebP at original or smaller sizes.
- **Bulk export:** pick mockups, designs and a list of HEX colors. Every combination is rendered and streamed into a
  zip (with a `manifest.csv`), either to the user's computer or to their own Google Drive.
- **AI edit:** optional. Users paste their own Gemini API key to edit a mockup with a prompt, or hand the image to
  Gemini, ChatGPT, Claude, Copilot or Firefly.

## Run it

```bash
npm install        # also applies a small patch to ag-psd, see below
npm run dev        # http://localhost:5173
npm test           # unit tests
npm run build      # typecheck + production build into dist/
npm run preview    # serve dist/ at http://localhost:4173 with the production security headers
```

Requires Node 20 or newer and a browser with WebGL 2 (current Chrome, Edge, Firefox or Safari).

`npm run sample` writes three small test PSDs into `sample-psd/`. `npm run inspect -- file.psd` prints a PSD's layer
tree, which is the quickest way to see why a mockup behaves the way it does.

## Configuration

Google sign-in and Drive saving are optional and need your own OAuth Client ID. See [SETUP.md](SETUP.md). Without it the
app works as a guest and the Sign in button explains what to set up. AI editing needs no setup.

## Deploying

The build output in `dist/` is a static site: upload it to any static host (Netlify, Cloudflare Pages, Vercel, S3 plus
a CDN, your own nginx).

1. Set `VITE_GOOGLE_CLIENT_ID` in the build environment if you want sign-in (it is public by design).
2. Serve `index.html` for unknown paths only if you add routes later; today there is a single page.
3. Security headers: the build writes `dist/_headers`, which Netlify and Cloudflare Pages apply automatically. On other
   hosts copy those values into the server config. The Content-Security-Policy there is the one the app was tested with;
   it allows only this site, Google sign-in, and the Google APIs.
4. Add your production origin (for example `https://reskin.in`) to the OAuth client's *Authorized JavaScript origins*.

## How it fits together

| Area | Files |
| --- | --- |
| PSD import (worker, compression, masks, curves) | `src/workers/ingest.worker.ts`, `src/lib/ingest.ts` |
| Storage, 24h guest expiry, kept files | `src/lib/store.ts`, `src/lib/session.ts` |
| Renderer (WebGL 2: blend modes, masks, curves, smart objects) | `src/lib/render.ts` |
| Edits, colors, layers | `src/lib/layers.ts`, `src/Editor.tsx` |
| Bulk planning, zip streaming, Drive sink | `src/lib/bulk.ts`, `src/Bulk.tsx` |
| Google sign-in and Drive upload | `src/lib/auth.ts`, `src/lib/drive.ts` |
| Drive backup of original PSDs | `src/lib/backup.ts` |
| AI editing | `src/lib/ai.ts`, `src/AiPanel.tsx` |

## Things worth knowing

- **ag-psd patch.** The PSD library has two bugs that break real 16-bit mockups (it drops all layers after a layer mask
  with an empty rectangle, and it mis-decodes 16-bit ZIP data). `scripts/patch-ag-psd.mjs` fixes both on `npm install`.
  If you upgrade `ag-psd` the script stops with a clear message so the patch can be re-checked. During development,
  bump `__AG_PSD_PATCH__` in `vite.config.ts` after changing the patch so browsers refetch the dependency.
- **The PSD's own flattened preview is not trusted.** For 16-bit files it decodes wrongly, so previews are rendered from
  the layers instead.
- **Limits.** Source files up to 2 GB each (a browser memory limit), 1 GB of stored mockups, 400 MB of stored designs,
  1000 images per bulk batch. Very large PSDs can run out of memory while being parsed; the app reports this.
- **Unsupported Photoshop features** (layer styles, warped smart objects, clipping and vector masks, some adjustment
  layers) are listed per mockup as "things not rendered".
- **Chrome and Edge** stream bulk zips straight to disk, so memory stays flat. Other browsers hold the zip in memory
  until it is finished.

## Privacy

Nothing is uploaded unless the user chooses Drive or an AI edit. Drive access is limited to files this app creates
(`drive.file`). A Gemini API key stays in the browser and is sent only to Google. Access tokens are kept in memory.
