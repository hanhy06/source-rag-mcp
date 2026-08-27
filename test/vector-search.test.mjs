import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { IndexBuilder } from "../dist/source/IndexBuilder.js";
import { SearchEngine } from "../dist/source/SearchEngine.js";
import { SourceCatalog } from "../dist/source/SourceCatalog.js";
import { VectorSearch } from "../dist/source/VectorSearch.js";
import { VectorWriter } from "../dist/source/VectorStore.js";

test("VectorWriter and worker search contiguous int8 vectors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "source-rag-vector-"));
  const filePath = path.join(root, "vectors.i8");
  const writer = await VectorWriter.create(filePath);
  await writer.append([new Int8Array([127, 0]), new Int8Array([0, 127]), new Int8Array([-127, 0])]);
  assert.deepEqual(await writer.finalize(), { dimensions: 2, count: 3 });

  const search = new VectorSearch();
  try {
    const hits = await search.search(filePath, new Int8Array([120, 0]), 2);
    assert.deepEqual(hits.map(hit => hit.row), [0, 1]);
    assert.equal(hits[0].score, 1);
  } finally {
    await search.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("IndexBuilder and SearchEngine use stored dense vectors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "source-rag-dense-"));
  const sourceDir = path.join(root, "sources");
  await cp(path.resolve("test/fixtures"), sourceDir, { recursive: true });
  const catalog = new SourceCatalog(path.join(root, "data"));
  const embedding = {
    enabled: true,
    modelName: "fixture-embedding",
    embed: async texts => texts.map(text => text.includes("damageAndBreak") ? new Int8Array([127, 0, 0]) : new Int8Array([0, 0, 127])),
    embedQuery: async () => new Int8Array([127, 0, 0])
  };
  const search = new SearchEngine(catalog, embedding);
  try {
    const index = await new IndexBuilder(catalog, undefined, embedding).indexSources("fixture", sourceDir, { sourceType: "custom" });
    assert.equal(index.embeddingModel, "fixture-embedding");
    assert.equal(index.embeddingDimensions, 3);

    const hits = await search.ragSearch("fixture", "wear the tool out", 3);
    assert.equal(hits[0].name, "damageAndBreak");
  } finally {
    await search.close();
    catalog.close();
    await rm(root, { recursive: true, force: true });
  }
});
