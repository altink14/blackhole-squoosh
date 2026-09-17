import type {
  CompressRequest,
  CompressResponse,
  EncodeSettings,
} from "./codecs";

type Resolver = (response: CompressResponse) => void;

interface QueueEntry {
  request: CompressRequest;
  resolve: Resolver;
}

/**
 * A small pool of encode workers. Each worker holds its own WASM instances, so
 * the pool stays deliberately narrow -- a handful of codec heaps is the point
 * where parallelism starts costing more memory than it buys in throughput.
 */
export class CompressorPool {
  private readonly size: number;
  private readonly workers: Worker[] = [];
  private readonly free: Worker[] = [];
  private readonly jobs = new Map<Worker, Resolver>();
  private readonly queue: QueueEntry[] = [];
  private nextId = 1;
  private disposed = false;

  constructor(size?: number) {
    const cores =
      typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 2 : 2;
    this.size = Math.max(1, Math.min(size ?? 3, cores));
  }

  private spawn(): Worker {
    const worker = new Worker(
      new URL("./compress.worker.ts", import.meta.url),
      { type: "module" }
    );

    worker.addEventListener("message", (event: MessageEvent<CompressResponse>) => {
      this.settle(worker, event.data);
    });

    worker.addEventListener("error", (event) => {
      this.settle(worker, {
        id: -1,
        ok: false,
        error: event.message || "The encoder worker crashed",
      });
    });

    this.workers.push(worker);
    return worker;
  }

  private settle(worker: Worker, response: CompressResponse) {
    const resolve = this.jobs.get(worker);
    this.jobs.delete(worker);
    resolve?.(response);

    if (this.disposed) return;
    const next = this.queue.shift();
    if (next) {
      this.dispatch(worker, next);
    } else {
      this.free.push(worker);
    }
  }

  private dispatch(worker: Worker, entry: QueueEntry) {
    this.jobs.set(worker, entry.resolve);
    worker.postMessage(entry.request);
  }

  run(file: File, settings: EncodeSettings): Promise<CompressResponse> {
    const request: CompressRequest = { id: this.nextId++, file, settings };

    return new Promise<CompressResponse>((resolve) => {
      if (this.disposed) {
        resolve({ id: request.id, ok: false, error: "Pool has been disposed" });
        return;
      }

      const entry: QueueEntry = { request, resolve };
      const worker =
        this.free.pop() ??
        (this.workers.length < this.size ? this.spawn() : undefined);

      if (worker) {
        this.dispatch(worker, entry);
      } else {
        this.queue.push(entry);
      }
    });
  }

  dispose() {
    this.disposed = true;
    this.queue.length = 0;
    this.free.length = 0;
    this.jobs.clear();
    for (const worker of this.workers) worker.terminate();
    this.workers.length = 0;
  }
}
