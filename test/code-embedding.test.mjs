import assert from "node:assert/strict";
import test from "node:test";

import { CodeEmbedding, DEFAULT_CODE_EMBEDDING_MODEL } from "../dist/source/CodeEmbedding.js";

test("code embeddings distinguish document titles and queries, then normalize before int8 storage", async () => {
  const embedding = new CodeEmbedding("unused");
  const calls = [];
  let disposed = false;
  const vector = Array(768).fill(0);
  vector[0] = 3;
  vector[1] = 4;
  vector[256] = 120;
  embedding.runtime = Promise.resolve({
    tokenizer: async (texts, options) => {
      calls.push({ texts, options });
      return { count: texts.length };
    },
    model: Object.assign(async inputs => ({
      sentence_embedding: { dims: [inputs.count, 768], tolist: () => Array.from({ length: inputs.count }, () => vector) }
    }), { dispose: async () => { disposed = true; } })
  });

  assert.equal(embedding.modelName, DEFAULT_CODE_EMBEDDING_MODEL);
  assert.deepEqual(await embedding.embedDocuments([]), []);
  const documents = await embedding.embedDocuments([{ title: "demo/Tool.java", text: "void damageAndBreak() {}" }]);
  const query = await embedding.embedQuery("wear the tool out");
  assert.equal(documents[0].length, 256);
  assert.deepEqual(Array.from(documents[0].slice(0, 2)), [76, 102]);
  assert.deepEqual(query, documents[0]);
  assert.deepEqual(calls[0].texts, ["title: demo/Tool.java | text: void damageAndBreak() {}"]);
  assert.deepEqual(calls[1].texts, ["task: code retrieval | query: wear the tool out"]);
  assert.equal(calls[0].options.truncation, true);
  assert.equal(calls[0].options.max_length, 1024);
  await embedding.close();
  assert.equal(disposed, true);
});

test("invalid model output is rejected instead of storing corrupted vectors", async () => {
  const embedding = new CodeEmbedding("unused");
  for (const value of [NaN, Infinity, 0]) {
    const vector = Array(768).fill(0);
    vector[0] = value;
    embedding.runtime = Promise.resolve({
      tokenizer: async () => ({}),
      model: async () => ({ sentence_embedding: { dims: [1, 768], tolist: () => [vector] } })
    });
    await assert.rejects(embedding.embedQuery("query"), /non-finite|zero-length/);
  }
});

test("embedding settings are captured at construction and invalid precision is rejected", async () => {
  const previousEnabled = process.env.SOURCE_RAG_EMBEDDINGS;
  const previousDtype = process.env.SOURCE_RAG_EMBEDDING_DTYPE;
  try {
    process.env.SOURCE_RAG_EMBEDDINGS = "disabled";
    const embedding = new CodeEmbedding("unused");
    delete process.env.SOURCE_RAG_EMBEDDINGS;
    assert.equal(embedding.enabled, false);
    assert.deepEqual(await embedding.embedDocuments([{ title: "Tool.java", text: "code" }]), []);
    assert.equal(await embedding.embedQuery("query"), undefined);
    assert.equal(embedding.runtime, undefined);
    process.env.SOURCE_RAG_EMBEDDING_DTYPE = "fp16";
    assert.throws(() => new CodeEmbedding("unused"), /must be q4 or q8/);
  } finally {
    if (previousEnabled === undefined) delete process.env.SOURCE_RAG_EMBEDDINGS;
    else process.env.SOURCE_RAG_EMBEDDINGS = previousEnabled;
    if (previousDtype === undefined) delete process.env.SOURCE_RAG_EMBEDDING_DTYPE;
    else process.env.SOURCE_RAG_EMBEDDING_DTYPE = previousDtype;
  }
});
