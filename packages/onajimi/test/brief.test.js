import test from "node:test";
import assert from "node:assert/strict";
import { buildBrief, renderPrompt } from "../src/brief.js";
import { parsePost } from "../src/corpus.js";
import { analyzeProse, stripTitle } from "../src/prose.js";
import { measureArticle } from "../src/stats.js";
import { post } from "./corpus-helpers.js";

const body = [
  "# 一つ目",
  "",
  "あ".repeat(130),
  "",
  "## 小見出し",
  "",
  "### 深い見出し",
  "",
  "> # 引用の中の見出し",
  "",
  "# `code` の話",
  "",
  "い".repeat(120),
].join("\n");

test("the brief has title, summary, #/## outline, rounded prose chars and ai_summary", () => {
  const brief = buildBrief(parsePost("x", post({ title: "題", date: "2021-01-01", aiSummary: "要点です。", body })));
  assert.deepEqual(brief, {
    slug: "x",
    title: "題",
    summary: "副題",
    outline: [
      { depth: 1, text: "一つ目" },
      { depth: 2, text: "小見出し" },
      { depth: 1, text: "code の話" },
    ],
    chars: 300,
    points: "要点です。",
  });
});

test("the prompt fills placeholders and marks what is missing", () => {
  const template = "約{chars}字。{title}／{summary}\n{outline}\n要点: {points}";
  const brief = { title: "題", summary: "", outline: [{ depth: 1, text: "A" }, { depth: 2, text: "B" }], chars: 300, points: "" };
  assert.equal(renderPrompt(template, brief), "約300字。題／（なし）\n# A\n## B\n要点: （なし）");
  assert.equal(renderPrompt("{outline}", { ...brief, outline: [] }), "（見出しなし）");
  assert.throws(() => renderPrompt("{style}", brief), /\{style\}/);
});

test("a leading title heading and its subtitle are dropped from control outputs only", async () => {
  const meta = { title: "Latin-1と0x85のなぞ", summary: "CR, LF, そしてNEL――" };
  const control = "# Latin-1 と 0x85 のなぞ\n\n**CR, LF, そしてNEL――**\n\n# 概要\n\n本文。\n";
  assert.equal(stripTitle(control, meta), "\n\n\n\n# 概要\n\n本文。\n");
  assert.equal(stripTitle("# Latin-1と0x85のなぞ\n## CR, LF, そしてNEL――\n\n本文。\n", meta), "\n\n\n本文。\n");
  assert.equal(stripTitle("# Latin-1と0x85のなぞ\n\n**強調**の文。\n", meta), "\n\n**強調**の文。\n");
  assert.equal(stripTitle("# 概要\n\n**CR, LF, そしてNEL――**\n", meta), "# 概要\n\n**CR, LF, そしてNEL――**\n");
  const authorPost = post({ title: meta.title, date: "2021-01-01", body: "# 概要\n\n本文。" });
  assert.equal(stripTitle(authorPost, meta).split("\n").slice(-3).join("\n"), "# 概要\n\n本文。\n".split("\n").slice(-3).join("\n"));
  assert.deepEqual(analyzeProse(stripTitle(authorPost, meta)).headings, [{ depth: 1, text: "概要" }]);
  assert.equal((await measureArticle(stripTitle(control, meta))).bold_per_1000, 0);
});
