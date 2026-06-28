import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { spawn } from "node:child_process";

const VINEFLOWER_VERSION = "1.12.0";
const VINEFLOWER_URL = `https://repo.maven.apache.org/maven2/org/vineflower/vineflower/${VINEFLOWER_VERSION}/vineflower-${VINEFLOWER_VERSION}.jar`;

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
      return jarPath;
    } catch {
      await mkdir(toolDir, { recursive: true });
      await this.download(VINEFLOWER_URL, jarPath);
      return jarPath;
    }
  }

  private async download(url: string, outputPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const request = https.get(url, response => {
        if (response.statusCode !== 200) {
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
