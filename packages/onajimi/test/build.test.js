import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeRoot, run } from "./helpers.js";
import { parseProfile } from "../src/build.js";

test("build writes the four generated files and keeps evidence out of messages", () => {
  const root = makeRoot();
  const result = run(["build", "--root", root, "--author", "demo"]);
  assert.equal(result.code, 0, result.stderr);
  const dir = path.join(root, "authors/demo/generated");
  assert.deepEqual(fs.readdirSync(dir).sort(), [".textlintrc.json", "author-leaning.json", "model-leaning.json", "orthography.yml"]);
  const model = JSON.parse(fs.readFileSync(path.join(dir, "model-leaning.json"), "utf8"));
  assert.deepEqual(Object.keys(model.entries[0]).sort(), ["message", "tokens"]);
  const author = JSON.parse(fs.readFileSync(path.join(dir, "author-leaning.json"), "utf8"));
  assert.equal(author.entries[0].message, "筆者は「確かめる」と書く。");
  const rc = JSON.parse(fs.readFileSync(path.join(dir, ".textlintrc.json"), "utf8"));
  assert.equal(rc.rules["preset-onajimi"]["model-leaning"].dictionaryMode, "override");
  assert.equal(rc.rules["preset-onajimi"]["decoration-density"].maxBoldPer1000, 3);
  assert.equal(rc.rules["sentence-length"].max, 60);
  assert.equal(rc.rules["max-ten"].max, 2);
  assert.match(fs.readFileSync(path.join(dir, "orthography.yml"), "utf8"), /expected: できる/);
});

test("build --check passes when up to date and fails after the profile changes", () => {
  const root = makeRoot();
  assert.equal(run(["build", "--root", root, "--author", "demo", "--check"]).code, 1);
  run(["build", "--root", root, "--author", "demo"]);
  assert.equal(run(["build", "--root", root, "--author", "demo", "--check"]).code, 0);
  const profile = path.join(root, "authors/demo/profile.yml");
  fs.writeFileSync(profile, fs.readFileSync(profile, "utf8").replace("max_ten: 2", "max_ten: 3"));
  const stale = run(["build", "--root", root, "--author", "demo", "--check"]);
  assert.equal(stale.code, 1);
  assert.match(stale.stdout, /generated\/\.textlintrc\.json が profile\.yml と食い違っている/);
});

test("thresholds that are not given leave their rules out", () => {
  const root = makeRoot();
  const profile = path.join(root, "authors/demo/profile.yml");
  fs.writeFileSync(profile, "model_leaning: []\n");
  run(["build", "--root", root, "--author", "demo"]);
  const rc = JSON.parse(fs.readFileSync(path.join(root, "authors/demo/generated/.textlintrc.json"), "utf8"));
  assert.equal(rc.rules["sentence-length"], undefined);
  assert.equal(rc.rules["max-ten"], undefined);
  assert.deepEqual(rc.rules["preset-onajimi"]["decoration-density"], { severity: "warning" });
});

test("profile errors name the place", () => {
  assert.throws(() => parseProfile("unknown: 1\n"), /最上位: 知らないキー unknown/);
  assert.throws(() => parseProfile("model_leaning:\n  - tokens: []\n    message: x\n"), /model_leaning\[0\]: tokens/);
  assert.throws(() => parseProfile("author_leaning:\n  - tokens: [{basic_form: a}]\n"), /author_leaning\[0\]: author/);
  assert.throws(() => parseProfile("thresholds:\n  max_ten: -1\n"), /thresholds\.max_ten/);
});

test("build rejects author names that could escape authors/", () => {
  const root = makeRoot();
  const result = run(["build", "--root", root, "--author", "../x"]);
  assert.equal(result.code, 2);
});
