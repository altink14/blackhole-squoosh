"use client";

import { useEffect, useRef, useState } from "react";
import { createRenderer, type Renderer } from "./black-hole-utils/renderer";

export interface BlackHoleProps {
  /**
   * Drives brightness and how fast the disk spins. Ease it toward 1 while
   * something is being consumed, back to 0 when idle.
   */
  intensity?: number;
  className?: string;
}

export function BlackHole({ intensity = 0, className }: BlackHoleProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = createRenderer({ canvas });
    rendererRef.current = renderer;
    renderer.ready.catch(() => setFailed(true));

    return () => {
      rendererRef.current = null;
      renderer.dispose();
    };
  }, []);

  useEffect(() => {
    rendererRef.current?.setIntensity(intensity);
  }, [intensity]);

  return (
    <div
      className={`relative h-full w-full overflow-hidden bg-black ${className ?? ""}`}
    >
      <canvas
        ref={canvasRef}
        aria-hidden
        className="block h-full w-full touch-none"
      />
      {failed ? (
        // No WebGL2: keep the same visual language with a static gradient so
        // the page never renders as a flat black rectangle.
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_52%,transparent_11%,rgba(255,150,60,0.30)_13%,rgba(255,90,20,0.16)_20%,rgba(120,30,90,0.10)_34%,transparent_58%)]"
        />
      ) : null}
    </div>
  );
}

export default BlackHole;
