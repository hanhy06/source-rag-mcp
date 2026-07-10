import path from "node:path";

import { pipeline, type DeviceType } from "@huggingface/transformers";

type FeatureExtractor = Awaited<ReturnType<typeof pipeline<"feature-extraction">>>;

export const DEFAULT_CODE_EMBEDDING_MODEL = "jinaai/jina-embeddings-v2-base-code";

export class CodeEmbedding {
  private readonly cacheDir: string;
  private readonly model: string;
  private readonly device: DeviceType;
  private extractor?: Promise<FeatureExtractor>;

  public constructor(dataDir: string, model = process.env.SOURCE_RAG_EMBEDDING_MODEL ?? DEFAULT_CODE_EMBEDDING_MODEL) {
    this.cacheDir = path.join(dataDir, "models");
    this.model = model;
    this.device = (process.env.SOURCE_RAG_EMBEDDING_DEVICE ?? "auto") as DeviceType;
  }

  public get modelName(): string {
    return this.model;
  }

  public get enabled(): boolean {
    return process.env.SOURCE_RAG_EMBEDDINGS !== "disabled";
  }

  public get deviceName(): string {
    return this.device;
  }

  public async embed(texts: string[]): Promise<string[]> {
    if (!this.enabled || texts.length === 0) return [];
    const extractor = await this.getExtractor();
    const result: string[] = [];
    const batchSize = Math.max(1, Number(process.env.SOURCE_RAG_EMBEDDING_BATCH_SIZE ?? 8));
    const progressEvery = Math.max(1, Number(process.env.SOURCE_RAG_EMBEDDING_PROGRESS_EVERY ?? 100));
    const totalBatches = Math.ceil(texts.length / batchSize);
    for (let start = 0; start < texts.length; start += batchSize) {
      const batch = texts.slice(start, start + batchSize);
      const tensor = await extractor(batch, { pooling: "mean", normalize: true });
      const vectors = tensor.tolist() as number[][];
      for (const vector of vectors) result.push(quantizeVector(vector));
      const completedBatches = Math.floor(start / batchSize) + 1;
      if (completedBatches % progressEvery === 0 || completedBatches === totalBatches) {
        process.stderr.write(`[source-rag] embedded ${Math.min(start + batch.length, texts.length)}/${texts.length} chunks (${completedBatches}/${totalBatches} batches)\n`);
      }
    }
    return result;
  }

  public async embedQuery(text: string): Promise<string | undefined> {
    const embeddings = await this.embed([text]);
    return embeddings[0];
  }

  private async getExtractor(): Promise<FeatureExtractor> {
    this.extractor ??= pipeline("feature-extraction", this.model, {
        cache_dir: this.cacheDir,
        dtype: "fp32",
        device: this.device,
        session_options: {
          intraOpNumThreads: 2,
          interOpNumThreads: 1,
          executionMode: "sequential",
          enableMemPattern: this.device !== "dml"
        }
      })
      .then(extractor => {
        extractor.tokenizer._tokenizerConfig.model_max_length = Math.max(
          128,
          Number(process.env.SOURCE_RAG_EMBEDDING_MAX_TOKENS ?? 1024)
        );
        return extractor;
      });
    return await this.extractor;
  }
}

export function quantizeVector(vector: number[]): string {
  const quantized = new Int8Array(vector.length);
  for (let i = 0; i < vector.length; i++) quantized[i] = Math.max(-127, Math.min(127, Math.round(vector[i] * 127)));
  return Buffer.from(quantized.buffer).toString("base64");
}

export function quantizedCosine(left: string, right: string): number {
  const leftBytes = new Int8Array(Buffer.from(left, "base64"));
  const rightBytes = new Int8Array(Buffer.from(right, "base64"));
  if (leftBytes.length !== rightBytes.length || leftBytes.length === 0) return 0;
  let dot = 0;
  let leftLength = 0;
  let rightLength = 0;
  for (let i = 0; i < leftBytes.length; i++) {
    dot += leftBytes[i] * rightBytes[i];
    leftLength += leftBytes[i] * leftBytes[i];
    rightLength += rightBytes[i] * rightBytes[i];
  }
  return leftLength === 0 || rightLength === 0 ? 0 : dot / Math.sqrt(leftLength * rightLength);
}
