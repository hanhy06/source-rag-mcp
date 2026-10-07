import assert from "node:assert/strict";
import { cp, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { CodeEmbedding, quantizedCosine } from "../dist/source/CodeEmbedding.js";
import { IndexBuilder } from "../dist/source/IndexBuilder.js";
import { SearchEngine } from "../dist/source/SearchEngine.js";
import { SourceCatalog } from "../dist/source/SourceCatalog.js";

const dataDir = path.resolve(".source-rag-gemma-validation/data");
const sourceDir = path.resolve(".source-rag-gemma-validation/sources");
await mkdir(sourceDir, { recursive: true });
await cp("test/fixtures", sourceDir, { recursive: true });
const embedding = new CodeEmbedding(dataDir);
const catalog = new SourceCatalog(dataDir);
const search = new SearchEngine(catalog, embedding);
try {
  const started = performance.now();
  const documents = await embedding.embedDocuments([
    { title: "Tool.java", text: "void damageAndBreak(int amount) { durability -= amount; if (durability <= 0) breakItem(); }" },
    { title: "Pose.java", text: 'String renderPiglinPose() { return "ATTACKING_WITH_MELEE_WEAPON"; }' }
  ]);
  const query = await embedding.embedQuery("decrease item durability and break it when it reaches zero");
  assert.equal(query.length, 256);
  assert.ok(documents.every(vector => vector instanceof Int8Array && vector.length === 256 && vector.some(value => value !== 0)));
  const scores = documents.map(vector => quantizedCosine(query, vector));
  assert.ok(scores[0] > scores[1], JSON.stringify(scores));
  const inferenceMs = Math.round(performance.now() - started);
  const indexStarted = performance.now();
  const index = await new IndexBuilder(catalog, undefined, embedding).indexSources("gemma-smoke", sourceDir, { sourceType: "custom" });
  assert.equal(index.embeddingDimensions, 256);
  const dense = await search.semanticSearch("gemma-smoke", "decrease item durability and break it when it reaches zero", 3, {});
  assert.ok(dense.some(hit => hit.name === "damageAndBreak"), JSON.stringify(dense));
  const hybrid = await search.ragSearch("gemma-smoke", "decrease item durability and break it when it reaches zero", 3);
  assert.ok(hybrid.some(hit => hit.name === "damageAndBreak"));
  const modelDir = path.join(dataDir, "models", embedding.modelName);
  const onnxFiles = await readdir(path.join(modelDir, "onnx"));
  assert.ok(onnxFiles.every(file => !/vision|audio/.test(file)), JSON.stringify(onnxFiles));
  const sizes = await Promise.all(onnxFiles.map(async file => ({ file, bytes: (await stat(path.join(modelDir, "onnx", file))).size })));
  console.log(JSON.stringify({ device: embedding.deviceName, scores, inferenceMs, indexAndSearchMs: Math.round(performance.now() - indexStarted), chunks: index.chunkCount, dimensions: index.embeddingDimensions, dense: dense.map(hit => ({ name: hit.name, score: hit.score })), onnxFiles: sizes, memory: process.memoryUsage() }, null, 2));
} finally {
  await search.close();
  await embedding.close();
  catalog.close();
}
