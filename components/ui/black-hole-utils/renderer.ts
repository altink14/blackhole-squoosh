import { FRAGMENT_SHADER, VERTEX_SHADER } from "./shader";

export interface RendererOptions {
  canvas: HTMLCanvasElement;
  /** Extra brightness and spin. 0 = idle, 1 = actively feeding. */
  intensity?: number;
  /** Ceiling on internally rendered pixels. Lower trades sharpness for speed. */
  maxPixels?: number;
}

export interface Renderer {
  /** Resolves once the first frame is on screen, rejects if WebGL2 is absent. */
  ready: Promise<void>;
  setIntensity(value: number): void;
  setPaused(paused: boolean): void;
  dispose(): void;
}

const MAX_STEPS = 240;
const MIN_STEPS = 130;
const MAX_SCALE = 1.5;
const MIN_SCALE = 0.5;

function compile(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Failed to allocate shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compilation failed: ${log}`);
  }
  return shader;
}

function link(gl: WebGL2RenderingContext, vert: string, frag: string) {
  const vs = compile(gl, gl.VERTEX_SHADER, vert);
  const fs = compile(gl, gl.FRAGMENT_SHADER, frag);
  const program = gl.createProgram();
  if (!program) throw new Error("Failed to allocate program");
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Program link failed: ${log}`);
  }
  return program;
}

export function createRenderer({
  canvas,
  intensity = 0,
  maxPixels = 1_300_000,
}: RendererOptions): Renderer {
  let disposed = false;
  let frame = 0;

  let targetIntensity = intensity;
  let currentIntensity = intensity;

  let paused = false;
  let visible = true;
  let documentVisible =
    typeof document === "undefined" || document.visibilityState !== "hidden";

  // Adaptive quality. Both knobs move together when frames get expensive.
  let scale = Math.min(
    typeof devicePixelRatio === "number" ? devicePixelRatio : 1,
    MAX_SCALE
  );
  let steps = MAX_STEPS;
  let frameAccum = 0;
  let frameCount = 0;

  const reduceMotion =
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;
  const speed = reduceMotion ? 0.12 : 1;

  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const ready = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // The caller may only `void renderer.ready`, so make sure an unobserved
  // rejection never surfaces as an unhandled promise rejection.
  ready.catch(() => {});

  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    desynchronized: true,
    powerPreference: "high-performance",
    preserveDrawingBuffer: false,
  });

  if (!gl) {
    canvas.dataset.webglUnavailable = "true";
    reject(new Error("WebGL2 is not available in this browser"));
    return {
      ready,
      setIntensity: () => {},
      setPaused: () => {},
      dispose: () => {},
    };
  }

  let program: WebGLProgram;
  try {
    program = link(gl, VERTEX_SHADER, FRAGMENT_SHADER);
  } catch (error) {
    // Surface this: a shader that fails to build is a bug, and silently
    // swapping in the CSS fallback would hide it completely.
    console.error("[black-hole] renderer failed to start", error);
    canvas.dataset.webglUnavailable = "true";
    reject(error instanceof Error ? error : new Error(String(error)));
    return {
      ready,
      setIntensity: () => {},
      setPaused: () => {},
      dispose: () => {},
    };
  }

  delete canvas.dataset.webglUnavailable;

  // WebGL2 can build a fullscreen triangle from gl_VertexID alone, so there is
  // no vertex buffer to feed -- but a bound VAO is still required to draw.
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.useProgram(program);

  const uResolution = gl.getUniformLocation(program, "uResolution");
  const uTime = gl.getUniformLocation(program, "uTime");
  const uPhase = gl.getUniformLocation(program, "uPhase");
  const uIntensity = gl.getUniformLocation(program, "uIntensity");
  const uSteps = gl.getUniformLocation(program, "uSteps");

  let width = 0;
  let height = 0;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const cssWidth = Math.max(1, rect.width || canvas.clientWidth || 1);
    const cssHeight = Math.max(1, rect.height || canvas.clientHeight || 1);

    // Clamp by total pixel count so an ultrawide display does not quietly cost
    // four times as much as a laptop screen.
    const budget = Math.sqrt(maxPixels / (cssWidth * cssHeight));
    const effective = Math.min(scale, Math.max(MIN_SCALE, budget));

    const next = {
      w: Math.max(1, Math.round(cssWidth * effective)),
      h: Math.max(1, Math.round(cssHeight * effective)),
    };
    if (next.w === width && next.h === height) return;

    width = next.w;
    height = next.h;
    canvas.width = width;
    canvas.height = height;
    gl!.viewport(0, 0, width, height);
  }

  const observer =
    typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
  observer?.observe(canvas);

  const intersection =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver(
          (entries) => {
            visible = entries.some((entry) => entry.isIntersecting);
          },
          { threshold: 0 }
        )
      : null;
  intersection?.observe(canvas);

  function onVisibilityChange() {
    documentVisible = document.visibilityState !== "hidden";
    if (documentVisible) last = performance.now();
  }
  document.addEventListener("visibilitychange", onVisibilityChange);

  function onContextLost(event: Event) {
    event.preventDefault();
    canvas.dataset.webglUnavailable = "true";
  }
  canvas.addEventListener("webglcontextlost", onContextLost);

  let last = performance.now();
  let phase = 0;
  let elapsed = 0;
  let firstFrameDone = false;

  /**
   * Driven by the frame-to-frame interval, not by how long the draw call takes
   * to submit. drawArrays returns as soon as the command is queued, so timing
   * around it measures almost nothing and would ratchet quality to maximum on
   * any GPU, however slow.
   */
  function adaptQuality(frameIntervalMs: number) {
    // Ignore the first frame after a pause, and any hitch long enough to be a
    // stall rather than a slow frame.
    if (frameIntervalMs <= 0 || frameIntervalMs > 200) return;

    frameAccum += frameIntervalMs;
    frameCount += 1;
    if (frameCount < 45) return;

    const average = frameAccum / frameCount;
    frameAccum = 0;
    frameCount = 0;

    // Thresholds straddle a 60Hz vsync interval: past ~21ms we are missing
    // frames, under ~17.6ms we are pinned to the display and have headroom.
    if (average > 21 && (scale > MIN_SCALE || steps > MIN_STEPS)) {
      steps = Math.max(MIN_STEPS, Math.round(steps * 0.85));
      scale = Math.max(MIN_SCALE, scale * 0.85);
      width = 0; // force resize() to rebuild the drawing buffer
      resize();
    } else if (average < 17.6 && scale < MAX_SCALE) {
      steps = Math.min(MAX_STEPS, Math.round(steps * 1.08) + 1);
      scale = Math.min(MAX_SCALE, scale * 1.08);
      width = 0;
      resize();
    }
  }

  function render(now: number) {
    if (disposed) return;
    frame = requestAnimationFrame(render);

    const intervalMs = now - last;
    const dt = Math.min(0.05, Math.max(0, intervalMs / 1000));
    last = now;

    if ((paused || !visible || !documentVisible) && firstFrameDone) return;

    // Ease toward the requested intensity so state changes feel like the disk
    // spinning up rather than a hard cut.
    currentIntensity += (targetIntensity - currentIntensity) * Math.min(1, dt * 3);

    elapsed += dt * speed;
    phase += dt * speed * (1 + 1.35 * currentIntensity);

    resize();

    gl!.useProgram(program);
    gl!.bindVertexArray(vao);
    gl!.uniform2f(uResolution, width, height);
    gl!.uniform1f(uTime, elapsed);
    gl!.uniform1f(uPhase, phase);
    gl!.uniform1f(uIntensity, currentIntensity);
    gl!.uniform1i(uSteps, steps);
    gl!.drawArrays(gl!.TRIANGLES, 0, 3);

    if (!firstFrameDone) {
      firstFrameDone = true;
      resolve();
    } else {
      adaptQuality(intervalMs);
    }
  }

  resize();
  frame = requestAnimationFrame(render);

  return {
    ready,
    setIntensity(value: number) {
      targetIntensity = Math.min(1, Math.max(0, value));
    },
    setPaused(value: boolean) {
      paused = value;
      if (!value) last = performance.now();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(frame);
      observer?.disconnect();
      intersection?.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      gl!.deleteProgram(program);
      gl!.deleteVertexArray(vao);
      // Deliberately NOT calling WEBGL_lose_context here. A canvas hands back
      // the same context object on every getContext call, so forcing a loss
      // would poison the element for any later mount -- which StrictMode's
      // double-invoked effects trigger on every dev render.
    },
  };
}
