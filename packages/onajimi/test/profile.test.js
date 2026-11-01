import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { aggregate, compare, docFeatures, featuresOfMarkdown, isContentWord, logOddsZ, snippet } from "../src/profile.js";
import { measureArticle, proposeThresholds } from "../src/stats.js";
import { run } from "./helpers.js";
import { makeCorpusRoot, post } from "./corpus-helpers.js";

test("log-odds with an informative Dirichlet prior matches a hand computation", () => {
  // α_w = 10 × 12/200 = 0.6, δ = ln(10.6/99.4) − ln(2.6/107.4) = 1.48275, σ² = 1/10.6 + 1/2.6
  assert.ok(Math.abs(logOddsZ(10, 2, 100, 100, 10) - 2.1425) < 1e-4);
  assert.ok(Math.abs(logOddsZ(2, 10, 100, 100, 10) + 2.1425) < 1e-4);
  assert.equal(logOddsZ(5, 5, 100, 100, 10), 0);
});

test("features are content-word unigrams and adjacent bigrams by basic form", async () => {
  const { features } = await featuresOfMarkdown("動作を確認した。2024年に確認する。\n");
  assert.equal(features.get("確認/名詞").count, 2);
  assert.equal(features.get("確認+する").count, 2);
  assert.deepEqual(features.get("確認+する").tokens, [{ basic_form: "確認" }, { basic_form: "する" }]);
  assert.deepEqual([...features.get("確認+する").surfaces], [["確認し", 1], ["確認する", 1]]);
  assert.equal(features.get("2/名詞"), undefined);
  assert.equal([...features.keys()].some((key) => key.startsWith("4+")), false);
  assert.equal(isContentWord({ pos: "名詞", pos_detail_1: "非自立", surface_form: "こと" }), false);
  const ascii = (await featuresOfMarkdown("UTF-8の0x85とU+0000はWebの話。\n")).features;
  for (const key of ["x/名詞", "U/名詞", "Web/名詞"]) {
    assert.equal(ascii.get(key), undefined, key);
  }
  assert.equal([...ascii.keys()].some((key) => /^[\x21-\x7e]+\+[\x21-\x7e]+$/u.test(key)), false);
  assert.ok(ascii.get("Web+の"));
});

test("snippets stay within 40 characters", () => {
  const text = `${"あ".repeat(50)}確認${"い".repeat(50)}。次の文。`;
  const short = snippet(text, 50, 52);
  assert.ok([...short].length <= 40);
  assert.match(short, /確認/);
  assert.equal(snippet("前の文。短い確認の文。後の文。", 6, 8), "短い確認の文。");
});

test("compare keeps model-leaning features seen in enough control documents", () => {
  const doc = (id, words) => ({ id, features: docFeatures([{ text: words.join(""), tokens: words.map((w, i) => ({ surface_form: w, basic_form: w, pos: "名詞", pos_detail_1: "一般", word_position: i + 1 })) }]) });
  const author = aggregate([doc("a1", ["猫", "犬", "猫"]), doc("a2", ["猫", "犬"])]);
  const control = aggregate([doc("c1", ["鍵", "鍵", "犬"]), doc("c2", ["鍵", "猫"])]);
  const other = aggregate([doc("o1", ["象"]), doc("o2", ["象"])]);
  const rows = compare(author, { m: control, o: other }, { alpha0: 10, min_docs: 2, min_count: 2 });
  assert.equal(rows.find((row) => row.feature === "象/名詞").z.m, undefined);
  assert.ok(rows.every((row) => Number.isFinite(row.score)));
  const unigrams = rows.filter((row) => row.kind === "unigram" && row.feature !== "象/名詞");
  assert.equal(unigrams[0].feature, "鍵/名詞");
  assert.equal(unigrams[0].modelLeaning.m, true);
  assert.ok(unigrams[0].z.m < 0);
  assert.equal(unigrams.at(-1).feature, "猫/名詞");
  assert.equal(unigrams.at(-1).authorLeaning, true);
});

test("article measures follow sentence-length, max-ten and decoration-density", async () => {
  const markdown = ["東京、大阪、名古屋に行き、食べ、寝た。短い。", "", "**太字**の文。", "", "- 項目", "", "> 引用、引用、引用、引用、引用。", ""].join("\n");
  const measure = await measureArticle(markdown);
  assert.equal(measure.sentence_length, 19);
  assert.equal(measure.max_ten, 2);
  assert.equal(measure.bold_per_1000, Number(((1 / measure.proseChars) * 1000).toFixed(1)));
  assert.equal(measure.list_ratio, Number((2 / measure.proseChars).toFixed(2)));
});

test("proposed thresholds are not exceeded by any article; stricter ones are the 90th percentile", () => {
  const articles = Array.from({ length: 10 }, (_, i) => ({ sentence_length: 50 + i, max_ten: i % 4, bold_per_1000: i * 0.33, list_ratio: i * 0.031, lengths: [], tens: [] }));
  const result = proposeThresholds(articles);
  assert.equal(result.sentence_length.proposed, 59);
  assert.equal(result.sentence_length.stricter, 58);
  assert.equal(result.sentence_length.stricter_exceeds, 1);
  assert.equal(result.bold_per_1000.proposed, 3);
  assert.equal(result.list_ratio.proposed, 0.28);
  assert.equal(result.max_ten.proposed, 3);
});

test("profile writes candidates, a proposal and thresholds from cached controls", () => {
  const body = (extra) => `# 見出し\n\n今日は動作を${extra}。結果を書いた。\n`;
  const { root } = makeCorpusRoot({
    a: post({ title: "A", date: "2021-01-01", body: body("確かめた") }),
    b: post({ title: "B", date: "2021-01-02", body: body("確かめた") }),
    c: post({ title: "C", date: "2021-01-03", body: body("確かめた") }),
    d: post({ title: "D", date: "2021-01-04", body: body("確かめた") }),
  });
  assert.equal(run(["split", "--root", root, "--author", "demo"]).code, 0);
  const dir = path.join(root, "authors/demo/corpus/_control/fake");
  fs.mkdirSync(dir, { recursive: true });
  for (const slug of ["a", "b"]) {
    fs.writeFileSync(path.join(dir, `${slug}.md`), "# 見出し\n\n今日は動作を確認した。徹底的に確認した。\n");
  }
  const result = run(["profile", "--root", root, "--author", "demo"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /author 3 本 \d+ 字、fake 2 本/u);
  const out = path.join(root, "authors/demo/profile");
  const [header, ...rows] = fs.readFileSync(path.join(out, "candidates.tsv"), "utf8").trimEnd().split("\n");
  const columns = header.split("\t");
  assert.deepEqual(columns.slice(0, 8), ["feature", "kind", "z_fake", "z_limited", "z_flaky", "z_down", "author_count", "author_docs"]);
  const field = (cells, name) => cells[columns.indexOf(name)];
  const full = fs.readFileSync(path.join(out, "_full/candidates.tsv"), "utf8").trimEnd().split("\n");
  const kakunin = full.map((row) => row.split("\t")).find((cells) => cells[0] === "確認+する");
  assert.ok(Number(field(kakunin, "z_fake")) < 0);
  assert.equal(field(kakunin, "z_limited"), "");
  assert.equal(field(kakunin, "surfaces"), "確認し");
  const proposal = YAML.parse(fs.readFileSync(path.join(out, "proposal.yml"), "utf8"));
  assert.ok(proposal.model_leaning.some((entry) => entry.evidence.feature === "確認+する"));
  assert.deepEqual(Object.keys(proposal.thresholds), ["sentence_length", "max_ten", "bold_per_1000", "list_ratio"]);
  assert.ok(fs.existsSync(path.join(out, "thresholds.yml")));
  assert.ok(full.length > rows.length + 1);
  for (const row of rows) {
    const z = row.split("\t").slice(2, 6).filter(Boolean).map(Number);
    assert.ok(z.some((value) => Math.abs(value) >= 2), row);
  }
});
