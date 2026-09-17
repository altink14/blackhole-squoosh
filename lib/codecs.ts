export type OutputFormat = "avif" | "webp" | "jpeg" | "png";

export interface EncodeSettings {
  format: OutputFormat;
  /** 1-100. Ignored by PNG, which is always lossless. */
  quality: number;
  /** 0-10. Higher means slower encoding for a smaller file. */
  effort: number;
  resizeEnabled: boolean;
  /** Longest edge, in pixels. Images are never upscaled. */
  maxDimension: number;
}

export interface FormatMeta {
  label: string;
  codec: string;
  mime: string;
  extension: string;
  lossy: boolean;
  blurb: string;
}

export const FORMATS: Record<OutputFormat, FormatMeta> = {
  avif: {
    label: "AVIF",
    codec: "libavif",
    mime: "image/avif",
    extension: "avif",
    lossy: true,
    blurb: "Smallest files. Slowest to encode.",
  },
  webp: {
    label: "WebP",
    codec: "libwebp",
    mime: "image/webp",
    extension: "webp",
    lossy: true,
    blurb: "Great ratio, universal support.",
  },
  jpeg: {
    label: "JPEG",
    codec: "MozJPEG",
    mime: "image/jpeg",
    extension: "jpg",
    lossy: true,
    blurb: "Works literally everywhere.",
  },
  png: {
    label: "PNG",
    codec: "OxiPNG",
    mime: "image/png",
    extension: "png",
    lossy: false,
    blurb: "Lossless. Best for flat art and alpha.",
  },
};

export const FORMAT_ORDER: OutputFormat[] = ["avif", "webp", "jpeg", "png"];

export const DEFAULT_SETTINGS: EncodeSettings = {
  format: "webp",
  quality: 75,
  effort: 4,
  resizeEnabled: false,
  maxDimension: 2048,
};

export const ACCEPTED_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/avif",
  "image/gif",
  "image/bmp",
];

export interface CompressRequest {
  id: number;
  file: File;
  settings: EncodeSettings;
}

export interface CompressSuccess {
  id: number;
  ok: true;
  buffer: ArrayBuffer;
  mime: string;
  extension: string;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  durationMs: number;
}

export interface CompressFailure {
  id: number;
  ok: false;
  error: string;
}

export type CompressResponse = CompressSuccess | CompressFailure;

/** Swaps the extension on a filename, preserving the rest of the name. */
export function renameTo(filename: string, extension: string) {
  const base = filename.replace(/\.[^./\\]+$/, "") || "image";
  return `${base}.${extension}`;
}
