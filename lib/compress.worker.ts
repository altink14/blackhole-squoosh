/// <reference lib="webworker" />

import { defaultOptions as avifDefaults } from "@jsquash/avif/meta.js";
import {
  FORMATS,
  type CompressRequest,
  type CompressResponse,
  type EncodeSettings,
  type OutputFormat,
  type WorkerRequest,
} from "./codecs";

// The .wasm binaries are copied out of node_modules into /public/codecs by
// scripts/copy-codecs.mjs, so they are served as plain static assets and the
// bundler never has to resolve them.
const CODEC_BASE = "/codecs/";
const locateFile = (path: string) => CODEC_BASE + path;

type JpegModule = typeof import("@jsquash/jpeg/encode");
type WebpModule = typeof import("@jsquash/webp/encode");
type AvifModule = AvifEncoder;
type OxipngModule = typeof import("@jsquash/oxipng/codec/pkg/squoosh_oxipng.js");

let jpeg: Promise<JpegModule> | null = null;
let webp: Promise<WebpModule> | null = null;
let avif: Promise<AvifModule> | null = null;
let oxipng: Promise<OxipngModule> | null = null;

function loadJpeg() {
  jpeg ??= import("@jsquash/jpeg/encode").then(async (mod) => {
    await mod.init({ locateFile });
    return mod;
  });
  return jpeg;
}

function loadWebp() {
  webp ??= import("@jsquash/webp/encode").then(async (mod) => {
    await mod.init({ locateFile });
    return mod;
  });
  return webp;
}

interface AvifEncoder {
  encode(
    data: Uint8Array,
    width: number,
    height: number,
    options: Record<string, unknown>
  ): Uint8Array | null;
}

type AvifFactory = (options: {
  locateFile: (path: string) => string;
  mainScriptUrlOrBlob?: string;
}) => Promise<AvifEncoder>;

/**
 * Loads libavif's emscripten glue from /codecs at runtime rather than letting
 * the bundler inline it. Keeps ~1 MB of glue out of the client bundle, and the
 * encoder is instantiated once per worker and reused.
 *
 * Deliberately the SINGLE-THREADED build, and deliberately not chosen by
 * feature detection.
 *
 * The multi-threaded build does not work here. jSquash selects it whenever
 * SharedArrayBuffer exists, so merely adding COOP/COEP headers to this app is
 * enough to switch it on -- and it then hangs forever. At init, emscripten
 * pre-allocates one pthread worker per core and blocks module readiness on a
 * run dependency until every one reports back; from inside a nested worker
 * (which is where this code runs) those workers never do. It fails silently:
 * no error, no rejected promise, and the wasm is never even requested, so the
 * encode simply never returns. Verified with the glue served as a real URL and
 * with mainScriptUrlOrBlob passed explicitly; the same factory resolves in
 * ~60ms when called on the main thread.
 *
 * If cross-origin isolation is ever wanted here, this function must keep
 * pinning the ST build or AVIF will break.
 */
function loadAvif() {
  avif ??= (async () => {
    const imported = (await import(
      /* webpackIgnore: true */ `${CODEC_BASE}avif_enc.js`
    )) as { default: AvifFactory };
    return imported.default({ locateFile });
  })();
  return avif;
}

/**
 * Loads OxiPNG's single-threaded build directly rather than through
 * `@jsquash/oxipng/optimise`.
 *
 * That wrapper picks between the single- and multi-threaded builds at runtime
 * based on SharedArrayBuffer availability, but takes one wasm URL for both.
 * Once the page became cross-origin isolated it would select the parallel
 * build and hand it the single-threaded binary, which fails on mismatched
 * wasm-bindgen imports. Pinning the path keeps PNG deterministic; the parallel
 * build additionally needs its wasm-bindgen-rayon worker snippets served,
 * which is a separate piece of work.
 */
function loadOxipng() {
  oxipng ??= import("@jsquash/oxipng/codec/pkg/squoosh_oxipng.js").then(
    async (mod) => {
      await mod.default(`${CODEC_BASE}squoosh_oxipng_bg.wasm`);
      return mod;
    }
  );
  return oxipng;
}

/** Instantiates a codec ahead of first use so the encode is not waiting on it. */
async function warm(format: OutputFormat) {
  try {
    switch (format) {
      case "jpeg":
        await loadJpeg();
        break;
      case "webp":
        await loadWebp();
        break;
      case "avif":
        await loadAvif();
        break;
      case "png":
        await loadOxipng();
        break;
    }
  } catch {
    // A failed warm-up is not an error worth surfacing: the encode path will
    // retry the load and report properly if it genuinely cannot start.
  }
}

/**
 * OxiPNG's levels are not monotonic in output size, so this is a measured
 * table rather than arithmetic. On a 2400x1600 PNG:
 *
 *   level 1 -> 2.05 MB in 1.4s
 *   level 2 -> 1.77 MB in 3.4s
 *   level 3 -> 1.80 MB in 8.5s   <- slower AND larger than level 2
 *
 * Level 3 tries filter/strategy combinations that can land worse than level 2
 * while costing 2.5x the time, so the default effort maps to 2 and the higher
 * levels are reserved for people who deliberately ask for them.
 */
const OXIPNG_LEVEL_BY_EFFORT = [1, 1, 2, 2, 2, 3, 3, 4, 4, 5, 6];

function oxipngLevel(effort: number) {
  return OXIPNG_LEVEL_BY_EFFORT[Math.min(10, Math.max(0, Math.round(effort)))];
}

/** Reads width, height, bit depth and colour type out of a PNG's IHDR chunk. */
function readPngHeader(bytes: Uint8Array) {
  const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24) return null;
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (bytes[i] !== SIGNATURE[i]) return null;
  }
  if (String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) !== "IHDR") {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width === 0 || height === 0) return null;
  return { width, height, bitDepth: bytes[24], colourType: bytes[25] };
}

function targetSize(
  width: number,
  height: number,
  settings: EncodeSettings
): { width: number; height: number } {
  if (!settings.resizeEnabled) return { width, height };
  const longest = Math.max(width, height);
  if (longest <= settings.maxDimension) return { width, height };
  const ratio = settings.maxDimension / longest;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

/**
 * Downscales by repeated halving before the final draw. A single large
 * drawImage step drops source pixels outright; halving averages them, which is
 * the difference between a crisp thumbnail and an aliased mess.
 */
function toImageData(
  bitmap: ImageBitmap,
  width: number,
  height: number,
  flatten: boolean
): ImageData {
  let source: CanvasImageSource = bitmap;
  let currentWidth = bitmap.width;
  let currentHeight = bitmap.height;

  while (currentWidth > width * 2 && currentHeight > height * 2) {
    const nextWidth = Math.max(width, Math.round(currentWidth / 2));
    const nextHeight = Math.max(height, Math.round(currentHeight / 2));
    const step = new OffscreenCanvas(nextWidth, nextHeight);
    const stepContext = step.getContext("2d");
    if (!stepContext) break;
    stepContext.imageSmoothingEnabled = true;
    stepContext.imageSmoothingQuality = "high";
    stepContext.drawImage(source, 0, 0, nextWidth, nextHeight);
    source = step;
    currentWidth = nextWidth;
    currentHeight = nextHeight;
  }

  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("2D canvas is unavailable in this worker");

  // JPEG has no alpha channel. Without this, transparent pixels encode as
  // black instead of the white a browser would composite them against.
  if (flatten) {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
  }

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, width, height);
  return context.getImageData(0, 0, width, height);
}

async function encode(
  data: ImageData,
  settings: EncodeSettings
): Promise<ArrayBuffer> {
  const { format, quality, effort } = settings;

  switch (format) {
    case "jpeg": {
      const mod = await loadJpeg();
      return mod.default(data, { quality });
    }
    case "webp": {
      const mod = await loadWebp();
      return mod.default(data, {
        quality,
        method: Math.min(6, Math.max(0, Math.round(2 + effort * 0.4))),
      });
    }
    case "avif": {
      const mod = await loadAvif();
      const out = mod.encode(
        new Uint8Array(data.data.buffer),
        data.width,
        data.height,
        {
          ...avifDefaults,
          quality,
          speed: Math.min(10, Math.max(0, 10 - effort)),
        }
      );
      if (!out) throw new Error("AVIF encoding failed");
      return out.buffer as ArrayBuffer;
    }
    case "png": {
      const mod = await loadOxipng();
      const out = mod.optimise_raw(
        data.data,
        data.width,
        data.height,
        oxipngLevel(effort),
        false,
        true
      );
      return out.buffer as ArrayBuffer;
    }
  }
}

/**
 * Optimises a 16-bit PNG from its original bytes, bypassing the canvas.
 *
 * Narrow on purpose. The obvious generalisation -- routing every PNG-to-PNG
 * job through OxiPNG's own decoder -- measures *slower* (3.9s vs 3.4s on a
 * 2400x1600 image) because OxiPNG then decodes the file in wasm instead of
 * reusing the browser's native decoder, and it produces an identical result.
 *
 * At 16 bits per channel it stops being about speed and becomes correctness:
 * a canvas is 8-bit, so `getImageData` silently halves the precision of a
 * 16-bit PNG. Calling this format "lossless" in the UI while quietly
 * truncating it would be a lie, so those files skip the canvas entirely.
 *
 * Returns null when the fast general pipeline should be used instead.
 */
async function optimiseDeepPng(
  file: File,
  settings: EncodeSettings
): Promise<{ buffer: ArrayBuffer; width: number; height: number } | null> {
  if (settings.format !== "png" || settings.resizeEnabled) return null;
  if (file.type !== "image/png") return null;

  const bytes = new Uint8Array(await file.arrayBuffer());
  const header = readPngHeader(bytes);
  if (!header || header.bitDepth !== 16) return null;

  const mod = await loadOxipng();
  const out = mod.optimise(bytes, oxipngLevel(settings.effort), false, true);
  return {
    buffer: out.buffer as ArrayBuffer,
    width: header.width,
    height: header.height,
  };
}

async function compress(request: CompressRequest): Promise<CompressResponse> {
  const started = performance.now();
  const { id, file, settings } = request;

  let bitmap: ImageBitmap | null = null;
  try {
    const direct = await optimiseDeepPng(file, settings);
    if (direct) {
      const meta = FORMATS.png;
      return {
        id,
        ok: true,
        buffer: direct.buffer,
        mime: meta.mime,
        extension: meta.extension,
        width: direct.width,
        height: direct.height,
        sourceWidth: direct.width,
        sourceHeight: direct.height,
        durationMs: Math.round(performance.now() - started),
      };
    }

    bitmap = await createImageBitmap(file, {
      imageOrientation: "from-image",
      colorSpaceConversion: "default",
    });

    const sourceWidth = bitmap.width;
    const sourceHeight = bitmap.height;
    const { width, height } = targetSize(sourceWidth, sourceHeight, settings);

    const data = toImageData(bitmap, width, height, settings.format === "jpeg");
    const buffer = await encode(data, settings);
    const meta = FORMATS[settings.format];

    return {
      id,
      ok: true,
      buffer,
      mime: meta.mime,
      extension: meta.extension,
      width,
      height,
      sourceWidth,
      sourceHeight,
      durationMs: Math.round(performance.now() - started),
    };
  } catch (error) {
    return {
      id,
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Could not read this file as an image",
    };
  } finally {
    bitmap?.close();
  }
}

self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  if (request.kind === "warm") {
    void warm(request.format);
    return;
  }

  void compress(request).then((response) => {
    if (response.ok) {
      (self as unknown as Worker).postMessage(response, [response.buffer]);
    } else {
      (self as unknown as Worker).postMessage(response);
    }
  });
});
