export type SourceVersion = {
  version: string;
  sourceDir: string;
  indexedAt: string;
  fileCount: number;
  symbolCount: number;
  indexFormatVersion?: number;
  sourceType?: SourceType;
  minecraftVersion?: string;
  modId?: string;
  modVersion?: string;
  mappingNamespace?: string;
  side?: "client" | "server";
  embeddingModel?: string;
  embeddingDimensions?: number;
  embeddingDevice?: string;
};

export type SourceType = "minecraft" | "mod" | "custom";

export type SourceMetadata = {
  sourceType?: SourceType;
  minecraftVersion?: string;
  modId?: string;
  modVersion?: string;
  mappingNamespace?: string;
  side?: "client" | "server";
};

export type SearchFilter = {
  sourceTypes?: SourceType[];
  pathPrefix?: string;
  owner?: string;
  kinds?: SourceSymbol["kind"][];
  excludeDeclaration?: boolean;
  contextLines?: number;
};

export type SearchMode = "auto" | "symbol" | "text" | "hybrid";

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
  kind: "class" | "interface" | "enum" | "record" | "annotation" | "method" | "constructor" | "field" | "enum_constant";
  name: string;
  owner: string | null;
  path: string;
  line: number;
  signature: string;
};

export type SearchHit = {
  version: string;
  path: string;
  line?: number;
  endLine?: number;
  owner?: string | null;
  kind?: SourceSymbol["kind"] | SourceChunkKind;
  name?: string;
  signature?: string;
  score?: number;
  previewStartLine?: number;
  previewEndLine?: number;
  preview: string;
};

export type MethodComparison = {
  owner: string;
  method: string;
  from: SearchHit;
  to: SearchHit;
  changed: boolean;
  diff: string;
};

export type SourceChunkKind = "file" | "class" | "method" | "constructor" | "initializer";

export type SourceRange = {
  version: string;
  path: string;
  owner: string | null;
  startLine: number;
  endLine: number;
  text: string;
};

export type MethodLookup = {
  signature?: string;
  parameterTypes?: string[];
  parameterCount?: number;
  overloadIndex?: number;
};

export type ParseErrorFile = {
  version: string;
  path: string;
  parseErrorCount: number;
};
