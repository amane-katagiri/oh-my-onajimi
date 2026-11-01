import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { run } from "./helpers.js";
import { makeCorpusRoot, post } from "./corpus-helpers.js";
import preset from "../../textlint-rule-preset-onajimi/index.js";
import { documentKeyOf, renderEval, scoreDocs } from "../src/eval.js";
import { kernelRules } from "../src/lint.js";

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

const densityRules = (...messages) =>
  kernelRules({ rules: { "preset-onajimi": { "phrase-density": { entries: messages.map((message) => ({ tokens: [{ surface_form: "x" }], max_per_1000: 1, message })) } } } }, preset);
const spread = (line, entry) => ({ ruleId: "onajimi/phrase-density", line, column: 1, message: `${entry}この文書では 3 回（目安 1 回まで）。2 回減らす。` });
const bold = (line) => ({ ruleId: "onajimi/decoration-density", line, column: 1, message: "この文書の太字は 2 個（目安 1 個まで）。1 個減らす。" });
const score = async (rules, messages) => {
  const lintText = async (_text, file) => messages[file.replace(/\.md$/u, "")];
  const docs = Object.keys(messages).map((slug) => ({ slug, text: "本文。\n".repeat(10) }));
  return scoreDocs(lintText, docs, {}, documentKeyOf(rules, preset));
};

test("eval counts each occurrence and, separately, reduce-by-count findings once per document and entry", async () => {
  const label = (line) => ({ ruleId: "onajimi/decoration-density", line, column: 1, message: "太字のラベルと「:」で始まる箇条書き（この文書に 2 個、目安 0 個以下）。ラベルを外して文で書くか、段落にする。" });
  const row = await score(densityRules("「A」", "「B」"), {
    a: [spread(1, "「A」"), spread(2, "「A」"), spread(3, "「A」"), spread(4, "「B」"), label(5), label(6), bold(7), bold(8)],
    b: [spread(1, "「A」")],
  });
  assert.equal(row.findings, 9);
  assert.equal(row.documentLevel, 6);
  assert.deepEqual(row.byRule, { "phrase-density": { findings: 5, documentLevel: 3 }, "decoration-density": { findings: 4, documentLevel: 3 } });
  assert.match(renderEval([{ label: "x", ...row }]).split("\n")[2], /^\| x \| 2 \| \d+ \| 9 \| 6 \| [\d.]+ \| phrase-density 5（3）, decoration-density 4（3） \| 0 \|$/u);
});

test("eval tells density entries apart by the configured entry when one message starts with another", async () => {
  const rules = densityRules("「A」が多い。", "「A」が多い。言い切る。");
  const same = (line, entry) => ({ ...spread(line, entry), message: `${entry}この文書では 2 回（目安 1 回まで）。1 回減らす。` });
  const row = await score(rules, { a: [same(1, "「A」が多い。"), same(2, "「A」が多い。"), same(3, "「A」が多い。言い切る。"), same(4, "「A」が多い。言い切る。")] });
  assert.equal(row.findings, 4);
  assert.equal(row.documentLevel, 2);
});

test("eval collapses bold density once per document", async () => {
  const row = await score(densityRules(), { a: [bold(1), bold(2), bold(3)], b: [bold(1), bold(2)] });
  assert.deepEqual(row.byRule, { "decoration-density": { findings: 5, documentLevel: 2 } });
});

test("eval counts every finding of other rules even when the message ends like a density finding", async () => {
  const lookalike = (ruleId, line) => ({ ruleId, line, column: 1, message: "「A」が多い（目安 1 回まで）。2 回減らす。" });
  const row = await score(densityRules("「A」"), {
    a: [lookalike("onajimi/model-leaning", 1), lookalike("onajimi/model-leaning", 2), lookalike("onajimi/decoration-density", 3), lookalike("onajimi/decoration-density", 4)],
  });
  assert.equal(row.findings, 4);
  assert.equal(row.documentLevel, 4);
});
