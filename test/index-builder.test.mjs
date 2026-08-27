import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { IndexBuilder } from "../dist/source/IndexBuilder.js";
import { SourceCatalog } from "../dist/source/SourceCatalog.js";

test("IndexBuilder snapshots Java sources and stores AST declarations in batches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "source-rag-builder-"));
  const sourceDir = path.join(root, "input");
  const dataDir = path.join(root, "data");
  await mkdir(path.join(sourceDir, "demo"), { recursive: true });
  const sourcePath = path.join(sourceDir, "demo", "Example.java");
  const original = `package demo;
public class Example {
  private boolean enabled = false;
  void run() {
    int local = 1;
    if (local > 0) return;
  }
}`;
  await writeFile(sourcePath, original, "utf8");

  const catalog = new SourceCatalog(dataDir);
  try {
    const index = await new IndexBuilder(catalog, undefined, { enabled: false }).indexSources("fixture", sourceDir, { sourceType: "custom" });
    assert.equal(index.fileCount, 1);
    assert.equal(index.parseErrorCount, 0);
    assert.equal(await readFile(path.join(index.sourceDir, "demo", "Example.java"), "utf8"), original);

    await writeFile(sourcePath, "package demo; class Changed {}", "utf8");
    assert.equal(await readFile(path.join(index.sourceDir, "demo", "Example.java"), "utf8"), original);

    const database = new DatabaseSync(index.databasePath, { readOnly: true });
    const fields = database.prepare("SELECT name, owner FROM symbols WHERE kind = 'field'").all();
    assert.deepEqual(fields.map(row => [row.name, row.owner]), [["enabled", "demo.Example"]]);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM symbols WHERE name IN ('false', 'local')").get().count, 0);
    assert.ok(database.prepare("SELECT COUNT(*) AS count FROM chunks").get().count >= 3);
    database.close();
  } finally {
    catalog.close();
    await rm(root, { recursive: true, force: true });
  }
});
