"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileDown, ImagePlus, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";

import BlackHole from "@/components/ui/black-hole";
import { Button } from "@/components/ui/button";
import { CompareView } from "@/components/compare-view";
import { ImageRow } from "@/components/image-row";
import { SettingsBar } from "@/components/settings-bar";
import {
  ACCEPTED_TYPES,
  DEFAULT_SETTINGS,
  renameTo,
  type EncodeSettings,
} from "@/lib/codecs";
import { CompressorPool } from "@/lib/compressor";
import { formatBytes, savings } from "@/lib/format";
import type { QueueItem } from "@/lib/types";
import { cn } from "@/lib/utils";

function newId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Object URLs outlive the render that replaced them, so let the DOM settle. */
function scheduleRevoke(url: string) {
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  scheduleRevoke(url);
}

function carriesFiles(event: DragEvent) {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

export function Studio() {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [settings, setSettings] = useState<EncodeSettings>(DEFAULT_SETTINGS);
  const [dragging, setDragging] = useState(false);
  const [comparing, setComparing] = useState<string | null>(null);
  const [zipping, setZipping] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const poolRef = useRef<CompressorPool | null>(null);
  const itemsRef = useRef(items);
  const settingsRef = useRef(settings);
  const generationRef = useRef(0);

  // Mirrors of the latest state, so the async encode pipeline and the window
  // level listeners can read current values without re-subscribing.
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const getPool = useCallback(() => {
    poolRef.current ??= new CompressorPool();
    return poolRef.current;
  }, []);

  useEffect(() => {
    return () => {
      poolRef.current?.dispose();
      poolRef.current = null;
      for (const item of itemsRef.current) {
        URL.revokeObjectURL(item.previewUrl);
        if (item.result) URL.revokeObjectURL(item.result.url);
      }
    };
  }, []);

  const process = useCallback(
    async (targets: QueueItem[], config: EncodeSettings, generation: number) => {
      if (targets.length === 0) return;
      const pool = getPool();
      const ids = new Set(targets.map((target) => target.id));

      setItems((previous) =>
        previous.map((item) =>
          ids.has(item.id)
            ? { ...item, status: "working", error: undefined }
            : item
        )
      );

      await Promise.all(
        targets.map(async (target) => {
          const response = await pool.run(target.file, config);

          // A newer settings generation already superseded this encode.
          if (generationRef.current !== generation) return;

          const stale = itemsRef.current.find((item) => item.id === target.id)
            ?.result?.url;

          setItems((previous) =>
            previous.map((item) => {
              if (item.id !== target.id) return item;

              if (!response.ok) {
                return {
                  ...item,
                  status: "error",
                  error: response.error,
                  result: undefined,
                };
              }

              const blob = new Blob([response.buffer], {
                type: response.mime,
              });

              return {
                ...item,
                status: "done",
                error: undefined,
                sourceWidth: response.sourceWidth,
                sourceHeight: response.sourceHeight,
                result: {
                  blob,
                  url: URL.createObjectURL(blob),
                  filename: renameTo(item.file.name, response.extension),
                  size: blob.size,
                  width: response.width,
                  height: response.height,
                  durationMs: response.durationMs,
                },
              };
            })
          );

          if (stale) scheduleRevoke(stale);
        })
      );
    },
    [getPool]
  );

  const addFiles = useCallback(
    (incoming: File[]) => {
      const images = incoming.filter((file) => file.type.startsWith("image/"));
      const skipped = incoming.length - images.length;
      if (skipped > 0) {
        toast.error(
          `Skipped ${skipped} non-image ${skipped === 1 ? "file" : "files"}`
        );
      }
      if (images.length === 0) return;

      const created: QueueItem[] = images.map((file) => ({
        id: newId(),
        file,
        previewUrl: URL.createObjectURL(file),
        originalSize: file.size,
        status: "queued",
      }));

      setItems((previous) => [...previous, ...created]);
      void process(created, settingsRef.current, generationRef.current);
    },
    [process]
  );

  // Re-encode everything when the settings change, debounced so dragging a
  // slider does not queue a job per pixel of travel.
  useEffect(() => {
    if (itemsRef.current.length === 0) return;
    const handle = setTimeout(() => {
      generationRef.current += 1;
      void process(itemsRef.current, settings, generationRef.current);
    }, 350);
    return () => clearTimeout(handle);
  }, [settings, process]);

  // The whole window is a drop target, not just the ring.
  useEffect(() => {
    let depth = 0;

    function onDragEnter(event: DragEvent) {
      if (!carriesFiles(event)) return;
      depth += 1;
      setDragging(true);
    }
    function onDragOver(event: DragEvent) {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    }
    function onDragLeave(event: DragEvent) {
      if (!carriesFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    }
    function onDrop(event: DragEvent) {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setDragging(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) addFiles(files);
    }
    function onPaste(event: ClipboardEvent) {
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length > 0) {
        event.preventDefault();
        addFiles(files);
      }
    }

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    window.addEventListener("paste", onPaste);

    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("paste", onPaste);
    };
  }, [addFiles]);

  const remove = useCallback((id: string) => {
    setComparing((current) => (current === id ? null : current));
    setItems((previous) => {
      const target = previous.find((item) => item.id === id);
      if (target) {
        scheduleRevoke(target.previewUrl);
        if (target.result) scheduleRevoke(target.result.url);
      }
      return previous.filter((item) => item.id !== id);
    });
  }, []);

  const clearAll = useCallback(() => {
    setComparing(null);
    generationRef.current += 1;
    setItems((previous) => {
      for (const item of previous) {
        scheduleRevoke(item.previewUrl);
        if (item.result) scheduleRevoke(item.result.url);
      }
      return [];
    });
  }, []);

  const downloadAll = useCallback(async () => {
    const finished = itemsRef.current.filter((item) => item.result);
    if (finished.length === 0) return;

    if (finished.length === 1) {
      const only = finished[0].result!;
      triggerDownload(only.blob, only.filename);
      return;
    }

    setZipping(true);
    try {
      const { default: JSZip } = await import("jszip");
      const zip = new JSZip();
      const seen = new Map<string, number>();

      for (const item of finished) {
        const result = item.result!;
        const count = seen.get(result.filename) ?? 0;
        seen.set(result.filename, count + 1);
        const name =
          count === 0
            ? result.filename
            : result.filename.replace(/(\.[^.]+)$/, `-${count}$1`);
        zip.file(name, result.blob);
      }

      const archive = await zip.generateAsync({ type: "blob" });
      triggerDownload(archive, "blackhole.zip");
    } catch {
      toast.error("Could not build the archive");
    } finally {
      setZipping(false);
    }
  }, []);

  const busy = items.some((item) => item.status === "working");
  const totals = useMemo(() => {
    let before = 0;
    let after = 0;
    let done = 0;
    for (const item of items) {
      if (!item.result) continue;
      before += item.originalSize;
      after += item.result.size;
      done += 1;
    }
    return { before, after, done, delta: savings(before, after) };
  }, [items]);

  const compared = items.find((item) => item.id === comparing) ?? null;
  const intensity = dragging ? 1 : busy ? 0.7 : 0;
  const hasItems = items.length > 0;

  return (
    <>
      <div
        className={cn(
          "fixed inset-0 z-0 transition-opacity duration-1000",
          hasItems ? "opacity-60" : "opacity-100"
        )}
      >
        <BlackHole intensity={intensity} />
      </div>

      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPTED_TYPES.join(",")}
        className="sr-only"
        onChange={(event) => {
          addFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />

      <div className="relative z-10 flex min-h-dvh flex-col">
        <header className="flex items-center justify-between gap-4 px-5 py-4 sm:px-8">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold tracking-[0.3em] text-glow uppercase">
              blackhole
            </span>
          </div>
          <p className="hidden text-[11px] tracking-wide text-white/45 sm:block">
            every byte is crushed locally · nothing is uploaded
          </p>
        </header>

        {hasItems ? (
          <section className="mx-auto w-full max-w-3xl flex-1 px-4 pb-10 sm:px-6">
            <div className="glass overflow-hidden rounded-2xl">
              <SettingsBar settings={settings} onChange={setSettings} />

              <ul className="max-h-[46vh] divide-y divide-white/[0.07] overflow-y-auto scrollbar-thin">
                {items.map((item) => (
                  <ImageRow
                    key={item.id}
                    item={item}
                    onRemove={remove}
                    onCompare={setComparing}
                  />
                ))}
              </ul>

              <div className="flex flex-wrap items-center gap-3 border-t border-white/10 bg-black/20 px-4 py-3 sm:px-5">
                <div className="flex-1 font-mono text-xs tabular-nums">
                  {totals.done > 0 ? (
                    <>
                      <span className="text-muted-foreground">
                        {formatBytes(totals.before)}
                      </span>
                      <span className="mx-1.5 opacity-50">&rarr;</span>
                      <span>{formatBytes(totals.after)}</span>
                      <span
                        className={cn(
                          "ml-2 font-medium",
                          totals.delta < 0 ? "text-destructive" : "text-primary"
                        )}
                      >
                        {totals.delta < 0 ? "+" : "−"}
                        {Math.abs(totals.delta).toFixed(1)}%
                      </span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">
                      {busy ? "Crossing the horizon…" : "Waiting"}
                    </span>
                  )}
                </div>

                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearAll}
                  disabled={busy}
                >
                  <Trash2 data-icon="inline-start" />
                  Clear
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => inputRef.current?.click()}
                >
                  <ImagePlus data-icon="inline-start" />
                  Add
                </Button>
                <Button
                  size="sm"
                  onClick={() => void downloadAll()}
                  disabled={totals.done === 0 || zipping}
                >
                  {zipping ? (
                    <Loader2 data-icon="inline-start" className="animate-spin" />
                  ) : (
                    <FileDown data-icon="inline-start" />
                  )}
                  {totals.done > 1 ? `Download ${totals.done}` : "Download"}
                </Button>
              </div>
            </div>

            <p className="mt-3 text-center text-[11px] text-white/35">
              Drop or paste more images anywhere on the page.
            </p>
          </section>
        ) : (
          <section className="grid flex-1 place-items-center px-6 pb-16">
            <div className="flex flex-col items-center gap-8">
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className={cn(
                  "group relative grid size-[min(46vh,78vw,27rem)] place-items-center rounded-full",
                  "transition-transform duration-500 focus-visible:outline-none",
                  dragging ? "scale-[1.04]" : "hover:scale-[1.02]"
                )}
                aria-label="Choose images to compress"
              >
                <span
                  className={cn(
                    "animate-horizon absolute inset-0 rounded-full border transition-colors duration-300",
                    dragging
                      ? "border-primary/80 shadow-[0_0_80px_-10px_var(--primary)]"
                      : "border-white/20 group-hover:border-white/40",
                    "group-focus-visible:border-primary"
                  )}
                />
                {/* Sits above centre: the accretion disk crosses in front of
                    the shadow at the equator, and centred text lands right on
                    that bright band. */}
                <span className="relative flex -translate-y-8 flex-col items-center gap-2 px-8 text-center sm:-translate-y-12">
                  <span className="text-lg font-medium tracking-[0.18em] text-white uppercase [text-shadow:0_2px_20px_rgb(0_0_0/0.95)] sm:text-xl">
                    {dragging ? "let go" : "drop images"}
                  </span>
                  <span className="max-w-[16rem] text-xs leading-relaxed text-white/60 [text-shadow:0_1px_14px_rgb(0_0_0/0.95)]">
                    {dragging
                      ? "They are not coming back the same size."
                      : "or click to browse · paste works too"}
                  </span>
                </span>
              </button>

              <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[11px] tracking-wide text-white/35 uppercase">
                <span>MozJPEG</span>
                <Dot />
                <span>libwebp</span>
                <Dot />
                <span>libavif</span>
                <Dot />
                <span>OxiPNG</span>
              </div>
            </div>
          </section>
        )}
      </div>

      {compared ? (
        <CompareView item={compared} onClose={() => setComparing(null)} />
      ) : null}

      <Toaster position="bottom-center" />
    </>
  );
}

function Dot() {
  return <span aria-hidden className="size-1 rounded-full bg-white/25" />;
}
