import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildBm25Index, searchBm25 } from "./Bm25.js";
import { CodeEmbedding, quantizedCosine } from "./CodeEmbedding.js";
import { unifiedDiff } from "./Diff.js";
import { findJavaBlockEnd, scanJavaStructure } from "./JavaStructure.js";
import { tokenizeForSearch } from "./SearchTokenizer.js";
import type { MethodComparison, MethodLookup, SearchFilter, SearchHit, SearchMode, SourceChunk, SourceFile, SourceMetadata, SourceRange, SourceSymbol, SourceType, SourceVersion, VersionIndex } from "./types.js";

const DEFAULT_DATA_DIR = ".source-rag";
const JAVA_FILE = ".java";
const CLASS_PATTERN = /^\s*(?:(?:public|protected|private|abstract|final|static|sealed|non-sealed)\s+)*(?:class|interface|enum|record)\s+([A-Za-z_][A-Za-z0-9_]*)/;
const FIELD_PATTERN = /^\s*(?:public|protected|private|static|final|volatile|transient|\s)+[\w<>\[\].?,\s]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|;)/;

export class SourceIndex {
  private readonly dataDir: string;
  private readonly embedding: CodeEmbedding;
  private readonly indexCache = new Map<string, { mtimeMs: number; index: VersionIndex }>();

  public constructor(dataDir = process.env.SOURCE_RAG_DATA ?? path.resolve(DEFAULT_DATA_DIR)) {
    this.dataDir = path.resolve(dataDir);
    this.embedding = new CodeEmbedding(this.dataDir);
  }

  public sourceDir(version: string): string {
    return path.join(this.dataDir, "sources", encodeURIComponent(version));
  }

  public async listVersions(): Promise<SourceVersion[]> {
    await mkdir(this.dataDir, { recursive: true });

    const entries = await readdir(this.dataDir, { withFileTypes: true });
    const versions: SourceVersion[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const metaPath = path.join(this.dataDir, entry.name, "meta.json");
      try {
        const text = await readFile(metaPath, "utf8");
        versions.push(this.normalizeMeta(JSON.parse(text) as SourceVersion));
      } catch {
        continue;
      }
    }

    return versions.sort((a, b) => a.version.localeCompare(b.version));
  }

  public async indexSources(version: string, sourceDir: string, metadata: SourceMetadata = {}): Promise<SourceVersion> {
    const absoluteSourceDir = path.resolve(sourceDir);
    const sourceStat = await stat(absoluteSourceDir);
    if (!sourceStat.isDirectory()) throw new Error(`sourceDir is not a directory: ${absoluteSourceDir}`);

    const javaFiles = await this.collectJavaFiles(absoluteSourceDir);
    const files: SourceFile[] = [];
    const symbols: SourceSymbol[] = [];
    const chunks: SourceChunk[] = [];

    for (const absolutePath of javaFiles) {
      const text = await readFile(absolutePath, "utf8");
      const relativePath = path.relative(absoluteSourceDir, absolutePath).replaceAll("\\", "/");
      const sourceFile = this.parseSourceFile(version, absoluteSourceDir, relativePath, text);
      files.push(sourceFile);
      symbols.push(...this.parseSymbols(sourceFile));
      chunks.push(...this.parseChunks(sourceFile));
    }

    const denseEmbeddings = await this.embedding.embed(chunks.map(chunk => this.embeddingText(chunk)));
    for (let i = 0; i < denseEmbeddings.length; i++) chunks[i].embedding = denseEmbeddings[i];
    const bm25 = buildBm25Index(chunks);

    const meta: SourceVersion = {
      version,
      sourceDir: absoluteSourceDir,
      indexedAt: new Date().toISOString(),
      fileCount: files.length,
      symbolCount: symbols.length,
      indexFormatVersion: 2,
      ...this.inferMetadata(version),
      ...metadata
    };
    if (denseEmbeddings.length > 0) {
      meta.embeddingModel = this.embedding.modelName;
      meta.embeddingDimensions = Buffer.from(denseEmbeddings[0], "base64").length;
      meta.embeddingDevice = this.embedding.deviceName;
    }

    const index: VersionIndex = { meta, files, symbols, chunks, bm25 };
    await this.writeIndex(index);

    return meta;
  }

  public async searchSymbol(version: string | undefined, query: string, limit: number, filter: SearchFilter = {}): Promise<SourceSymbol[]> {
    const indexes = await this.loadIndexes(version, filter.sourceTypes);
    const normalized = query.toLowerCase();
    const hits: Array<SourceSymbol & { score: number }> = [];

    for (const index of indexes) {
      for (const symbol of index.symbols) {
        if (filter.kinds && !filter.kinds.includes(symbol.kind)) continue;
        if (!this.matchesLocationFilter(symbol.path, symbol.owner, filter)) continue;
        const haystack = `${symbol.name} ${symbol.owner ?? ""} ${symbol.signature}`.toLowerCase();
        if (!haystack.includes(normalized)) continue;

        const caseExact = symbol.name === query ? 100 : 0;
        const exact = symbol.name.toLowerCase() === normalized ? 50 : 0;
        const prefix = symbol.name.toLowerCase().startsWith(normalized) ? 20 : 0;
        const kind = symbol.kind === "class" ? 15 : symbol.kind === "method" ? 5 : 0;
        const topLevel = path.basename(symbol.path, JAVA_FILE).toLowerCase() === normalized ? 30 : 0;
        hits.push({ ...symbol, score: caseExact + exact + prefix + kind + topLevel + normalized.length });
      }
    }

    return hits.sort((a, b) => b.score - a.score).slice(0, limit).map(({ score: _score, ...symbol }) => symbol);
  }

  public async searchText(version: string | undefined, query: string, limit: number, filter: SearchFilter = {}): Promise<SearchHit[]> {
    const indexes = await this.loadIndexes(version, filter.sourceTypes);
    const terms = tokenizeForSearch(query);
    const hits: SearchHit[] = [];
    const retainedCandidates = Math.max(limit * 4, 40);

    for (const index of indexes) {
      for (const file of index.files) {
        if (!this.matchesLocationFilter(file.path, file.fullName, filter)) continue;
        const lines = file.text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const score = this.scoreText(line, terms, query);
          if (score <= 0) continue;

          hits.push({
            version: file.version,
            path: file.path,
            line: i + 1,
            owner: file.fullName,
            score,
            ...this.contextPreview(lines, i, filter.contextLines),
            preview: this.contextPreview(lines, i, filter.contextLines).preview
          });
          if (hits.length >= retainedCandidates * 2) {
            hits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
            hits.length = retainedCandidates;
          }
        }
      }
    }

    return hits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, limit);
  }

  public async ragSearch(version: string | undefined, query: string, limit: number, filter: SearchFilter = {}): Promise<SearchHit[]> {
    const indexes = await this.loadIndexes(version, filter.sourceTypes);
    const hasDenseIndex = indexes.some(index =>
      index.meta.embeddingModel === this.embedding.modelName && index.chunks.some(chunk => typeof chunk.embedding === "string")
    );
    const queryEmbedding = hasDenseIndex ? await this.embedding.embedQuery(query) : undefined;
    const ranked: Array<SearchHit & { bm25Score: number; denseScore: number }> = [];

    for (const index of indexes) {
      index.bm25 ??= buildBm25Index(index.chunks);
      const bm25Scores = searchBm25(index.bm25, query);
      let maximumBm25 = 0;
      for (const score of bm25Scores.values()) maximumBm25 = Math.max(maximumBm25, score);
      for (let chunkIndex = 0; chunkIndex < index.chunks.length; chunkIndex++) {
        const chunk = index.chunks[chunkIndex];
        if (!this.matchesLocationFilter(chunk.path, chunk.owner, filter)) continue;
        const rawBm25 = bm25Scores.get(chunkIndex) ?? 0;
        const bm25Score = maximumBm25 > 0 ? rawBm25 / maximumBm25 : 0;
        const denseScore = queryEmbedding && typeof chunk.embedding === "string"
          ? Math.max(0, quantizedCosine(queryEmbedding, chunk.embedding))
          : 0;
        if (bm25Score === 0 && denseScore < 0.1) continue;
        const exactBoost = this.embeddingText(chunk).toLowerCase().includes(query.toLowerCase()) ? 0.15 : 0;
        const score = bm25Score * 0.55 + denseScore * 0.45 + exactBoost;

        ranked.push({
          version: chunk.version,
          path: chunk.path,
          line: chunk.startLine,
          endLine: chunk.endLine,
          owner: chunk.owner,
          kind: chunk.kind,
          name: chunk.name,
          signature: chunk.signature,
          score: Number((score * 100).toFixed(4)),
          preview: this.preview(chunk.text),
          bm25Score,
          denseScore
        });
      }
    }

    return ranked
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, limit)
      .map(({ bm25Score: _bm25Score, denseScore: _denseScore, ...hit }) => hit);
  }

  public async getSource(version: string, fileOrClass: string): Promise<SourceFile> {
    const index = await this.loadIndex(version);
    return this.getSourceFromIndex(index, fileOrClass);
  }

  public async searchCode(
    version: string | undefined,
    query: string,
    limit: number,
    mode: SearchMode = "auto",
    filter: SearchFilter = {}
  ): Promise<SearchHit[]> {
    if (mode === "symbol") return this.symbolHits(await this.searchSymbol(version, query, limit, filter));
    if (mode === "text") return await this.searchText(version, query, limit, filter);
    if (mode === "hybrid") return await this.ragSearch(version, query, limit, filter);

    const candidateLimit = Math.min(100, Math.max(limit * 3, 20));
    const [symbols, textHits, hybridHits] = await Promise.all([
      this.searchSymbol(version, query, candidateLimit, filter).then(hits => this.symbolHits(hits)),
      this.searchText(version, query, candidateLimit, filter),
      this.ragSearch(version, query, candidateLimit, filter)
    ]);
    return this.reciprocalRankFusion([symbols, textHits, hybridHits], limit);
  }

  public async compareMethodSource(
    fromVersion: string,
    toVersion: string,
    owner: string,
    method: string,
    lookup: MethodLookup = {}
  ): Promise<MethodComparison> {
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

  public async getSourceRange(
    version: string,
    fileOrClass: string,
    startLine: number,
    endLine: number,
    contextLines = 0
  ): Promise<SourceRange> {
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
    const index = await this.loadIndex(version);
    const file = this.getSourceFromIndex(index, owner);
    const lines = file.text.split(/\r?\n/);
    const range = this.findOwnerRange(file, owner, lines);
    const blocks = scanJavaStructure(file.text, file.packageName);
    const matches: SearchHit[] = [];

    for (const block of blocks) {
      if (block.kind !== "method" || block.name !== method) continue;
      if (block.startLine - 1 < range.start || block.endLine - 1 > range.end) continue;
      const rawParameters = this.signatureParameters(block.signature);
      if (!this.matchesMethodLookup(block.signature, rawParameters, lookup)) continue;

      const i = block.startLine - 1;
      const end = block.endLine - 1;
      matches.push({
        version,
        path: file.path,
        line: i + 1,
        endLine: end + 1,
        owner: range.owner,
        kind: "method",
        name: method,
        signature: block.signature,
        preview: lines.slice(i, end + 1).join("\n")
      });
    }

    const overloadIndex = lookup.overloadIndex ?? 0;
    const hit = matches[overloadIndex];
    if (hit) return hit;

    const candidates = index.symbols
      .filter(symbol => symbol.kind === "method" && symbol.owner === file.fullName)
      .map(symbol => symbol.name)
      .filter((name, position, names) => names.indexOf(name) === position);
    throw new Error(this.notFoundMessage(`Method not found: ${owner}#${method}`, method, candidates));
  }

  public async findReferences(version: string | undefined, symbol: string, limit: number, filter: SearchFilter = {}): Promise<SearchHit[]> {
    const indexes = await this.loadIndexes(version, filter.sourceTypes);
    const pattern = new RegExp(`\\b${this.escapeRegex(symbol)}\\b`);
    const hits: SearchHit[] = [];

    for (const index of indexes) {
      for (const file of index.files) {
        if (!this.matchesLocationFilter(file.path, file.fullName, filter)) continue;
        const lines = file.text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!pattern.test(line)) continue;
          if (filter.excludeDeclaration && index.symbols.some(candidate =>
            candidate.path === file.path && candidate.line === i + 1 && candidate.name === symbol
          )) continue;

          hits.push({
            version: file.version,
            path: file.path,
            line: i + 1,
            owner: file.fullName,
            ...this.contextPreview(lines, i, filter.contextLines),
            preview: this.contextPreview(lines, i, filter.contextLines).preview
          });
          if (hits.length >= limit) return hits;
        }
      }
    }

    return hits.slice(0, limit);
  }

  private getSourceFromIndex(index: VersionIndex, fileOrClass: string): SourceFile {
    const normalized = fileOrClass.replaceAll("\\", "/");

    const file = index.files.find(candidate =>
      candidate.path === normalized ||
      candidate.fullName === fileOrClass ||
      candidate.className === fileOrClass ||
      this.ownerMatchesFile(candidate, fileOrClass)
    );

    if (!file) {
      const candidates = index.files.flatMap(candidate => [candidate.fullName, candidate.className, candidate.path])
        .filter((candidate): candidate is string => candidate !== null);
      throw new Error(this.notFoundMessage(`Source not found: ${fileOrClass}`, fileOrClass, candidates));
    }
    return file;
  }

  private async collectJavaFiles(root: string): Promise<string[]> {
    const files: string[] = [];
    const entries = await readdir(root, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        files.push(...await this.collectJavaFiles(absolutePath));
        continue;
      }

      if (entry.isFile() && entry.name.endsWith(JAVA_FILE)) files.push(absolutePath);
    }

    return files;
  }

  private parseSourceFile(version: string, sourceDir: string, relativePath: string, text: string): SourceFile {
    const packageMatch = text.match(/^\s*package\s+([A-Za-z0-9_.]+)\s*;/m);
    const packageName = packageMatch?.[1] ?? null;
    const classBlock = scanJavaStructure(text, packageName).find(block => block.kind === "class");
    const className = classBlock?.name ?? path.basename(relativePath, JAVA_FILE);
    const fullName = packageName ? `${packageName}.${className}` : className;

    return {
      version,
      path: relativePath,
      absolutePath: path.join(sourceDir, relativePath),
      packageName,
      className,
      fullName,
      text
    };
  }

  private parseSymbols(file: SourceFile): SourceSymbol[] {
    const symbols: SourceSymbol[] = [];
    const lines = file.text.split(/\r?\n/);
    const blocks = scanJavaStructure(file.text, file.packageName);

    for (const block of blocks) {
      symbols.push({
        version: file.version,
        kind: block.kind,
        name: block.name,
        owner: block.owner,
        path: file.path,
        line: block.startLine,
        signature: block.signature
      });
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fieldMatch = line.match(FIELD_PATTERN);
      if (fieldMatch) symbols.push(this.symbol(file, "field", fieldMatch[1], i + 1, line));
    }

    return symbols;
  }

  private parseChunks(file: SourceFile): SourceChunk[] {
    const chunks: SourceChunk[] = [];
    const lines = file.text.split(/\r?\n/);
    const blocks = scanJavaStructure(file.text, file.packageName);
    const semanticBlocks = blocks.filter(block => block.kind === "method" || block.kind === "class");

    if (semanticBlocks.length === 0) {
      this.pushChunkSegments(chunks, file, "file", file.className ?? undefined, undefined, 1, lines.length);
      return chunks;
    }

    const firstBlock = semanticBlocks[0];
    if (firstBlock.startLine > 1) {
      this.pushChunkSegments(chunks, file, "file", file.className ?? undefined, undefined, 1, firstBlock.startLine - 1);
    }
    for (const block of semanticBlocks) {
      if (block.kind === "class") {
        const firstNestedMethod = blocks.find(candidate => candidate.kind === "method" && candidate.owner === block.owner);
        const classEnd = Math.min(block.endLine, firstNestedMethod ? firstNestedMethod.startLine - 1 : block.endLine);
        this.pushChunkSegments(chunks, file, "class", block.name, block.signature, block.startLine, classEnd);
      } else {
        this.pushChunkSegments(chunks, file, "method", block.name, block.signature, block.startLine, block.endLine, block.owner);
      }
    }

    return chunks;
  }

  private pushChunkSegments(
    chunks: SourceChunk[],
    file: SourceFile,
    kind: SourceChunk["kind"],
    name: string | undefined,
    signature: string | undefined,
    startLine: number,
    endLine: number,
    owner = file.fullName
  ): void {
    const lines = file.text.split(/\r?\n/);
    const maximumLines = 160;
    const overlapLines = 20;
    let segmentStart = startLine;
    while (segmentStart <= endLine) {
      const segmentEnd = Math.min(endLine, segmentStart + maximumLines - 1);
      const text = lines.slice(segmentStart - 1, segmentEnd).join("\n");
      chunks.push({
        id: `${file.path}:${segmentStart}-${segmentEnd}`,
        version: file.version,
        path: file.path,
        owner,
        kind,
        name,
        signature,
        startLine: segmentStart,
        endLine: segmentEnd,
        text
      });
      if (segmentEnd === endLine) break;
      segmentStart = segmentEnd - overlapLines + 1;
    }
  }

  private embeddingText(chunk: SourceChunk): string {
    return `${chunk.owner ?? ""} ${chunk.name ?? ""} ${chunk.signature ?? ""}\n${chunk.text}`;
  }

  private symbol(file: SourceFile, kind: SourceSymbol["kind"], name: string, line: number, signature: string): SourceSymbol {
    return {
      version: file.version,
      kind,
      name,
      owner: file.fullName,
      path: file.path,
      line,
      signature: signature.trim()
    };
  }

  private async writeIndex(index: VersionIndex): Promise<void> {
    const versionDir = path.join(this.dataDir, encodeURIComponent(index.meta.version));
    await mkdir(versionDir, { recursive: true });
    const temporarySuffix = `.tmp-${process.pid}`;
    const metaPath = path.join(versionDir, "meta.json");
    const indexPath = path.join(versionDir, "index.json");
    const temporaryMetaPath = `${metaPath}${temporarySuffix}`;
    const temporaryIndexPath = `${indexPath}${temporarySuffix}`;
    await writeFile(temporaryIndexPath, JSON.stringify(index), "utf8");
    await writeFile(temporaryMetaPath, JSON.stringify(index.meta, null, 2), "utf8");
    await rename(temporaryIndexPath, indexPath);
    await rename(temporaryMetaPath, metaPath);
    const indexStat = await stat(indexPath);
    this.indexCache.set(index.meta.version, { mtimeMs: indexStat.mtimeMs, index });
  }

  private async loadIndexes(version: string | undefined, sourceTypes?: SourceType[]): Promise<VersionIndex[]> {
    if (version) {
      const index = await this.loadIndex(version);
      return this.matchesSourceType(index.meta, sourceTypes) ? [index] : [];
    }

    const versions = (await this.listVersions()).filter(meta => this.matchesSourceType(meta, sourceTypes));
    const indexes: VersionIndex[] = [];
    for (const meta of versions) {
      indexes.push(await this.loadIndex(meta.version));
    }

    return indexes;
  }

  private async loadIndex(version: string): Promise<VersionIndex> {
    const indexPath = path.join(this.dataDir, encodeURIComponent(version), "index.json");
    let indexStat;
    try {
      indexStat = await stat(indexPath);
    } catch {
      const versions = await this.listVersions();
      const candidates = versions.map(candidate => candidate.version);
      throw new Error(this.notFoundMessage(`Index not found: ${version}`, version, candidates));
    }

    const cached = this.indexCache.get(version);
    if (cached?.mtimeMs === indexStat.mtimeMs) return cached.index;

    const text = await readFile(indexPath, "utf8");
    const index = JSON.parse(text) as VersionIndex;
    index.meta = this.normalizeMeta(index.meta);
    this.indexCache.set(version, { mtimeMs: indexStat.mtimeMs, index });
    return index;
  }

  private matchesLocationFilter(pathName: string, owner: string | null | undefined, filter: SearchFilter): boolean {
    if (filter.pathPrefix && !pathName.startsWith(filter.pathPrefix.replaceAll("\\", "/"))) return false;
    if (filter.owner) {
      const normalizedOwner = filter.owner.replaceAll("$", ".");
      const candidate = owner?.replaceAll("$", ".") ?? "";
      if (candidate !== normalizedOwner && !candidate.startsWith(`${normalizedOwner}.`)) return false;
    }
    return true;
  }

  private matchesSourceType(meta: SourceVersion, sourceTypes: SourceType[] | undefined): boolean {
    return !sourceTypes || sourceTypes.length === 0 || sourceTypes.includes(this.normalizeMeta(meta).sourceType ?? "custom");
  }

  private normalizeMeta(meta: SourceVersion): SourceVersion {
    return {
      indexFormatVersion: 1,
      ...this.inferMetadata(meta.version),
      ...meta
    };
  }

  private inferMetadata(version: string): SourceMetadata {
    if (version.startsWith("mod:")) {
      const [, modId, modVersion] = version.split(":");
      return { sourceType: "mod", modId, modVersion };
    }
    if (/^(?:\d|latest)/.test(version)) return { sourceType: "minecraft", minecraftVersion: version };
    return { sourceType: "custom" };
  }

  private notFoundMessage(message: string, query: string, candidates: string[]): string {
    const suggestions = candidates
      .map(candidate => ({ candidate, distance: this.editDistance(query.toLowerCase(), candidate.toLowerCase()) }))
      .sort((left, right) => left.distance - right.distance || left.candidate.localeCompare(right.candidate))
      .slice(0, 5)
      .map(entry => entry.candidate);

    return suggestions.length > 0 ? `${message}. Did you mean: ${suggestions.join(", ")}` : message;
  }

  private editDistance(left: string, right: string): number {
    const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    const current = new Array<number>(right.length + 1);

    for (let i = 1; i <= left.length; i++) {
      current[0] = i;
      for (let j = 1; j <= right.length; j++) {
        current[j] = Math.min(
          current[j - 1] + 1,
          previous[j] + 1,
          previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1)
        );
      }
      for (let j = 0; j <= right.length; j++) previous[j] = current[j];
    }

    return previous[right.length];
  }

  private scoreText(text: string, terms: string[], rawQuery: string): number {
    const lower = text.toLowerCase();
    let score = lower.includes(rawQuery.toLowerCase()) ? 25 : 0;

    for (const term of terms) {
      if (!lower.includes(term)) continue;
      score += term.length;
    }

    return score;
  }

  private preview(text: string): string {
    return text.replace(/\s+/g, " ").trim().slice(0, 500);
  }

  private contextPreview(lines: string[], lineIndex: number, contextLines = 0): { preview: string; previewStartLine: number; previewEndLine: number } {
    const start = Math.max(0, lineIndex - contextLines);
    const end = Math.min(lines.length - 1, lineIndex + contextLines);
    return {
      preview: lines.slice(start, end + 1).join("\n").trim(),
      previewStartLine: start + 1,
      previewEndLine: end + 1
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

  private reciprocalRankFusion(resultSets: SearchHit[][], limit: number): SearchHit[] {
    const fused = new Map<string, { hit: SearchHit; score: number }>();
    const weights = [1.1, 0.8, 1.2];
    for (let resultIndex = 0; resultIndex < resultSets.length; resultIndex++) {
      const hits = resultSets[resultIndex];
      for (let rank = 0; rank < hits.length; rank++) {
        const hit = hits[rank];
        const key = `${hit.version}:${hit.path}:${hit.line ?? 0}:${hit.kind ?? ""}:${hit.name ?? ""}`;
        const entry = fused.get(key) ?? { hit, score: 0 };
        entry.score += (weights[resultIndex] ?? 1) / (60 + rank + 1);
        if ((hit.preview?.length ?? 0) > (entry.hit.preview?.length ?? 0)) entry.hit = hit;
        fused.set(key, entry);
      }
    }
    return [...fused.values()]
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map(entry => ({ ...entry.hit, score: Number((entry.score * 1000).toFixed(4)) }));
  }

  private ownerMatchesFile(file: SourceFile, owner: string): boolean {
    if (!file.fullName || !file.className) return false;

    const normalizedOwner = owner.replaceAll("$", ".");
    if (normalizedOwner === file.fullName) return true;
    if (normalizedOwner === file.className) return true;

    return normalizedOwner.startsWith(`${file.fullName}.`) ||
      normalizedOwner.startsWith(`${file.className}.`);
  }

  private findOwnerRange(file: SourceFile, owner: string, lines: string[]): { start: number; end: number; owner: string | null } {
    const normalizedOwner = owner.replaceAll("$", ".");
    if (!file.fullName || normalizedOwner === file.fullName || normalizedOwner === file.className) {
      return {
        start: 0,
        end: lines.length - 1,
        owner: file.fullName
      };
    }

    const simpleOwner = normalizedOwner.split(".").at(-1) ?? normalizedOwner;
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(CLASS_PATTERN);
      if (!match || match[1] !== simpleOwner) continue;

      return {
        start: i,
        end: this.findBlockEnd(lines, i),
        owner: `${file.fullName}.${simpleOwner}`
      };
    }

    return {
      start: 0,
      end: lines.length - 1,
      owner: file.fullName
    };
  }

  private matchesMethodLookup(signature: string, rawParameters: string, lookup: MethodLookup): boolean {
    if (lookup.signature && !signature.includes(lookup.signature)) return false;

    const parameters = this.parseParameterTypes(rawParameters);
    if (lookup.parameterCount !== undefined && parameters.length !== lookup.parameterCount) return false;

    if (lookup.parameterTypes) {
      if (parameters.length !== lookup.parameterTypes.length) return false;

      for (let i = 0; i < parameters.length; i++) {
        if (!this.parameterTypeMatches(parameters[i], lookup.parameterTypes[i])) return false;
      }
    }

    return true;
  }

  private signatureParameters(signature: string): string {
    const start = signature.lastIndexOf("(");
    if (start < 0) return "";
    let depth = 0;
    for (let i = start; i < signature.length; i++) {
      if (signature[i] === "(") depth++;
      if (signature[i] === ")") {
        depth--;
        if (depth === 0) return signature.slice(start + 1, i);
      }
    }
    return "";
  }

  private parseParameterTypes(rawParameters: string): string[] {
    const trimmed = rawParameters.trim();
    if (!trimmed) return [];

    return trimmed.split(",")
      .map(parameter => parameter.trim())
      .map(parameter => parameter.replace(/\bfinal\s+/g, ""))
      .map(parameter => parameter.replace(/\s+/g, " "))
      .map(parameter => {
        const parts = parameter.split(" ");
        if (parts.length <= 1) return parameter;
        return parts.slice(0, -1).join(" ");
      });
  }

  private parameterTypeMatches(actual: string, expected: string): boolean {
    const normalizedActual = this.normalizeType(actual);
    const normalizedExpected = this.normalizeType(expected);

    return normalizedActual === normalizedExpected ||
      normalizedActual.endsWith(`.${normalizedExpected}`) ||
      normalizedExpected.endsWith(`.${normalizedActual}`);
  }

  private normalizeType(type: string): string {
    return type.replace(/\s+/g, "")
      .replaceAll("$", ".")
      .toLowerCase();
  }

  private findBlockEnd(lines: string[], start: number): number {
    return findJavaBlockEnd(lines, start);
  }

  private escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}
