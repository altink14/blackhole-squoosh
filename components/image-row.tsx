"use client";

import { Download, GitCompareArrows, Loader2, TriangleAlert, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatBytes, formatDuration, savings } from "@/lib/format";
import type { QueueItem } from "@/lib/types";
import { cn } from "@/lib/utils";

interface ImageRowProps {
  item: QueueItem;
  onRemove: (id: string) => void;
  onCompare: (id: string) => void;
}

export function ImageRow({ item, onRemove, onCompare }: ImageRowProps) {
  const result = item.result;
  const delta = result ? savings(item.originalSize, result.size) : 0;
  const grew = delta < 0;

  return (
    <li className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-white/[0.04] sm:gap-4 sm:px-5">
      <div className="relative size-12 shrink-0 overflow-hidden rounded-lg border border-white/10 bg-white/5">
        {/* Local object URL of a user-selected file: next/image would only add
            an optimizer round trip for something that never leaves the tab. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={item.previewUrl}
          alt=""
          className="size-full object-cover"
          loading="lazy"
          decoding="async"
        />
        {item.status === "working" ? (
          <div className="absolute inset-0 grid place-items-center bg-black/65">
            <Loader2 className="size-4 animate-spin text-primary" />
          </div>
        ) : null}
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium" title={item.file.name}>
          {item.file.name}
        </p>
        <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground tabular-nums">
          {item.status === "error" ? (
            <span className="inline-flex items-center gap-1 text-destructive">
              <TriangleAlert className="size-3" />
              {item.error}
            </span>
          ) : result ? (
            <>
              {formatBytes(item.originalSize)}
              <span className="mx-1.5 opacity-50">&rarr;</span>
              <span className="text-foreground">{formatBytes(result.size)}</span>
              {/* Dropped on narrow screens so the size delta never truncates. */}
              <span className="hidden sm:inline">
                <span className="mx-1.5 opacity-40">·</span>
                {result.width}&times;{result.height}
                <span className="mx-1.5 opacity-40">·</span>
                {formatDuration(result.durationMs)}
              </span>
            </>
          ) : (
            <>
              {formatBytes(item.originalSize)}
              <span className="mx-1.5 opacity-50">&rarr;</span>
              <span className="opacity-60">
                {item.status === "working" ? "collapsing…" : "queued"}
              </span>
            </>
          )}
        </p>
      </div>

      {result ? (
        <span
          className={cn(
            "shrink-0 rounded-md px-2 py-1 font-mono text-xs font-medium tabular-nums",
            grew
              ? "bg-destructive/15 text-destructive"
              : "bg-primary/15 text-primary"
          )}
          title={grew ? "This encode is larger than the original" : undefined}
        >
          {grew ? "+" : "−"}
          {Math.abs(delta).toFixed(0)}%
        </span>
      ) : null}

      <div className="flex shrink-0 items-center gap-0.5">
        {result ? (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onCompare(item.id)}
              aria-label={`Compare ${item.file.name}`}
              title="Compare before and after"
            >
              <GitCompareArrows />
            </Button>
            <Button variant="ghost" size="icon-sm" asChild>
              <a
                href={result.url}
                download={result.filename}
                aria-label={`Download ${result.filename}`}
                title="Download"
              >
                <Download />
              </a>
            </Button>
          </>
        ) : null}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => onRemove(item.id)}
          aria-label={`Remove ${item.file.name}`}
          title="Remove"
        >
          <X />
        </Button>
      </div>
    </li>
  );
}
