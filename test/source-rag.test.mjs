import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { quantizeVector, quantizedCosine } from "../dist/source/CodeEmbedding.js";
import { IndexBuilder } from "../dist/source/IndexBuilder.js";
import { SourceCatalog } from "../dist/source/SourceCatalog.js";

test("quantized vectors preserve cosine similarity", () => {
  const vector = quantizeVector([0.1, 0.2, 0.3]);
  assert.equal(quantizedCosine(vector, vector), 1);
});

test("v3 index and MCP expose structured range, search, and comparison results", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "source-rag-mcp-"));
  const previousData = process.env.SOURCE_RAG_DATA;
  const previousEmbeddings = process.env.SOURCE_RAG_EMBEDDINGS;
  process.env.SOURCE_RAG_DATA = dataDir;
  process.env.SOURCE_RAG_EMBEDDINGS = "disabled";
  try {
    const catalog = new SourceCatalog(dataDir);
    const builder = new IndexBuilder(catalog);
    await builder.indexSources("fixture-v1", path.resolve("test/fixtures"), { sourceType: "custom" });
    await builder.indexSources("fixture-v2", path.resolve("test/fixtures-v2"), { sourceType: "custom" });
    await builder.indexSources("fixture-errors", path.resolve("test/fixtures-errors"), { sourceType: "custom" });
    const { SearchEngine } = await import("../dist/source/SearchEngine.js");
    const comparison = await new SearchEngine(catalog).compareMethodSource("fixture-v1", "fixture-v2", "demo.DurableItem", "damageAndBreak");
    assert.equal(comparison.changed, true);
    assert.match(comparison.diff, /Math\.max/);
    catalog.close();

    const { createServer } = await import("../dist/server.js");
    const server = createServer();
    const client = new Client({ name: "source-rag-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = await client.listTools();
    assert.ok(tools.tools.some(tool => tool.name === "search_code" && tool.outputSchema));
    assert.ok(tools.tools.some(tool => tool.name === "list_parse_errors" && tool.outputSchema));
    const parseErrors = await client.callTool({
      name: "list_parse_errors",
      arguments: { version: "fixture-errors", limit: 10 }
    });
    assert.equal(parseErrors.structuredContent.result[0].path, "demo/Broken.java");
    assert.ok(parseErrors.structuredContent.result[0].parseErrorCount > 0);
    const filteredParseErrors = await client.callTool({
      name: "list_parse_errors",
      arguments: { version: "fixture-errors", limit: 10, pathPrefix: "other/" }
    });
    assert.deepEqual(filteredParseErrors.structuredContent.result, []);
    const result = await client.callTool({
      name: "get_source_range",
      arguments: { version: "fixture-v1", fileOrClass: "demo.DurableItem", startLine: 4, endLine: 9, contextLines: 0 }
    });
    assert.deepEqual(result.content, []);
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
