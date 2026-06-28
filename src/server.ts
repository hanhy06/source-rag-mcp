import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { Decompiler } from "./source/Decompiler.js";
import { SourceIndex } from "./source/SourceIndex.js";
import { VersionDownloader } from "./source/VersionDownloader.js";

const optionalVersionSchema = z.string().optional().describe("Minecraft version. Omit to search every indexed version.");
const limitSchema = z.number().int().min(1).max(100).default(20);

export function createServer(): McpServer {
  const index = new SourceIndex();
  const decompiler = new Decompiler();
  const downloader = new VersionDownloader();
  const server = new McpServer({
    name: "source-rag-mcp",
    version: "0.1.0"
  });

  server.registerTool("list_versions", {
    description: "List indexed Minecraft source versions.",
    inputSchema: {}
  }, async () => {
    const versions = await index.listVersions();
    return text(JSON.stringify(versions, null, 2));
  });

  server.registerTool("index_sources", {
    description: "Index a local decompiled Minecraft Java source tree.",
    inputSchema: {
      version: z.string().describe("Version label, for example 26.1."),
      sourceDir: z.string().describe("Folder containing decompiled .java sources.")
    }
  }, async ({ version, sourceDir }) => {
    const meta = await index.indexSources(version, sourceDir);
    return text(JSON.stringify(meta, null, 2));
  });

  server.registerTool("decompile_classes", {
    description: "Decompile a jar, class file, or class directory with Vineflower. Optionally index the output.",
    inputSchema: {
      input: z.string().describe("Jar, .class file, or directory containing .class files."),
      outputDir: z.string().describe("Directory where decompiled .java files should be written."),
      version: z.string().optional().describe("Version label to index after decompilation."),
      indexAfter: z.boolean().default(false)
    }
  }, async ({ input, outputDir, version, indexAfter }) => {
    const result = await decompiler.decompile(input, outputDir);
    if (!indexAfter) return text(JSON.stringify(result, null, 2));
    if (!version) throw new Error("version is required when indexAfter is true.");

    const meta = await index.indexSources(version, outputDir);
    return text(JSON.stringify({ decompile: result, index: meta }, null, 2));
  });

  server.registerTool("add_minecraft_version", {
    description: "Download a Minecraft jar from Mojang metadata, decompile it, and index the sources.",
    inputSchema: {
      version: z.string().describe("Exact version id, latest_release, latest_snapshot, or latest."),
      side: z.enum(["client", "server"]).default("client"),
      indexAs: z.string().optional().describe("Optional index label. Defaults to the resolved version id.")
    }
  }, async ({ version, side, indexAs }) => {
    const download = await downloader.downloadVersion(version, side);
    const label = indexAs ?? download.resolvedVersion;
    const sourceDir = index.sourceDir(label);
    const decompile = await decompiler.decompile(download.jarPath, sourceDir);
    const meta = await index.indexSources(label, sourceDir);

    return text(JSON.stringify({ download, decompile, index: meta }, null, 2));
  });

  server.registerTool("search_symbol", {
    description: "Search classes, methods, and fields by name or signature.",
    inputSchema: {
      version: optionalVersionSchema,
      query: z.string(),
      limit: limitSchema
    }
  }, async ({ version, query, limit }) => {
    const hits = await index.searchSymbol(version, query, limit);
    return text(JSON.stringify(hits, null, 2));
  });

  server.registerTool("search_text", {
    description: "Search raw source lines.",
    inputSchema: {
      version: optionalVersionSchema,
      query: z.string(),
      limit: limitSchema
    }
  }, async ({ version, query, limit }) => {
    const hits = await index.searchText(version, query, limit);
    return text(JSON.stringify(hits, null, 2));
  });

  server.registerTool("rag_search", {
    description: "Search source chunks with lightweight lexical RAG scoring.",
    inputSchema: {
      version: optionalVersionSchema,
      query: z.string(),
      limit: limitSchema
    }
  }, async ({ version, query, limit }) => {
    const hits = await index.ragSearch(version, query, limit);
    return text(JSON.stringify(hits, null, 2));
  });

  server.registerTool("get_source", {
    description: "Read a full source file by relative path, class name, or fully qualified class name.",
    inputSchema: {
      version: z.string(),
      fileOrClass: z.string()
    }
  }, async ({ version, fileOrClass }) => {
    const source = await index.getSource(version, fileOrClass);
    return text(source.text);
  });

  server.registerTool("get_method_source", {
    description: "Read a method body from a class. Supports inner class owners and overloaded methods.",
    inputSchema: {
      version: z.string(),
      owner: z.string().describe("Relative path, simple class name, or fully qualified class name."),
      method: z.string(),
      signature: z.string().optional().describe("Optional substring that must appear in the method signature."),
      parameterTypes: z.array(z.string()).optional().describe("Optional ordered parameter type filter for overloaded methods."),
      parameterCount: z.number().int().min(0).optional().describe("Optional parameter count filter for overloaded methods."),
      overloadIndex: z.number().int().min(0).optional().describe("Zero-based match index after other overload filters.")
    }
  }, async ({ version, owner, method, signature, parameterTypes, parameterCount, overloadIndex }) => {
    const hit = await index.getMethodSource(version, owner, method, {
      signature,
      parameterTypes,
      parameterCount,
      overloadIndex
    });
    return text(hit.preview);
  });

  server.registerTool("find_references", {
    description: "Find exact word references to a symbol.",
    inputSchema: {
      version: optionalVersionSchema,
      symbol: z.string(),
      limit: limitSchema
    }
  }, async ({ version, symbol, limit }) => {
    const hits = await index.findReferences(version, symbol, limit);
    return text(JSON.stringify(hits, null, 2));
  });

  return server;
}

function text(value: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: value
      }
    ]
  };
}
