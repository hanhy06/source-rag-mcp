import { Worker } from "node:worker_threads";

export type VectorSearchResult = { row: number; score: number };

export class VectorSearch {
  private worker?: Worker;
  private nextRequestId = 1;
  private readonly pending = new Map<number, { resolve: (results: VectorSearchResult[]) => void; reject: (error: Error) => void }>();

  public async search(filePath: string, query: Int8Array, limit: number): Promise<VectorSearchResult[]> {
    const worker = this.ensureWorker();
    const id = this.nextRequestId++;
    return await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, path: filePath, query, limit });
    });
  }

  public async close(): Promise<void> {
    if (!this.worker) return;
    const worker = this.worker;
    this.worker = undefined;
    for (const request of this.pending.values()) request.reject(new Error("Vector search worker closed."));
    this.pending.clear();
    await worker.terminate();
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./VectorSearchWorker.js", import.meta.url));
    worker.unref();
    worker.on("message", (message: { id: number; results?: VectorSearchResult[]; error?: string }) => {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error));
      else request.resolve(message.results ?? []);
    });
    worker.on("error", error => {
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
      this.worker = undefined;
    });
    this.worker = worker;
    return worker;
  }
}
