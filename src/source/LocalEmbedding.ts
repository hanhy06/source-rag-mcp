export type SparseEmbedding = Array<[number, number]>;

const EMBEDDING_DIMENSIONS = 2048;
const TOKEN_PATTERN = /[A-Za-z_][A-Za-z0-9_]*|\d+/g;

export class LocalEmbedding {
  public embed(text: string): SparseEmbedding {
    const tokens = this.tokens(text);
    const values = new Map<number, number>();

    for (const token of tokens) {
      this.add(values, token, 1);
    }

    for (let i = 0; i < tokens.length - 1; i++) {
      this.add(values, `${tokens[i]}:${tokens[i + 1]}`, 0.35);
    }

    return this.normalize(values);
  }

  public similarity(left: SparseEmbedding, right: SparseEmbedding | undefined): number {
    if (!right || left.length === 0 || right.length === 0) return 0;

    const values = new Map<number, number>();
    for (const [index, value] of right) {
      values.set(index, value);
    }

    let score = 0;
    for (const [index, value] of left) {
      score += value * (values.get(index) ?? 0);
    }

    return score;
  }

  private tokens(text: string): string[] {
    const tokens: string[] = [];
    for (const match of text.matchAll(TOKEN_PATTERN)) {
      const token = match[0];
      tokens.push(token.toLowerCase());
      tokens.push(...this.splitIdentifier(token));
    }

    return tokens;
  }

  private splitIdentifier(value: string): string[] {
    const spaced = value
      .replace(/_/g, " ")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");

    const parts = spaced.split(/\s+/)
      .map(part => part.toLowerCase())
      .filter(part => part.length > 1);

    if (parts.length <= 1) return [];
    return parts;
  }

  private add(values: Map<number, number>, token: string, weight: number): void {
    if (token.length <= 1) return;

    const index = this.hash(token) % EMBEDDING_DIMENSIONS;
    values.set(index, (values.get(index) ?? 0) + weight);
  }

  private normalize(values: Map<number, number>): SparseEmbedding {
    let length = 0;
    for (const value of values.values()) {
      length += value * value;
    }

    const norm = Math.sqrt(length);
    if (norm === 0) return [];

    const embedding: SparseEmbedding = [];
    for (const [index, value] of values) {
      embedding.push([index, Number((value / norm).toFixed(6))]);
    }

    return embedding.sort((a, b) => a[0] - b[0]);
  }

  private hash(value: string): number {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }

    return hash >>> 0;
  }
}
