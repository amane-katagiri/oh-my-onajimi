import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { dataRoot, resolveRoot } from "../src/paths.js";
import { makeRoot, repoRoot, run, writeFile } from "./helpers.js";

test("--root wins over ONAJIMI_ROOT, which wins over the entry point's default", () => {
  assert.equal(resolveRoot("/a", { ONAJIMI_ROOT: "/b" }, "/c"), "/a");
  assert.equal(resolveRoot(undefined, { ONAJIMI_ROOT: "/b" }, "/c"), "/b");
  assert.equal(resolveRoot(undefined, { ONAJIMI_ROOT: "" }, "/c"), "/c");
  assert.equal(resolveRoot(undefined, {}, "/c"), "/c");
});

test("the published default root follows XDG_DATA_HOME and ignores a relative one", () => {
  assert.equal(dataRoot({ XDG_DATA_HOME: "/x" }, "/h"), "/x/onajimi");
  assert.equal(dataRoot({}, "/h"), "/h/.local/share/onajimi");
  assert.equal(dataRoot({ XDG_DATA_HOME: "" }, "/h"), "/h/.local/share/onajimi");
  assert.equal(dataRoot({ XDG_DATA_HOME: "data" }, "/h"), "/h/.local/share/onajimi");
});

const runWithDefaultRoot = (defaultRoot, args) => {
  const script = [
    `import preset from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "packages/textlint-rule-preset-onajimi/index.js")).href)};`,
    `import { main } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "packages/onajimi/src/main.js")).href)};`,
    `process.exitCode = await main({ argv: ${JSON.stringify(args)}, preset, defaultRoot: ${JSON.stringify(defaultRoot)} });`,
  ].join("\n");
  return run(["--input-type=module", "-e", script], { command: [process.execPath], env: { ONAJIMI_ROOT: "" } });
};

test("only init and import create the default root; other commands name the missing author directory", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "onajimi-test-"));
  const defaultRoot = path.join(base, "share/onajimi");
  const draft = writeFile(base, "draft.md", "本文。\n");
  const missing = runWithDefaultRoot(defaultRoot, ["lint", "--author", "fresh", draft]);
  assert.equal(missing.code, 2);
  assert.ok(missing.stderr.includes(`${path.join(defaultRoot, "authors/fresh")} がない。onajimi init --author fresh`), missing.stderr);
  assert.equal(fs.existsSync(defaultRoot), false);
  const init = runWithDefaultRoot(defaultRoot, ["init", "--author", "fresh"]);
  assert.equal(init.code, 0, init.stderr);
  assert.deepEqual(fs.readdirSync(path.join(defaultRoot, "authors/fresh")).sort(), ["corpus.yml", "profile.yml"]);
});

test("the repository entry defaults to the repository root", () => {
  const result = run(["corpus", "--author", "nobody"], { env: { ONAJIMI_ROOT: "" } });
  assert.equal(result.code, 2);
  assert.ok(result.stderr.includes(path.join(repoRoot, "authors/nobody")), result.stderr);
  assert.ok(run([]).stderr.includes(`それもなければ ${repoRoot}）`));
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

test("the repository entry lints from any working directory", () => {
  const from = sourceRoot();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "onajimi-test-"));
  run(["import", "--root", root, "--from", from, "--author", "demo"]);
  const file = writeFile(root, "draft.md", "# 見出し\n\n設定が静かに壊れていた。\n");
  const result = run(["lint", "--root", root, "--author", "demo", file], { cwd: os.tmpdir() });
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stdout, /^3:4 model-leaning /u);
});
