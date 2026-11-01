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

test("decoration-density fires once on bold density", async () => {
  const messages = await lintFixture("decoration-density", "fires-bold.md");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].ruleId, "onajimi/decoration-density");
  assert.match(messages[0].message, /太字が多い: 1000字あたり [\d.]+ 個（目安 5 以下）/);
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

test("phrase-density fires once per entry when the rate exceeds the threshold", async () => {
  const messages = await lintFixture("phrase-density", "fires.md");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].ruleId, "onajimi/phrase-density");
  assert.match(messages[0].message, /^「思う」が多い。 1000字あたり [\d.]+（筆者はふつう 4、目安 20 以下）。$/u);
});

test("phrase-density is clean under the threshold, ignores headings and quotes, and skips short documents", async () => {
  assert.deepEqual(await lintFixture("phrase-density", "clean.md"), []);
  assert.deepEqual(await lintFixture("phrase-density", "short.md"), []);
});

test("decoration-density skips the bold check on documents shorter than minChars", async () => {
  assert.deepEqual(await lintFixture("decoration-emphasis", "short-bold.md"), []);
});

test("decoration-density reports each bold-label list item at its own line", async () => {
  const messages = (await lintFixture("decoration-emphasis", "fires-label.md")).filter((m) => /ラベル/u.test(m.message));
  assert.deepEqual(messages.map((m) => [m.line, m.column]), [[3, 1], [4, 1]]);
  assert.match(messages[0].message, /この文書に 2 個、目安 0 個以下/u);
});

test("decoration-density fires once when emphasis leans on bold", async () => {
  const messages = await lintFixture("decoration-emphasis", "fires-emphasis.md");
  assert.equal(messages.length, 1);
  assert.match(messages[0].message, /斜体の割合 0\.25（筆者はふつう 0\.6、目安 0\.3 以上）/u);
});

test("decoration-density is clean on italic-leaning emphasis and colon-free bold items", async () => {
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
