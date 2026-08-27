import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { Decompiler } from "./source/Decompiler.js";
import { IndexBuilder } from "./source/IndexBuilder.js";
import { ModJarIndexer } from "./source/ModJarIndexer.js";
import { SearchEngine } from "./source/SearchEngine.js";
import { SourceCatalog } from "./source/SourceCatalog.js";
import { VersionDownloader } from "./source/VersionDownloader.js";

const optionalVersionSchema = z.string().optional().describe("Index label. It may be omitted only when exactly one matching index exists.");
const limitSchema = z.number().int().min(1).max(100).default(20);
const resultSchema = { result: z.unknown() };
const sourceTypeSchema = z.enum(["minecraft", "mod", "custom"]);
const symbolKindSchema = z.enum(["class", "interface", "enum", "record", "annotation", "method", "constructor", "field", "enum_constant"]);
const searchModeSchema = z.enum(["auto", "symbol", "text", "hybrid"]);
const searchFilterSchema = {
  sourceTypes: z.array(sourceTypeSchema).optional().describe("Limit results to Minecraft, mod, or custom source indexes."),
  pathPrefix: z.string().optional().describe("Only return source paths under this normalized prefix."),
  owner: z.string().optional().describe("Only return this class owner and its nested owners."),
  contextLines: z.number().int().min(0).max(20).default(2).describe("Surrounding lines for text and reference previews.")
};

export function createServer(): McpServer {
  const dataDir = path.resolve(process.env.SOURCE_RAG_DATA ?? ".source-rag");
  const catalog = new SourceCatalog(dataDir);
  const indexBuilder = new IndexBuilder(catalog);
  const search = new SearchEngine(catalog);
  const decompiler = new Decompiler(dataDir);
  const downloader = new VersionDownloader(dataDir);
  const modJarIndexer = new ModJarIndexer(indexBuilder, dataDir);
  const server = new McpServer({
    name: "source-rag-mcp",
    version: "0.3.0"
  });
  server.server.onclose = () => {
    void search.close();
    catalog.close();
  };

  server.registerTool("list_versions", {
    description: "List indexed Minecraft, mod, and custom source indexes with source metadata.",
    inputSchema: {},
    outputSchema: resultSchema
  }, async () => {
    const indexes = catalog.listIndexes();
    const activeLabels = new Set(indexes.map(index => index.label));
    const legacy = (await catalog.listLegacyIndexes()).filter(index => !activeLabels.has(index.label));
    return structured([...indexes, ...legacy]);
  });

  server.registerTool("index_sources", {
    description: "Index a local decompiled Minecraft Java source tree.",
    inputSchema: {
      version: z.string().describe("Version label, for example 26.1."),
      sourceDir: z.string().describe("Folder containing decompiled .java sources."),
      sourceType: sourceTypeSchema.default("custom"),
      minecraftVersion: z.string().optional(),
      modId: z.string().optional(),
      modVersion: z.string().optional(),
      mappingNamespace: z.string().optional()
    },
    outputSchema: resultSchema
  }, async ({ version, sourceDir, sourceType, minecraftVersion, modId, modVersion, mappingNamespace }) => {
    const meta = await indexBuilder.indexSources(version, sourceDir, {
      sourceType, minecraftVersion, modId, modVersion, mappingNamespace
    });
    return structured(meta);
  });

  server.registerTool("decompile_classes", {
    description: "Decompile a jar, class file, or class directory with Vineflower. Optionally index the output.",
    inputSchema: {
      input: z.string().describe("Jar, .class file, or directory containing .class files."),
      outputDir: z.string().describe("Directory where decompiled .java files should be written."),
      version: z.string().optional().describe("Version label to index after decompilation."),
      indexAfter: z.boolean().default(false)
    },
    outputSchema: resultSchema
  }, async ({ input, outputDir, version, indexAfter }) => {
    const result = await decompiler.decompile(input, outputDir);
    if (!indexAfter) return structured(result);
    if (!version) throw new Error("version is required when indexAfter is true.");

    const meta = await indexBuilder.indexSources(version, outputDir, { sourceType: "custom" });
    return structured({ decompile: result, index: meta });
  });

  server.registerTool("add_minecraft_version", {
    description: "Download a Minecraft jar from Mojang metadata, decompile it, and index the sources.",
    inputSchema: {
      version: z.string().describe("Exact version id, latest_release, latest_snapshot, or latest."),
      side: z.enum(["client", "server"]).default("client"),
      indexAs: z.string().optional().describe("Optional index label. Defaults to the resolved version id.")
    },
    outputSchema: resultSchema
  }, async ({ version, side, indexAs }) => {
    const download = await downloader.downloadVersion(version, side);
    const label = indexAs ?? download.resolvedVersion;
    const preparedSourceDir = path.join(dataDir, "work", randomUUID());
    try {
      const decompile = await decompiler.decompile(download.jarPath, preparedSourceDir);
      const meta = await indexBuilder.indexSources(label, preparedSourceDir, {
        sourceType: "minecraft",
        minecraftVersion: download.resolvedVersion,
        side
      });
      return structured({ download, decompile, index: meta });
    } finally {
      await rm(preparedSourceDir, { recursive: true, force: true });
    }
  });

  server.registerTool("add_mod_jar", {
    description: "Decompile and index a local mod jar. This tool does not download mod jars.",
    inputSchema: {
      jarPath: z.string().describe("Local path to a mod jar."),
      modId: z.string().optional().describe("Optional mod id for the index label."),
      version: z.string().optional().describe("Optional mod version for the index label."),
      indexAs: z.string().optional().describe("Optional full index label. Defaults to mod:<jar-name> or mod:<modId>:<version>.")
    },
    outputSchema: resultSchema
  }, async ({ jarPath, modId, version, indexAs }) => {
    const result = await modJarIndexer.addModJar({
      jarPath,
      modId,
      version,
      indexAs
    });

    return structured(result);
  });

  server.registerTool("search_symbol", {
    description: "Search classes, methods, and fields by name or signature.",
    inputSchema: {
      version: optionalVersionSchema,
      query: z.string(),
      limit: limitSchema,
      kinds: z.array(symbolKindSchema).optional(),
      ...searchFilterSchema
    },
    outputSchema: resultSchema
  }, async ({ version, query, limit, kinds, sourceTypes, pathPrefix, owner }) => {
    const hits = await search.searchSymbol(version, query, limit, { kinds, sourceTypes, pathPrefix, owner });
    return structured(hits);
  });

  server.registerTool("search_text", {
    description: "Search raw source lines.",
    inputSchema: {
      version: optionalVersionSchema,
      query: z.string(),
      limit: limitSchema,
      ...searchFilterSchema
    },
    outputSchema: resultSchema
  }, async ({ version, query, limit, sourceTypes, pathPrefix, owner, contextLines }) => {
    const hits = await search.searchText(version, query, limit, { sourceTypes, pathPrefix, owner, contextLines });
    return structured(hits);
  });

  server.registerTool("rag_search", {
    description: "Search class and method chunks with the active hybrid index.",
    inputSchema: {
      version: optionalVersionSchema,
      query: z.string(),
      limit: limitSchema,
      ...searchFilterSchema
    },
    outputSchema: resultSchema
  }, async ({ version, query, limit, sourceTypes, pathPrefix, owner, contextLines }) => {
    const hits = await search.ragSearch(version, query, limit, { sourceTypes, pathPrefix, owner, contextLines });
    return structured(hits);
  });

  server.registerTool("search_code", {
    description: "Primary code search tool. Auto mode fuses symbol, exact text, BM25, and code-embedding results.",
    inputSchema: {
      version: optionalVersionSchema,
      query: z.string().describe("A symbol, code fragment, or natural-language question."),
      mode: searchModeSchema.default("auto"),
      limit: limitSchema,
      kinds: z.array(symbolKindSchema).optional(),
      ...searchFilterSchema
    },
    outputSchema: resultSchema
  }, async ({ version, query, mode, limit, kinds, sourceTypes, pathPrefix, owner, contextLines }) => {
    return structured(await search.searchCode(version, query, limit, mode, {
      kinds, sourceTypes, pathPrefix, owner, contextLines
    }));
  });

  server.registerTool("get_source", {
    description: "Read a full source file by relative path, class name, or fully qualified class name.",
    inputSchema: {
      version: z.string(),
      fileOrClass: z.string()
    },
    outputSchema: resultSchema
  }, async ({ version, fileOrClass }) => {
    const source = await search.getSource(version, fileOrClass);
    return structured({
      version: source.version,
      path: source.path,
      owner: source.fullName,
      startLine: 1,
      endLine: source.text.split(/\r?\n/).length,
      text: source.text
    });
  });

  server.registerTool("get_source_range", {
    description: "Read an inclusive line range from a source file with optional surrounding context.",
    inputSchema: {
      version: z.string(),
      fileOrClass: z.string(),
      startLine: z.number().int().min(1),
      endLine: z.number().int().min(1),
      contextLines: z.number().int().min(0).max(50).default(3)
    },
    outputSchema: resultSchema
  }, async ({ version, fileOrClass, startLine, endLine, contextLines }) => {
    return structured(await search.getSourceRange(version, fileOrClass, startLine, endLine, contextLines));
  });

  server.registerTool("list_parse_errors", {
    description: "List indexed source files containing Java parse errors. Returns counts, not exact error locations.",
    inputSchema: {
      version: z.string(),
      limit: limitSchema,
      pathPrefix: z.string().optional().describe("Only return source paths under this normalized prefix.")
    },
    outputSchema: resultSchema
  }, async ({ version, limit, pathPrefix }) => {
    return structured(search.listParseErrors(version, limit, pathPrefix));
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
    },
    outputSchema: resultSchema
  }, async ({ version, owner, method, signature, parameterTypes, parameterCount, overloadIndex }) => {
    const hit = await search.getMethodSource(version, owner, method, {
      signature,
      parameterTypes,
      parameterCount,
      overloadIndex
    });
    return structured(hit);
  });

  server.registerTool("compare_method_source", {
    description: "Compare the same method across two indexed versions and return both bodies plus a unified diff.",
    inputSchema: {
      fromVersion: z.string(),
      toVersion: z.string(),
      owner: z.string(),
      method: z.string(),
      signature: z.string().optional(),
      parameterTypes: z.array(z.string()).optional(),
      parameterCount: z.number().int().min(0).optional(),
      overloadIndex: z.number().int().min(0).optional()
    },
    outputSchema: resultSchema
  }, async ({ fromVersion, toVersion, owner, method, signature, parameterTypes, parameterCount, overloadIndex }) => {
    return structured(await search.compareMethodSource(fromVersion, toVersion, owner, method, {
      signature, parameterTypes, parameterCount, overloadIndex
    }));
  });

  server.registerTool("find_references", {
    description: "Find exact word references to a symbol.",
    inputSchema: {
      version: optionalVersionSchema,
      symbol: z.string(),
      limit: limitSchema,
      excludeDeclaration: z.boolean().default(true),
      ...searchFilterSchema
    },
    outputSchema: resultSchema
  }, async ({ version, symbol, limit, excludeDeclaration, sourceTypes, pathPrefix, owner, contextLines }) => {
    const hits = await search.findReferences(version, symbol, limit, {
      excludeDeclaration, sourceTypes, pathPrefix, owner, contextLines
    });
    return structured(hits);
  });

  return server;
}

function structured(value: unknown) {
  const payload = { result: value };
  return {
    content: [],
    structuredContent: payload
  };
}
