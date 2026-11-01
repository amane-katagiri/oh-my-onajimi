import test from "node:test";
import assert from "node:assert/strict";
import { makeRoot, run, writeFile } from "./helpers.js";

const prepare = () => {
  const root = makeRoot();
  run(["build", "--root", root, "--author", "demo"]);
  return root;
};

test("lint prints one line per finding as 行:列 ルール名 メッセージ and exits 1", () => {
  const root = prepare();
  const file = writeFile(root, "draft.md", [
    "# 見出し",
    "",
    "設定が静かに壊れていたので、動作を確認した。これは出来る。",
    "",
    "あ、い、う、え。",
    "",
  ].join("\n"));
  const result = run(["lint", "--root", root, "--author", "demo", file]);
  assert.equal(result.code, 1, result.stderr);
  const lines = result.stdout.trimEnd().split("\n");
  for (const line of lines) {
    assert.match(line, /^\d+:\d+ [a-z-]+ \S.*$/u);
  }
  assert.deepEqual(lines.map((line) => line.split(" ").slice(0, 2).join(" ")), [
    "3:4 model-leaning",
    "3:18 author-leaning",
    "3:26 orthography",
    "5:6 max-ten",
  ]);
  assert.match(lines[3], /読点が多い: 1文に「、」が3個以上（目安 2 個以下）。/);
});

test("lint prints nothing and exits 0 without findings", () => {
  const root = prepare();
  const file = writeFile(root, "clean.md", "# 見出し\n\n動作を確かめた。これはできる。\n");
  const result = run(["lint", "--root", root, "--author", "demo", file]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("lint skips loose key: value frontmatter but keeps line numbers", () => {
  const root = prepare();
  const file = writeFile(root, "post.md", [
    "title: 静かに壊れる話",
    "summary: 出来るだけ短く、とても、とても、とても",
    "",
    "本文が静かに壊れた。",
    "",
  ].join("\n"));
  const result = run(["lint", "--root", root, "--author", "demo", file]);
  assert.equal(result.stdout, "4:4 model-leaning 「静かに壊れる」は筆者の言い方ではない。\n");
});

test("lint reports long sentences with a short message", () => {
  const root = prepare();
  const file = writeFile(root, "long.md", `${"長".repeat(70)}。\n`);
  const result = run(["lint", "--root", root, "--author", "demo", file]);
  assert.equal(result.stdout, "1:1 sentence-length 文が長い: 71字（目安 60 字以下）。\n");
});

test("lint asks for build when generated files are missing", () => {
  const root = makeRoot();
  const file = writeFile(root, "draft.md", "本文。\n");
  const result = run(["lint", "--root", root, "--author", "demo", file]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /onajimi build --author demo/);
});
