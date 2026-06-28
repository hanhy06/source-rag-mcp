import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SearchHit, SourceChunk, SourceFile, SourceSymbol, SourceVersion, VersionIndex } from "./types.js";

const DEFAULT_DATA_DIR = ".source-rag";
const JAVA_FILE = ".java";
const WORD_PATTERN = /[A-Za-z_][A-Za-z0-9_]*/g;
const CLASS_PATTERN = /^\s*(?:(?:public|protected|private|abstract|final|static|sealed|non-sealed)\s+)*(?:class|interface|enum|record)\s+([A-Za-z_][A-Za-z0-9_]*)/;
const METHOD_PATTERN = /^\s*(?:public|protected|private|static|final|abstract|synchronized|native|strictfp|default|\s)+[\w<>\[\].?,\s]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*(?:throws\s+[^{]+)?\{/;
const FIELD_PATTERN = /^\s*(?:public|protected|private|static|final|volatile|transient|\s)+[\w<>\[\].?,\s]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|;)/;

export class SourceIndex {
  private readonly dataDir: string;

  public constructor(dataDir = process.env.SOURCE_RAG_DATA ?? path.resolve(DEFAULT_DATA_DIR)) {
    this.dataDir = path.resolve(dataDir);
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
        versions.push(JSON.parse(text) as SourceVersion);
      } catch {
        continue;
      }
    }

    return versions.sort((a, b) => a.version.localeCompare(b.version));
  }

  public async indexSources(version: string, sourceDir: string): Promise<SourceVersion> {
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
      const sourceFile = this.parseSourceFile(version, absoluteSourceDir, absolutePath, relativePath, text);
      files.push(sourceFile);
      symbols.push(...this.parseSymbols(sourceFile));
      chunks.push(...this.parseChunks(sourceFile));
    }

    const meta: SourceVersion = {
      version,
      sourceDir: absoluteSourceDir,
      indexedAt: new Date().toISOString(),
      fileCount: files.length,
      symbolCount: symbols.length
    };

    const index: VersionIndex = { meta, files, symbols, chunks };
    await this.writeIndex(index);

    return meta;
  }

  public async searchSymbol(version: string | undefined, query: string, limit: number): Promise<SourceSymbol[]> {
    const indexes = await this.loadIndexes(version);
    const normalized = query.toLowerCase();
    const hits: Array<SourceSymbol & { score: number }> = [];

    for (const index of indexes) {
      for (const symbol of index.symbols) {
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

  public async searchText(version: string | undefined, query: string, limit: number): Promise<SearchHit[]> {
    const indexes = await this.loadIndexes(version);
    const terms = this.tokenize(query);
    const hits: SearchHit[] = [];

    for (const index of indexes) {
      for (const file of index.files) {
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
            preview: line.trim()
          });
        }
      }
    }

    return hits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, limit);
  }

  public async ragSearch(version: string | undefined, query: string, limit: number): Promise<SearchHit[]> {
    const indexes = await this.loadIndexes(version);
    const terms = this.tokenize(query);
    const hits: SearchHit[] = [];

    for (const index of indexes) {
      for (const chunk of index.chunks) {
        const score = this.scoreText(chunk.text, terms, query);
        if (score <= 0) continue;

        hits.push({
          version: chunk.version,
          path: chunk.path,
          line: chunk.startLine,
          owner: chunk.owner,
          score,
          preview: this.preview(chunk.text)
        });
      }
    }

    return hits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, limit);
  }

  public async getSource(version: string, fileOrClass: string): Promise<SourceFile> {
    const index = await this.loadIndex(version);
    const normalized = fileOrClass.replaceAll("\\", "/");

    const file = index.files.find(candidate =>
      candidate.path === normalized ||
      candidate.fullName === fileOrClass ||
      candidate.className === fileOrClass
    );

    if (!file) throw new Error(`Source not found: ${fileOrClass}`);
    return file;
  }

  public async getMethodSource(version: string, owner: string, method: string): Promise<SearchHit> {
    const file = await this.getSource(version, owner);
    const lines = file.text.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = line.match(METHOD_PATTERN);
      if (!match || match[1] !== method) continue;

      const end = this.findBlockEnd(lines, i);
      return {
        version,
        path: file.path,
        line: i + 1,
        owner: file.fullName,
        preview: lines.slice(i, end + 1).join("\n")
      };
    }

    throw new Error(`Method not found: ${owner}#${method}`);
  }

  public async findReferences(version: string | undefined, symbol: string, limit: number): Promise<SearchHit[]> {
    const indexes = await this.loadIndexes(version);
    const pattern = new RegExp(`\\b${this.escapeRegex(symbol)}\\b`);
    const hits: SearchHit[] = [];

    for (const index of indexes) {
      for (const file of index.files) {
        const lines = file.text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!pattern.test(line)) continue;

          hits.push({
            version: file.version,
            path: file.path,
            line: i + 1,
            owner: file.fullName,
            preview: line.trim()
          });
        }
      }
    }

    return hits.slice(0, limit);
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

  private parseSourceFile(version: string, sourceDir: string, absolutePath: string, relativePath: string, text: string): SourceFile {
    const packageMatch = text.match(/^\s*package\s+([A-Za-z0-9_.]+)\s*;/m);
    const classMatch = text.match(CLASS_PATTERN);
    const className = classMatch?.[1] ?? path.basename(relativePath, JAVA_FILE);
    const packageName = packageMatch?.[1] ?? null;
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

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const classMatch = line.match(CLASS_PATTERN);
      if (classMatch) {
        symbols.push(this.symbol(file, "class", classMatch[1], i + 1, line));
        continue;
      }

      const methodMatch = line.match(METHOD_PATTERN);
      if (methodMatch) {
        symbols.push(this.symbol(file, "method", methodMatch[1], i + 1, line));
        continue;
      }

      const fieldMatch = line.match(FIELD_PATTERN);
      if (fieldMatch) symbols.push(this.symbol(file, "field", fieldMatch[1], i + 1, line));
    }

    return symbols;
  }

  private parseChunks(file: SourceFile): SourceChunk[] {
    const chunks: SourceChunk[] = [];
    const lines = file.text.split(/\r?\n/);
    let start = 0;

    while (start < lines.length) {
      const end = Math.min(start + 80, lines.length);
      chunks.push({
        version: file.version,
        path: file.path,
        owner: file.fullName,
        startLine: start + 1,
        endLine: end,
        text: lines.slice(start, end).join("\n")
      });
      start = end;
    }

    return chunks;
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
    await writeFile(path.join(versionDir, "meta.json"), JSON.stringify(index.meta, null, 2), "utf8");
    await writeFile(path.join(versionDir, "index.json"), JSON.stringify(index), "utf8");
  }

  private async loadIndexes(version: string | undefined): Promise<VersionIndex[]> {
    if (version) return [await this.loadIndex(version)];

    const versions = await this.listVersions();
    const indexes: VersionIndex[] = [];
    for (const meta of versions) {
      indexes.push(await this.loadIndex(meta.version));
    }

    return indexes;
  }

  private async loadIndex(version: string): Promise<VersionIndex> {
    const indexPath = path.join(this.dataDir, encodeURIComponent(version), "index.json");
    const text = await readFile(indexPath, "utf8");
    return JSON.parse(text) as VersionIndex;
  }

  private tokenize(text: string): string[] {
    return Array.from(text.matchAll(WORD_PATTERN), match => match[0].toLowerCase());
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

  private findBlockEnd(lines: string[], start: number): number {
    let depth = 0;
    let started = false;

    for (let i = start; i < lines.length; i++) {
      for (const char of lines[i]) {
        if (char === "{") {
          depth++;
          started = true;
        }
        if (char === "}") depth--;
      }

      if (started && depth <= 0) return i;
    }

    return Math.min(start + 80, lines.length - 1);
  }

  private escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}
