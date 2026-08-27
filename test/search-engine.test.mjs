import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { IndexBuilder } from "../dist/source/IndexBuilder.js";
import { SearchEngine } from "../dist/source/SearchEngine.js";
import { SourceCatalog } from "../dist/source/SourceCatalog.js";

test("SearchEngine queries v3 symbols, lexical chunks, methods, and references", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "source-rag-search-"));
  const sourceDir = path.join(root, "sources");
  await cp(path.resolve("test/fixtures"), sourceDir, { recursive: true });
  const catalog = new SourceCatalog(path.join(root, "data"));
  try {
    await new IndexBuilder(catalog).indexSources("fixture", sourceDir, { sourceType: "custom" });
    const search = new SearchEngine(catalog);

    const fields = await search.searchSymbol("fixture", "false", 10, { kinds: ["field"] });
    assert.deepEqual(fields, []);

    const methods = await search.searchSymbol("fixture", "damageAndBreak", 10, { kinds: ["method"] });
    assert.equal(methods[0].owner, "demo.DurableItem");

    const lexical = await search.searchCode("fixture", "where item durability decreases until it breaks", 5, "auto");
    assert.equal(lexical[0].name, "damageAndBreak");

    const method = await search.getMethodSource("fixture", "demo.DurableItem", "damageAndBreak", { parameterTypes: ["int"] });
    assert.match(method.preview, /this\.durability -= amount/);

    const references = await search.findReferences("fixture", "breakItem", 10, { excludeDeclaration: true });
    assert.equal(references.length, 1);
    assert.match(references[0].preview, /this\.breakItem/);
  } finally {
    catalog.close();
    await rm(root, { recursive: true, force: true });
  }
});
