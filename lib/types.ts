export type QueueStatus = "queued" | "working" | "done" | "error";

export interface EncodeResult {
  blob: Blob;
  url: string;
  filename: string;
  size: number;
  width: number;
  height: number;
  durationMs: number;
}

export interface QueueItem {
  id: string;
  file: File;
  previewUrl: string;
  originalSize: number;
  sourceWidth?: number;
  sourceHeight?: number;
  status: QueueStatus;
  result?: EncodeResult;
  error?: string;
}
