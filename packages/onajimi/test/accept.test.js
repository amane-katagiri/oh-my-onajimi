import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { makeRoot, run } from "./helpers.js";

const tokens = [{ basic_form: "思う" }, { basic_form: "。" }];

const proposal = {
  model_leaning: [
    { id: "M1", tokens: [{ basic_form: "くれる" }, { basic_form: "ます" }], message: "「くれます」は筆者の言い方ではない。", note: "メモ", evidence: { feature: "くれる+ます", z: { opus: -3 } } },
    { id: "M2", tokens: [{ surface_form: "静か" }, { surface_form: "に" }, { basic_form: "壊れる" }], message: "重なる。", evidence: { feature: "静か+に" } },
  ],
  orthography: [{ id: "O1", expected: "全て", pattern: "すべて", evidence: { feature: "すべて", z: { opus: 4 } } }],
  orthography_review: [{ id: "R1", expected: "みなさん", pattern: "皆さん", check: ["品詞の細分類が違う"], evidence: { feature: "皆さん" } }],
  density: [{ id: "D1", tokens, max_per_1000: 0.9, min_chars: 1500, typical_per_1000: 0, message: "「思う。」が多い。", evidence: { feature: "思う+。", control: { opus: { p50: 0.4, fires: 3, docs: 9 } } } }],
  thresholds: {
    sentence_length: 120,
    max_ten: 4,
    bold_per_1000: null,
    list_ratio: 0.3,
    decoration_min_chars: 1500,
    bold_label_items: 0,
    emphasis_share_min: 0,
    emphasis_min_marks: 3,
    density_min_chars: 1500,
    emphasis_share_typical: 0.67,
  },
};

const prepare = (profileText) => {
  const root = makeRoot();
  const dir = path.join(root, "authors/demo");
  fs.mkdirSync(path.join(dir, "profile"), { recursive: true });
  fs.writeFileSync(path.join(dir, "profile/proposal.yml"), YAML.stringify(proposal));
  const profile = path.join(dir, "profile.yml");
  if (profileText !== undefined) {
    fs.writeFileSync(profile, profileText);
  }
  return { root, profile, generated: path.join(dir, "generated") };
};

test("accept appends the numbered entries without anchors, keeps the rest of profile.yml and builds", () => {
  const { root, profile, generated } = prepare();
  const before = fs.readFileSync(profile, "utf8");
  const result = run(["accept", "--root", root, "--author", "demo", "M1", "O1", "R1", "D1=「〜と思う。」で終わる文を減らす。言い切る。"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /M1 O1 R1 D1/u);
  const text = fs.readFileSync(profile, "utf8");
  assert.doesNotMatch(text, /[&*][a-z0-9]+\b/u);
  assert.ok(text.startsWith(before.slice(0, before.indexOf("author_leaning:"))));
  const parsed = YAML.parse(text);
  assert.deepEqual(parsed.model_leaning[0], YAML.parse(before).model_leaning[0]);
  assert.deepEqual(parsed.model_leaning[1], { tokens: [{ basic_form: "くれる" }, { basic_form: "ます" }], message: "「くれます」は筆者の言い方ではない。", note: "メモ", evidence: { feature: "くれる+ます", z: { opus: -3 } } });
  assert.deepEqual(parsed.orthography.slice(1), [
    { expected: "全て", pattern: "すべて", evidence: { feature: "すべて", z: { opus: 4 } } },
    { expected: "みなさん", pattern: "皆さん", evidence: { feature: "皆さん" } },
  ]);
  assert.deepEqual(parsed.density, [{ tokens, max_per_1000: 0.9, min_chars: 1500, typical_per_1000: 0, message: "「〜と思う。」で終わる文を減らす。言い切る。", evidence: proposal.density[0].evidence }]);
  assert.deepEqual(parsed.thresholds, YAML.parse(before).thresholds);
  assert.equal(JSON.parse(fs.readFileSync(path.join(generated, "model-leaning.json"), "utf8")).entries.length, 2);
  assert.match(fs.readFileSync(path.join(generated, "orthography.yml"), "utf8"), /expected: 全て/u);
  assert.equal(run(["build", "--root", root, "--author", "demo", "--check"]).code, 0);
});

test("accept refuses duplicates and unknown ids and then writes nothing", () => {
  const { root, profile } = prepare();
  const before = fs.readFileSync(profile, "utf8");
  const clash = run(["accept", "--root", root, "--author", "demo", "M1", "M2"]);
  assert.equal(clash.code, 2);
  assert.match(clash.stderr, /重なる項目があるので何も書いていない: M2/u);
  assert.equal(run(["accept", "--root", root, "--author", "demo", "M1", "M1"]).code, 2);
  assert.match(run(["accept", "--root", root, "--author", "demo", "M9"]).stderr, /M9 は proposal\.yml の model_leaning にない/u);
  assert.match(run(["accept", "--root", root, "--author", "demo", "T.sentence_length"]).stderr, /thresholds\.sentence_length はもう 60/u);
  assert.match(run(["accept", "--root", root, "--author", "demo", "O1=x"]).stderr, /message を付けられない/u);
  assert.equal(fs.readFileSync(profile, "utf8"), before);
});

test("accept T takes every proposed threshold except values that would turn a check off", () => {
  const { root, profile } = prepare("model_leaning: []\nthresholds: {}\nallow: []\n");
  const result = run(["accept", "--root", root, "--author", "demo", "T"]);
  assert.equal(result.code, 0, result.stderr);
  const parsed = YAML.parse(fs.readFileSync(profile, "utf8"));
  assert.deepEqual(parsed.thresholds, { sentence_length: 120, max_ten: 4, list_ratio: 0.3, decoration_min_chars: 1500, bold_label_items: 0, density_min_chars: 1500 });
  assert.deepEqual(parsed.allow, []);
  const single = run(["accept", "--root", root, "--author", "demo", "T.bold_per_1000=2.5"]);
  assert.equal(single.code, 0, single.stderr);
  assert.equal(YAML.parse(fs.readFileSync(profile, "utf8")).thresholds.bold_per_1000, 2.5);
  assert.equal(run(["accept", "--root", root, "--author", "demo", "T"]).code, 2);
});
