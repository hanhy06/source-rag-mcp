import path from "node:path";

import { AutoConfig, AutoModel, AutoTokenizer, type DeviceType } from "@huggingface/transformers";

type EmbeddingRuntime = {
  model: Awaited<ReturnType<typeof AutoModel.from_pretrained>>;
  tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;
};

export type CodeDocument = { title: string; text: string };

export const DEFAULT_CODE_EMBEDDING_MODEL = "onnx-community/embeddinggemma-2-ONNX";

export class CodeEmbedding {
  private readonly cacheDir: string;
  private readonly model: string;
  private readonly device: DeviceType;
  private readonly dtype: "q4" | "q8";
  private readonly batchSize: number;
  private readonly maxTokens: number;
  private readonly progressEvery: number;
  public readonly enabled: boolean;
  public readonly dimensions = 256;
  private runtime?: Promise<EmbeddingRuntime>;

  public constructor(dataDir: string, model = process.env.SOURCE_RAG_EMBEDDING_MODEL ?? DEFAULT_CODE_EMBEDDING_MODEL) {
    this.cacheDir = path.join(dataDir, "models");
    this.model = model;
    const device = (process.env.SOURCE_RAG_EMBEDDING_DEVICE ?? "auto") as DeviceType;
    // DirectML cannot share an ONNX session with the WebGPU provider selected by auto/gpu.
    this.device = process.platform === "win32" && (device === "auto" || device === "gpu") ? "dml" : device;
    const dtype = process.env.SOURCE_RAG_EMBEDDING_DTYPE ?? "q4";
    if (dtype !== "q4" && dtype !== "q8") throw new Error(`SOURCE_RAG_EMBEDDING_DTYPE must be q4 or q8; received ${dtype}.`);
    this.dtype = dtype;
    this.batchSize = positiveIntegerEnvironment("SOURCE_RAG_EMBEDDING_BATCH_SIZE", 15, 1);
    this.maxTokens = positiveIntegerEnvironment("SOURCE_RAG_EMBEDDING_MAX_TOKENS", 1024, 128);
    if (this.maxTokens > 8192) throw new Error("SOURCE_RAG_EMBEDDING_MAX_TOKENS must not exceed 8192.");
    this.progressEvery = positiveIntegerEnvironment("SOURCE_RAG_EMBEDDING_PROGRESS_EVERY", 100, 1);
    this.enabled = process.env.SOURCE_RAG_EMBEDDINGS !== "disabled";
  }

  public get modelName(): string {
    return this.model;
  }

  public get deviceName(): string {
    return this.device;
  }

  public async embedDocuments(documents: CodeDocument[]): Promise<Int8Array[]> {
    return await this.embed(documents.map(document => `title: ${document.title || "none"} | text: ${document.text}`));
  }

  public async embedQuery(text: string): Promise<Int8Array | undefined> {
    const embeddings = await this.embed([`task: code retrieval | query: ${text}`]);
    return embeddings[0];
  }

  public async close(): Promise<void> {
    if (this.runtime) await (await this.runtime).model.dispose();
  }

  private async embed(texts: string[]): Promise<Int8Array[]> {
    if (!this.enabled || texts.length === 0) return [];
    const { model, tokenizer } = await this.getRuntime();
    const result: Int8Array[] = [];
    const totalBatches = Math.ceil(texts.length / this.batchSize);
    for (let start = 0; start < texts.length; start += this.batchSize) {
      const batch = texts.slice(start, start + this.batchSize);
      const inputs = await tokenizer(batch, { padding: true, truncation: true, max_length: this.maxTokens });
      const { sentence_embedding: tensor } = await model(inputs);
      if (!tensor || tensor.dims.length !== 2 || tensor.dims[0] !== batch.length || tensor.dims[1] !== 768) {
        throw new Error("EmbeddingGemma 2 must return one 768-dimensional sentence embedding per input.");
      }
      const vectors = tensor.tolist() as number[][];
      for (const vector of vectors) {
        if (vector.some(value => !Number.isFinite(value))) throw new Error("EmbeddingGemma 2 returned non-finite values.");
        const truncated = vector.slice(0, this.dimensions);
        const length = Math.sqrt(truncated.reduce((sum, value) => sum + value * value, 0));
        if (length === 0) throw new Error("EmbeddingGemma 2 returned a zero-length vector.");
        result.push(quantizeVector(truncated.map(value => value / length)));
      }
      const completedBatches = Math.floor(start / this.batchSize) + 1;
      if (texts.length > this.batchSize && (completedBatches % this.progressEvery === 0 || completedBatches === totalBatches)) {
        process.stderr.write(`[source-rag] embedded ${Math.min(start + batch.length, texts.length)}/${texts.length} chunks (${completedBatches}/${totalBatches} batches)\n`);
      }
    }
    return result;
  }

  private async getRuntime(): Promise<EmbeddingRuntime> {
    this.runtime ??= (async () => {
      const options = { cache_dir: this.cacheDir };
      const [config, tokenizer] = await Promise.all([
        AutoConfig.from_pretrained(this.model, options),
        AutoTokenizer.from_pretrained(this.model, options)
      ]);
      if (config.model_type !== "embedding_gemma2") throw new Error(`Expected an EmbeddingGemma 2 model; received ${config.model_type}.`);
      Object.assign(config, { vision_config: null, audio_config: null });
      const model = await AutoModel.from_pretrained(this.model, {
        config,
        cache_dir: this.cacheDir,
        dtype: this.dtype,
        device: this.device,
        session_options: {
          intraOpNumThreads: 4,
          interOpNumThreads: 1,
          executionMode: "sequential",
          enableMemPattern: this.device !== "dml"
        }
      });
      return { model, tokenizer };
    })();
    return await this.runtime;
  }
}

export function quantizeVector(vector: number[]): Int8Array {
  const quantized = new Int8Array(vector.length);
  for (let i = 0; i < vector.length; i++) quantized[i] = Math.max(-127, Math.min(127, Math.round(vector[i] * 127)));
  return quantized;
}

export function quantizedCosine(left: Int8Array, right: Int8Array): number {
  if (left.length !== right.length || left.length === 0) return 0;
  let dot = 0;
  let leftLength = 0;
  let rightLength = 0;
  for (let i = 0; i < left.length; i++) {
    dot += left[i] * right[i];
    leftLength += left[i] * left[i];
    rightLength += right[i] * right[i];
  }
  return leftLength === 0 || rightLength === 0 ? 0 : dot / Math.sqrt(leftLength * rightLength);
}

function positiveIntegerEnvironment(name: string, defaultValue: number, minimum: number): number {
  const rawValue = process.env[name];
  if (rawValue === undefined) return defaultValue;
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} must be an integer greater than or equal to ${minimum}; received ${rawValue}.`);
  return value;
}
