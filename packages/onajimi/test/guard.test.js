import test from "node:test";
import assert from "node:assert/strict";
import { countNegations, extractNumbers, guard, isConjecture, isQuestion, sentencesOf } from "../src/guard.js";
import { makeRoot, run, writeFile } from "./helpers.js";

test("numbers are compared after NFKC and kanji normalization", () => {
  assert.deepEqual(guard("会議は3日に１０００円で、三十分かかった。", "会議は三日に1,000円で、30分かかった。"), []);
  assert.deepEqual(guard("参加者は2千人。", "参加者は2000人。"), []);
  assert.deepEqual(guard("第三章を読む。", "第3章を読む。"), []);
});

test("words that only contain numeral kanji are not numbers", () => {
  assert.deepEqual(extractNumbers("一般的に一緒に十分に確かめた。統一する。"), []);
  assert.deepEqual(extractNumbers("三十分と十分間"), ["30", "10"]);
  assert.deepEqual(extractNumbers("v2の1.2.3"), ["1.2.3"]);
});

test("a changed number is caught", () => {
  assert.deepEqual(guard("締め切りは3日後。", "締め切りは5日後。"), [
    "数値 3 が減った（1 → 0 個）。元に戻す。",
    "数値 5 が増えた（0 → 1 個）。元にない数値を足していないか見る。",
  ]);
});

test("numbers in code are ignored", () => {
  const before = "本文。\n\n```js\nconst a = 1;\n```\n\n`x = 2` を使う。\n";
  const after = "本文。\n\n```js\nconst a = 9;\n```\n\n`x = 7` を使う。\n";
  assert.deepEqual(guard(before, after), []);
});

test("obligation, conjecture and idiomatic forms are masked before counting negations", () => {
  assert.equal(countNegations("設定を変更しなければならない。"), 0);
  assert.equal(countNegations("壊れているかもしれない。"), 0);
  assert.equal(countNegations("速いとは限らない。"), 0);
  assert.equal(countNegations("残りは少ない。道が危ない。"), 0);
  assert.equal(countNegations("AではなくBだ。まず、読む。必ず読む。"), 0);
  assert.deepEqual(guard("設定を変更する必要がある。", "設定を変更しなければならない。"), []);
  assert.deepEqual(guard("候補は多い。", "候補は少ない。"), []);
});

test("a real negation flip is caught", () => {
  assert.deepEqual(guard("この機能は Windows に対応している。", "この機能は Windows に対応していない。"), [
    "否定の数が変わった（0 → 1）。肯定と否定が入れ替わった文を元に戻す。",
  ]);
  assert.equal(guard("動かない。", "動く。").length, 1);
});

test("guard CLI exits 0 silently when nothing changed and 1 with messages otherwise", () => {
  const root = makeRoot();
  const before = writeFile(root, "draft.md", "title: x\n\n3つの手順を確認しなければならない。\n");
  const same = writeFile(root, "same.md", "title: x\n\n三つの手順を確かめなければならない。\n");
  const flipped = writeFile(root, "flip.md", "title: x\n\n3つの手順を確かめない。\n");
  assert.deepEqual(run(["guard", before, same]), { code: 0, stdout: "", stderr: "" });
  const result = run(["guard", before, flipped]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /否定の数が変わった/);
});

test("sentences are split per block with inline code masked", () => {
  assert.deepEqual(sentencesOf("これは`a?`です。動くか？\n\n# 見出しか\n\n「すごくないですか？」と言った。"), ["これは＿です。", "動くか？", "見出しか", "「すごくないですか？」", "と言った。"]);
  assert.equal(isQuestion("原因は明らかか。"), true);
  assert.equal(isQuestion("原因は明らか。"), false);
  assert.equal(isQuestion("ほかに手はある。ほか"), false);
  assert.equal(isQuestion("一種の死ではないかと思う。"), true);
  assert.equal(isConjecture("雨が降るだろう。"), true);
  assert.equal(isConjecture("犯人は学生らしい。"), true);
  assert.equal(isConjecture("素晴らしい。"), false);
  assert.equal(isConjecture("晴れるでしょうか。"), false);
});

test("a question turned into an assertion is caught; a rewrite keeping the question passes", () => {
  assert.deepEqual(guard("強制リセットは一種の死ではないか。", "強制リセットは一種の死にあたる。"), [
    "問いの文が減った（1 → 0）。断定や地の文に変えた問いを元に戻す。",
  ]);
  assert.deepEqual(guard("強制リセットは一種の死ではないか。", "強制リセットは、一種の死ではないだろうか。"), []);
  assert.ok(guard("でしょうか、でしょうか", "はっきりしません").includes("問いの文が減った（1 → 0）。断定や地の文に変えた問いを元に戻す。"));
});

test("a conjecture turned into an assertion is caught", () => {
  assert.deepEqual(guard("明日は晴れるだろう。", "明日は晴れる。"), ["推量の文が減った（1 → 0）。断定に変えた推量を元に戻す。"]);
  assert.deepEqual(guard("明日は晴れる。", "明日は晴れるかもしれない。"), ["推量の文が増えた（0 → 1）。断定を推量に変えていないか見る。"]);
  assert.deepEqual(guard("明日は晴れるだろう。", "明日はきっと晴れるでしょう。"), []);
});
