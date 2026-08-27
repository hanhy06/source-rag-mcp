import { open, type FileHandle } from "node:fs/promises";

const MAGIC = Buffer.from("SRVEC3\0\0", "ascii");
const FORMAT_VERSION = 1;
const HEADER_SIZE = 32;

export type VectorFileInfo = {
  dimensions: number;
  count: number;
};

export class VectorWriter {
  private readonly handle: FileHandle;
  private dimensions = 0;
  private count = 0;
  private closed = false;

  private constructor(handle: FileHandle) {
    this.handle = handle;
  }

  public static async create(filePath: string): Promise<VectorWriter> {
    const handle = await open(filePath, "w+");
    await handle.write(Buffer.alloc(HEADER_SIZE), 0, HEADER_SIZE, 0);
    return new VectorWriter(handle);
  }

  public async append(vectors: Int8Array[]): Promise<number[]> {
    if (vectors.length === 0) return [];
    const dimensions = vectors[0].length;
    if (dimensions === 0) throw new Error("Embedding vectors must not be empty.");
    if (this.dimensions === 0) this.dimensions = dimensions;
    if (dimensions !== this.dimensions || vectors.some(vector => vector.length !== this.dimensions)) {
      throw new Error(`Embedding dimension mismatch. Expected ${this.dimensions}, received ${dimensions}.`);
    }

    const firstRow = this.count;
    const buffer = Buffer.allocUnsafe(vectors.length * this.dimensions);
    for (let index = 0; index < vectors.length; index++) {
      Buffer.from(vectors[index].buffer, vectors[index].byteOffset, vectors[index].byteLength).copy(buffer, index * this.dimensions);
    }
    await this.handle.write(buffer, 0, buffer.length, HEADER_SIZE + firstRow * this.dimensions);
    this.count += vectors.length;
    return Array.from({ length: vectors.length }, (_, index) => firstRow + index);
  }

  public async finalize(): Promise<VectorFileInfo> {
    if (this.closed) throw new Error("Vector writer is already closed.");
    const header = Buffer.alloc(HEADER_SIZE);
    MAGIC.copy(header, 0);
    header.writeUInt32LE(FORMAT_VERSION, 8);
    header.writeUInt32LE(this.dimensions, 12);
    header.writeUInt32LE(this.count, 16);
    await this.handle.write(header, 0, header.length, 0);
    await this.handle.sync();
    await this.handle.close();
    this.closed = true;
    return { dimensions: this.dimensions, count: this.count };
  }

  public async abort(): Promise<void> {
    if (this.closed) return;
    await this.handle.close();
    this.closed = true;
  }
}

export function readVectorHeader(buffer: Buffer): VectorFileInfo {
  if (buffer.length < HEADER_SIZE || !buffer.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Invalid vector file magic.");
  const version = buffer.readUInt32LE(8);
  if (version !== FORMAT_VERSION) throw new Error(`Unsupported vector file format: ${version}`);
  const dimensions = buffer.readUInt32LE(12);
  const count = buffer.readUInt32LE(16);
  if (buffer.length !== HEADER_SIZE + dimensions * count) throw new Error("Vector file size does not match its header.");
  return { dimensions, count };
}

export const VECTOR_HEADER_SIZE = HEADER_SIZE;
