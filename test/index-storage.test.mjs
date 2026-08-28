import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { IndexDatabase } from "../dist/source/IndexDatabase.js";
import { SourceCatalog } from "../dist/source/SourceCatalog.js";

test("v3 storage keeps labels out of paths and activates an immutable generation", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "source-rag-v3-"));
  const catalog = new SourceCatalog(dataDir);
  try {
    const build = await catalog.createBuild();
    assert.equal(build.stagingDir.includes(".."), false);

    const lock = await catalog.acquireBuildLock("fixture");
    await assert.rejects(() => catalog.acquireBuildLock("fixture"), /already running/);
    await lock.release();
    const nextLock = await catalog.acquireBuildLock("fixture");
    await nextLock.release();

    const database = new IndexDatabase(build.databasePath, "create");
    database.transaction(() => {
      const fileId = database.insertFile({
        path: "demo/Example.java",
        packageName: "demo",
        primaryTypeName: "Example",
        fullName: "demo.Example",
        contentHash: "abc",
        lineCount: 5,
        parseErrorCount: 0
      });
      database.insertDeclaration(fileId, {
        kind: "method",
        name: "runExample",
        owner: "demo.Example",
        signature: "void runExample()",
        startLine: 2,
        endLine: 4,
        parameterTypes: []
      });
      database.insertChunk({
        fileId,
        kind: "method",
        owner: "demo.Example",
        name: "runExample",
        signature: "void runExample()",
        startLine: 2,
        endLine: 4,
        searchText: "void runExample() { return; }"
      });
    });
    assert.deepEqual(database.summary(), { fileCount: 1, symbolCount: 1, chunkCount: 1, parseErrorCount: 0 });
    database.integrityCheck();
    database.optimize();
    database.close();
    await mkdir(build.sourceDir, { recursive: true });

    const previous = await catalog.activateBuild(build, {
      label: "..",
      sourceType: "custom",
      indexedAt: "2026-08-27T00:00:00.000Z",
      fileCount: 1,
      symbolCount: 1,
      chunkCount: 1,
      parseErrorCount: 0
    });
    assert.equal(previous, undefined);

    const active = catalog.getIndex("..");
    assert.equal(active?.label, "..");
    assert.equal(path.dirname(active.databasePath), catalog.generationDir(active.generationId));
    assert.equal(active.databasePath.startsWith(path.join(dataDir, "indexes")), true);
    assert.equal(catalog.listIndexes().length, 1);

    const abandoned = path.join(dataDir, "staging", "00000000-0000-4000-8000-000000000000");
    await mkdir(abandoned, { recursive: true });
    const old = new Date(Date.now() - 48 * 60 * 60 * 1_000);
    await utimes(abandoned, old, old);
    await catalog.runMaintenance();
    await assert.rejects(() => access(abandoned));
  } finally {
    catalog.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
