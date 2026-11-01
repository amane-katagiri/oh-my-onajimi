import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataRoot, resolveRoot } from "../src/paths.js";
import { emptyRoot, isolatedHome, makeRoot, run, writeFile } from "./helpers.js";

test("--root wins over ONAJIMI_ROOT, which wins over the data root", () => {
  assert.deepEqual(resolveRoot("/a", { ONAJIMI_ROOT: "/b" }, "/h"), { root: "/a", source: "--root" });
  assert.deepEqual(resolveRoot(undefined, { ONAJIMI_ROOT: "/b" }, "/h"), { root: "/b", source: "ONAJIMI_ROOT" });
  assert.deepEqual(resolveRoot(undefined, { ONAJIMI_ROOT: "" }, "/h"), { root: "/h/.local/share/onajimi", source: "default" });
  assert.deepEqual(resolveRoot(undefined, { XDG_DATA_HOME: "/x" }, "/h"), { root: "/x/onajimi", source: "default" });
});

test("the data root follows XDG_DATA_HOME and ignores a relative one", () => {
  assert.equal(dataRoot({ XDG_DATA_HOME: "/x" }, "/h"), "/x/onajimi");
  assert.equal(dataRoot({}, "/h"), "/h/.local/share/onajimi");
  assert.equal(dataRoot({ XDG_DATA_HOME: "" }, "/h"), "/h/.local/share/onajimi");
  assert.equal(dataRoot({ XDG_DATA_HOME: "data" }, "/h"), "/h/.local/share/onajimi");
});

test("the repository entry defaults to the data root and only init and import create it", () => {
  const env = isolatedHome();
  const defaultRoot = path.join(env.XDG_DATA_HOME, "onajimi");
  const draft = writeFile(env.HOME, "draft.md", "本文。\n");
  const missing = run(["lint", "--author", "fresh", draft], { env });
  assert.equal(missing.code, 2);
  assert.ok(missing.stderr.includes(`${path.join(defaultRoot, "authors/fresh")} がない。onajimi init --author fresh`), missing.stderr);
  assert.equal(fs.existsSync(defaultRoot), false);
  assert.ok(run([], { env }).stderr.includes(`それもなければ ${defaultRoot}）`));
  const init = run(["init", "--author", "fresh"], { env });
  assert.equal(init.code, 0, init.stderr);
  assert.deepEqual(fs.readdirSync(path.join(defaultRoot, "authors/fresh")).sort(), ["corpus.yml", "profile.yml"]);
});

test("without XDG_DATA_HOME the data root is under HOME", () => {
  const env = { ...isolatedHome(), XDG_DATA_HOME: "" };
  const result = run(["root"], { env });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, `${path.join(env.HOME, ".local/share/onajimi")}\n既定値（\${XDG_DATA_HOME:-~/.local/share}/onajimi）\n`);
});

test("root prints the resolved root and where it came from", () => {
  const env = isolatedHome();
  const elsewhere = path.join(env.HOME, "elsewhere");
  const fromEnv = run(["root"], { env: { ...env, ONAJIMI_ROOT: elsewhere } });
  assert.equal(fromEnv.stdout, `${elsewhere}\n環境変数 ONAJIMI_ROOT から\n`);
  const fromFlag = run(["root", "--root", "."], { env: { ...env, ONAJIMI_ROOT: elsewhere }, cwd: env.HOME });
  assert.equal(fromFlag.stdout, `${env.HOME}\n--root で指定した\n`);
  assert.equal(fs.existsSync(env.XDG_DATA_HOME), false);
});

test("init writes under ONAJIMI_ROOT when --root is absent", () => {
  const root = emptyRoot();
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
  const root = emptyRoot();
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

test("import --force overwrites the profile files but leaves corpus/ alone", () => {
  const from = sourceRoot();
  const root = emptyRoot();
  assert.equal(run(["import", "--root", root, "--from", from, "--author", "demo"]).code, 0);
  const dir = path.join(root, "authors/demo");
  writeFile(dir, "corpus/mine.md", "自分の記事。\n");
  writeFile(dir, "profile/stale.tsv", "x\n");
  writeFile(dir, "profile/_full/kept.tsv", "x\n");
  writeFile(dir, "split.yml", "profile: [old]\n");
  writeFile(path.join(from, "authors/demo"), "corpus.yml", "select: { min_chars: 1 }\n");
  writeFile(path.join(from, "authors/demo"), "profile/thresholds.yml", "changed: 1\n");
  const result = run(["import", "--root", root, "--from", from, "--author", "demo", "--force"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(dir, "corpus.yml"), "utf8"), "select: { min_chars: 1 }\n");
  assert.equal(fs.readFileSync(path.join(dir, "split.yml"), "utf8"), "profile: []\ndev: []\ntest: []\n");
  assert.equal(fs.readFileSync(path.join(dir, "profile/thresholds.yml"), "utf8"), "changed: 1\n");
  assert.deepEqual(fs.readdirSync(path.join(dir, "profile")).sort(), ["_full", "thresholds.yml"]);
  assert.deepEqual(fs.readdirSync(path.join(dir, "profile/_full")), ["kept.tsv"]);
  assert.deepEqual(fs.readdirSync(path.join(dir, "corpus")), ["mine.md"]);
});

test("the repository entry lints from any working directory", () => {
  const from = sourceRoot();
  const root = emptyRoot();
  run(["import", "--root", root, "--from", from, "--author", "demo"]);
  const file = writeFile(root, "draft.md", "# 見出し\n\n設定が静かに壊れていた。\n");
  const result = run(["lint", "--root", root, "--author", "demo", file], { cwd: os.tmpdir() });
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stdout, /^3:4 model-leaning /u);
});
