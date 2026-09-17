const UNITS = ["B", "KB", "MB", "GB"];

export function formatBytes(bytes: number, precision?: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";

  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }

  const digits = precision ?? (unit === 0 ? 0 : value < 10 ? 2 : 1);
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

/** Positive means the file shrank. Negative means the encode made it bigger. */
export function savings(before: number, after: number) {
  if (before <= 0) return 0;
  return ((before - after) / before) * 100;
}

export function formatDuration(ms: number) {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}
