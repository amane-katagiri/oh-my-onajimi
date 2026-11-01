import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapMeanCi, editRatio, excerpt, median, pickExamples, revisePrompt, signTest, stylePrompt } from "../src/abc.js";
import { centroid, delta, dictionaryTokens, fitScaler, mostFrequent, tokenCounts, zVector } from "../src/delta.js";
import { proseParagraphs } from "../src/prose.js";
import { run } from "./helpers.js";
import { makeCorpusRoot, post } from "./corpus-helpers.js";

const fakeRunner = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/fake-runner.js");

test("proseParagraphs keeps paragraphs and drops frontmatter, headings, quotes, code and skipped paragraphs", () => {
  const markdown = ["title: 題", "date: 2021-01-01", "", "# 見出し", "", "一段落目の`code`です。", "", "> 引用", "", "```", "コード", "```", "", "[TOC]", "", "- 箇条書き", ""].join("\n");
  assert.deepEqual(proseParagraphs(markdown, { skipParagraphs: ["[TOC]"] }), ["一段落目のcodeです。", "箇条書き"]);
});

test("excerpt stops at a paragraph boundary and cuts a single long paragraph", () => {
  assert.equal(excerpt(["あいう", "えお", "かきくけ"], 6), "あいう\n\nえお");
  assert.equal(excerpt(["あいうえおか"], 3), "あいう");
});

test("pickExamples takes the newest posts", () => {
  const posts = ["2021-01-01", "2023-01-01", "2022-01-01", "2020-01-01"].map((date, i) => ({ slug: `p${i}`, meta: { date } }));
  assert.deepEqual(pickExamples(posts).map((p) => p.slug), ["p1", "p2", "p0"]);
});

test("pickExamples can be limited to one category", () => {
  const posts = [["2021-01-01", "tech"], ["2023-01-01", "ugoki"], ["2022-01-01", "tech"], ["2020-01-01", "tech"], ["2024-01-01", "ugoki"]].map(([date, category], i) => ({ slug: `p${i}`, meta: { date, category } }));
  assert.deepEqual(pickExamples(posts, "tech").map((p) => p.slug), ["p2", "p0", "p3"]);
});

test("prompts carry the base prompt, the examples, the findings and the draft", () => {
  const b = stylePrompt("書いてください。", [{ title: "例題", text: "例の本文。" }]);
  assert.match(b, /^書いてください。\n\nこの筆者の文体で書いてください。/u);
  assert.match(b, /--- 例 1: 例題 ---\n例の本文。\n\n--- 例ここまで ---$/u);
  const c = revisePrompt("# 題\n\n本文。\n", ["3:1 orthography 出来る => できる ｜ 本文。"]);
  assert.match(c, /K 箇所だけを直し/u);
  assert.match(c, /\n3:1 orthography 出来る => できる ｜ 本文。\n/u);
  assert.match(c, /--- 下書きここから ---\n# 題\n\n本文。\n--- 下書きここまで ---$/u);
});

test("Delta is zero for identical documents and uses only features that vary", async () => {
  const docs = [];
  for (const text of ["猫が寝た。猫が起きた。", "犬が走った。", "猫と犬が遊んだ。"]) {
    docs.push(await tokenCounts(text, {}));
  }
  const vocab = mostFrequent(docs, 5);
  assert.equal(vocab.length, 5);
  assert.equal(vocab[0], "。");
  const features = fitScaler(docs, vocab);
  assert.ok(features.every((feature) => feature.sd > 0));
  const z = docs.map((doc) => zVector(features, doc));
  assert.equal(delta(z[0], z[0]), 0);
  assert.ok(delta(z[0], z[1]) > 0);
  assert.deepEqual(centroid([[1, 2], [3, 4]]), [2, 3]);
  assert.ok(!mostFrequent(docs, 3, (key) => key === "。").includes("。"));
});

test("dictionaryTokens matches orthography forms and density tokens", () => {
  const isDictionary = dictionaryTokens({
    orthography: [{ expected: "分か", pattern: "/わか(?=[っらりるれ])/" }, { expected: "全て", pattern: "すべて" }],
    density: [{ tokens: [{ basic_form: "を" }, { basic_form: "、" }] }],
    modelLeaning: [],
    authorLeaning: [{ tokens: [{ surface_form: "確認" }] }],
  });
  for (const key of ["分かる", "わかる", "全て", "すべて", "を", "、", "確認"]) {
    assert.ok(isDictionary(key), key);
  }
  for (const key of ["わかめ", "が", "。"]) {
    assert.ok(!isDictionary(key), key);
  }
});

test("statistics helpers", () => {
  assert.equal(signTest(5, 0), 0.0625);
  assert.equal(signTest(1, 1), 1);
  assert.equal(signTest(0, 0), 1);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.deepEqual(bootstrapMeanCi([1, 1, 1]), [1, 1]);
  const [low, high] = bootstrapMeanCi([-1, -2, 0, -3]);
  assert.ok(low >= -3 && high <= 0 && low < high);
  assert.equal(editRatio("あいう", "あいう"), 0);
  assert.equal(editRatio("あいう", "かきく"), 1);
  assert.equal(editRatio("ab", "abcd"), 1 - 4 / 6);
});

const prepare = () => {
  const bodies = ["今日は猫を見た。とても眠そうだった。", "犬が走る。私は追いかけた。", "雨が降った。傘を忘れた。", "本を読んだ。面白かった。"];
  const titles = { p09: "通の題", p10: "数の題", p11: "素の題" };
  const posts = {};
  for (let i = 0; i < 12; i += 1) {
    const slug = `p${String(i).padStart(2, "0")}`;
    posts[slug] = post({ title: titles[slug] ?? `題${i}`, date: `2021-01-${String(i + 1).padStart(2, "0")}`, body: `# 見出し${i}\n\n${bodies[i % 4]}${"それから考えた。".repeat(i % 3)}\n` });
  }
  const { root, log } = makeCorpusRoot(posts, { runners: { fake: { model: "fake", command: [process.execPath, fakeRunner, "LOG", "abc"], output: "json", meta_fields: ["total_cost_usd"] } } });
  const config = path.join(root, "authors/demo/corpus.yml");
  fs.writeFileSync(config, fs.readFileSync(config, "utf8").replace("LOG", log));
  for (const args of [["split"], ["build"], ["control", "--runner", "fake", "--set", "all", "--yes"]]) {
    const result = run([...args, "--root", root, "--author", "demo"]);
    assert.equal(result.code, 0, result.stderr);
  }
  return { root, log, dir: path.join(root, "authors/demo/experiments/abc") };
};

const calls = (log) => fs.readFileSync(log, "utf8").split("\n").filter(Boolean).length;

test("abc estimates, gates on --yes, runs B and C once, and reports", () => {
  const { root, log, dir } = prepare();
  const base = ["abc", "--root", root, "--author", "demo", "--delay", "0"];
  const before = calls(log);
  const gated = run(base);
  assert.equal(gated.code, 5, gated.stderr);
  assert.match(gated.stdout, /^runner fake、test 3 本、例: p08, p07, p06\nB: 呼び出し 3 本（新規 3・作り直し 0）、既存 0 本、約 \d+ 秒、約 \$0\.03（A の 3 本の平均から）\nC: 呼び出し 2 本（新規 2・作り直し 0）、指摘なしで A のまま 1 本、既存 0 本/u);
  assert.equal(run([...base, "--estimate"]).code, 0);
  assert.equal(calls(log), before);
  assert.equal(fs.existsSync(dir), false);

  const first = run([...base, "--yes", "--limit", "1"]);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /^呼び出し 1、A のまま 0、既存 0、失敗 0、guard 失敗 0\nB p09: /u);
  const second = run([...base, "--yes"]);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /^呼び出し 4、A のまま 1、既存 1、失敗 0、guard 失敗 1\n/u);
  assert.equal(calls(log), before + 5);
  assert.match(run([...base, "--estimate"]).stdout, /B: 呼び出し 0 本（新規 0・作り直し 0）、既存 3 本\nC: 呼び出し 0 本（新規 0・作り直し 0）、指摘なしで A のまま 0 本、既存 3 本/u);
  assert.equal(run([...base, "--yes"]).stdout, "呼び出し 0、A のまま 0、既存 6、失敗 0、guard 失敗 0\n");
  assert.equal(calls(log), before + 5);

  assert.match(fs.readFileSync(path.join(dir, "B/p09.md"), "utf8"), /例を読んだ。/u);
  const bMeta = JSON.parse(fs.readFileSync(path.join(dir, "B/p09.json"), "utf8"));
  assert.deepEqual(bMeta.examples, ["p08", "p07", "p06"]);
  assert.equal(bMeta.total_cost_usd, 0.01);
  const passed = JSON.parse(fs.readFileSync(path.join(dir, "C/p09.json"), "utf8"));
  assert.equal(passed.findings, 1);
  assert.deepEqual(passed.guard, { pass: true, problems: [] });
  assert.match(fs.readFileSync(path.join(dir, "C/p09.md"), "utf8"), /これならできる。/u);
  const broken = JSON.parse(fs.readFileSync(path.join(dir, "C/p10.json"), "utf8"));
  assert.equal(broken.guard.pass, false);
  assert.match(fs.readFileSync(path.join(dir, "C/p10.md"), "utf8"), /何回か試した/u);
  const copied = JSON.parse(fs.readFileSync(path.join(dir, "C/p11.json"), "utf8"));
  assert.equal(copied.called, false);
  assert.equal(fs.readFileSync(path.join(dir, "C/p11.md"), "utf8"), fs.readFileSync(path.join(root, "authors/demo/corpus/_control/fake/p11.md"), "utf8"));

  const report = run([...base, "--report"]);
  assert.equal(report.code, 0, report.stderr);
  assert.equal(calls(log), before + 5);
  const text = fs.readFileSync(path.join(dir, "report.md"), "utf8");
  assert.match(text, /^# A\/B\/C（test 3 本、runner fake）/u);
  for (const heading of ["1. Burrows の Delta", "2. プロファイル用の筆者の重心", "3. N を変えたとき", "4. lint の指摘", "5. 壊していないか", "6. 費用と時間", "7. 記事ごと"]) {
    assert.match(text, new RegExp(`## ${heading}`, "u"), heading);
  }
  assert.match(text, /C で呼び出した 2 本のうち guard 通過 1 本。指摘なしで A のままの記事 1 本/u);
  assert.match(text, /\| C vs A \| \d \| \d \| \d \| /u);
  assert.match(text, /\| p10 \| 1 \| する \| 失敗 \| /u);
  assert.match(text, /- p10: 数値 3 が減った/u);
  assert.match(text, /\| B \| 3 \| 0\.03 \| 0\.010 \| /u);
});

test("abc refuses when A is missing for the chosen posts", () => {
  const { root } = prepare();
  fs.rmSync(path.join(root, "authors/demo/corpus/_control/fake/p10.md"));
  const result = run(["abc", "--root", root, "--author", "demo", "--estimate"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /A（fake の対照）がない: p10/u);
});
