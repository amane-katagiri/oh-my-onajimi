import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeRoot, run } from "./helpers.js";
import { parseProfile } from "../src/build.js";

test("build writes the four generated files and keeps evidence out of messages", () => {
  const root = makeRoot();
  const result = run(["build", "--root", root, "--author", "demo"]);
  assert.equal(result.code, 0, result.stderr);
  const dir = path.join(root, "authors/demo/generated");
  assert.deepEqual(fs.readdirSync(dir).sort(), [".textlintrc.json", "author-leaning.json", "model-leaning.json", "orthography.yml"]);
  const model = JSON.parse(fs.readFileSync(path.join(dir, "model-leaning.json"), "utf8"));
  assert.deepEqual(Object.keys(model.entries[0]).sort(), ["message", "tokens"]);
  const author = JSON.parse(fs.readFileSync(path.join(dir, "author-leaning.json"), "utf8"));
  assert.equal(author.entries[0].message, "筆者は「確かめる」と書く。");
  const rc = JSON.parse(fs.readFileSync(path.join(dir, ".textlintrc.json"), "utf8"));
  assert.equal(rc.rules["preset-onajimi"]["model-leaning"].dictionaryPath, "./model-leaning.json");
  assert.equal(rc.rules["preset-onajimi"]["decoration-density"].maxBoldPer1000, 3);
  assert.equal(rc.rules["sentence-length"].max, 60);
  assert.equal(rc.rules["max-ten"].max, 2);
  assert.match(fs.readFileSync(path.join(dir, "orthography.yml"), "utf8"), /expected: できる/);
});

test("build --check passes when up to date and fails after the profile changes", () => {
  const root = makeRoot();
  assert.equal(run(["build", "--root", root, "--author", "demo", "--check"]).code, 1);
  run(["build", "--root", root, "--author", "demo"]);
  assert.equal(run(["build", "--root", root, "--author", "demo", "--check"]).code, 0);
  const profile = path.join(root, "authors/demo/profile.yml");
  fs.writeFileSync(profile, fs.readFileSync(profile, "utf8").replace("max_ten: 2", "max_ten: 3"));
  const stale = run(["build", "--root", root, "--author", "demo", "--check"]);
  assert.equal(stale.code, 1);
  assert.match(stale.stdout, /generated\/\.textlintrc\.json が profile\.yml と食い違っている/);
});

test("thresholds that are not given leave their rules out", () => {
  const root = makeRoot();
  const profile = path.join(root, "authors/demo/profile.yml");
  fs.writeFileSync(profile, "model_leaning: []\n");
  run(["build", "--root", root, "--author", "demo"]);
  const rc = JSON.parse(fs.readFileSync(path.join(root, "authors/demo/generated/.textlintrc.json"), "utf8"));
  assert.equal(rc.rules["sentence-length"], undefined);
  assert.equal(rc.rules["max-ten"], undefined);
  assert.deepEqual(rc.rules["preset-onajimi"]["decoration-density"], { severity: "warning" });
});

test("profile errors name the place", () => {
  assert.throws(() => parseProfile("unknown: 1\n"), /最上位: 知らないキー unknown/);
  assert.throws(() => parseProfile("model_leaning:\n  - tokens: []\n    message: x\n"), /model_leaning\[0\]: tokens/);
  assert.throws(() => parseProfile("author_leaning:\n  - tokens: [{basic_form: a}]\n"), /author_leaning\[0\]: author/);
  assert.throws(() => parseProfile("thresholds:\n  max_ten: -1\n"), /thresholds\.max_ten/);
});

test("build rejects author names that could escape authors/", () => {
  const root = makeRoot();
  const result = run(["build", "--root", root, "--author", "../x"]);
  assert.equal(result.code, 2);
});

test("density entries and the new thresholds reach the generated config, and phrase-density fires through lint", () => {
  const root = makeRoot();
  const profile = path.join(root, "authors/demo/profile.yml");
  fs.writeFileSync(
    profile,
    [
      "density:",
      "  - tokens: [{ pos: 動詞, basic_form: 思う }]",
      "    max_per_1000: 20",
      "    typical_per_1000: 3",
      "    message: 「思う」が多い。",
      "    evidence: { feature: 思う/動詞 }",
      "  - tokens: [{ basic_form: 静か }]",
      "    max_per_1000: 5",
      "    min_chars: 10",
      "    message: 「静か」が多い。",
      "thresholds:",
      "  bold_per_1000: 3",
      "  decoration_min_chars: 1500",
      "  bold_label_items: 0",
      "  emphasis_share_min: 0.3",
      "  emphasis_share_typical: 0.55",
      "  emphasis_min_marks: 3",
      "  density_min_chars: 40",
      "",
    ].join("\n"),
  );
  assert.equal(run(["build", "--root", root, "--author", "demo"]).code, 0);
  const rc = JSON.parse(fs.readFileSync(path.join(root, "authors/demo/generated/.textlintrc.json"), "utf8"));
  assert.deepEqual(rc.rules["preset-onajimi"]["decoration-density"], {
    severity: "warning",
    maxBoldPer1000: 3,
    minChars: 1500,
    maxBoldLabelItems: 0,
    minEmphasisShare: 0.3,
    minEmphasisMarks: 3,
    typicalEmphasisShare: 0.55,
  });
  const density = rc.rules["preset-onajimi"]["phrase-density"];
  assert.equal(density.severity, "warning");
  assert.deepEqual(density.entries[0], { tokens: [{ pos: "動詞", basic_form: "思う" }], max_per_1000: 20, min_chars: 40, typical_per_1000: 3, message: "「思う」が多い。" });
  assert.equal(density.entries[1].min_chars, 10);
  const draft = path.join(root, "draft.md");
  fs.writeFileSync(draft, "今日は雨だと思う。明日は晴れると思った。週末も晴れると思う。来週の天気は分からないが大丈夫だと思う。\n\n- **速さ**: 速い\n");
  const lines = run(["lint", "--root", root, "--author", "demo", draft]).stdout.trimEnd().split("\n");
  assert.ok(lines.some((line) => /^1:1 phrase-density 「思う」が多い。 1000字あたり [\d.]+（筆者はふつう 3、目安 20 以下）。$/u.test(line)), lines.join("\n"));
  assert.ok(lines.some((line) => /^3:1 decoration-density 太字のラベル/u.test(line)), lines.join("\n"));
  assert.throws(() => parseProfile("density:\n  - tokens: [{ basic_form: a }]\n    message: x\n"), /density\[0\]: max_per_1000 が要る/u);
  assert.throws(() => parseProfile("thresholds:\n  emphasis_share_min: 2\n"), /thresholds\.emphasis_share_min: 0 以上 1 以下/u);
});

test("evidence and note are allowed on orthography entries and left out of the generated rules", () => {
  const root = makeRoot();
  const profile = path.join(root, "authors/demo/profile.yml");
  fs.writeFileSync(profile, "orthography:\n  - expected: できる\n    pattern: 出来る\n    note: 人のメモ\n    evidence:\n      z: { opus: 3 }\n");
  const result = run(["build", "--root", root, "--author", "demo"]);
  assert.equal(result.code, 0, result.stderr);
  const generated = fs.readFileSync(path.join(root, "authors/demo/generated/orthography.yml"), "utf8");
  assert.equal(generated, "version: 1\nrules:\n  - expected: できる\n    pattern: 出来る\n");
});
