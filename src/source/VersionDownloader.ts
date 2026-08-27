import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import https from "node:https";
import path from "node:path";

const VERSION_MANIFEST_URL = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

type VersionManifest = {
  latest: {
    release: string;
    snapshot: string;
  };
  versions: Array<{
    id: string;
    type: string;
    url: string;
  }>;
};

type VersionJson = {
  id: string;
  downloads: {
    client?: DownloadEntry;
    server?: DownloadEntry;
  };
};

type DownloadEntry = {
  sha1: string;
  size: number;
  url: string;
};

export type MinecraftSide = "client" | "server";

export type DownloadVersionResult = {
  requestedVersion: string;
  resolvedVersion: string;
  side: MinecraftSide;
  jarPath: string;
  versionJsonPath: string;
};

export class VersionDownloader {
  private readonly dataDir: string;

  public constructor(dataDir = process.env.SOURCE_RAG_DATA ?? path.resolve(".source-rag")) {
    this.dataDir = path.resolve(dataDir);
  }

  public async downloadVersion(version: string, side: MinecraftSide): Promise<DownloadVersionResult> {
    const manifest = await this.fetchJson<VersionManifest>(VERSION_MANIFEST_URL);
    const resolvedVersion = this.resolveVersion(manifest, version);
    const versionInfo = manifest.versions.find(candidate => candidate.id === resolvedVersion);
    if (!versionInfo) throw new Error(`Minecraft version not found: ${version}`);

    const versionJson = await this.fetchJson<VersionJson>(versionInfo.url);
    const download = versionJson.downloads[side];
    if (!download) throw new Error(`${side} download is not available for ${resolvedVersion}`);

    const versionDir = path.join(this.dataDir, "versions", encodeURIComponent(resolvedVersion));
    await mkdir(versionDir, { recursive: true });

    const versionJsonPath = path.join(versionDir, "version.json");
    const jarPath = path.join(versionDir, `${side}.jar`);
    const temporaryVersionJsonPath = `${versionJsonPath}.tmp-${randomUUID()}`;
    await writeFile(temporaryVersionJsonPath, JSON.stringify(versionJson, null, 2), "utf8");
    await rm(versionJsonPath, { force: true });
    await rename(temporaryVersionJsonPath, versionJsonPath);
    await this.downloadFile(download.url, jarPath, download.size, download.sha1);

    return {
      requestedVersion: version,
      resolvedVersion,
      side,
      jarPath,
      versionJsonPath
    };
  }

  private resolveVersion(manifest: VersionManifest, version: string): string {
    if (version === "latest" || version === "latest_release") return manifest.latest.release;
    if (version === "latest_snapshot") return manifest.latest.snapshot;
    return version;
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const text = await this.fetchText(url);
    return JSON.parse(text) as T;
  }

  private async fetchText(url: string, redirects = 0): Promise<string> {
    return await new Promise((resolve, reject) => {
      const request = https.get(url, response => {
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          if (redirects >= 5) {
            reject(new Error(`Too many redirects while fetching: ${url}`));
            return;
          }
          void this.fetchText(new URL(response.headers.location, url).toString(), redirects + 1).then(resolve, reject);
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`Request failed: ${response.statusCode} ${response.statusMessage}`));
          return;
        }

        const chunks: Buffer[] = [];
        response.on("data", chunk => chunks.push(Buffer.from(chunk)));
        response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      });

      request.on("error", reject);
    });
  }

  private async downloadFile(url: string, outputPath: string, expectedSize: number, expectedSha1: string): Promise<void> {
    try {
      const existing = await stat(outputPath);
      if (existing.size === expectedSize && await this.sha1(outputPath) === expectedSha1.toLowerCase()) return;
    } catch {
      // download below
    }

    const temporaryPath = `${outputPath}.tmp-${randomUUID()}`;
    try {
      await this.writeDownload(url, temporaryPath);
      const downloaded = await stat(temporaryPath);
      if (downloaded.size !== expectedSize) throw new Error(`Download size mismatch. Expected ${expectedSize}, received ${downloaded.size}.`);
      const actualSha1 = await this.sha1(temporaryPath);
      if (actualSha1 !== expectedSha1.toLowerCase()) throw new Error(`Download SHA-1 mismatch. Expected ${expectedSha1}, received ${actualSha1}.`);
      await rm(outputPath, { force: true });
      await rename(temporaryPath, outputPath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  private async writeDownload(url: string, outputPath: string, redirects = 0): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const request = https.get(url, response => {
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          if (redirects >= 5) {
            reject(new Error(`Too many redirects while downloading: ${url}`));
            return;
          }
          void this.writeDownload(new URL(response.headers.location, url).toString(), outputPath, redirects + 1).then(resolve, reject);
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`Download failed: ${response.statusCode} ${response.statusMessage}`));
          return;
        }

        const file = createWriteStream(outputPath);
        response.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve();
        });
        file.on("error", reject);
      });

      request.on("error", reject);
    });
  }

  private async sha1(filePath: string): Promise<string> {
    return await new Promise((resolve, reject) => {
      const hash = createHash("sha1");
      const input = createReadStream(filePath);
      input.on("data", chunk => hash.update(chunk));
      input.on("end", () => resolve(hash.digest("hex")));
      input.on("error", reject);
    });
  }
}
