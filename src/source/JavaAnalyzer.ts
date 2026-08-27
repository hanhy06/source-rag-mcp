import Parser from "tree-sitter";
import Java from "tree-sitter-java";

export type JavaDeclarationKind =
  | "class"
  | "interface"
  | "enum"
  | "record"
  | "annotation"
  | "method"
  | "constructor"
  | "field"
  | "enum_constant";

export type JavaDeclaration = {
  kind: JavaDeclarationKind;
  name: string;
  owner: string;
  signature: string;
  startLine: number;
  endLine: number;
  parameterTypes?: string[];
};

export type JavaAnalysis = {
  packageName: string | null;
  primaryTypeName: string | null;
  fullName: string | null;
  parseErrorCount: number;
  declarations: JavaDeclaration[];
  chunks: JavaChunk[];
};

export type JavaChunk = {
  kind: "file" | "class" | "method" | "constructor" | "initializer";
  owner: string | null;
  name?: string;
  signature?: string;
  startLine: number;
  endLine: number;
  text: string;
};

const TYPE_KINDS = new Map<string, JavaDeclarationKind>([
  ["class_declaration", "class"],
  ["interface_declaration", "interface"],
  ["enum_declaration", "enum"],
  ["record_declaration", "record"],
  ["annotation_type_declaration", "annotation"]
]);

export class JavaAnalyzer {
  private readonly parser: Parser;

  public constructor() {
    this.parser = new Parser();
    this.parser.setLanguage(Java);
  }

  public analyze(source: string): JavaAnalysis {
    const tree = this.parser.parse(source, undefined, { bufferSize: Math.max(32 * 1024, source.length + 1) });
    const packageNode = tree.rootNode.namedChildren.find(node => node.type === "package_declaration");
    const packageName = packageNode ? packageNode.text.replace(/^\s*package\s+|\s*;\s*$/g, "") : null;
    const declarations: JavaDeclaration[] = [];
    const chunks: JavaChunk[] = [];
    let parseErrorCount = 0;
    let primaryTypeName: string | null = null;

    const visit = (node: Parser.SyntaxNode, owners: string[]): void => {
      if (node.isError || node.isMissing) parseErrorCount++;

      const typeKind = TYPE_KINDS.get(node.type);
      if (typeKind) {
        const name = node.childForFieldName("name")?.text;
        if (!name) return;

        const owner = owners.length > 0 ? `${owners.at(-1)}.${name}` : packageName ? `${packageName}.${name}` : name;
        if (owners.length === 0 && primaryTypeName === null) primaryTypeName = name;
        const signature = this.declarationHeader(node);
        declarations.push(this.declaration(typeKind, name, owner, signature, node));
        const body = node.childForFieldName("body");
        chunks.push({
          kind: "class",
          owner,
          name,
          signature,
          startLine: node.startPosition.row + 1,
          endLine: (body?.startPosition.row ?? node.endPosition.row) + 1,
          text: signature
        });
        for (const child of node.namedChildren) visit(child, [...owners, owner]);
        return;
      }

      const owner = owners.at(-1);
      if (owner && (node.type === "method_declaration" || node.type === "constructor_declaration" || node.type === "compact_constructor_declaration")) {
        const name = node.childForFieldName("name")?.text;
        if (name) {
          const kind = node.type === "method_declaration" ? "method" : "constructor";
          const signature = this.declarationHeader(node);
          declarations.push({
            ...this.declaration(kind, name, owner, signature, node),
            parameterTypes: this.parameterTypes(node)
          });
          chunks.push(...this.callableChunks(node, kind, owner, name, signature));
        }
      } else if (owner && node.type === "field_declaration") {
        const signature = compact(node.text);
        for (const declarator of node.namedChildren.filter(child => child.type === "variable_declarator")) {
          const name = declarator.childForFieldName("name")?.text;
          if (name) declarations.push(this.declaration("field", name, owner, signature, node));
        }
        chunks.push(this.chunk(node, "class", owner, undefined, signature));
      } else if (owner && node.type === "enum_constant") {
        const name = node.childForFieldName("name")?.text;
        if (name) declarations.push(this.declaration("enum_constant", name, owner, compact(node.text), node));
      } else if (owner && (node.type === "static_initializer" || (node.type === "block" && node.parent?.type === "class_body"))) {
        chunks.push(this.chunk(node, "initializer", owner));
      }

      for (const child of node.namedChildren) visit(child, owners);
    };

    visit(tree.rootNode, []);
    const fullName = primaryTypeName ? packageName ? `${packageName}.${primaryTypeName}` : primaryTypeName : null;
    const firstType = declarations.find(declaration => TYPE_KINDS.has(`${declaration.kind}_declaration`) || declaration.kind === "annotation");
    if (firstType && firstType.startLine > 1) {
      const text = source.split(/\r?\n/).slice(0, firstType.startLine - 1).join("\n").trim();
      if (text) chunks.unshift({ kind: "file", owner: fullName, name: primaryTypeName ?? undefined, startLine: 1, endLine: firstType.startLine - 1, text });
    }
    if (chunks.length === 0 && source.trim()) {
      chunks.push({ kind: "file", owner: fullName, name: primaryTypeName ?? undefined, startLine: 1, endLine: source.split(/\r?\n/).length, text: source });
    }
    return {
      packageName,
      primaryTypeName,
      fullName,
      parseErrorCount,
      declarations: declarations.sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine),
      chunks: chunks.sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine)
    };
  }

  private declaration(
    kind: JavaDeclarationKind,
    name: string,
    owner: string,
    signature: string,
    node: Parser.SyntaxNode
  ): JavaDeclaration {
    return {
      kind,
      name,
      owner,
      signature,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1
    };
  }

  private declarationHeader(node: Parser.SyntaxNode): string {
    const body = node.childForFieldName("body");
    if (!body) return compact(node.text.replace(/;\s*$/, ""));
    return compact(node.text.slice(0, Math.max(0, node.text.length - body.text.length)));
  }

  private parameterTypes(node: Parser.SyntaxNode): string[] {
    const parameters = node.childForFieldName("parameters");
    if (!parameters) return [];

    const types: string[] = [];
    for (const parameter of parameters.namedChildren) {
      if (!parameter.type.endsWith("parameter")) continue;
      const type = parameter.childForFieldName("type")?.text ?? (parameter.type === "spread_parameter"
        ? parameter.namedChildren.find(child => child.type !== "variable_declarator")?.text
        : undefined);
      if (!type) continue;

      const suffix = parameter.type === "spread_parameter" ? "..." : parameter.namedChildren.some(child => child.type === "dimensions") ? "[]" : "";
      types.push(compact(`${type}${suffix}`));
    }
    return types;
  }

  private callableChunks(
    node: Parser.SyntaxNode,
    kind: "method" | "constructor",
    owner: string,
    name: string,
    signature: string
  ): JavaChunk[] {
    const body = node.childForFieldName("body");
    if (!body || node.endPosition.row - node.startPosition.row < 120) return [this.chunk(node, kind, owner, name, signature)];

    const statements = body.namedChildren;
    if (statements.length < 2) return [this.chunk(node, kind, owner, name, signature)];
    const chunks: JavaChunk[] = [];
    let start = 0;
    while (start < statements.length) {
      let end = start;
      while (end + 1 < statements.length && statements[end + 1].endPosition.row - statements[start].startPosition.row < 110) end++;
      const first = statements[start];
      const last = statements[end];
      chunks.push({
        kind,
        owner,
        name,
        signature,
        startLine: start === 0 ? node.startPosition.row + 1 : first.startPosition.row + 1,
        endLine: end === statements.length - 1 ? node.endPosition.row + 1 : last.endPosition.row + 1,
        text: `${signature}\n${statements.slice(start, end + 1).map(statement => statement.text).join("\n")}`
      });
      if (end === statements.length - 1) break;
      start = Math.max(start + 1, end);
    }
    return chunks;
  }

  private chunk(
    node: Parser.SyntaxNode,
    kind: JavaChunk["kind"],
    owner: string,
    name?: string,
    signature?: string
  ): JavaChunk {
    return {
      kind,
      owner,
      name,
      signature,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      text: node.text
    };
  }
}

function compact(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
