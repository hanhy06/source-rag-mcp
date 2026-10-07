import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { spawn } from "node:child_process";

const VINEFLOWER_VERSION = "1.12.0";
const VINEFLOWER_URL = `https://repo.maven.apache.org/maven2/org/vineflower/vineflower/${VINEFLOWER_VERSION}/vineflower-${VINEFLOWER_VERSION}.jar`;
const VINEFLOWER_SHA256 = "1dfcfe974395734fa467ce620661c7623d05ba83670de0529b1fbd63ff548b9d";

export type DecompileResult = {
  input: string;
  outputDir: string;
  decompilerJar: string;
  stdout: string;
  stderr: string;
};

export class Decompiler {
  private readonly dataDir: string;

  public constructor(dataDir = process.env.SOURCE_RAG_DATA ?? path.resolve(".source-rag")) {
    this.dataDir = path.resolve(dataDir);
  }

  public async decompile(input: string, outputDir: string): Promise<DecompileResult> {
    const absoluteInput = path.resolve(input);
    const absoluteOutputDir = path.resolve(outputDir);
    await stat(absoluteInput);
    await mkdir(absoluteOutputDir, { recursive: true });

    const decompilerJar = await this.ensureVineflower();
    const result = await this.runJava([
      "-jar",
      decompilerJar,
      absoluteInput,
      absoluteOutputDir
    ]);

    return {
      input: absoluteInput,
      outputDir: absoluteOutputDir,
      decompilerJar,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }

  private async ensureVineflower(): Promise<string> {
    const toolDir = path.join(this.dataDir, "tools");
    const jarPath = path.join(toolDir, `vineflower-${VINEFLOWER_VERSION}.jar`);

    try {
      await stat(jarPath);
      if (await this.sha256(jarPath) === VINEFLOWER_SHA256) return jarPath;
    } catch {
      // download below
    }
    await mkdir(toolDir, { recursive: true });
    const temporaryPath = `${jarPath}.tmp-${randomUUID()}`;
    try {
      await this.download(VINEFLOWER_URL, temporaryPath);
      const actualSha256 = await this.sha256(temporaryPath);
      if (actualSha256 !== VINEFLOWER_SHA256) throw new Error(`Vineflower SHA-256 mismatch. Expected ${VINEFLOWER_SHA256}, received ${actualSha256}.`);
      await rm(jarPath, { force: true });
      await rename(temporaryPath, jarPath);
      return jarPath;
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  private async download(url: string, outputPath: string, redirects = 0): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const request = https.get(url, response => {
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          if (redirects >= 5) {
            reject(new Error(`Too many redirects while downloading: ${url}`));
            return;
          }
          void this.download(new URL(response.headers.location, url).toString(), outputPath, redirects + 1).then(resolve, reject);
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

  private async sha256(filePath: string): Promise<string> {
    return await new Promise((resolve, reject) => {
      const hash = createHash("sha256");
      const input = createReadStream(filePath);
      input.on("data", chunk => hash.update(chunk));
      input.on("end", () => resolve(hash.digest("hex")));
      input.on("error", reject);
    });
  }

  private async runJava(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return await new Promise((resolve, reject) => {
      const process = spawn("java", args, {
        windowsHide: true
      });

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      process.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
      process.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
      process.on("error", reject);
      process.on("close", code => {
        const result = {
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8")
        };

        if (code === 0) {
          resolve(result);
          return;
        }

        reject(new Error(`Vineflower failed with exit code ${code}\n${result.stderr}`));
      });
    });
  }
}
