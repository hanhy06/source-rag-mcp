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
