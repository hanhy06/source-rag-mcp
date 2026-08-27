import { readFile } from "node:fs/promises";
import path from "node:path";

import { unifiedDiff } from "./Diff.js";
import { IndexDatabase, type StoredChunk, type StoredFile, type StoredSymbol } from "./IndexDatabase.js";
import { tokenizeForSearch } from "./SearchTokenizer.js";
import { SourceCatalog, type CatalogIndex } from "./SourceCatalog.js";
import type { MethodComparison, MethodLookup, SearchFilter, SearchHit, SearchMode, SourceFile, SourceRange, SourceSymbol, SourceType } from "./types.js";

export class SearchEngine {
  private readonly catalog: SourceCatalog;

  public constructor(catalog: SourceCatalog) {
    this.catalog = catalog;
  }

  public async searchSymbol(version: string | undefined, query: string, limit: number, filter: SearchFilter = {}): Promise<SourceSymbol[]> {
    const indexes = this.resolveIndexes(version, filter.sourceTypes);
    const hits: SourceSymbol[] = [];
    for (const index of indexes) {
      hits.push(...this.withDatabase(index, database => database.searchSymbols(query, limit, {
        kinds: filter.kinds,
        pathPrefix: filter.pathPrefix,
        owner: filter.owner
      }).map(symbol => this.sourceSymbol(index, symbol))));
    }
    return hits.slice(0, limit);
  }

  public async searchText(version: string | undefined, query: string, limit: number, filter: SearchFilter = {}): Promise<SearchHit[]> {
    const candidates = this.lexicalCandidates(version, query, Math.max(limit * 4, 40), filter);
    const queryTerms = [...new Set(tokenizeForSearch(query))];
    const ranked = await Promise.all(candidates.map(async candidate => {
      const source = await this.readSource(candidate.index, this.requireFile(candidate.index, candidate.chunk.path));
      const lines = source.text.split(/\r?\n/);
      const chunkText = lines.slice(candidate.chunk.startLine - 1, candidate.chunk.endLine).join("\n");
      const searchable = `${candidate.chunk.owner ?? ""} ${candidate.chunk.name ?? ""} ${candidate.chunk.signature ?? ""}\n${chunkText}`.toLowerCase();
      const coverage = queryTerms.filter(term => searchable.includes(term)).length;
      return { ...candidate, source, coverage };
    }));
    ranked.sort((left, right) => right.coverage - left.coverage || left.chunk.rank - right.chunk.rank);
    const hits: SearchHit[] = [];
    for (let rank = 0; rank < ranked.length && hits.length < limit; rank++) {
      const { index, chunk, source } = ranked[rank];
      hits.push(this.chunkHit(index, chunk, query, filter.contextLines ?? 0, 1 / (rank + 1), source));
    }
    return hits;
  }

  public async ragSearch(version: string | undefined, query: string, limit: number, filter: SearchFilter = {}): Promise<SearchHit[]> {
    return await this.searchText(version, query, limit, filter);
  }

  public async searchCode(
    version: string | undefined,
    query: string,
    limit: number,
    mode: SearchMode = "auto",
    filter: SearchFilter = {}
  ): Promise<SearchHit[]> {
    if (mode === "symbol") return this.symbolHits(await this.searchSymbol(version, query, limit, filter));
    if (mode === "text" || mode === "hybrid") return await this.searchText(version, query, limit, filter);

    const candidateLimit = Math.min(100, Math.max(limit * 3, 20));
    const [symbols, lexical] = await Promise.all([
      this.searchSymbol(version, query, candidateLimit, filter).then(hits => this.symbolHits(hits)),
      this.searchText(version, query, candidateLimit, filter)
    ]);
    return this.reciprocalRankFusion([symbols, lexical], [1.2, 1], limit);
  }

  public async getSource(version: string, fileOrClass: string): Promise<SourceFile> {
    const index = this.requireIndex(version);
    const file = this.withDatabase(index, database => database.findFile(fileOrClass));
    if (!file) {
      const candidates = this.withDatabase(index, database => database.fileCandidates());
      throw new Error(this.notFoundMessage(`Source not found: ${fileOrClass}`, fileOrClass, candidates));
    }
    return await this.readSource(index, file);
  }

  public async getSourceRange(version: string, fileOrClass: string, startLine: number, endLine: number, contextLines = 0): Promise<SourceRange> {
    const file = await this.getSource(version, fileOrClass);
    const lines = file.text.split(/\r?\n/);
    const requestedStart = Math.max(1, startLine);
    const requestedEnd = Math.max(requestedStart, endLine);
    const actualStart = Math.max(1, requestedStart - contextLines);
    const actualEnd = Math.min(lines.length, requestedEnd + contextLines);
    return {
      version,
      path: file.path,
      owner: file.fullName,
      startLine: actualStart,
      endLine: actualEnd,
      text: lines.slice(actualStart - 1, actualEnd).join("\n")
    };
  }

  public async getMethodSource(version: string, owner: string, method: string, lookup: MethodLookup = {}): Promise<SearchHit> {
    const index = this.requireIndex(version);
    const methods = this.withDatabase(index, database => database.findMethods(owner, method))
      .filter(symbol => this.matchesMethodLookup(symbol, lookup));
    const hit = methods[lookup.overloadIndex ?? 0];
    if (!hit) {
      const candidates = this.withDatabase(index, database => database.searchSymbols(method, 20, { kinds: ["method", "constructor"] }).map(symbol => symbol.name));
      throw new Error(this.notFoundMessage(`Method not found: ${owner}#${method}`, method, candidates));
    }

    const source = await this.readSource(index, this.requireFile(index, hit.path));
    return {
      version,
      path: hit.path,
      line: hit.startLine,
      endLine: hit.endLine,
      owner: hit.owner,
      kind: hit.kind,
      name: hit.name,
      signature: hit.signature,
      preview: source.text.split(/\r?\n/).slice(hit.startLine - 1, hit.endLine).join("\n")
    };
  }

  public async compareMethodSource(fromVersion: string, toVersion: string, owner: string, method: string, lookup: MethodLookup = {}): Promise<MethodComparison> {
    const [from, to] = await Promise.all([
      this.getMethodSource(fromVersion, owner, method, lookup),
      this.getMethodSource(toVersion, owner, method, lookup)
    ]);
    return {
      owner,
      method,
      from,
      to,
      changed: from.preview !== to.preview,
      diff: unifiedDiff(`${fromVersion}:${from.path}`, `${toVersion}:${to.path}`, from.preview, to.preview)
    };
  }

  public async findReferences(version: string | undefined, symbol: string, limit: number, filter: SearchFilter = {}): Promise<SearchHit[]> {
    const indexes = this.resolveIndexes(version, filter.sourceTypes);
    const pattern = new RegExp(`\\b${this.escapeRegex(symbol)}\\b`);
    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    for (const index of indexes) {
      const chunks = this.withDatabase(index, database => database.searchChunks(this.ftsQuery(symbol), Math.max(limit * 20, 200), filter));
      const declarationCache = new Map<number, Set<number>>();
      for (const chunk of chunks) {
        const source = await this.readSource(index, this.requireFile(index, chunk.path));
        const lines = source.text.split(/\r?\n/);
        for (let line = chunk.startLine; line <= chunk.endLine; line++) {
          if (!pattern.test(lines[line - 1] ?? "")) continue;
          const key = `${index.label}:${chunk.path}:${line}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (filter.excludeDeclaration) {
            let declarationLines = declarationCache.get(chunk.fileId);
            if (!declarationLines) {
              declarationLines = this.withDatabase(index, database => database.declarationLines(chunk.fileId, symbol));
              declarationCache.set(chunk.fileId, declarationLines);
            }
            if (declarationLines.has(line)) continue;
          }
          hits.push({
            version: index.label,
            path: chunk.path,
            line,
            owner: chunk.owner,
            ...this.contextPreview(lines, line - 1, filter.contextLines ?? 0)
          });
          if (hits.length >= limit) return hits;
        }
      }
    }
    return hits;
  }

  private lexicalCandidates(version: string | undefined, query: string, limit: number, filter: SearchFilter): Array<{ index: CatalogIndex; chunk: StoredChunk }> {
    const ftsQuery = this.ftsQuery(query);
    const candidates: Array<{ index: CatalogIndex; chunk: StoredChunk }> = [];
    for (const index of this.resolveIndexes(version, filter.sourceTypes)) {
      candidates.push(...this.withDatabase(index, database => database.searchChunks(ftsQuery, limit, filter)).map(chunk => ({ index, chunk })));
    }
    return candidates.sort((left, right) => left.chunk.rank - right.chunk.rank).slice(0, limit);
  }

  private chunkHit(index: CatalogIndex, chunk: StoredChunk, query: string, contextLines: number, score: number, source: SourceFile): SearchHit {
    const lines = source.text.split(/\r?\n/);
    const terms = tokenizeForSearch(query);
    let lineIndex = Math.max(0, chunk.startLine - 1);
    let bestScore = -1;
    for (let candidate = chunk.startLine - 1; candidate < Math.min(lines.length, chunk.endLine); candidate++) {
      const lower = lines[candidate].toLowerCase();
      const candidateScore = (lower.includes(query.toLowerCase()) ? 100 : 0) + terms.filter(term => lower.includes(term)).length;
      if (candidateScore > bestScore) {
        bestScore = candidateScore;
        lineIndex = candidate;
      }
    }
    return {
      version: index.label,
      path: chunk.path,
      line: lineIndex + 1,
      endLine: chunk.endLine,
      owner: chunk.owner,
      kind: chunk.kind,
      name: chunk.name ?? undefined,
      signature: chunk.signature ?? undefined,
      score,
      ...this.contextPreview(lines, lineIndex, contextLines)
    };
  }

  private resolveIndexes(version: string | undefined, sourceTypes?: SourceType[]): CatalogIndex[] {
    const indexes = version ? [this.requireIndex(version)] : this.catalog.listIndexes();
    const filtered = sourceTypes && sourceTypes.length > 0 ? indexes.filter(index => sourceTypes.includes(index.sourceType)) : indexes;
    if (version || filtered.length <= 1) return filtered;
    throw new Error(`version is required when multiple indexes are available. Available indexes: ${filtered.map(index => index.label).join(", ")}`);
  }

  private requireIndex(version: string): CatalogIndex {
    const index = this.catalog.getIndex(version);
    if (index) return index;
    throw new Error(this.notFoundMessage(`Index not found: ${version}`, version, this.catalog.listIndexes().map(candidate => candidate.label)));
  }

  private requireFile(index: CatalogIndex, fileOrClass: string): StoredFile {
    const file = this.withDatabase(index, database => database.findFile(fileOrClass));
    if (!file) throw new Error(`Indexed file is missing: ${index.label}:${fileOrClass}`);
    return file;
  }

  private async readSource(index: CatalogIndex, file: StoredFile): Promise<SourceFile> {
    const absolutePath = path.resolve(index.sourceDir, ...file.path.split("/"));
    const sourceRoot = `${path.resolve(index.sourceDir)}${path.sep}`;
    if (!absolutePath.startsWith(sourceRoot)) throw new Error(`Indexed source path escapes its snapshot: ${file.path}`);
    return {
      version: index.label,
      path: file.path,
      absolutePath,
      packageName: file.packageName,
      className: file.primaryTypeName,
      fullName: file.fullName,
      text: await readFile(absolutePath, "utf8")
    };
  }

  private sourceSymbol(index: CatalogIndex, symbol: StoredSymbol): SourceSymbol {
    return {
      version: index.label,
      kind: symbol.kind,
      name: symbol.name,
      owner: symbol.owner,
      path: symbol.path,
      line: symbol.startLine,
      signature: symbol.signature
    };
  }

  private symbolHits(symbols: SourceSymbol[]): SearchHit[] {
    return symbols.map(symbol => ({
      version: symbol.version,
      path: symbol.path,
      line: symbol.line,
      endLine: symbol.line,
      owner: symbol.owner,
      kind: symbol.kind,
      name: symbol.name,
      signature: symbol.signature,
      preview: symbol.signature
    }));
  }

  private reciprocalRankFusion(resultSets: SearchHit[][], weights: number[], limit: number): SearchHit[] {
    const fused = new Map<string, { hit: SearchHit; score: number }>();
    for (let resultIndex = 0; resultIndex < resultSets.length; resultIndex++) {
      for (let rank = 0; rank < resultSets[resultIndex].length; rank++) {
        const hit = resultSets[resultIndex][rank];
        const key = `${hit.version}:${hit.path}:${hit.line ?? 0}:${hit.kind ?? ""}:${hit.name ?? ""}`;
        const entry = fused.get(key) ?? { hit, score: 0 };
        entry.score += (weights[resultIndex] ?? 1) / (60 + rank + 1);
        if ((hit.preview?.length ?? 0) > (entry.hit.preview?.length ?? 0)) entry.hit = hit;
        fused.set(key, entry);
      }
    }
    return [...fused.values()].sort((left, right) => right.score - left.score).slice(0, limit)
      .map(entry => ({ ...entry.hit, score: Number((entry.score * 1000).toFixed(4)) }));
  }

  private matchesMethodLookup(symbol: StoredSymbol, lookup: MethodLookup): boolean {
    if (lookup.signature && !symbol.signature.includes(lookup.signature)) return false;
    const parameters = symbol.parameterTypes ?? [];
    if (lookup.parameterCount !== undefined && parameters.length !== lookup.parameterCount) return false;
    if (!lookup.parameterTypes) return true;
    return parameters.length === lookup.parameterTypes.length && parameters.every((actual, index) => this.typeMatches(actual, lookup.parameterTypes?.[index] ?? ""));
  }

  private typeMatches(actual: string, expected: string): boolean {
    const left = actual.replace(/\s+/g, "").replaceAll("$", ".").toLowerCase();
    const right = expected.replace(/\s+/g, "").replaceAll("$", ".").toLowerCase();
    return left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`);
  }

  private ftsQuery(query: string): string {
    const tokens = [...new Set(tokenizeForSearch(query))].slice(0, 24);
    const fallback = query.match(/[\p{L}\p{N}_$]+/gu)?.map(token => token.toLowerCase()) ?? [];
    const selected = tokens.length > 0 ? tokens : fallback;
    if (selected.length === 0) throw new Error("Search query does not contain searchable terms.");
    return selected.map(token => `"${token.replaceAll('"', '""')}"`).join(" OR ");
  }

  private contextPreview(lines: string[], lineIndex: number, contextLines: number): { preview: string; previewStartLine: number; previewEndLine: number } {
    const start = Math.max(0, lineIndex - contextLines);
    const end = Math.min(lines.length - 1, lineIndex + contextLines);
    return { preview: lines.slice(start, end + 1).join("\n").trim(), previewStartLine: start + 1, previewEndLine: end + 1 };
  }

  private withDatabase<T>(index: CatalogIndex, action: (database: IndexDatabase) => T): T {
    const database = new IndexDatabase(index.databasePath, "read");
    try {
      return action(database);
    } finally {
      database.close();
    }
  }

  private notFoundMessage(message: string, query: string, candidates: string[]): string {
    const suggestions = candidates.map(candidate => ({ candidate, distance: editDistance(query.toLowerCase(), candidate.toLowerCase()) }))
      .sort((left, right) => left.distance - right.distance || left.candidate.localeCompare(right.candidate)).slice(0, 5).map(entry => entry.candidate);
    return suggestions.length > 0 ? `${message}. Did you mean: ${suggestions.join(", ")}` : message;
  }

  private escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = new Array<number>(right.length + 1);
  for (let i = 1; i <= left.length; i++) {
    current[0] = i;
    for (let j = 1; j <= right.length; j++) current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
    for (let j = 0; j <= right.length; j++) previous[j] = current[j];
  }
  return previous[right.length];
}
