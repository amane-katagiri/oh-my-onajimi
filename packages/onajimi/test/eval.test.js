import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { run } from "./helpers.js";
import { makeCorpusRoot, post } from "./corpus-helpers.js";

test("eval prints false positives on test posts and detections on test-set controls", () => {
  const { root } = makeCorpusRoot({
    a: post({ title: "A", date: "2021-01-01", body: "本文です。" }),
    b: post({ title: "B", date: "2021-01-02", body: "本文です。" }),
    c: post({ title: "C", date: "2021-01-03", body: "本文です。" }),
    d: post({ title: "D", date: "2021-01-04", body: "設定が静かに壊れた。\n\n> 引用が静かに壊れた。\n" }),
  });
  run(["split", "--root", root, "--author", "demo"]);
  run(["build", "--root", root, "--author", "demo"]);
  const dir = path.join(root, "authors/demo/corpus/_control/fake");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "d.md"), "静かに壊れる。静かに壊れた。\n");
  const result = run(["eval", "--root", root, "--author", "demo"]);
  assert.equal(result.code, 0, result.stderr);
  const lines = result.stdout.trimEnd().split("\n");
  assert.equal(lines[2], "| 誤検出: 筆者 test | 1 | 10 | 1 | 100.00 | model-leaning 1 | 1 |");
  assert.equal(lines[3], "| 検出: fake test | 1 | 14 | 2 | 142.86 | model-leaning 2 | 0 |");
  assert.equal(lines[4], "| 検出: limited test | 0 | 0 | 0 | 対照なし | - | 0 |");
});
