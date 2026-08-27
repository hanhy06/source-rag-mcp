import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { SourceType } from "./types.js";

export const INDEX_FORMAT_VERSION = 3;

export type IndexBuildPaths = {
  generationId: string;
  stagingDir: string;
  sourceDir: string;
  databasePath: string;
  vectorPath: string;
};

export type CatalogIndexInput = {
  label: string;
  sourceType: SourceType;
  minecraftVersion?: string;
  side?: "client" | "server";
  modId?: string;
  modVersion?: string;
  mappingNamespace?: string;
  indexedAt: string;
  fileCount: number;
  symbolCount: number;
  chunkCount: number;
  parseErrorCount: number;
  embeddingModel?: string;
  embeddingDimensions?: number;
};

export type CatalogIndex = CatalogIndexInput & {
  generationId: string;
  indexFormatVersion: number;
  sourceDir: string;
  databasePath: string;
  vectorPath: string;
};

export class SourceCatalog {
  private readonly dataDir: string;
  private readonly database: DatabaseSync;

  public constructor(dataDir = process.env.SOURCE_RAG_DATA ?? path.resolve(".source-rag")) {
    this.dataDir = path.resolve(dataDir);
    mkdirSync(this.dataDir, { recursive: true });
    this.database = new DatabaseSync(path.join(this.dataDir, "catalog.sqlite"), {
      timeout: 5_000,
      allowBareNamedParameters: false,
      allowUnknownNamedParameters: false
    });
    this.createSchema();
  }

  public async createBuild(): Promise<IndexBuildPaths> {
    const generationId = randomUUID();
    const stagingDir = path.join(this.dataDir, "staging", generationId);
    const sourceDir = path.join(stagingDir, "sources");
    await mkdir(sourceDir, { recursive: true });
    return {
      generationId,
      stagingDir,
      sourceDir,
      databasePath: path.join(stagingDir, "index.sqlite"),
      vectorPath: path.join(stagingDir, "vectors.i8")
    };
  }

  public async activateBuild(build: IndexBuildPaths, input: CatalogIndexInput): Promise<CatalogIndex | undefined> {
    const previous = this.getIndex(input.label);
    const targetDir = this.generationDir(build.generationId);
    await mkdir(path.dirname(targetDir), { recursive: true });
    await rename(build.stagingDir, targetDir);

    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO indexes(
          label, generation_id, source_type, minecraft_version, side, mod_id, mod_version, mapping_namespace,
          indexed_at, file_count, symbol_count, chunk_count, parse_error_count, embedding_model, embedding_dimensions
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(label) DO UPDATE SET
          generation_id = excluded.generation_id,
          source_type = excluded.source_type,
          minecraft_version = excluded.minecraft_version,
          side = excluded.side,
          mod_id = excluded.mod_id,
          mod_version = excluded.mod_version,
          mapping_namespace = excluded.mapping_namespace,
          indexed_at = excluded.indexed_at,
          file_count = excluded.file_count,
          symbol_count = excluded.symbol_count,
          chunk_count = excluded.chunk_count,
          parse_error_count = excluded.parse_error_count,
          embedding_model = excluded.embedding_model,
          embedding_dimensions = excluded.embedding_dimensions
      `).run(
        input.label,
        build.generationId,
        input.sourceType,
        input.minecraftVersion ?? null,
        input.side ?? null,
        input.modId ?? null,
        input.modVersion ?? null,
        input.mappingNamespace ?? null,
        input.indexedAt,
        input.fileCount,
        input.symbolCount,
        input.chunkCount,
        input.parseErrorCount,
        input.embeddingModel ?? null,
        input.embeddingDimensions ?? null
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return previous;
  }

  public listIndexes(): CatalogIndex[] {
    const rows = this.database.prepare("SELECT * FROM indexes ORDER BY label").all() as Array<Record<string, string | number | null>>;
    return rows.map(row => this.catalogIndex(row));
  }

  public getIndex(label: string): CatalogIndex | undefined {
    const row = this.database.prepare("SELECT * FROM indexes WHERE label = ?").get(label) as Record<string, string | number | null> | undefined;
    return row ? this.catalogIndex(row) : undefined;
  }

  public generationDir(generationId: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(generationId)) throw new Error(`Invalid generation id: ${generationId}`);
    return path.join(this.dataDir, "indexes", generationId);
  }

  public close(): void {
    if (this.database.isOpen) this.database.close();
  }

  private catalogIndex(row: Record<string, string | number | null>): CatalogIndex {
    const generationId = String(row.generation_id);
    const generationDir = this.generationDir(generationId);
    return {
      label: String(row.label),
      generationId,
      indexFormatVersion: INDEX_FORMAT_VERSION,
      sourceType: String(row.source_type) as SourceType,
      minecraftVersion: optionalString(row.minecraft_version),
      side: optionalString(row.side) as "client" | "server" | undefined,
      modId: optionalString(row.mod_id),
      modVersion: optionalString(row.mod_version),
      mappingNamespace: optionalString(row.mapping_namespace),
      indexedAt: String(row.indexed_at),
      fileCount: Number(row.file_count),
      symbolCount: Number(row.symbol_count),
      chunkCount: Number(row.chunk_count),
      parseErrorCount: Number(row.parse_error_count),
      embeddingModel: optionalString(row.embedding_model),
      embeddingDimensions: row.embedding_dimensions === null ? undefined : Number(row.embedding_dimensions),
      sourceDir: path.join(generationDir, "sources"),
      databasePath: path.join(generationDir, "index.sqlite"),
      vectorPath: path.join(generationDir, "vectors.i8")
    };
  }

  private createSchema(): void {
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;

      CREATE TABLE IF NOT EXISTS indexes (
        label TEXT PRIMARY KEY,
        generation_id TEXT NOT NULL UNIQUE,
        source_type TEXT NOT NULL,
        minecraft_version TEXT,
        side TEXT,
        mod_id TEXT,
        mod_version TEXT,
        mapping_namespace TEXT,
        indexed_at TEXT NOT NULL,
        file_count INTEGER NOT NULL,
        symbol_count INTEGER NOT NULL,
        chunk_count INTEGER NOT NULL,
        parse_error_count INTEGER NOT NULL,
        embedding_model TEXT,
        embedding_dimensions INTEGER
      ) STRICT;
    `);
  }
}

function optionalString(value: string | number | null): string | undefined {
  return value === null ? undefined : String(value);
}
