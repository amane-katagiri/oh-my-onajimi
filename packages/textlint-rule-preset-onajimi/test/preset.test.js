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

test("leaning rules stay off unless configured, so the ai-words-ja built-in dictionary never runs", async () => {
  assert.deepEqual(await lintFixture("decoration-density-off", "builtin.md"), []);
});
