export function unifiedDiff(fromLabel: string, toLabel: string, fromText: string, toText: string): string {
  const left = fromText.split(/\r?\n/);
  const right = toText.split(/\r?\n/);
  const common = longestCommonSubsequence(left, right);
  const output = [`--- ${fromLabel}`, `+++ ${toLabel}`];
  let leftIndex = 0;
  let rightIndex = 0;

  for (const line of common) {
    while (left[leftIndex] !== line) output.push(`-${left[leftIndex++]}`);
    while (right[rightIndex] !== line) output.push(`+${right[rightIndex++]}`);
    output.push(` ${line}`);
    leftIndex++;
    rightIndex++;
  }
  while (leftIndex < left.length) output.push(`-${left[leftIndex++]}`);
  while (rightIndex < right.length) output.push(`+${right[rightIndex++]}`);
  return output.join("\n");
}

function longestCommonSubsequence(left: string[], right: string[]): string[] {
  const rows = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      rows[i][j] = left[i] === right[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1]);
    }
  }
  const result: string[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      result.push(left[i]); i++; j++;
    } else if (rows[i + 1][j] >= rows[i][j + 1]) i++;
    else j++;
  }
  return result;
}
