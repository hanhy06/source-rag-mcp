import assert from "node:assert/strict";
import test from "node:test";

import { JavaAnalyzer } from "../dist/source/JavaAnalyzer.js";

test("JavaAnalyzer extracts only real fields and preserves nested owners", () => {
  const analysis = new JavaAnalyzer().analyze(`package demo;
public class Outer {
  private int first, second = 2;
  void run() {
    int local = 1;
    if (local > 0) return;
  }
  class Middle {
    class Inner {
      boolean enabled = false;
    }
  }
}`);

  assert.equal(analysis.fullName, "demo.Outer");
  assert.deepEqual(
    analysis.declarations.filter(declaration => declaration.kind === "field").map(declaration => [declaration.owner, declaration.name]),
    [
      ["demo.Outer", "first"],
      ["demo.Outer", "second"],
      ["demo.Outer.Middle.Inner", "enabled"]
    ]
  );
  assert.equal(analysis.declarations.some(declaration => declaration.name === "false" || declaration.name === "local"), false);
});

test("JavaAnalyzer preserves generic and vararg parameter boundaries", () => {
  const analysis = new JavaAnalyzer().analyze(`package demo;
import java.util.List;
import java.util.Map;
public record Example(int value) {
  public Example { }
  public <T> void apply(Map<String, List<T>> values, String... names) { }
}`);

  const constructor = analysis.declarations.find(declaration => declaration.kind === "constructor");
  const method = analysis.declarations.find(declaration => declaration.kind === "method" && declaration.name === "apply");
  assert.deepEqual(constructor?.parameterTypes, []);
  assert.deepEqual(method?.parameterTypes, ["Map<String, List<T>>", "String..."]);
  assert.equal(analysis.parseErrorCount, 0);
});

test("JavaAnalyzer splits long methods only between top-level statements", () => {
  const statements = Array.from({ length: 130 }, (_, index) => `    consume(${index});`).join("\n");
  const analysis = new JavaAnalyzer().analyze(`class LongMethod {
  void run() {
${statements}
  }
}`);
  const chunks = analysis.chunks.filter(chunk => chunk.kind === "method");
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.signature === "void run()"));
  assert.ok(chunks.every(chunk => !chunk.text.includes("consume(") || /consume\(\d+\);/.test(chunk.text)));
});

test("JavaAnalyzer parses source files larger than the native default input buffer", () => {
  const fields = Array.from({ length: 4_000 }, (_, index) => `  int field${index};`).join("\n");
  const source = `class LargeSource {\n${fields}\n}`;
  assert.ok(source.length > 32 * 1024);

  const analysis = new JavaAnalyzer().analyze(source);
  assert.equal(analysis.parseErrorCount, 0);
  assert.equal(analysis.declarations.filter(declaration => declaration.kind === "field").length, 4_000);
});
