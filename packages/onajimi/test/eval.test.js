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
  assert.equal(lines[2], "| 誤検出: 筆者 test | 1 | 10 | 1 | 1 | 100.00 | model-leaning 1 | 1 |");
  assert.equal(lines[3], "| 検出: fake test | 1 | 14 | 2 | 2 | 142.86 | model-leaning 2 | 0 |");
  assert.equal(lines[4], "| 検出: limited test | 0 | 0 | 0 | 0 | 対照なし | - | 0 |");
});

test("finding lines keep at most 60 characters of the line around the column", async () => {
  const { around } = await import("../src/eval.js");
  const line = `${"あ".repeat(50)}対象${"い".repeat(50)}`;
  const shown = around(line, 51);
  assert.ok([...shown].length <= 60);
  assert.match(shown, /^…あ+対象い+…$/u);
  assert.equal(around("短い行", 1), "短い行");
  assert.ok([...around("う".repeat(80), 1)].length <= 60);
});

test("eval counts each occurrence and, separately, reduce-by-count findings once per document and entry", async () => {
  const { scoreDocs, renderEval } = await import("../src/eval.js");
  const spread = (line, entry) => ({ ruleId: "onajimi/phrase-density", line, column: 1, message: `${entry}この文書では 3 回（目安 1 回まで）。2 回減らす。` });
  const label = (line) => ({ ruleId: "onajimi/decoration-density", line, column: 1, message: "太字のラベルと「:」で始まる箇条書き（この文書に 2 個、目安 0 個以下）。ラベルを外して文で書くか、段落にする。" });
  const bold = (line) => ({ ruleId: "onajimi/decoration-density", line, column: 1, message: "この文書の太字は 2 個（目安 1 個まで）。1 個減らす。" });
  const messages = { a: [spread(1, "「A」"), spread(2, "「A」"), spread(3, "「A」"), spread(4, "「B」"), label(5), label(6), bold(7), bold(8)], b: [spread(1, "「A」")] };
  const lintText = async (_text, file) => messages[file.replace(/\.md$/u, "")];
  const docs = [{ slug: "a", text: "本文。\n".repeat(8) }, { slug: "b", text: "本文。\n" }];
  const row = await scoreDocs(lintText, docs, {});
  assert.equal(row.findings, 9);
  assert.equal(row.documentLevel, 6);
  assert.deepEqual(row.byRule, { "phrase-density": { findings: 5, documentLevel: 3 }, "decoration-density": { findings: 4, documentLevel: 3 } });
  assert.match(renderEval([{ label: "x", ...row }]).split("\n")[2], /^\| x \| 2 \| \d+ \| 9 \| 6 \| [\d.]+ \| phrase-density 5（3）, decoration-density 4（3） \| 0 \|$/u);
});
