import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
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

export type LegacyIndex = {
  label: string;
  indexFormatVersion: number;
  sourceDir: string;
  indexedAt?: string;
  rebuildRequired: true;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ABANDONED_AGE_MS = 24 * 60 * 60 * 1_000;

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

  public get rootDir(): string {
    return this.dataDir;
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

  public async acquireBuildLock(label: string): Promise<{ release: () => Promise<void> }> {
    const lockDir = path.join(this.dataDir, "locks");
    const lockName = `${createHash("sha256").update(label).digest("hex")}.lock`;
    const lockPath = path.join(lockDir, lockName);
    await mkdir(lockDir, { recursive: true });

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(lockPath, "wx");
        await handle.writeFile(JSON.stringify({ label, pid: process.pid, createdAt: new Date().toISOString() }), "utf8");
        let released = false;
        return {
          release: async () => {
            if (released) return;
            released = true;
            await handle.close();
            await rm(lockPath, { force: true });
          }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const lockStat = await stat(lockPath).catch(() => undefined);
        if (attempt === 0 && lockStat && Date.now() - lockStat.mtimeMs >= ABANDONED_AGE_MS) {
          await rm(lockPath, { force: true });
          continue;
        }
        throw new Error(`Index build is already running for label: ${label}`);
      }
    }
    throw new Error(`Unable to acquire index build lock: ${label}`);
  }

  public async runMaintenance(): Promise<void> {
    const activeGenerations = new Set(this.listIndexes().map(index => index.generationId));
    await this.removeAbandonedDirectories(path.join(this.dataDir, "staging"));
    await this.removeAbandonedDirectories(path.join(this.dataDir, "work"));
    await this.removeAbandonedDirectories(path.join(this.dataDir, "indexes"), activeGenerations);
  }

  public async listLegacyIndexes(): Promise<LegacyIndex[]> {
    const entries = await readdir(this.dataDir, { withFileTypes: true });
    const legacy: LegacyIndex[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const meta = JSON.parse(await readFile(path.join(this.dataDir, entry.name, "meta.json"), "utf8")) as Record<string, unknown>;
        const format = Number(meta.indexFormatVersion ?? 1);
        if (format >= INDEX_FORMAT_VERSION || typeof meta.version !== "string" || typeof meta.sourceDir !== "string") continue;
        legacy.push({
          label: meta.version,
          indexFormatVersion: format,
          sourceDir: meta.sourceDir,
          ...(typeof meta.indexedAt === "string" ? { indexedAt: meta.indexedAt } : {}),
          rebuildRequired: true
        });
      } catch {
        continue;
      }
    }
    return legacy.sort((left, right) => left.label.localeCompare(right.label));
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
    if (!UUID_PATTERN.test(generationId)) throw new Error(`Invalid generation id: ${generationId}`);
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

  private async removeAbandonedDirectories(parent: string, excluded = new Set<string>()): Promise<void> {
    const entries = await readdir(parent, { withFileTypes: true }).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name) || excluded.has(entry.name)) continue;
      const target = path.resolve(parent, entry.name);
      const expectedParent = `${path.resolve(parent)}${path.sep}`;
      if (!target.startsWith(expectedParent)) continue;
      const targetStat = await stat(target);
      if (Date.now() - targetStat.mtimeMs < ABANDONED_AGE_MS) continue;
      await rm(target, { recursive: true, force: true });
    }
  }
}

function optionalString(value: string | number | null): string | undefined {
  return value === null ? undefined : String(value);
}
