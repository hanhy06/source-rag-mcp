import { readFileSync } from "node:fs";
import { parentPort } from "node:worker_threads";

import { readVectorHeader, VECTOR_HEADER_SIZE } from "./VectorStore.js";

type SearchRequest = { id: number; path: string; query: Int8Array; limit: number };
type SearchResult = { row: number; score: number };

const cache = new Map<string, Buffer>();

parentPort?.on("message", (request: SearchRequest) => {
  try {
    let buffer = cache.get(request.path);
    if (!buffer) {
      buffer = readFileSync(request.path);
      readVectorHeader(buffer);
      cache.set(request.path, buffer);
      if (cache.size > 2) cache.delete(cache.keys().next().value as string);
    }

    const info = readVectorHeader(buffer);
    if (request.query.length !== info.dimensions) throw new Error(`Query dimensions ${request.query.length} do not match index dimensions ${info.dimensions}.`);
    const queryLength = squaredLength(request.query);
    const best: SearchResult[] = [];
    for (let row = 0; row < info.count; row++) {
      const offset = VECTOR_HEADER_SIZE + row * info.dimensions;
      let dot = 0;
      let vectorLength = 0;
      for (let dimension = 0; dimension < info.dimensions; dimension++) {
        const value = buffer.readInt8(offset + dimension);
        dot += request.query[dimension] * value;
        vectorLength += value * value;
      }
      const score = queryLength === 0 || vectorLength === 0 ? 0 : dot / Math.sqrt(queryLength * vectorLength);
      if (best.length < request.limit || score > best[best.length - 1].score) {
        best.push({ row, score });
        best.sort((left, right) => right.score - left.score);
        if (best.length > request.limit) best.pop();
      }
    }
    parentPort?.postMessage({ id: request.id, results: best });
  } catch (error) {
    parentPort?.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
});

function squaredLength(vector: Int8Array): number {
  let result = 0;
  for (const value of vector) result += value * value;
  return result;
}
