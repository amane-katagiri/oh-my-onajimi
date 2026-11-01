import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { parseCorpusConfig } from "../src/corpus.js";
import { parseProfile } from "../src/build.js";
import { renderReview, truncate } from "../src/review.js";
import { run } from "./helpers.js";
import { makeCorpusRoot, post } from "./corpus-helpers.js";
import { fileURLToPath } from "node:url";

const fakeRunner = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/fake-runner.js");

const corpusPosts = () => {
  const posts = {};
  for (let i = 0; i < 8; i += 1) {
    const extra = i === 5 ? `設定が静かに壊れた。${"長い文が続く".repeat(15)}。` : "動作を確かめた。";
    posts[`p${i}`] = post({ title: `題${i}`, date: `2021-01-0${i + 1}`, body: `# 見出し${i}\n\n今日は${extra}結果を書いた。\n` });
  }
  return posts;
};

test("pipeline runs split, control for every runner, profile, build and review, and review.md is compact", () => {
  const { root, log } = makeCorpusRoot(corpusPosts(), {
    devRatio: 0.25,
    runners: { fake: { command: [process.execPath, fakeRunner, "LOG", "ok"], output: "json" } },
  });
  const config = path.join(root, "authors/demo/corpus.yml");
  fs.writeFileSync(config, fs.readFileSync(config, "utf8").replace("LOG", log));
  const result = run(["pipeline", "--root", root, "--author", "demo"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^split: profile 4 本、dev 2 本、test 2 本\ncontrol fake: 生成 8/u);
  const review = fs.readFileSync(path.join(root, "authors/demo/profile/review.md"), "utf8");
  for (const heading of ["model_leaning の候補", "excluded_in_brief", "表記の候補（orthography）", "密度の候補", "筆者寄りの語", "しきい値", "dev の指摘"]) {
    assert.match(review, new RegExp(`## .*${heading.replace(/[()（）]/gu, ".")}`, "u"), heading);
  }
  const finding = review.split("\n").find((line) => line.startsWith("- p5:"));
  assert.match(finding, /^- p5:10 model-leaning .*｜今日は設定が静かに壊れた。/u);
  assert.ok([...finding.split("｜").at(-1)].length <= 61);
  assert.match(review, /\| 誤検出: 筆者 dev \| 2 \|/u);
  assert.ok(review.split("\n").length < 600);
  const again = run(["pipeline", "--root", root, "--author", "demo"]);
  assert.match(again.stdout, /^control fake: 生成 0（うち作り直し 0）、既存 8/u);
});

test("pipeline stops before profile when a runner hits its rate limit, and --limit caps new generations", () => {
  const { root } = makeCorpusRoot(corpusPosts(), { devRatio: 0.25 });
  const config = path.join(root, "authors/demo/corpus.yml");
  const parsed = YAML.parse(fs.readFileSync(config, "utf8"));
  parsed.control.runners = { fake: parsed.control.runners.fake, limited: parsed.control.runners.limited };
  fs.writeFileSync(config, YAML.stringify(parsed));
  const first = run(["pipeline", "--root", root, "--author", "demo", "--limit", "2"]);
  assert.equal(first.code, 3, first.stderr);
  assert.match(first.stdout, /control fake: 生成 2/u);
  assert.match(first.stdout, /profile と review は実行していない/u);
  assert.equal(fs.existsSync(path.join(root, "authors/demo/profile/review.md")), false);
  const second = run(["pipeline", "--root", root, "--author", "demo", "--limit", "2"]);
  assert.match(second.stdout, /control fake: 生成 2（うち作り直し 0）、既存 2/u);
});

test("init writes a starter corpus.yml and an empty profile.yml, and refuses to overwrite", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "onajimi-init-"));
  const result = run(["init", "--root", root, "--author", "newbie", "--posts", "~/blog/content/post"]);
  assert.equal(result.code, 0, result.stderr);
  const text = fs.readFileSync(path.join(root, "authors/newbie/corpus.yml"), "utf8");
  assert.doesNotMatch(text, /#/u);
  const config = parseCorpusConfig(text);
  assert.equal(config.posts, "~/blog/content/post");
  assert.deepEqual(Object.keys(config.control.runners), ["opus", "gemini"]);
  assert.match(config.control.prompt, /\{outline\}/u);
  assert.equal(config.profile.min_chars, 1500);
  const profile = parseProfile(fs.readFileSync(path.join(root, "authors/newbie/profile.yml"), "utf8"));
  assert.deepEqual(profile.modelLeaning, []);
  assert.equal(run(["init", "--root", root, "--author", "newbie"]).code, 2);
  assert.equal(run(["build", "--root", root, "--author", "newbie"]).code, 0);
});

test("review rows show z, counts, brief and register columns, context and examples", () => {
  const evidence = {
    feature: "どこ+か",
    z: { opus: -5.1, gemini: -6 },
    author_count: 2,
    author_docs: 2,
    control: { opus: { count: 46, docs: 30 }, gemini: { count: 55, docs: 33 } },
    in_brief_docs: 0,
    author_other_per_1000: 0.4,
    control_per_1000: 0.9,
    author_next: "に/助詞 1",
    control_next: "懐かしい/形容詞 9",
    author_example: `slug: ${"あ".repeat(50)}`,
    control_example: "c: どこか懐かしい。",
  };
  const text = renderReview({
    author: "demo",
    proposal: { sides: { author: { docs: 3, chars: 100 } }, model_leaning: [{ message: "「どこか」は筆者の言い方ではない。", note: "ジャンルで変わる", evidence }] },
    thresholds: { articles: 3 },
    evalRows: [],
    findings: [],
    stale: ["model-leaning.json"],
  });
  assert.match(text, /- \*\*どこか\*\*（どこ\+か）z opus -5\.1 \/ gemini -6｜筆者 2回・2本｜opus 46回・30本、gemini 55回・33本｜指示 0本｜他ジャンル 0\.4\/1000（対照 0\.9）/u);
  assert.match(text, /後ろ: 筆者 に\/助詞 1｜対照 懐かしい\/形容詞 9/u);
  assert.match(text, new RegExp(`例: 筆者「${"あ".repeat(40)}…」｜対照「どこか懐かしい。」`, "u"));
  assert.match(text, /注: ジャンルで変わる/u);
  assert.match(text, /generated\/ が profile\.yml と食い違っている/u);
  assert.equal(truncate("abc", 2), "ab…");
});
