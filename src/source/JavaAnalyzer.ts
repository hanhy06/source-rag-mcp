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
    const tree = this.parser.parse(source);
    const packageNode = tree.rootNode.namedChildren.find(node => node.type === "package_declaration");
    const packageName = packageNode ? packageNode.text.replace(/^\s*package\s+|\s*;\s*$/g, "") : null;
    const declarations: JavaDeclaration[] = [];
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
        declarations.push(this.declaration(typeKind, name, owner, this.declarationHeader(node), node));
        for (const child of node.namedChildren) visit(child, [...owners, owner]);
        return;
      }

      const owner = owners.at(-1);
      if (owner && (node.type === "method_declaration" || node.type === "constructor_declaration" || node.type === "compact_constructor_declaration")) {
        const name = node.childForFieldName("name")?.text;
        if (name) {
          const kind = node.type === "method_declaration" ? "method" : "constructor";
          declarations.push({
            ...this.declaration(kind, name, owner, this.declarationHeader(node), node),
            parameterTypes: this.parameterTypes(node)
          });
        }
      } else if (owner && node.type === "field_declaration") {
        const signature = compact(node.text);
        for (const declarator of node.namedChildren.filter(child => child.type === "variable_declarator")) {
          const name = declarator.childForFieldName("name")?.text;
          if (name) declarations.push(this.declaration("field", name, owner, signature, node));
        }
      } else if (owner && node.type === "enum_constant") {
        const name = node.childForFieldName("name")?.text;
        if (name) declarations.push(this.declaration("enum_constant", name, owner, compact(node.text), node));
      }

      for (const child of node.namedChildren) visit(child, owners);
    };

    visit(tree.rootNode, []);
    const fullName = primaryTypeName ? packageName ? `${packageName}.${primaryTypeName}` : primaryTypeName : null;
    return {
      packageName,
      primaryTypeName,
      fullName,
      parseErrorCount,
      declarations: declarations.sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine)
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
}

function compact(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
