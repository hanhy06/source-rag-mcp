import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import { Decompiler, type DecompileResult } from "./Decompiler.js";
import { IndexBuilder } from "./IndexBuilder.js";
import type { CatalogIndex } from "./SourceCatalog.js";

export type AddModJarParameter = {
  jarPath: string;
  modId?: string;
  version?: string;
  indexAs?: string;
};

export type AddModJarResult = {
  jarPath: string;
  cachedJarPath: string;
  indexLabel: string;
  decompile: DecompileResult;
  index: CatalogIndex;
};

export class ModJarIndexer {
  private readonly dataDir: string;
  private readonly decompiler: Decompiler;
  private readonly indexBuilder: IndexBuilder;

  public constructor(indexBuilder: IndexBuilder, dataDir = process.env.SOURCE_RAG_DATA ?? path.resolve(".source-rag")) {
    this.dataDir = path.resolve(dataDir);
    this.decompiler = new Decompiler(this.dataDir);
    this.indexBuilder = indexBuilder;
  }

  public async addModJar(parameter: AddModJarParameter): Promise<AddModJarResult> {
    const jarPath = path.resolve(parameter.jarPath);
    const jarStat = await stat(jarPath);
    if (!jarStat.isFile()) throw new Error(`jarPath is not a file: ${jarPath}`);
    if (path.extname(jarPath).toLowerCase() !== ".jar") throw new Error(`jarPath is not a jar file: ${jarPath}`);

    const indexLabel = parameter.indexAs ?? this.createIndexLabel(jarPath, parameter.modId, parameter.version);
    const cacheKey = createHash("sha256").update(indexLabel).digest("hex").slice(0, 24);
    const cacheDir = path.join(this.dataDir, "mods", cacheKey);
    await mkdir(cacheDir, { recursive: true });

    const cachedJarPath = path.join(cacheDir, "mod.jar");
    const temporaryJarPath = `${cachedJarPath}.tmp-${randomUUID()}`;
    try {
      await copyFile(jarPath, temporaryJarPath);
      await rm(cachedJarPath, { force: true });
      await rename(temporaryJarPath, cachedJarPath);
    } catch (error) {
      await rm(temporaryJarPath, { force: true });
      throw error;
    }

    const sourceDir = path.join(this.dataDir, "work", randomUUID());
    let decompile: DecompileResult;
    let index: CatalogIndex;
    try {
      decompile = await this.decompiler.decompile(cachedJarPath, sourceDir);
      index = await this.indexBuilder.indexSources(indexLabel, sourceDir, {
        sourceType: "mod",
        modId: parameter.modId ?? this.safeLabelPart(path.basename(jarPath, ".jar")),
        modVersion: parameter.version
      });
    } finally {
      await rm(sourceDir, { recursive: true, force: true });
    }

    return {
      jarPath,
      cachedJarPath,
      indexLabel,
      decompile,
      index
    };
  }

  private createIndexLabel(jarPath: string, modId: string | undefined, version: string | undefined): string {
    const id = this.safeLabelPart(modId ?? path.basename(jarPath, ".jar"));
    if (!version) return `mod:${id}`;

    return `mod:${id}:${this.safeLabelPart(version)}`;
  }

  private safeLabelPart(value: string): string {
    return value.trim()
      .replace(/\.jar$/i, "")
      .replace(/[^A-Za-z0-9_.+-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "unknown";
  }
}
