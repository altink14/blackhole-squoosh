/// <reference lib="webworker" />

import {
  FORMATS,
  type CompressRequest,
  type CompressResponse,
  type EncodeSettings,
} from "./codecs";

// The .wasm binaries are copied out of node_modules into /public/codecs by
// scripts/copy-codecs.mjs, so they are served as plain static assets and the
// bundler never has to resolve them.
const CODEC_BASE = "/codecs/";
const locateFile = (path: string) => CODEC_BASE + path;

type JpegModule = typeof import("@jsquash/jpeg/encode");
type WebpModule = typeof import("@jsquash/webp/encode");
type AvifModule = typeof import("@jsquash/avif/encode");
type OxipngModule = typeof import("@jsquash/oxipng/optimise");

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

function loadAvif() {
  avif ??= import("@jsquash/avif/encode").then(async (mod) => {
    await mod.init({ locateFile });
    return mod;
  });
  return avif;
}

function loadOxipng() {
  oxipng ??= import("@jsquash/oxipng/optimise").then(async (mod) => {
    await mod.init(`${CODEC_BASE}squoosh_oxipng_bg.wasm`);
    return mod;
  });
  return oxipng;
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
      return mod.default(data, {
        quality,
        speed: Math.min(10, Math.max(0, 10 - effort)),
      });
    }
    case "png": {
      const mod = await loadOxipng();
      return mod.default(data, {
        level: Math.min(6, Math.max(1, Math.round(1 + effort * 0.5))),
        interlace: false,
        optimiseAlpha: true,
      });
    }
  }
}

async function compress(request: CompressRequest): Promise<CompressResponse> {
  const started = performance.now();
  const { id, file, settings } = request;

  let bitmap: ImageBitmap | null = null;
  try {
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

self.addEventListener("message", (event: MessageEvent<CompressRequest>) => {
  void compress(event.data).then((response) => {
    if (response.ok) {
      (self as unknown as Worker).postMessage(response, [response.buffer]);
    } else {
      (self as unknown as Worker).postMessage(response);
    }
  });
});
