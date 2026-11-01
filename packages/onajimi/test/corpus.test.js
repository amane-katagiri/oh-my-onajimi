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
  assert.deepEqual(splitByDate(posts, 0.25), { profile: ["p1", "p3", "p4"], test: ["p2", "p0"] });
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
  assert.equal(first.stdout, "profile 3 本、test 1 本\n");
  const split = YAML.parse(fs.readFileSync(path.join(root, "authors/demo/split.yml"), "utf8"));
  assert.deepEqual(split, { profile: ["p0", "p1", "p2"], test: ["p3"] });
  assert.equal(run(["split", "--root", root, "--author", "demo"]).code, 2);
  assert.match(run(["corpus", "--root", root, "--author", "demo"]).stdout, /^profile\t3 本\t15 字\t2021-01-01〜2021-01-03\ntest\t1 本\t5 字/u);
});
