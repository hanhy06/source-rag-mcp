# source-rag-mcp

Minecraft decompiled source MCP server for local source search, symbol lookup, reference lookup, and local embedding RAG.

Node.js 24 or newer is required.

## Copyright Boundary

This project does **not** ship Minecraft source code, bytecode, assets, jars, mod jars, or decompiled output.

The package contains only the MCP server code. When you use `add_minecraft_version`, `add_mod_jar`, or `decompile_classes`, Minecraft and mod files are downloaded, copied, or generated only on your local machine under `SOURCE_RAG_DATA` or `./.source-rag`.

Do not commit, publish, or redistribute:

* `.source-rag/`
* `sources/`
* Minecraft `.jar` files
* mod `.jar` files
* Minecraft `.class` files
* mod `.class` files
* decompiled Minecraft or mod `.java` output

This project is licensed under Apache-2.0. Minecraft is owned by Mojang/Microsoft and is not included in this project.

## Setup

```powershell
pnpm install
pnpm build
```

## Run

Run the server from the project root:

```powershell
pnpm build
node ./dist/index.js
```

The server writes index data to `./.source-rag` by default.
You can override this location with the `SOURCE_RAG_DATA` environment variable.

### Windows accelerated embeddings

The bundled Node runtime supports DirectML without an additional Python environment. This is the recommended Windows setup:

```powershell
$env:SOURCE_RAG_EMBEDDING_DEVICE = "dml"
$env:SOURCE_RAG_EMBEDDING_MAX_TOKENS = "1024"
$env:SOURCE_RAG_EMBEDDING_BATCH_SIZE = "10"
```

The 1024-token limit prevents unusually large decompiler methods from exhausting GPU memory. The default batch size is 10 and can be lowered if GPU memory is limited. DirectML sessions use sequential execution and two ONNX CPU threads.

## First Index

For a normal Minecraft version, use `add_minecraft_version`.
The MCP server will download the Minecraft jar from Mojang metadata, decompile it, and index it.

```json
{
  "version": "latest_release",
  "side": "client"
}
```

Exact version IDs work too:

```json
{
  "version": "26.2",
  "side": "client"
}
```

If you already have decompiled `.java` files, use `index_sources` with a version name and source directory:

```json
{
  "version": "26.1",
  "sourceDir": "./sources/26.1"
}
```

If you have a jar, `.class` file, or class directory, use `decompile_classes` first:

```json
{
  "input": "./sources/26.2",
  "outputDir": "./.source-rag/sources/26.2",
  "version": "26.2",
  "indexAfter": true
}
```

`decompile_classes` downloads Vineflower into `./.source-rag/tools` on first use.

## Mod Jars

`add_mod_jar` only accepts a local jar path. It does not download mod jars from URLs.

```json
{
  "jarPath": "C:\\dev\\minecraft\\afterglow\\run\\mods\\sodium-fabric-0.9.0+mc26.2.jar",
  "modId": "sodium",
  "version": "0.9.0+mc26.2"
}
```

The resulting index label defaults to:

```text
mod:<jar-name>
```

or, when `modId` and `version` are provided:

```text
mod:<modId>:<version>
```

You can also provide `indexAs` directly.

## Hybrid Code Search

`search_code` is the primary search tool. Its default `auto` mode combines:

* exact symbol lookup
* raw text matches
* SQLite FTS5 BM25 over identifier-aware tokens
* cosine similarity over local `jinaai/jina-embeddings-v2-base-code` vectors

Tree-sitter extracts classes, methods, constructors, and fields without treating local variables as fields. Source is chunked at declaration and statement boundaries. Long methods are split between top-level statements with a small overlap. Dense vectors are normalized, quantized to int8, and stored as contiguous rows in a binary vector file.

Each index generation uses a managed source snapshot, a SQLite symbol/FTS database, and an optional vector file. Display labels never become filesystem paths directly. A completed generation replaces the active catalog entry atomically, so a failed rebuild leaves the previous generation available.

The embedding model is downloaded from Hugging Face on the first new index and cached under `<SOURCE_RAG_DATA>/models`. The default model file is about 642 MB. Inference is local and does not use an external embedding API.

Set `SOURCE_RAG_EMBEDDINGS=disabled` to build and search an FTS-only index. Override the model with `SOURCE_RAG_EMBEDDING_MODEL`; indexes searched together must use the same model. `SOURCE_RAG_EMBEDDING_DEVICE` selects the Transformers.js execution device and defaults to `auto`. On Windows, use `dml` for DirectML acceleration.

`SOURCE_RAG_EMBEDDING_MAX_TOKENS` defaults to 1024 so unusually large decompiler methods cannot exhaust GPU memory. Long methods are already split into overlapping source chunks before this final tokenizer limit is applied.

The v3 catalog does not load the previous JSON index format. Rebuild indexes with `index_sources`, `add_minecraft_version`, or `add_mod_jar`. Existing v2 data is not deleted automatically.

## Tools

* `list_versions`: list Minecraft, mod, and custom indexes with source metadata
* `add_minecraft_version`: download a Minecraft jar from Mojang metadata, decompile it, and index it
* `add_mod_jar`: decompile and index a local mod jar without downloading anything
* `index_sources`: index a local decompiled Java source tree
* `decompile_classes`: decompile class or jar input with Vineflower and optionally index it
* `search_symbol`: search classes, methods, and fields
* `search_text`: search raw source lines
* `rag_search`: search semantic chunks with BM25 and local code embeddings
* `search_code`: automatically fuse symbol, text, BM25, and code-embedding results
* `get_source`: read a source file by path or class name
* `get_source_range`: read an inclusive line range with optional context
* `get_method_source`: read a method body from a class, including inner class owners and overloaded methods
* `compare_method_source`: compare a method across two indexes and return a unified diff
* `find_references`: find exact word references with source, path, owner, and declaration filters

All tools return MCP `structuredContent` with a stable `{ "result": ... }` envelope as well as a JSON text representation.

`get_method_source` accepts these optional overload filters:

```json
{
  "version": "26.2",
  "owner": "net.minecraft.world.item.ItemStack",
  "method": "ItemStack",
  "parameterTypes": ["Holder<Item>", "int"]
}
```

Inner classes can be addressed with either `.` or `$`:

```json
{
  "version": "26.2",
  "owner": "com.mojang.blaze3d.vertex.TlsfAllocator.Block",
  "method": "isFree"
}
```

## Codex MCP Config

Add this to your Codex `config.toml`. Prefer absolute paths because Codex may start the MCP server from a different working directory.

```toml
[mcp_servers.minecraft-source]
command = "node"
args = [
  "C:\\dev\\minecraft\\source-rag-mcp\\dist\\index.js"
]

[mcp_servers.minecraft-source.env]
SOURCE_RAG_DATA = "C:\\dev\\minecraft\\source-rag-mcp\\.source-rag"
SOURCE_RAG_EMBEDDING_DEVICE = "dml"
SOURCE_RAG_EMBEDDING_MAX_TOKENS = "1024"
SOURCE_RAG_EMBEDDING_BATCH_SIZE = "10"
```

If `node` is not on `PATH`, use an absolute Node executable path for `command` only:

```toml
[mcp_servers.minecraft-source]
command = "<path-to-node>"
args = [
  "C:\\dev\\minecraft\\source-rag-mcp\\dist\\index.js"
]

[mcp_servers.minecraft-source.env]
SOURCE_RAG_DATA = "C:\\dev\\minecraft\\source-rag-mcp\\.source-rag"
SOURCE_RAG_EMBEDDING_DEVICE = "dml"
SOURCE_RAG_EMBEDDING_MAX_TOKENS = "1024"
SOURCE_RAG_EMBEDDING_BATCH_SIZE = "10"
```

Example:

```toml
[mcp_servers.minecraft-source]
command = "C:/path/to/node.exe"
args = [
  "C:\\dev\\minecraft\\source-rag-mcp\\dist\\index.js"
]

[mcp_servers.minecraft-source.env]
SOURCE_RAG_DATA = "C:\\dev\\minecraft\\source-rag-mcp\\.source-rag"
SOURCE_RAG_EMBEDDING_DEVICE = "dml"
SOURCE_RAG_EMBEDDING_MAX_TOKENS = "1024"
SOURCE_RAG_EMBEDDING_BATCH_SIZE = "10"
```

## Indexed Sources

Every active catalog entry points to an immutable UUID generation stored under:

```text
<SOURCE_RAG_DATA>/indexes/<generation-uuid>/
  index.sqlite
  vectors.i8
  sources/
```

The human-readable index label is stored in `catalog.sqlite` and is not used as a directory name.
