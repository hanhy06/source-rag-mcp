# source-rag-mcp

Minecraft decompiled source MCP server for local source search, symbol lookup, reference lookup, and local embedding RAG.

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

## Embeddings

Indexes include local sparse embeddings for each source chunk. No external embedding API, model download, or network call is used for embeddings.

`rag_search` combines:

* lexical token matching
* cosine similarity over local source-code embeddings

Existing indexes created before this feature should be rebuilt with `index_sources`, `add_minecraft_version`, or `add_mod_jar` to populate embeddings.

## Tools

* `list_versions`: list indexed source versions
* `add_minecraft_version`: download a Minecraft jar from Mojang metadata, decompile it, and index it
* `add_mod_jar`: decompile and index a local mod jar without downloading anything
* `index_sources`: index a local decompiled Java source tree
* `decompile_classes`: decompile class or jar input with Vineflower and optionally index it
* `search_symbol`: search classes, methods, and fields
* `search_text`: search raw source lines
* `rag_search`: search source chunks with local sparse embeddings and lexical scoring
* `get_source`: read a source file by path or class name
* `get_method_source`: read a method body from a class, including inner class owners and overloaded methods
* `find_references`: find exact word references

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
```

## Indexed Sources

Indexed source trees are stored under:

```text
<SOURCE_RAG_DATA>/sources/<version>
```

For example:

```text
C:\dev\minecraft\source-rag-mcp\.source-rag\sources\26.2
```
