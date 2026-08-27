import { DatabaseSync, type StatementSync } from "node:sqlite";

import type { JavaDeclaration } from "./JavaAnalyzer.js";

export type IndexFileInput = {
  path: string;
  packageName: string | null;
  primaryTypeName: string | null;
  fullName: string | null;
  contentHash: string;
  lineCount: number;
  parseErrorCount: number;
};

export type IndexChunkInput = {
  fileId: number;
  kind: "file" | "class" | "method" | "constructor" | "initializer";
  owner: string | null;
  name?: string;
  signature?: string;
  startLine: number;
  endLine: number;
  searchText: string;
};

export type IndexSummary = {
  fileCount: number;
  symbolCount: number;
  chunkCount: number;
  parseErrorCount: number;
};

export class IndexDatabase {
  private readonly database: DatabaseSync;
  private readonly insertFileStatement: StatementSync;
  private readonly insertSymbolStatement: StatementSync;
  private readonly insertChunkStatement: StatementSync;
  private readonly insertFtsStatement: StatementSync;
  private readonly updateVectorStatement: StatementSync;

  public constructor(databasePath: string, mode: "create" | "read" = "read") {
    this.database = new DatabaseSync(databasePath, {
      readOnly: mode === "read",
      timeout: 5_000,
      allowBareNamedParameters: false,
      allowUnknownNamedParameters: false
    });
    if (mode === "create") this.createSchema();

    this.insertFileStatement = this.database.prepare(`
      INSERT INTO files(path, package_name, primary_type_name, full_name, content_hash, line_count, parse_error_count)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.insertSymbolStatement = this.database.prepare(`
      INSERT INTO symbols(file_id, kind, name, normalized_name, owner, signature, start_line, end_line, parameter_count, parameter_types)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.insertChunkStatement = this.database.prepare(`
      INSERT INTO chunks(file_id, kind, owner, name, signature, start_line, end_line)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.insertFtsStatement = this.database.prepare(`
      INSERT INTO chunk_fts(rowid, owner_tokens, name_tokens, signature_tokens, body_tokens)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.updateVectorStatement = this.database.prepare("UPDATE chunks SET vector_row = ? WHERE id = ?");
  }

  public transaction<T>(action: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  public insertFile(file: IndexFileInput): number {
    const result = this.insertFileStatement.run(
      file.path,
      file.packageName,
      file.primaryTypeName,
      file.fullName,
      file.contentHash,
      file.lineCount,
      file.parseErrorCount
    );
    return Number(result.lastInsertRowid);
  }

  public insertDeclaration(fileId: number, declaration: JavaDeclaration): number {
    const parameterTypes = declaration.parameterTypes ? JSON.stringify(declaration.parameterTypes) : null;
    const result = this.insertSymbolStatement.run(
      fileId,
      declaration.kind,
      declaration.name,
      declaration.name.toLowerCase(),
      declaration.owner,
      declaration.signature,
      declaration.startLine,
      declaration.endLine,
      declaration.parameterTypes?.length ?? null,
      parameterTypes
    );
    return Number(result.lastInsertRowid);
  }

  public insertChunk(chunk: IndexChunkInput): number {
    const result = this.insertChunkStatement.run(
      chunk.fileId,
      chunk.kind,
      chunk.owner,
      chunk.name ?? null,
      chunk.signature ?? null,
      chunk.startLine,
      chunk.endLine
    );
    const chunkId = Number(result.lastInsertRowid);
    this.insertFtsStatement.run(
      chunkId,
      tokenizeIdentifiers(chunk.owner ?? ""),
      tokenizeIdentifiers(chunk.name ?? ""),
      tokenizeIdentifiers(chunk.signature ?? ""),
      tokenizeIdentifiers(chunk.searchText)
    );
    return chunkId;
  }

  public setVectorRow(chunkId: number, vectorRow: number): void {
    this.updateVectorStatement.run(vectorRow, chunkId);
  }

  public setMetadata(key: string, value: unknown): void {
    this.database.prepare(`
      INSERT INTO metadata(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, JSON.stringify(value));
  }

  public summary(): IndexSummary {
    const counts = this.database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM files) AS file_count,
        (SELECT COUNT(*) FROM symbols) AS symbol_count,
        (SELECT COUNT(*) FROM chunks) AS chunk_count,
        COALESCE((SELECT SUM(parse_error_count) FROM files), 0) AS parse_error_count
    `).get() as Record<string, number>;
    return {
      fileCount: Number(counts.file_count),
      symbolCount: Number(counts.symbol_count),
      chunkCount: Number(counts.chunk_count),
      parseErrorCount: Number(counts.parse_error_count)
    };
  }

  public integrityCheck(): void {
    const row = this.database.prepare("PRAGMA integrity_check").get() as Record<string, string>;
    if (Object.values(row)[0] !== "ok") throw new Error(`SQLite integrity check failed: ${Object.values(row)[0]}`);

    const missingFts = this.database.prepare(`
      SELECT COUNT(*) AS count FROM chunks LEFT JOIN chunk_fts ON chunk_fts.rowid = chunks.id WHERE chunk_fts.rowid IS NULL
    `).get() as Record<string, number>;
    if (Number(missingFts.count) !== 0) throw new Error(`${missingFts.count} chunks are missing from FTS.`);
  }

  public optimize(): void {
    this.database.exec("INSERT INTO chunk_fts(chunk_fts) VALUES ('optimize')");
    this.database.exec("PRAGMA optimize");
  }

  public close(): void {
    if (this.database.isOpen) this.database.close();
  }

  private createSchema(): void {
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA temp_store = MEMORY;

      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        package_name TEXT,
        primary_type_name TEXT,
        full_name TEXT,
        content_hash TEXT NOT NULL,
        line_count INTEGER NOT NULL,
        parse_error_count INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS symbols (
        id INTEGER PRIMARY KEY,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        owner TEXT,
        signature TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        parameter_count INTEGER,
        parameter_types TEXT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS symbols_name ON symbols(normalized_name, kind);
      CREATE INDEX IF NOT EXISTS symbols_owner ON symbols(owner, name);

      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        owner TEXT,
        name TEXT,
        signature TEXT,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        vector_row INTEGER
      ) STRICT;

      CREATE INDEX IF NOT EXISTS chunks_file_range ON chunks(file_id, start_line, end_line);
      CREATE INDEX IF NOT EXISTS chunks_vector_row ON chunks(vector_row) WHERE vector_row IS NOT NULL;

      CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
        owner_tokens,
        name_tokens,
        signature_tokens,
        body_tokens,
        content = '',
        columnsize = 1,
        tokenize = 'porter unicode61 remove_diacritics 0'
      );
    `);
  }
}

function tokenizeIdentifiers(text: string): string {
  return text.replace(/[_$]/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase();
}
