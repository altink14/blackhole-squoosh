"use client";

import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FORMATS, FORMAT_ORDER, type EncodeSettings } from "@/lib/codecs";
import { cn } from "@/lib/utils";

const DIMENSIONS = [640, 1024, 1280, 1600, 1920, 2048, 2560, 3840];

interface SettingsBarProps {
  settings: EncodeSettings;
  onChange: (next: EncodeSettings) => void;
  disabled?: boolean;
}

export function SettingsBar({ settings, onChange, disabled }: SettingsBarProps) {
  const meta = FORMATS[settings.format];

  function patch(partial: Partial<EncodeSettings>) {
    onChange({ ...settings, ...partial });
  }

  return (
    <div className="flex flex-col gap-5 border-b border-white/10 p-4 sm:p-5">
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-3">
          <Label>Format</Label>
          <span className="text-[11px] text-muted-foreground">{meta.blurb}</span>
        </div>
        <div
          role="radiogroup"
          aria-label="Output format"
          className="grid grid-cols-4 gap-1 rounded-xl bg-white/5 p-1"
        >
          {FORMAT_ORDER.map((format) => {
            const active = settings.format === format;
            return (
              <button
                key={format}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={disabled}
                onClick={() => patch({ format })}
                className={cn(
                  "rounded-lg px-2 py-2 text-xs font-medium transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  "disabled:pointer-events-none disabled:opacity-50",
                  active
                    ? "bg-primary text-primary-foreground shadow-[0_0_24px_-6px_var(--primary)]"
                    : "text-muted-foreground hover:bg-white/5 hover:text-foreground"
                )}
              >
                <span className="block">{FORMATS[format].label}</span>
                <span className="block text-[10px] font-normal opacity-70">
                  {FORMATS[format].codec}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div className={cn("flex flex-col gap-2", !meta.lossy && "opacity-40")}>
          <div className="flex items-baseline justify-between">
            <Label>Quality</Label>
            <Value>{meta.lossy ? settings.quality : "lossless"}</Value>
          </div>
          <Slider
            value={[settings.quality]}
            min={1}
            max={100}
            step={1}
            disabled={disabled || !meta.lossy}
            aria-label="Quality"
            onValueChange={([quality]) => patch({ quality })}
          />
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between">
            <Label>Effort</Label>
            <Value>{settings.effort} / 10</Value>
          </div>
          <Slider
            value={[settings.effort]}
            min={0}
            max={10}
            step={1}
            disabled={disabled}
            aria-label="Encoder effort"
            onValueChange={([effort]) => patch({ effort })}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="flex items-center gap-2.5">
          <Switch
            id="resize"
            checked={settings.resizeEnabled}
            disabled={disabled}
            onCheckedChange={(resizeEnabled) => patch({ resizeEnabled })}
          />
          <label
            htmlFor="resize"
            className="cursor-pointer text-xs font-medium tracking-wide text-muted-foreground uppercase"
          >
            Resize
          </label>
        </div>

        <Select
          value={String(settings.maxDimension)}
          disabled={disabled || !settings.resizeEnabled}
          onValueChange={(value) => patch({ maxDimension: Number(value) })}
        >
          <SelectTrigger size="sm" className="w-[170px]" aria-label="Longest edge">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DIMENSIONS.map((dimension) => (
              <SelectItem key={dimension} value={String(dimension)}>
                {dimension} px longest edge
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <p className="text-[11px] text-muted-foreground">
          Images are never enlarged.
        </p>
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
      {children}
    </span>
  );
}

function Value({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-xs tabular-nums text-foreground">
      {children}
    </span>
  );
}
