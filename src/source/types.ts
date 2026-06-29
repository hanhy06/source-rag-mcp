export type SourceVersion = {
  version: string;
  sourceDir: string;
  indexedAt: string;
  fileCount: number;
  symbolCount: number;
};

export type SourceFile = {
  version: string;
  path: string;
  absolutePath: string;
  packageName: string | null;
  className: string | null;
  fullName: string | null;
  text: string;
};

export type SourceSymbol = {
  version: string;
  kind: "class" | "method" | "field";
  name: string;
  owner: string | null;
  path: string;
  line: number;
  signature: string;
};

export type SourceChunk = {
  version: string;
  path: string;
  owner: string | null;
  startLine: number;
  endLine: number;
  text: string;
  embedding?: Array<[number, number]>;
};

export type SearchHit = {
  version: string;
  path: string;
  line?: number;
  owner?: string | null;
  score?: number;
  preview: string;
};

export type MethodLookup = {
  signature?: string;
  parameterTypes?: string[];
  parameterCount?: number;
  overloadIndex?: number;
};

export type VersionIndex = {
  meta: SourceVersion;
  files: SourceFile[];
  symbols: SourceSymbol[];
  chunks: SourceChunk[];
};
