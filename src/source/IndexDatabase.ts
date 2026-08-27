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

export type StoredFile = {
  id: number;
  path: string;
  packageName: string | null;
  primaryTypeName: string | null;
  fullName: string | null;
  lineCount: number;
};

export type StoredSymbol = {
  id: number;
  fileId: number;
  path: string;
  kind: JavaDeclaration["kind"];
  name: string;
  owner: string | null;
  signature: string;
  startLine: number;
  endLine: number;
  parameterTypes?: string[];
};

export type StoredChunk = {
  id: number;
  fileId: number;
  path: string;
  kind: IndexChunkInput["kind"];
  owner: string | null;
  name: string | null;
  signature: string | null;
  startLine: number;
  endLine: number;
  rank: number;
  vectorRow: number | null;
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

  public findFile(fileOrClass: string): StoredFile | undefined {
    const normalizedPath = fileOrClass.replaceAll("\\", "/");
    const normalizedOwner = fileOrClass.replaceAll("$", ".");
    const row = this.database.prepare(`
      SELECT id, path, package_name, primary_type_name, full_name, line_count
      FROM files
      WHERE path = ? OR full_name = ? OR primary_type_name = ? OR ? LIKE full_name || '.%'
      ORDER BY CASE WHEN path = ? THEN 0 WHEN full_name = ? THEN 1 WHEN primary_type_name = ? THEN 2 ELSE 3 END
      LIMIT 1
    `).get(normalizedPath, normalizedOwner, fileOrClass, normalizedOwner, normalizedPath, normalizedOwner, fileOrClass) as Record<string, string | number | null> | undefined;
    return row ? this.storedFile(row) : undefined;
  }

  public fileCandidates(): string[] {
    const rows = this.database.prepare("SELECT path, full_name, primary_type_name FROM files ORDER BY path").all() as Array<Record<string, string | null>>;
    return rows.flatMap(row => [row.full_name, row.primary_type_name, row.path]).filter((value): value is string => value !== null);
  }

  public searchSymbols(
    query: string,
    limit: number,
    filter: { kinds?: JavaDeclaration["kind"][]; pathPrefix?: string; owner?: string } = {}
  ): StoredSymbol[] {
    const normalized = query.toLowerCase();
    const contains = `%${escapeLike(normalized)}%`;
    const prefix = `${escapeLike(normalized)}%`;
    const conditions = ["(s.normalized_name LIKE ? ESCAPE '\\' OR lower(COALESCE(s.owner, '')) LIKE ? ESCAPE '\\' OR lower(s.signature) LIKE ? ESCAPE '\\')"];
    const parameters: Array<string | number> = [contains, contains, contains];
    if (filter.kinds && filter.kinds.length > 0) {
      conditions.push(`s.kind IN (${filter.kinds.map(() => "?").join(", ")})`);
      parameters.push(...filter.kinds);
    }
    if (filter.pathPrefix) {
      conditions.push("f.path LIKE ? ESCAPE '\\'");
      parameters.push(`${escapeLike(filter.pathPrefix.replaceAll("\\", "/"))}%`);
    }
    if (filter.owner) {
      conditions.push("(replace(s.owner, '$', '.') = ? OR replace(s.owner, '$', '.') LIKE ?)");
      const owner = filter.owner.replaceAll("$", ".");
      parameters.push(owner, `${escapeLike(owner)}.%`);
    }

    parameters.push(query, normalized, prefix, limit);
    const rows = this.database.prepare(`
      SELECT s.*, f.path
      FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY
        CASE WHEN s.name = ? THEN 0 WHEN s.normalized_name = ? THEN 1 WHEN s.normalized_name LIKE ? ESCAPE '\\' THEN 2 ELSE 3 END,
        CASE s.kind WHEN 'class' THEN 0 WHEN 'interface' THEN 1 WHEN 'record' THEN 2 WHEN 'enum' THEN 3 WHEN 'method' THEN 4 ELSE 5 END,
        length(s.name), f.path, s.start_line
      LIMIT ?
    `).all(...parameters) as Array<Record<string, string | number | null>>;
    return rows.map(row => this.storedSymbol(row));
  }

  public findMethods(owner: string, name: string): StoredSymbol[] {
    const normalizedOwner = owner.replaceAll("$", ".");
    const rows = this.database.prepare(`
      SELECT s.*, f.path
      FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE s.kind IN ('method', 'constructor') AND s.name = ? AND replace(s.owner, '$', '.') = ?
      ORDER BY s.start_line
    `).all(name, normalizedOwner) as Array<Record<string, string | number | null>>;
    return rows.map(row => this.storedSymbol(row));
  }

  public searchChunks(
    ftsQuery: string,
    limit: number,
    filter: { pathPrefix?: string; owner?: string } = {}
  ): StoredChunk[] {
    const conditions = ["chunk_fts MATCH ?"];
    const parameters: Array<string | number> = [ftsQuery];
    if (filter.pathPrefix) {
      conditions.push("f.path LIKE ? ESCAPE '\\'");
      parameters.push(`${escapeLike(filter.pathPrefix.replaceAll("\\", "/"))}%`);
    }
    if (filter.owner) {
      const owner = filter.owner.replaceAll("$", ".");
      conditions.push("(replace(c.owner, '$', '.') = ? OR replace(c.owner, '$', '.') LIKE ?)");
      parameters.push(owner, `${escapeLike(owner)}.%`);
    }
    parameters.push(limit);

    const rows = this.database.prepare(`
      SELECT c.*, f.path, bm25(chunk_fts, 4.0, 6.0, 3.0, 1.0) AS lexical_rank
      FROM chunk_fts
      JOIN chunks c ON c.id = chunk_fts.rowid
      JOIN files f ON f.id = c.file_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY lexical_rank, c.id
      LIMIT ?
    `).all(...parameters) as Array<Record<string, string | number | null>>;
    return rows.map(row => ({
      id: Number(row.id),
      fileId: Number(row.file_id),
      path: String(row.path),
      kind: String(row.kind) as StoredChunk["kind"],
      owner: optionalString(row.owner),
      name: optionalString(row.name),
      signature: optionalString(row.signature),
      startLine: Number(row.start_line),
      endLine: Number(row.end_line),
      rank: Number(row.lexical_rank),
      vectorRow: row.vector_row === null ? null : Number(row.vector_row)
    }));
  }

  public declarationLines(fileId: number, name: string): Set<number> {
    const rows = this.database.prepare("SELECT start_line FROM symbols WHERE file_id = ? AND name = ?").all(fileId, name) as Array<Record<string, number>>;
    return new Set(rows.map(row => Number(row.start_line)));
  }

  public chunksByVectorRows(vectorRows: number[]): Map<number, StoredChunk> {
    if (vectorRows.length === 0) return new Map();
    const rows = this.database.prepare(`
      SELECT c.*, f.path, 0.0 AS lexical_rank
      FROM chunks c JOIN files f ON f.id = c.file_id
      WHERE c.vector_row IN (${vectorRows.map(() => "?").join(", ")})
    `).all(...vectorRows) as Array<Record<string, string | number | null>>;
    return new Map(rows.map(row => {
      const chunk: StoredChunk = {
        id: Number(row.id),
        fileId: Number(row.file_id),
        path: String(row.path),
        kind: String(row.kind) as StoredChunk["kind"],
        owner: optionalString(row.owner),
        name: optionalString(row.name),
        signature: optionalString(row.signature),
        startLine: Number(row.start_line),
        endLine: Number(row.end_line),
        rank: 0,
        vectorRow: Number(row.vector_row)
      };
      return [chunk.vectorRow as number, chunk];
    }));
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

  private storedFile(row: Record<string, string | number | null>): StoredFile {
    return {
      id: Number(row.id),
      path: String(row.path),
      packageName: optionalString(row.package_name),
      primaryTypeName: optionalString(row.primary_type_name),
      fullName: optionalString(row.full_name),
      lineCount: Number(row.line_count)
    };
  }

  private storedSymbol(row: Record<string, string | number | null>): StoredSymbol {
    const rawParameterTypes = optionalString(row.parameter_types);
    return {
      id: Number(row.id),
      fileId: Number(row.file_id),
      path: String(row.path),
      kind: String(row.kind) as JavaDeclaration["kind"],
      name: String(row.name),
      owner: optionalString(row.owner),
      signature: String(row.signature),
      startLine: Number(row.start_line),
      endLine: Number(row.end_line),
      parameterTypes: rawParameterTypes ? JSON.parse(rawParameterTypes) as string[] : undefined
    };
  }
}

function tokenizeIdentifiers(text: string): string {
  return text.replace(/[_$]/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase();
}

function optionalString(value: string | number | null): string | null {
  return value === null ? null : String(value);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, character => `\\${character}`);
}
