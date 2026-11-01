import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { applyExclusions, parseCorpusConfig, parsePost, selectPosts, splitByDate } from "../src/corpus.js";
import { analyzeProse } from "../src/prose.js";
import { run } from "./helpers.js";
import { makeCorpusRoot, post } from "./corpus-helpers.js";

const config = parseCorpusConfig(YAML.stringify({ select: { author: "Demo", categories: ["tech", "ugoki"], since: "2020-01-01" } }));

test("selection keeps the author, the categories and posts since the date", () => {
  const posts = [
    parsePost("ok", post({ title: "a", date: "2020-01-01", body: "本文。" })),
    parsePost("old", post({ title: "b", date: "2019-12-31", body: "本文。" })),
    parsePost("lily", post({ title: "c", date: "2021-01-01", category: "lily", body: "本文。" })),
    parsePost("other", post({ title: "d", date: "2021-01-01", author: "stewpot", body: "本文。" })),
  ];
  assert.deepEqual(selectPosts(posts, config).map((p) => p.slug), ["ok"]);
});

test("the newest quarter goes to test", () => {
  const posts = ["2020-01-05", "2020-01-01", "2020-01-04", "2020-01-02", "2020-01-03"].map((date, i) =>
    parsePost(`p${i}`, post({ title: "t", date, body: "本文。" })),
  );
  assert.deepEqual(splitByDate(posts, 0.25), { profile: ["p1", "p3", "p4"], dev: [], test: ["p2", "p0"] });
});

test("dev takes the newest part of the profile side and leaves test as it was", () => {
  const posts = Array.from({ length: 20 }, (_, i) => parsePost(`p${String(i).padStart(2, "0")}`, post({ title: "t", date: `2020-02-${String(i + 1).padStart(2, "0")}`, body: "本文。" })));
  const without = splitByDate(posts, 0.25);
  const withDev = splitByDate(posts, 0.25, 0.1);
  assert.deepEqual(withDev.test, without.test);
  assert.deepEqual(withDev.dev, ["p13", "p14"]);
  assert.deepEqual([...withDev.profile, ...withDev.dev], without.profile);
});

test("fenced YAML frontmatter is read as metadata", () => {
  const parsed = parsePost("y", "---\ntitle: 題\ndate: 2021-01-01T10:00:00+09:00\ntags: [a, b]\n---\n\n本文。\n");
  assert.deepEqual(parsed.meta, { title: "題", date: "2021-01-01T10:00:00+09:00" });
});

test("the selection keys are optional, and unknown profile keys are rejected", () => {
  const all = parseCorpusConfig("posts: ~/blog/posts\n");
  assert.deepEqual(all.select, { author: undefined, categories: undefined, since: "" });
  assert.equal(all.posts, "~/blog/posts");
  assert.throws(() => parseCorpusConfig("profile:\n  nope: 1\n"), /profile: 知らないキー nope/u);
  assert.throws(() => parseCorpusConfig("test_ratio: 0.5\ndev_ratio: 0.5\n"), /dev_ratio/u);
});

test("an excluded section is cut from its heading to the end", () => {
  const original = parsePost("b", post({ title: "t", date: "2021-01-01", body: "# 前\n\n筆者の文。\n\n# おまけ\n\nAI の文。\n" }));
  const cut = applyExclusions(original, [{ post: "b", fromHeading: "おまけ" }]);
  assert.match(cut.text, /筆者の文/);
  assert.doesNotMatch(cut.text, /AI の文|おまけ/);
  assert.equal(applyExclusions(parsePost("c", original.text), [{ post: "b", fromHeading: "おまけ" }]).text, original.text);
  assert.throws(() => applyExclusions(original, [{ post: "b", fromHeading: "ない見出し" }]), /ない見出し/);
});

test("prose analysis skips frontmatter, headings, quotes, code, tables, html and skipped paragraphs", () => {
  const markdown = [
    "title: 題",
    "summary: 副題",
    "",
    "/* [thumbnail](/x.png) by [誰か](https://x) */",
    "",
    "[TOC]",
    "",
    "# 見出し",
    "",
    "地の文**太字**です。",
    "",
    "> 引用の文。",
    "",
    "```",
    "コードの文。",
    "```",
    "",
    "| 表 | の文 |",
    "|---|---|",
    "| a | b |",
    "",
    "<div>HTMLの文</div>",
    "",
    "- 項目の文",
    "",
  ].join("\n");
  const prose = analyzeProse(markdown, { skipParagraphs: ["[TOC]", "/^\\/\\*[\\s\\S]*\\*\\/$/"] });
  assert.deepEqual(prose.strs, ["地の文", "太字", "です。", "項目の文"]);
  assert.deepEqual(prose.headings, [{ depth: 1, text: "見出し" }]);
  assert.equal(prose.chars, 12);
});

test("split writes split.yml once and corpus reports the sets", () => {
  const posts = {};
  for (let i = 0; i < 4; i += 1) {
    posts[`p${i}`] = post({ title: `t${i}`, date: `2021-01-0${i + 1}`, body: "本文です。" });
  }
  const { root } = makeCorpusRoot(posts);
  const first = run(["split", "--root", root, "--author", "demo"]);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.stdout, "profile 3 本、dev 0 本、test 1 本、holdout 0 本\nsplit.yml を書いた。\n");
  const split = YAML.parse(fs.readFileSync(path.join(root, "authors/demo/split.yml"), "utf8"));
  assert.deepEqual(split, { profile: ["p0", "p1", "p2"], dev: [], test: ["p3"], holdout: [] });
  const again = run(["split", "--root", root, "--author", "demo"]);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /変更なし/u);
  assert.match(run(["corpus", "--root", root, "--author", "demo"]).stdout, /^profile\t3 本\t15 字\t2021-01-01〜2021-01-03\ndev\t0 本\t0 字\ntest\t1 本\t5 字/u);
});

test("split with a dev ratio writes three sets and eval --set dev reads the dev posts", () => {
  const posts = {};
  for (let i = 0; i < 8; i += 1) {
    posts[`p${i}`] = post({ title: `t${i}`, date: `2021-01-0${i + 1}`, body: "本文です。" });
  }
  const { root } = makeCorpusRoot(posts, { devRatio: 0.25 });
  assert.match(run(["split", "--root", root, "--author", "demo"]).stdout, /^profile 4 本、dev 2 本、test 2 本、holdout 0 本\n/u);
  const split = YAML.parse(fs.readFileSync(path.join(root, "authors/demo/split.yml"), "utf8"));
  assert.deepEqual(split, { profile: ["p0", "p1", "p2", "p3"], dev: ["p4", "p5"], test: ["p6", "p7"], holdout: [] });
  run(["build", "--root", root, "--author", "demo"]);
  const dev = run(["eval", "--root", root, "--author", "demo", "--set", "dev"]);
  assert.equal(dev.code, 0, dev.stderr);
  assert.match(dev.stdout, /\| 誤検出: 筆者 dev \| 2 \|/u);
  assert.match(run(["eval", "--root", root, "--author", "demo"]).stdout, /誤検出: 筆者 test/u);
  assert.equal(run(["eval", "--root", root, "--author", "demo", "--set", "nope"]).code, 2);
});

test("holdout_after sends later posts to holdout, and a second split never moves assigned posts", () => {
  const posts = {};
  for (let i = 0; i < 8; i += 1) {
    posts[`p${i}`] = post({ title: `t${i}`, date: `2021-01-0${i + 1}`, body: "本文です。" });
  }
  const { root } = makeCorpusRoot(posts, { devRatio: 0.25 });
  const configFile = path.join(root, "authors/demo/corpus.yml");
  const config = YAML.parse(fs.readFileSync(configFile, "utf8"));
  fs.writeFileSync(configFile, YAML.stringify({ ...config, holdout_after: "2021-01-06" }));
  run(["split", "--root", root, "--author", "demo"]);
  const splitFile = path.join(root, "authors/demo/split.yml");
  const first = YAML.parse(fs.readFileSync(splitFile, "utf8"));
  assert.deepEqual(first, { profile: ["p0", "p1"], dev: ["p2", "p3"], test: ["p4", "p5"], holdout: ["p6", "p7"] });
  fs.writeFileSync(path.join(root, "authors/demo/corpus/post/new.md"), post({ title: "n", date: "2020-06-01", body: "本文です。" }));
  fs.writeFileSync(configFile, YAML.stringify({ ...config, holdout_after: "2020-01-01", test_ratio: 0.5 }));
  const second = run(["split", "--root", root, "--author", "demo"]);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /holdout に入れた記事: new/u);
  assert.deepEqual(YAML.parse(fs.readFileSync(splitFile, "utf8")), { ...first, holdout: ["p6", "p7", "new"] });
  assert.match(run(["corpus", "--root", root, "--author", "demo"]).stdout, /holdout\t3 本/u);
  run(["build", "--root", root, "--author", "demo"]);
  assert.match(run(["eval", "--root", root, "--author", "demo", "--set", "holdout"]).stdout, /誤検出: 筆者 holdout \| 3 \|/u);
});

test("a split.yml without one of the sets is an error for corpus and split alike", () => {
  const posts = {};
  for (let i = 0; i < 4; i += 1) {
    posts[`p${i}`] = post({ title: `t${i}`, date: `2021-01-0${i + 1}`, body: "本文です。" });
  }
  const { root } = makeCorpusRoot(posts);
  const splitFile = path.join(root, "authors/demo/split.yml");
  const old = YAML.stringify({ profile: ["p0", "p1", "p2"], dev: [], test: ["p3"] });
  fs.writeFileSync(splitFile, old);
  for (const command of ["corpus", "split"]) {
    const result = run([command, "--root", root, "--author", "demo"]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /split\.yml に holdout がない/u);
  }
  assert.equal(fs.readFileSync(splitFile, "utf8"), old);
});
