export type JavaBlock = {
  kind: "class" | "method";
  name: string;
  owner: string | null;
  startLine: number;
  endLine: number;
  signature: string;
};

type OpenBlock = {
  declaration?: Omit<JavaBlock, "endLine">;
};

const CONTROL_NAMES = new Set(["if", "for", "while", "switch", "catch", "try", "do", "else", "synchronized", "return", "throw", "new"]);
const TYPE_PATTERN = /\b(?:class|interface|enum|record)\s+([A-Za-z_$][A-Za-z0-9_$]*)/;
const METHOD_NAME_PATTERN = /([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^()]*\)\s*(?:throws\s+[A-Za-z0-9_$.,<>?\s]+)?$/;

export function scanJavaStructure(text: string, packageName: string | null): JavaBlock[] {
  const sanitized = sanitizeJava(text);
  const lines = lineStarts(text);
  const blocks: JavaBlock[] = [];
  const stack: OpenBlock[] = [];
  let boundary = 0;

  for (let i = 0; i < sanitized.length; i++) {
    const char = sanitized[i];
    if (char === ";") {
      boundary = i + 1;
      continue;
    }
    if (char === "{") {
      const sanitizedHeader = sanitized.slice(boundary, i);
      const relativeStart = sanitizedHeader.search(/\S/);
      const startOffset = relativeStart >= 0 ? boundary + relativeStart : i;
      const rawHeader = text.slice(startOffset, i).trim();
      const header = sanitized.slice(startOffset, i).replace(/\s+/g, " ").trim();
      const startLine = offsetToLine(lines, startOffset);
      const typeMatch = header.match(TYPE_PATTERN);
      let declaration: OpenBlock["declaration"];

      if (typeMatch) {
        const parentOwner = nearestOwner(stack);
        const owner = parentOwner ? `${parentOwner}.${typeMatch[1]}` : packageName ? `${packageName}.${typeMatch[1]}` : typeMatch[1];
        declaration = { kind: "class", name: typeMatch[1], owner, startLine, signature: compact(rawHeader) };
      } else {
        const owner = nearestOwner(stack);
        const methodMatch = header.match(METHOD_NAME_PATTERN);
        const name = methodMatch?.[1];
        const prefix = name ? header.slice(0, Math.max(0, header.lastIndexOf(name))).trim() : "";
        if (owner && name && !CONTROL_NAMES.has(name) && !/[=]|->|\bnew\s+$/.test(prefix) && !CONTROL_NAMES.has(prefix.split(/\s+/).at(-1) ?? "")) {
          declaration = { kind: "method", name, owner, startLine, signature: compact(rawHeader) };
        }
      }

      stack.push({ declaration });
      boundary = i + 1;
      continue;
    }
    if (char === "}") {
      const open = stack.pop();
      if (open?.declaration) {
        blocks.push({ ...open.declaration, endLine: offsetToLine(lines, i) });
      }
      boundary = i + 1;
    }
  }

  return blocks.sort((left, right) => left.startLine - right.startLine || right.endLine - left.endLine);
}

export function findJavaBlockEnd(lines: string[], startLineIndex: number): number {
  const text = lines.slice(startLineIndex).join("\n");
  const sanitized = sanitizeJava(text);
  let depth = 0;
  let started = false;

  for (let i = 0; i < sanitized.length; i++) {
    if (sanitized[i] === "{") {
      depth++;
      started = true;
    } else if (sanitized[i] === "}") {
      depth--;
      if (started && depth === 0) return startLineIndex + sanitized.slice(0, i).split("\n").length - 1;
    }
  }

  return Math.min(startLineIndex + 80, lines.length - 1);
}

function sanitizeJava(text: string): string {
  let result = "";
  let state: "code" | "line" | "block" | "string" | "char" | "textBlock" = "code";

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    const triple = text.slice(i, i + 3);
    if (state === "code") {
      if (char === "/" && next === "/") {
        result += "  "; i++; state = "line"; continue;
      }
      if (char === "/" && next === "*") {
        result += "  "; i++; state = "block"; continue;
      }
      if (triple === '\"\"\"') {
        result += "   "; i += 2; state = "textBlock"; continue;
      }
      if (char === '"') { result += " "; state = "string"; continue; }
      if (char === "'") { result += " "; state = "char"; continue; }
      result += char;
      continue;
    }

    if (char === "\n") {
      result += "\n";
      if (state === "line") state = "code";
      continue;
    }
    if (state === "block" && char === "*" && next === "/") {
      result += "  "; i++; state = "code"; continue;
    }
    if (state === "textBlock" && triple === '\"\"\"') {
      result += "   "; i += 2; state = "code"; continue;
    }
    if ((state === "string" && char === '"') || (state === "char" && char === "'")) {
      result += " "; state = "code"; continue;
    }
    if ((state === "string" || state === "char") && char === "\\" && next !== undefined) {
      result += "  "; i++; continue;
    }
    result += " ";
  }

  return result;
}

function nearestOwner(stack: OpenBlock[]): string | null {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].declaration?.kind === "class") return stack[i].declaration?.owner ?? null;
  }
  return null;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

function offsetToLine(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle] <= offset) low = middle;
    else high = middle;
  }
  return low + 1;
}

function compact(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
