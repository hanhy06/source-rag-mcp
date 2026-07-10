import { tokenizeForSearch } from "./SearchTokenizer.js";
import type { Bm25Index, SourceChunk } from "./types.js";

const K1 = 1.2;
const B = 0.75;

export function buildBm25Index(chunks: SourceChunk[]): Bm25Index {
  const postings = Object.create(null) as Record<string, Array<[number, number]>>;
  const lengths: number[] = [];

  for (let document = 0; document < chunks.length; document++) {
    const tokens = tokenizeForSearch(searchableChunkText(chunks[document]));
    lengths.push(tokens.length);
    const frequencies = new Map<string, number>();
    for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    for (const [token, frequency] of frequencies) {
      if (!Object.hasOwn(postings, token)) postings[token] = [];
      postings[token].push([document, frequency]);
    }
  }

  return {
    documentCount: chunks.length,
    averageDocumentLength: lengths.length === 0 ? 0 : lengths.reduce((sum, length) => sum + length, 0) / lengths.length,
    lengths,
    postings
  };
}

export function searchBm25(index: Bm25Index, query: string): Map<number, number> {
  const scores = new Map<number, number>();
  const terms = [...new Set(tokenizeForSearch(query))];
  const averageLength = index.averageDocumentLength || 1;

  for (const term of terms) {
    const posting = Object.hasOwn(index.postings, term) ? index.postings[term] : undefined;
    if (!posting) continue;
    const documentFrequency = posting.length;
    const inverseDocumentFrequency = Math.log(1 + (index.documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5));
    for (const [document, frequency] of posting) {
      const documentLength = index.lengths[document] ?? averageLength;
      const denominator = frequency + K1 * (1 - B + B * documentLength / averageLength);
      const score = inverseDocumentFrequency * frequency * (K1 + 1) / denominator;
      scores.set(document, (scores.get(document) ?? 0) + score);
    }
  }

  return scores;
}

function searchableChunkText(chunk: SourceChunk): string {
  return `${chunk.owner ?? ""} ${chunk.name ?? ""} ${chunk.signature ?? ""}\n${chunk.text}`;
}
