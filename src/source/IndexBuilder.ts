import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import { IndexDatabase, type IndexFileInput } from "./IndexDatabase.js";
import { JavaAnalyzer, type JavaAnalysis } from "./JavaAnalyzer.js";
import { SourceCatalog, type CatalogIndex, type CatalogIndexInput } from "./SourceCatalog.js";

export type BuildIndexMetadata = Pick<
  CatalogIndexInput,
  "sourceType" | "minecraftVersion" | "side" | "modId" | "modVersion" | "mappingNamespace"
>;

type PendingFile = {
  file: IndexFileInput;
  analysis: JavaAnalysis;
};

const DATABASE_BATCH_SIZE = 100;

export class IndexBuilder {
  private readonly catalog: SourceCatalog;
  private readonly analyzer: JavaAnalyzer;

  public constructor(catalog: SourceCatalog, analyzer = new JavaAnalyzer()) {
    this.catalog = catalog;
    this.analyzer = analyzer;
  }

  public async indexSources(label: string, sourceDir: string, metadata: BuildIndexMetadata): Promise<CatalogIndex> {
    if (!label.trim()) throw new Error("Index label must not be empty.");
    const absoluteSourceDir = path.resolve(sourceDir);
    const sourceStat = await stat(absoluteSourceDir);
    if (!sourceStat.isDirectory()) throw new Error(`sourceDir is not a directory: ${absoluteSourceDir}`);

    const javaFiles = await this.collectJavaFiles(absoluteSourceDir);
    if (javaFiles.length === 0) throw new Error(`No Java sources found under: ${absoluteSourceDir}`);

    const build = await this.catalog.createBuild();
    let database: IndexDatabase | undefined;
    try {
      database = new IndexDatabase(build.databasePath, "create");
      const pending: PendingFile[] = [];
      for (let index = 0; index < javaFiles.length; index++) {
        const absolutePath = javaFiles[index];
        const relativePath = path.relative(absoluteSourceDir, absolutePath).replaceAll("\\", "/");
        const snapshotPath = path.join(build.sourceDir, ...relativePath.split("/"));
        await mkdir(path.dirname(snapshotPath), { recursive: true });
        await copyFile(absolutePath, snapshotPath);

        const source = await readFile(snapshotPath, "utf8");
        const analysis = this.analyzer.analyze(source);
        pending.push({
          file: {
            path: relativePath,
            packageName: analysis.packageName,
            primaryTypeName: analysis.primaryTypeName,
            fullName: analysis.fullName,
            contentHash: createHash("sha256").update(source).digest("hex"),
            lineCount: source.split(/\r?\n/).length,
            parseErrorCount: analysis.parseErrorCount
          },
          analysis
        });

        if (pending.length >= DATABASE_BATCH_SIZE || index === javaFiles.length - 1) this.flush(database, pending);
        if ((index + 1) % 500 === 0 || index === javaFiles.length - 1) {
          process.stderr.write(`[source-rag] indexed ${index + 1}/${javaFiles.length} Java files\n`);
        }
      }

      const summary = database.summary();
      database.setMetadata("formatVersion", 3);
      database.setMetadata("label", label);
      database.setMetadata("source", metadata);
      database.setMetadata("summary", summary);
      database.integrityCheck();
      database.optimize();
      database.close();
      database = undefined;

      await this.catalog.activateBuild(build, {
        label,
        ...metadata,
        indexedAt: new Date().toISOString(),
        ...summary
      });
      const active = this.catalog.getIndex(label);
      if (!active) throw new Error(`Activated index is missing from catalog: ${label}`);
      return active;
    } catch (error) {
      database?.close();
      await rm(build.stagingDir, { recursive: true, force: true });
      throw error;
    }
  }

  private flush(database: IndexDatabase, pending: PendingFile[]): void {
    database.transaction(() => {
      for (const entry of pending) {
        const fileId = database.insertFile(entry.file);
        for (const declaration of entry.analysis.declarations) database.insertDeclaration(fileId, declaration);
        for (const chunk of entry.analysis.chunks) {
          database.insertChunk({
            fileId,
            kind: chunk.kind,
            owner: chunk.owner,
            name: chunk.name,
            signature: chunk.signature,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            searchText: `${chunk.owner ?? ""}\n${chunk.signature ?? ""}\n${chunk.text}`
          });
        }
      }
    });
    pending.length = 0;
  }

  private async collectJavaFiles(root: string): Promise<string[]> {
    const files: string[] = [];
    const entries = await readdir(root, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = path.join(root, entry.name);
      if (entry.isDirectory()) files.push(...await this.collectJavaFiles(absolutePath));
      else if (entry.isFile() && entry.name.endsWith(".java")) files.push(absolutePath);
    }
    return files;
  }
}
