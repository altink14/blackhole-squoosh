# blackhole

**[blackhole-squoosh.vercel.app](https://blackhole-squoosh.vercel.app)**

Squoosh-grade image compression that runs entirely in your browser, wrapped
around a raytraced Schwarzschild black hole. Drop images into the singularity,
get smaller files back. Nothing is ever uploaded.

- **Codecs**: MozJPEG, libwebp, libavif and OxiPNG — the same encoders Squoosh
  uses — compiled to WebAssembly and run in a worker pool.
- **Visuals**: a single-pass WebGL2 fragment shader that integrates null
  geodesics around the hole, so the lensed accretion disk, the photon ring and
  the Einstein arcs fall out of the physics rather than being faked with sprites.
- **Privacy**: there is no server-side image path. No upload endpoint exists.

## Stack

| Concern    | Choice                                |
| ---------- | ------------------------------------- |
| Framework  | Next.js 16 (App Router)               |
| Language   | TypeScript (strict)                   |
| Styling    | Tailwind CSS v4                       |
| Components | shadcn/ui (`radix-nova`, Radix base)  |
| Codecs     | [jSquash](https://github.com/jamsinclair/jSquash) |

## Running it

```bash
npm install
npm run dev
```

`npm install` triggers `postinstall`, and `npm run dev` / `npm run build`
trigger `predev` / `prebuild`, all of which run `scripts/copy-codecs.mjs`. That
script copies the `.wasm` binaries out of `node_modules/@jsquash/*` into
`public/codecs/`, where they are served as ordinary static assets. The
binaries are gitignored — they are always regenerated from the lockfile.

Other scripts:

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run build       # production build
```

### Why both scripts pass `--webpack`

Next 16 uses Turbopack by default. On this dependency graph Turbopack deadlocks:
`next build` sits at `Creating an optimized production build ...` indefinitely
with the process pinned at 0% CPU — not slow, genuinely stuck. The identical
build finishes in about 11 seconds under webpack, so `dev` and `build` both
pass `--webpack`. The likely trigger is the emscripten codec glue, which pulls
in pthread worker variants (`avif_enc_mt.worker.mjs`, wasm-bindgen-rayon
snippets) that are never executed at runtime. Worth retrying on a future Next
release; if it builds, drop the flags.

## Deploying to Vercel

The app is a stock Next.js project with no environment variables and no server
state, so the defaults are correct:

1. Push the repo to GitHub.
2. In Vercel, **Add New → Project**, import the repo, and accept the detected
   Next.js settings.
3. Deploy.

The only non-obvious requirement is that `public/codecs/*.wasm` must exist at
build time. `prebuild` handles that on Vercel exactly as it does locally, so
there is nothing to configure.

## How the compression pipeline works

`lib/compress.worker.ts` does the work off the main thread:

1. **Decode** with the browser's native `createImageBitmap`, honouring EXIF
   orientation. Using the platform decoder means no decoder WASM has to ship.
2. **Resize** (optional) by repeated halving on an `OffscreenCanvas` before the
   final draw — a single large `drawImage` drops source pixels instead of
   averaging them, which aliases badly on big downscales.
3. **Encode** with the selected jSquash codec. When the target is JPEG the
   canvas is flattened onto white first, since JPEG has no alpha channel and
   would otherwise render transparent pixels as black.

Measured on the deployed build: a 3.27 MB, 2400×1600 photographic PNG at
quality 75 / effort 4.

| Format         | Output   | Saved  | Time   |
| -------------- | -------- | ------ | ------ |
| AVIF (libavif) | 26.0 KB  | −99.2% | 9.1 s  |
| WebP (libwebp) | 30.6 KB  | −99.1% | 0.7 s  |
| JPEG (MozJPEG) | 53.3 KB  | −98.4% | 0.6 s  |
| PNG (OxiPNG)   | 1.60 MB  | −51.2% | 9.1 s  |

Content matters more than the ranking suggests. The same table built from an
image of uniform per-pixel noise puts AVIF *last* rather than first — noise is
close to its worst case at speed 6, and it is the only one of the four with no
cheap way to give up on a region. Benchmark against images that look like
yours, not against a gradient or a noise field.

AVIF's ~9 s is the cost of running single-threaded (see below). Lower the
effort slider, which maps straight to libavif's speed parameter, if encode
latency matters more than the last few kilobytes.

`lib/compressor.ts` keeps a small pool of these workers. The pool is
deliberately narrow — each worker holds its own codec heaps, so wide
parallelism costs more memory than it buys in throughput.

Changing a setting bumps a generation counter and re-encodes everything;
results that land from a superseded generation are discarded.

### Threading

The codecs ship both single- and multi-threaded builds. The multi-threaded
paths require `SharedArrayBuffer`, which requires cross-origin isolation
(`COOP`/`COEP`). Those headers are deliberately **not** set, so `wasm-feature-detect`
reports no thread support and the single-threaded codecs are used. This keeps
the app free of the cross-origin isolation constraints; the cost is slower AVIF
encoding at high effort.

## The renderer

`components/ui/black-hole-utils/renderer.ts` owns a WebGL2 context and a
fullscreen triangle generated from `gl_VertexID` (no vertex buffers). The
shader in `shader.ts` marches each ray through the Schwarzschild metric with

```
a = -3/2 · h² · r / |r|⁵
```

where `h` is the conserved specific angular momentum. Every equatorial plane
crossing samples the accretion disk, which is why one ray can paint both the
disk in front of the hole and the lensed image of the disk behind it.

Disk shading includes Keplerian shear, relativistic Doppler beaming (the
approaching side is visibly brighter) and gravitational redshift.

The renderer adapts: it measures frame time and walks the internal resolution
and the integration step budget up or down to hold a usable frame rate. It
pauses when the tab is hidden or the canvas scrolls out of view, and respects
`prefers-reduced-motion`. Browsers without WebGL2 get a static CSS gradient
instead of a black rectangle.

The camera is fixed on purpose — no pointer tracking.

## Project layout

```
app/
  layout.tsx            dark-only shell
  page.tsx              renders <Studio />
  globals.css           Tailwind v4 + shadcn tokens + blackhole theme
components/
  ui/                   shadcn components (the CLI's default target)
    black-hole.tsx
    black-hole-utils/
      renderer.ts       WebGL2 lifecycle, adaptive quality
      shader.ts         GLSL
  studio.tsx            queue state, drag/drop/paste, downloads
  settings-bar.tsx      format, quality, effort, resize
  image-row.tsx         one queued image
  compare-view.tsx      before/after split slider
lib/
  codecs.ts             formats, settings, worker message types
  compress.worker.ts    decode → resize → encode
  compressor.ts         worker pool
  format.ts, types.ts
scripts/
  copy-codecs.mjs       stages .wasm into public/codecs
```

`components/ui` is where `components.json` points the shadcn CLI, so anything
added with `npx shadcn@latest add …` lands there and imports resolve through
the `@/*` alias. Keep that path as-is or the CLI will write components your
imports cannot find.

## Credits

- Codec builds: [jSquash](https://github.com/jamsinclair/jSquash) by Jamie Sinclair,
  repackaged from [Squoosh](https://squoosh.app) (Apache-2.0).
- The black hole concept comes from the component of the same name on
  [21st.dev](https://21st.dev); the renderer here is an original implementation.
