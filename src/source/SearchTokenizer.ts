const TOKEN_PATTERN = /[\p{L}_$][\p{L}\p{N}_$]*|\p{N}+/gu;
const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "get", "how", "in", "is", "it", "of", "on", "or", "that", "the", "this", "to", "what", "when", "where", "which", "who", "why", "with"
]);

export function tokenizeForSearch(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const token = match[0];
    const normalized = token.toLowerCase();
    tokens.push(normalized);
    const stem = stemEnglish(normalized);
    if (stem !== normalized) tokens.push(stem);
    tokens.push(...splitIdentifier(token));
  }
  return tokens.filter(token => token.length > 1 && !STOP_WORDS.has(token));
}

function splitIdentifier(value: string): string[] {
  const parts = value
    .replace(/[_$]/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/\s+/)
    .map(part => part.toLowerCase())
    .filter(part => part.length > 1);
  return parts.length > 1 ? parts : [];
}

function stemEnglish(token: string): string {
  if (!/^[a-z]+$/.test(token) || token.length < 5) return token;
  if (token.endsWith("ied")) return `${token.slice(0, -3)}y`;
  if (token.endsWith("ing")) {
    const base = token.slice(0, -3);
    return base.endsWith("y") ? base : `${base}${base.endsWith("at") || base.endsWith("iz") ? "e" : ""}`;
  }
  if (token.endsWith("ed")) return token.slice(0, -2);
  if (token.endsWith("es")) return token.slice(0, -2);
  if (token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}
