import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";

import { Decompiler, type DecompileResult } from "./Decompiler.js";
import { SourceIndex } from "./SourceIndex.js";
import type { SourceVersion } from "./types.js";

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
  index: SourceVersion;
};

export class ModJarIndexer {
  private readonly dataDir: string;
  private readonly decompiler: Decompiler;
  private readonly index: SourceIndex;

  public constructor(dataDir = process.env.SOURCE_RAG_DATA ?? path.resolve(".source-rag")) {
    this.dataDir = path.resolve(dataDir);
    this.decompiler = new Decompiler(this.dataDir);
    this.index = new SourceIndex(this.dataDir);
  }

  public async addModJar(parameter: AddModJarParameter): Promise<AddModJarResult> {
    const jarPath = path.resolve(parameter.jarPath);
    const jarStat = await stat(jarPath);
    if (!jarStat.isFile()) throw new Error(`jarPath is not a file: ${jarPath}`);
    if (path.extname(jarPath).toLowerCase() !== ".jar") throw new Error(`jarPath is not a jar file: ${jarPath}`);

    const indexLabel = parameter.indexAs ?? this.createIndexLabel(jarPath, parameter.modId, parameter.version);
    const cacheDir = path.join(this.dataDir, "mods", encodeURIComponent(indexLabel));
    await mkdir(cacheDir, { recursive: true });

    const cachedJarPath = path.join(cacheDir, "mod.jar");
    await copyFile(jarPath, cachedJarPath);

    const sourceDir = this.index.sourceDir(indexLabel);
    const decompile = await this.decompiler.decompile(cachedJarPath, sourceDir);
    const index = await this.index.indexSources(indexLabel, sourceDir);

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
