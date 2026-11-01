"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { lintFixture } = require("./lint");

test("model-leaning fires on a multi-token entry", async () => {
  const messages = await lintFixture("model-leaning", "fires.md");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].ruleId, "onajimi/model-leaning");
  assert.equal(messages[0].severity, 2);
  assert.equal(messages[0].line, 3);
  assert.match(messages[0].message, /静かに壊れる/);
});

test("model-leaning is clean on partial matches and code", async () => {
  assert.deepEqual(await lintFixture("model-leaning", "clean.md"), []);
});

test("author-leaning fires with warning severity across inflection", async () => {
  const messages = await lintFixture("author-leaning", "fires.md");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].ruleId, "onajimi/author-leaning");
  assert.equal(messages[0].severity, 1);
  assert.match(messages[0].message, /確かめる/);
});

test("author-leaning is clean when the author's word is used", async () => {
  assert.deepEqual(await lintFixture("author-leaning", "clean.md"), []);
});

test("decoration-density reports each counted bold at its own position when bold density is exceeded", async () => {
  const messages = await lintFixture("decoration-density", "fires-bold.md");
  assert.deepEqual(messages.map((m) => [m.line, m.column]), [[3, 6], [3, 17], [3, 29]]);
  for (const message of messages) {
    assert.equal(message.ruleId, "onajimi/decoration-density");
    assert.equal(message.message, "この文書の太字は 3 個（目安 0 個まで）。3 個減らす。");
  }
});

test("decoration-density fires once on list ratio", async () => {
  const messages = await lintFixture("decoration-density", "fires-list.md");
  assert.equal(messages.length, 1);
  assert.match(messages[0].message, /箇条書きが多い: 地の文の 0\.\d+ が箇条書き（目安 0.3 以下）/);
});

test("decoration-density is clean on plain prose and ignores quotes and code", async () => {
  assert.deepEqual(await lintFixture("decoration-density", "clean.md"), []);
});

test("decoration-density checks are off without options", async () => {
  assert.deepEqual(await lintFixture("decoration-density-off", "fires-bold.md"), []);
  assert.deepEqual(await lintFixture("decoration-density-off", "fires-list.md"), []);
});

test("model-leaning allows silence the matched span", async () => {
  assert.deepEqual(await lintFixture("model-leaning-allow", "fires.md"), []);
});

test("model-leaning allows ignore text outside the matched span", async () => {
  const messages = await lintFixture("model-leaning-allow-outside", "fires.md");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].column, 8);
});

test("model-leaning needs a dictionary when enabled", async () => {
  await assert.rejects(lintFixture("leaning-no-dictionary", "fires.md"), /dictionaryPath/);
});

test("leaning rules stay off unless configured", async () => {
  assert.deepEqual(await lintFixture("decoration-density-off", "builtin.md"), []);
});

test("phrase-density reports every occurrence of an exceeded entry with the count to cut", async () => {
  const messages = await lintFixture("phrase-density", "fires.md");
  assert.deepEqual(messages.map((m) => [m.line, m.column]), [[3, 7], [3, 17], [3, 28], [3, 54], [5, 7]]);
  for (const message of messages) {
    assert.equal(message.ruleId, "onajimi/phrase-density");
    assert.equal(message.message, "「思う」が多い。この文書では 5 回（目安 1 回まで）。4 回減らす。");
  }
});

test("phrase-density is clean under the threshold, ignores headings and quotes, and skips documents shorter than min_chars", async () => {
  assert.deepEqual(await lintFixture("phrase-density", "clean.md"), []);
  assert.deepEqual(await lintFixture("phrase-density", "short.md"), []);
});

test("decoration-density skips the bold check on documents shorter than minChars", async () => {
  assert.deepEqual(await lintFixture("decoration-emphasis", "short-bold.md"), []);
});

test("decoration-density reports each list item that opens with bold followed by more text, with or without a colon", async () => {
  const messages = (await lintFixture("decoration-emphasis", "fires-label.md")).filter((m) => /頭を太字/u.test(m.message));
  assert.deepEqual(messages.map((m) => [m.line, m.column]), [[3, 1], [4, 1], [5, 1]]);
  assert.match(messages[0].message, /この文書に 3 個、目安 0 個以下/u);
});

test("decoration-density fires once when emphasis leans on bold", async () => {
  const messages = await lintFixture("decoration-emphasis", "fires-emphasis.md");
  assert.equal(messages.length, 1);
  assert.match(messages[0].message, /斜体の割合 0\.25（筆者はふつう 0\.6、目安 0\.3 以上）/u);
});

test("decoration-density is clean on italic-leaning emphasis, all-bold items and bold later in an item", async () => {
  assert.deepEqual(await lintFixture("decoration-emphasis", "clean.md"), []);
});

test("leaning and density entries do not match across emphasis, inline code, line breaks or paragraphs", async () => {
  assert.deepEqual(await lintFixture("node-boundaries", "split.md"), []);
});

test("a partial match in one paragraph does not move the next finding", async () => {
  const messages = await lintFixture("node-boundaries", "mixed.md");
  const leaning = messages.filter((m) => m.ruleId === "onajimi/model-leaning");
  assert.deepEqual(leaning.map((m) => [m.line, m.column]), [[5, 11]]);
  assert.equal(messages.filter((m) => m.ruleId === "onajimi/phrase-density").length, 1);
});
