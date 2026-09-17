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

Measured on the deployed build: a 3.78 MB, 2400×1600 photographic PNG at
quality 75 / effort 4 (the defaults).

| Format         | Output   | Saved  | Time   |
| -------------- | -------- | ------ | ------ |
| AVIF (libavif) | 27.9 KB  | −99.3% | 1.3 s  |
| WebP (libwebp) | 29.2 KB  | −99.2% | 0.26 s |
| JPEG (MozJPEG) | 52.2 KB  | −98.6% | 0.28 s |
| PNG (OxiPNG)   | 1.77 MB  | −53.0% | 3.6 s  |

Content matters more than the ranking suggests. The same table built from an
image of uniform per-pixel noise puts AVIF *last* rather than first — noise is
close to its worst case at speed 6, and it is the only one of the four with no
cheap way to give up on a region. Benchmark against images that look like
yours, not against a gradient or a noise field.

Encode time swings hard on content as well as size. The same 2400×1600 frame
built from many overlapping translucent gradients takes AVIF ~6 s instead of
~1.4 s, because there is far more low-contrast detail for it to chase. Effort
is the direct lever: it maps straight to libavif's speed parameter, and
dropping it to 0 takes that same image to ~350 ms for roughly 40% more bytes.

`lib/compressor.ts` keeps a small pool of these workers. The pool is
deliberately narrow — each worker holds its own codec heaps, so wide
parallelism costs more memory than it buys in throughput.

Changing a setting bumps a generation counter and re-encodes everything;
results that land from a superseded generation are discarded.

### PNG levels are not monotonic

OxiPNG's effort levels do not trade time for size in a straight line. Measured
on a 2400×1600 PNG:

| Level | Output  | Time  |
| ----- | ------- | ----- |
| 1     | 2.05 MB | 1.4 s |
| 2     | 1.77 MB | 3.4 s |
| 3     | 1.80 MB | 8.5 s |

Level 3 costs 2.5× level 2 and comes out **larger**. The effort slider maps
through a measured lookup table rather than arithmetic, so the default lands on
2 rather than 3.

### 16-bit PNGs bypass the canvas

The pipeline normally decodes with `createImageBitmap` and reads pixels back
through a canvas, which is 8 bits per channel. That silently halves the
precision of a 16-bit PNG — unacceptable for a format the UI labels lossless.
Those files are handed to OxiPNG as their original bytes instead.

Deliberately narrow: routing *every* PNG through OxiPNG's own decoder is
slower (3.9 s vs 3.4 s), because it decodes in wasm rather than reusing the
browser's native decoder, and the result is identical. Enabling resize still
forces the canvas path, since resizing needs one; a 16-bit source will be 8-bit
on the way out in that case.

### Codec loading

AVIF's binary is ~3.5 MB, and it used to be downloaded and compiled *inside*
the first encode, which made a first AVIF look like it took 9 s when the
encode itself was under 2 s. Two things prevent that:

- The selected codec is instantiated as soon as it is chosen, not on first use.
- Once images are queued, the other codecs' binaries are pulled into cache in
  the background via `WebAssembly.compileStreaming`, which fills the engine's
  wasm code cache as well as the HTTP cache. Necessary because the format bar
  only exists once there is something to compress, so warming on selection
  alone always loses the race against the re-encode it triggers.

### Threading (does not work — do not "fix" by adding COOP/COEP)

The codecs ship multi-threaded builds, and jSquash selects them automatically
whenever `SharedArrayBuffer` exists. Adding `COOP`/`COEP` headers is therefore
enough to switch them on, and AVIF then **hangs forever**.

At startup the multi-threaded module pre-allocates one pthread worker per core
and blocks module readiness on a run dependency until every one reports back.
From inside a nested worker — which is where the encode pipeline runs — they
never do. It fails silently: no error, no rejected promise, and the wasm is
never even requested, so the encode just never returns. Reproduced with the
glue served as a real URL rather than a bundle chunk, and with
`mainScriptUrlOrBlob` passed explicitly. The same factory resolves in ~60 ms
when called on the main thread, so it is specific to the nested-worker context.

`loadAvif` therefore pins the single-threaded build explicitly instead of
feature-detecting. Leave it pinned unless the pool bootstrap is actually fixed.

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
