import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildBm25Index, searchBm25 } from "../dist/source/Bm25.js";
import { quantizeVector, quantizedCosine } from "../dist/source/CodeEmbedding.js";
import { scanJavaStructure } from "../dist/source/JavaStructure.js";
import { SourceIndex } from "../dist/source/SourceIndex.js";

test("Java structure scanner ignores non-code braces and finds multiline methods", () => {
  const source = `package demo;
public class Example {
  String brace = "}";
  public <T extends Number>
  T compute(T value) {
    return value;
  }
}`;
  const blocks = scanJavaStructure(source, "demo");
  assert.deepEqual(
    blocks.map(({ kind, name, startLine, endLine }) => ({ kind, name, startLine, endLine })),
    [
      { kind: "class", name: "Example", startLine: 2, endLine: 8 },
      { kind: "method", name: "compute", startLine: 4, endLine: 7 }
    ]
  );
});

test("BM25 and quantized vectors preserve relevant ranking primitives", () => {
  const chunks = [
    { version: "test", path: "Item.java", owner: "demo.Item", startLine: 1, endLine: 1, name: "damageAndBreak", text: "decrease durability and break item" },
    { version: "test", path: "Piglin.java", owner: "demo.Piglin", startLine: 1, endLine: 1, name: "pose", text: "melee attack arm pose" }
  ];
  const scores = searchBm25(buildBm25Index(chunks), "where item durability decreases until it breaks");
  assert.ok((scores.get(0) ?? 0) > (scores.get(1) ?? 0));
  const vector = quantizeVector([0.1, 0.2, 0.3]);
  assert.equal(quantizedCosine(vector, vector), 1);
});

test("SourceIndex and MCP expose structured range, search, and comparison results", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "source-rag-mcp-"));
  const previousData = process.env.SOURCE_RAG_DATA;
  const previousEmbeddings = process.env.SOURCE_RAG_EMBEDDINGS;
  process.env.SOURCE_RAG_DATA = dataDir;
  process.env.SOURCE_RAG_EMBEDDINGS = "disabled";
  try {
    const index = new SourceIndex(dataDir);
    await index.indexSources("fixture-v1", path.resolve("test/fixtures"), { sourceType: "custom" });
    await index.indexSources("fixture-v2", path.resolve("test/fixtures-v2"), { sourceType: "custom" });
    const comparison = await index.compareMethodSource("fixture-v1", "fixture-v2", "demo.DurableItem", "damageAndBreak");
    assert.equal(comparison.changed, true);
    assert.match(comparison.diff, /Math\.max/);

    const { createServer } = await import("../dist/server.js");
    const server = createServer();
    const client = new Client({ name: "source-rag-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = await client.listTools();
    assert.ok(tools.tools.some(tool => tool.name === "search_code" && tool.outputSchema));
    const result = await client.callTool({
      name: "get_source_range",
      arguments: { version: "fixture-v1", fileOrClass: "demo.DurableItem", startLine: 4, endLine: 9, contextLines: 0 }
    });
    assert.equal(result.structuredContent.result.startLine, 4);
    assert.match(result.structuredContent.result.text, /damageAndBreak/);
    await client.close();
    await server.close();
  } finally {
    if (previousData === undefined) delete process.env.SOURCE_RAG_DATA;
    else process.env.SOURCE_RAG_DATA = previousData;
    if (previousEmbeddings === undefined) delete process.env.SOURCE_RAG_EMBEDDINGS;
    else process.env.SOURCE_RAG_EMBEDDINGS = previousEmbeddings;
    await rm(dataDir, { recursive: true, force: true });
  }
});
