import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import { CodeEmbedding } from "./CodeEmbedding.js";
import { IndexDatabase, type IndexFileInput } from "./IndexDatabase.js";
import { JavaAnalyzer, type JavaAnalysis } from "./JavaAnalyzer.js";
import { SourceCatalog, type CatalogIndex, type CatalogIndexInput } from "./SourceCatalog.js";
import { VectorWriter } from "./VectorStore.js";

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
  private readonly embedding: CodeEmbedding;

  public constructor(catalog: SourceCatalog, analyzer = new JavaAnalyzer(), embedding = new CodeEmbedding(catalog.rootDir)) {
    this.catalog = catalog;
    this.analyzer = analyzer;
    this.embedding = embedding;
  }

  public async indexSources(label: string, sourceDir: string, metadata: BuildIndexMetadata): Promise<CatalogIndex> {
    if (!label.trim()) throw new Error("Index label must not be empty.");
    await this.catalog.runMaintenance();
    const lock = await this.catalog.acquireBuildLock(label);
    try {
      return await this.buildIndex(label, sourceDir, metadata);
    } finally {
      await lock.release();
    }
  }

  private async buildIndex(label: string, sourceDir: string, metadata: BuildIndexMetadata): Promise<CatalogIndex> {
    const absoluteSourceDir = path.resolve(sourceDir);
    const sourceStat = await stat(absoluteSourceDir);
    if (!sourceStat.isDirectory()) throw new Error(`sourceDir is not a directory: ${absoluteSourceDir}`);

    const javaFiles = await this.collectJavaFiles(absoluteSourceDir);
    if (javaFiles.length === 0) throw new Error(`No Java sources found under: ${absoluteSourceDir}`);

    const build = await this.catalog.createBuild();
    let database: IndexDatabase | undefined;
    let vectorWriter: VectorWriter | undefined;
    try {
      database = new IndexDatabase(build.databasePath, "create");
      if (this.embedding.enabled) vectorWriter = await VectorWriter.create(build.vectorPath);
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

        if (pending.length >= DATABASE_BATCH_SIZE || index === javaFiles.length - 1) await this.flush(database, pending, vectorWriter);
        if ((index + 1) % 500 === 0 || index === javaFiles.length - 1) {
          process.stderr.write(`[source-rag] indexed ${index + 1}/${javaFiles.length} Java files\n`);
        }
      }

      const summary = database.summary();
      const vectorInfo = vectorWriter ? await vectorWriter.finalize() : undefined;
      vectorWriter = undefined;
      database.setMetadata("formatVersion", 3);
      database.setMetadata("label", label);
      database.setMetadata("source", metadata);
      database.setMetadata("summary", summary);
      if (vectorInfo) database.setMetadata("embedding", { model: this.embedding.modelName, ...vectorInfo });
      database.integrityCheck();
      database.optimize();
      database.close();
      database = undefined;

      await this.catalog.activateBuild(build, {
        label,
        ...metadata,
        indexedAt: new Date().toISOString(),
        ...summary,
        embeddingModel: vectorInfo ? this.embedding.modelName : undefined,
        embeddingDimensions: vectorInfo?.dimensions
      });
      const active = this.catalog.getIndex(label);
      if (!active) throw new Error(`Activated index is missing from catalog: ${label}`);
      return active;
    } catch (error) {
      database?.close();
      await vectorWriter?.abort();
      await rm(build.stagingDir, { recursive: true, force: true });
      throw error;
    }
  }

  private async flush(database: IndexDatabase, pending: PendingFile[], vectorWriter: VectorWriter | undefined): Promise<void> {
    const embeddedChunks: Array<{ chunkId: number; title: string; text: string }> = [];
    database.transaction(() => {
      for (const entry of pending) {
        const fileId = database.insertFile(entry.file);
        for (const declaration of entry.analysis.declarations) database.insertDeclaration(fileId, declaration);
        for (const chunk of entry.analysis.chunks) {
          const searchText = `${chunk.owner ?? ""}\n${chunk.signature ?? ""}\n${chunk.text}`;
          const chunkId = database.insertChunk({
            fileId,
            kind: chunk.kind,
            owner: chunk.owner,
            name: chunk.name,
            signature: chunk.signature,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            searchText
          });
          if (vectorWriter) embeddedChunks.push({ chunkId, title: entry.file.path, text: searchText });
        }
      }
    });
    pending.length = 0;
    if (!vectorWriter || embeddedChunks.length === 0) return;

    const vectors = await this.embedding.embedDocuments(embeddedChunks);
    if (vectors.length !== embeddedChunks.length) throw new Error(`Embedding count mismatch. Expected ${embeddedChunks.length}, received ${vectors.length}.`);
    const vectorRows = await vectorWriter.append(vectors);
    database.transaction(() => {
      for (let index = 0; index < embeddedChunks.length; index++) database.setVectorRow(embeddedChunks[index].chunkId, vectorRows[index]);
    });
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
