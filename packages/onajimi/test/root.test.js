import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultRoot, resolveRoot } from "../src/paths.js";
import { makeRoot, run, writeFile } from "./helpers.js";

const wrapper = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../bin/onajimi");

test("--root wins over ONAJIMI_ROOT, which wins over the repository root", () => {
  assert.equal(resolveRoot("/a", { ONAJIMI_ROOT: "/b" }), "/a");
  assert.equal(resolveRoot(undefined, { ONAJIMI_ROOT: "/b" }), "/b");
  assert.equal(resolveRoot(undefined, { ONAJIMI_ROOT: "" }), defaultRoot);
  assert.equal(resolveRoot(undefined, {}), defaultRoot);
});

test("init writes under ONAJIMI_ROOT when --root is absent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "onajimi-test-"));
  const result = run(["init", "--author", "fresh"], { env: { ONAJIMI_ROOT: root } });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(fs.readdirSync(path.join(root, "authors/fresh")).sort(), ["corpus.yml", "profile.yml"]);
});

const sourceRoot = () => {
  const root = makeRoot();
  const dir = path.join(root, "authors/demo");
  fs.writeFileSync(path.join(dir, "corpus.yml"), "select: {}\n");
  fs.writeFileSync(path.join(dir, "split.yml"), "profile: []\ndev: []\ntest: []\n");
  fs.mkdirSync(path.join(dir, "profile/_full"), { recursive: true });
  fs.writeFileSync(path.join(dir, "profile/thresholds.yml"), "{}\n");
  fs.writeFileSync(path.join(dir, "profile/_full/candidates.tsv"), "x\n");
  fs.mkdirSync(path.join(dir, "corpus/_control/opus"), { recursive: true });
  fs.writeFileSync(path.join(dir, "corpus/post.md"), "本文。\n");
  fs.writeFileSync(path.join(dir, "corpus/_control/opus/post.md"), "本文。\n");
  return root;
};

test("import copies the profile but not the corpus, then builds", () => {
  const from = sourceRoot();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "onajimi-test-"));
  const result = run(["import", "--root", root, "--from", from, "--author", "demo"]);
  assert.equal(result.code, 0, result.stderr);
  const dir = path.join(root, "authors/demo");
  assert.deepEqual(fs.readdirSync(dir).sort(), ["corpus.yml", "generated", "profile", "profile.yml", "split.yml"]);
  assert.deepEqual(fs.readdirSync(path.join(dir, "profile")), ["thresholds.yml"]);
  assert.ok(fs.existsSync(path.join(dir, "generated/.textlintrc.json")));
  const again = run(["import", "--root", root, "--from", from, "--author", "demo"]);
  assert.equal(again.code, 2);
  assert.match(again.stderr, /はもうある/);
});

test("the plugin wrapper lints from any working directory", () => {
  const from = sourceRoot();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "onajimi-test-"));
  run(["import", "--root", root, "--from", from, "--author", "demo"]);
  const file = writeFile(root, "draft.md", "# 見出し\n\n設定が静かに壊れていた。\n");
  const result = run(["lint", "--root", root, "--author", "demo", file], { command: [wrapper], cwd: os.tmpdir() });
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stdout, /^3:4 model-leaning /u);
});
