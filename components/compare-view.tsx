"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatBytes, savings } from "@/lib/format";
import type { QueueItem } from "@/lib/types";

interface CompareViewProps {
  item: QueueItem;
  onClose: () => void;
}

export function CompareView({ item, onClose }: CompareViewProps) {
  const [position, setPosition] = useState(50);
  const frameRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const result = item.result;

  const updateFromClientX = useCallback((clientX: number) => {
    const frame = frameRef.current;
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    if (rect.width === 0) return;
    const ratio = ((clientX - rect.left) / rect.width) * 100;
    setPosition(Math.min(100, Math.max(0, ratio)));
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);

    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  useEffect(() => {
    function onPointerMove(event: PointerEvent) {
      if (draggingRef.current) updateFromClientX(event.clientX);
    }
    function onPointerUp() {
      draggingRef.current = false;
    }
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [updateFromClientX]);

  if (!result) return null;

  const delta = savings(item.originalSize, result.size);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Comparing ${item.file.name}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="glass flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-2xl">
        <header className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
          <p className="min-w-0 flex-1 truncate text-sm font-medium">
            {item.file.name}
          </p>
          <Button variant="ghost" size="icon-sm" asChild>
            <a href={result.url} download={result.filename} title="Download">
              <Download />
            </a>
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            autoFocus
            aria-label="Close comparison"
          >
            <X />
          </Button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto bg-[repeating-conic-gradient(#1a1a1f_0%_25%,#111115_0%_50%)] bg-[length:20px_20px] p-4">
          <div
            ref={frameRef}
            className="relative mx-auto w-fit cursor-ew-resize touch-none select-none"
            onPointerDown={(event) => {
              draggingRef.current = true;
              updateFromClientX(event.clientX);
            }}
          >
            {/* The original establishes the layout box; the compressed copy is
                absolutely positioned on top and clipped to the split. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={item.previewUrl}
              alt="Original"
              className="block max-h-[62vh] w-auto max-w-full"
              draggable={false}
            />
            <div
              className="absolute inset-0 overflow-hidden"
              style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={result.url}
                alt="Compressed"
                className="absolute inset-0 size-full object-fill"
                draggable={false}
              />
            </div>

            <div
              className="pointer-events-none absolute inset-y-0 w-0.5 bg-primary shadow-[0_0_20px_2px_var(--primary)]"
              style={{ left: `${position}%` }}
            >
              <div className="absolute top-1/2 left-1/2 size-8 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-black/70" />
            </div>

            <Tag className="left-3">after · {formatBytes(result.size)}</Tag>
            <Tag className="right-3">
              before · {formatBytes(item.originalSize)}
            </Tag>
          </div>
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 px-4 py-3">
          <label className="flex flex-1 items-center gap-3 text-xs text-muted-foreground">
            <span className="shrink-0 tracking-wide uppercase">Split</span>
            <input
              type="range"
              min={0}
              max={100}
              step={0.5}
              value={position}
              aria-label="Comparison split position"
              onChange={(event) => setPosition(Number(event.target.value))}
              className="h-1 w-full min-w-24 flex-1 cursor-pointer appearance-none rounded-full bg-white/15 accent-primary"
            />
          </label>
          <p className="font-mono text-xs tabular-nums">
            {item.sourceWidth && item.sourceHeight ? (
              <span className="text-muted-foreground">
                {item.sourceWidth}&times;{item.sourceHeight}
                <span className="mx-1.5 opacity-50">&rarr;</span>
                {result.width}&times;{result.height}
                <span className="mx-2 opacity-40">·</span>
              </span>
            ) : null}
            <span className={delta < 0 ? "text-destructive" : "text-primary"}>
              {delta < 0 ? "+" : "−"}
              {Math.abs(delta).toFixed(1)}%
            </span>
          </p>
        </footer>
      </div>
    </div>
  );
}

function Tag({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`pointer-events-none absolute top-3 rounded-md bg-black/70 px-2 py-1 font-mono text-[10px] tracking-wide text-white/80 uppercase ${className}`}
    >
      {children}
    </span>
  );
}
