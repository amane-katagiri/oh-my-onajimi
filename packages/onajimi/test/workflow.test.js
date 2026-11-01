import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { parseCorpusConfig } from "../src/corpus.js";
import { parseProfile } from "../src/build.js";
import { renderReview } from "../src/review.js";
import { truncate } from "../src/eval.js";
import { emptyRoot, makeRoot, run } from "./helpers.js";
import { makeCorpusRoot, post } from "./corpus-helpers.js";
import { fileURLToPath } from "node:url";

const fakeRunner = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/fake-runner.js");

const corpusPosts = () => {
  const posts = {};
  for (let i = 0; i < 8; i += 1) {
    const extra = i === 5 ? `設定が静かに壊れた。${"長い文が続く".repeat(15)}。` : "動作を確かめた。";
    posts[`p${i}`] = post({ title: `題${i}`, date: `2021-01-0${i + 1}`, body: `# 見出し${i}\n\n今日は${extra}結果を書いた。\n` });
  }
  return posts;
};

test("pipeline runs split, control for every runner, profile, build and review, and review.md is compact", () => {
  const { root, log } = makeCorpusRoot(corpusPosts(), {
    devRatio: 0.25,
    runners: { fake: { command: [process.execPath, fakeRunner, "LOG", "ok"], output: "json" } },
  });
  const config = path.join(root, "authors/demo/corpus.yml");
  fs.writeFileSync(config, fs.readFileSync(config, "utf8").replace("LOG", log));
  const result = run(["pipeline", "--root", root, "--author", "demo", "--yes"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^split: profile 4 本、dev 2 本、test 2 本、holdout 0 本\ncontrol fake: 生成 8/u);
  const review = fs.readFileSync(path.join(root, "authors/demo/profile/review.md"), "utf8");
  for (const heading of ["model_leaning の候補", "excluded_in_brief", "表記の候補（orthography）", "密度の候補", "筆者寄りの語", "しきい値", "dev の指摘"]) {
    assert.match(review, new RegExp(`## .*${heading.replace(/[()（）]/gu, ".")}`, "u"), heading);
  }
  const finding = review.split("\n").find((line) => line.startsWith("- p5:"));
  assert.match(finding, /^- p5:10 model-leaning .*｜今日は設定が静かに壊れた。/u);
  assert.ok([...finding.split("｜").at(-1)].length <= 60);
  assert.match(review, /\| 誤検出: 筆者 dev \| 2 \|/u);
  assert.ok(review.split("\n").length < 600);
  assert.match(review, /^- M1 \*\*.*｜筆者 0回・0本｜dev 0回・0本｜fake /mu);
  assert.match(review, /^\| T\.sentence_length \| /mu);
  assert.match(review, /onajimi accept --author demo M3 O2/u);
  const again = run(["pipeline", "--root", root, "--author", "demo"]);
  assert.match(again.stdout, /^control fake: 生成 0（うち作り直し 0）、既存 8/u);
});

test("pipeline stops before profile when a runner hits its rate limit, and --limit caps new generations", () => {
  const { root } = makeCorpusRoot(corpusPosts(), { devRatio: 0.25 });
  const config = path.join(root, "authors/demo/corpus.yml");
  const parsed = YAML.parse(fs.readFileSync(config, "utf8"));
  parsed.control.runners = { fake: parsed.control.runners.fake, limited: parsed.control.runners.limited };
  fs.writeFileSync(config, YAML.stringify(parsed));
  const first = run(["pipeline", "--root", root, "--author", "demo", "--limit", "2", "--yes"]);
  assert.equal(first.code, 3, first.stderr);
  assert.match(first.stdout, /control fake: 生成 2/u);
  assert.match(first.stdout, /profile と review は実行していない/u);
  assert.equal(fs.existsSync(path.join(root, "authors/demo/profile/review.md")), false);
  const second = run(["pipeline", "--root", root, "--author", "demo", "--limit", "2", "--yes"]);
  assert.match(second.stdout, /control fake: 生成 2（うち作り直し 0）、既存 2/u);
});

test("init writes a starter corpus.yml and an empty profile.yml, and refuses to overwrite", () => {
  const root = emptyRoot();
  const result = run(["init", "--root", root, "--author", "newbie", "--posts", "~/blog/content/post"]);
  assert.equal(result.code, 0, result.stderr);
  const text = fs.readFileSync(path.join(root, "authors/newbie/corpus.yml"), "utf8");
  assert.doesNotMatch(text, /#/u);
  const config = parseCorpusConfig(text);
  assert.equal(config.posts, "~/blog/content/post");
  assert.deepEqual(Object.keys(config.control.runners), ["opus", "gemini"]);
  assert.match(config.control.prompt, /\{outline\}/u);
  assert.equal(config.profile.min_chars, 1500);
  const profile = parseProfile(fs.readFileSync(path.join(root, "authors/newbie/profile.yml"), "utf8"));
  assert.deepEqual(profile.modelLeaning, []);
  assert.equal(run(["init", "--root", root, "--author", "newbie"]).code, 2);
  assert.equal(run(["build", "--root", root, "--author", "newbie"]).code, 0);
});

test("review rows show z, counts, brief and register columns, context and examples", () => {
  const evidence = {
    feature: "どこ+か",
    z: { opus: -5.1, gemini: -6 },
    author_count: 2,
    author_docs: 2,
    control: { opus: { count: 46, docs: 30 }, gemini: { count: 55, docs: 33 } },
    in_brief_docs: 0,
    author_other_per_1000: 0.4,
    control_per_1000: 0.9,
    author_next: "に/助詞 1",
    control_next: "懐かしい/形容詞 9",
    author_example: `slug: ${"あ".repeat(50)}`,
    control_example: "c: どこか懐かしい。",
  };
  const text = renderReview({
    author: "demo",
    proposal: {
      sides: { author: { docs: 3, chars: 100 } },
      model_leaning: [{ id: "M1", message: "「どこか」は筆者の言い方ではない。", note: "ジャンルで変わる", evidence }],
      density: [
        {
          id: "D1",
          message: "「を、」が多い。",
          max_per_1000: 0.7,
          typical_per_1000: 0,
          min_chars: 1500,
          evidence: { feature: "を+、", author_articles: 5, author_max: 0.6, control: { opus: { p50: 0.4, fires: 3, docs: 9 } } },
        },
        {
          id: "D2",
          message: "「か」」が多い。",
          max_per_1000: 0.3,
          typical_per_1000: 0,
          min_chars: 1500,
          note: "かぎかっこに掛かる語",
          evidence: { feature: "か+」", author_articles: 5, author_max: 0.3, control: { opus: { p50: 0.4, fires: 3, docs: 9 } } },
        },
      ],
    },
    dev: { M1: { count: 3, docs: 2 }, D1: { max: 0.9, fires: 1, docs: 4 } },
    thresholds: { articles: 3 },
    evalRows: [],
    findings: [],
    stale: ["model-leaning.json"],
  });
  assert.match(text, /- M1 \*\*どこか\*\*（どこ\+か）z opus -5\.1 \/ gemini -6｜筆者 2回・2本｜dev 3回・2本｜opus 46回・30本、gemini 55回・33本｜指示 0本｜他ジャンル 0\.4\/1000（対照 0\.9）/u);
  assert.match(text, /- D1 「を、」が多い。（を\+、）目安 0\.7\/1000｜筆者 中央 0・最大 0\.6（5本、1500字以上）｜dev 最大 0\.9・超え 1\/4本｜opus 中央 0\.4・超え 3\/9本｜指示 -$/mu);
  assert.match(text, /後ろ: 筆者 に\/助詞 1｜対照 懐かしい\/形容詞 9/u);
  assert.match(text, new RegExp(`例: 筆者「${"あ".repeat(40)}…」｜対照「どこか懐かしい。」`, "u"));
  assert.match(text, /注: ジャンルで変わる/u);
  assert.match(text, /- D2 「か」」が多い。.*\n  - 注: かぎかっこに掛かる語$/mu);
  assert.match(text, /generated\/ が profile\.yml と食い違っている/u);
  assert.equal(truncate("abc", 2), "ab…");
});

test("numeric options must be whole numbers and each command accepts only its own options", () => {
  const root = makeRoot();
  for (const args of [["--limit", "abc"], ["--limit", "1.5"], ["--delay=-1"], ["--delay", "Infinity"]]) {
    const result = run(["control", "--root", root, "--author", "demo", "--runner", "fake", ...args]);
    assert.equal(result.code, 2, args.join(" "));
    assert.match(result.stderr, /は 0 以上の整数で書く/u);
  }
  const dryRun = run(["pipeline", "--root", root, "--author", "demo", "--dry-run", "--yes"]);
  assert.equal(dryRun.code, 2);
  assert.match(dryRun.stderr, /^pipeline には --dry-run を使えない/u);
  assert.match(run(["eval", "--root", root, "--author", "demo", "--limit", "1", "--paired"]).stderr, /^eval には --limit・--paired を使えない/u);
});

test("pipeline prints an estimate and stops with 5 until --yes is given; --estimate never writes", () => {
  const { root, log } = makeCorpusRoot(corpusPosts(), {
    devRatio: 0.25,
    runners: { fake: { command: [process.execPath, fakeRunner, "LOG", "ok"], output: "json", price: 25 } },
  });
  const config = path.join(root, "authors/demo/corpus.yml");
  fs.writeFileSync(config, fs.readFileSync(config, "utf8").replace("LOG", log));
  const estimate = run(["pipeline", "--root", root, "--author", "demo", "--estimate"]);
  assert.equal(estimate.code, 0, estimate.stderr);
  assert.match(estimate.stdout, /^split（まだ書いていない）: profile 4 本、dev 2 本、test 2 本、holdout 0 本\n/u);
  assert.match(estimate.stdout, /estimate fake: 生成 8 本（新規 8・作り直し 0）、既存 0 本、目標 800 字、時間は不明（過去の出力がない）、出力 約 2000 トークン（仮の換算）、約 \$0\.05/u);
  assert.equal(fs.existsSync(path.join(root, "authors/demo/split.yml")), false);
  const gated = run(["pipeline", "--root", root, "--author", "demo"]);
  assert.equal(gated.code, 5, gated.stderr);
  assert.match(gated.stdout, /--yes を付けて/u);
  assert.equal(fs.existsSync(log), false);
  assert.equal(fs.existsSync(path.join(root, "authors/demo/corpus/_control")), false);
  assert.equal(run(["pipeline", "--root", root, "--author", "demo", "--yes"]).code, 0);
  const after = run(["pipeline", "--root", root, "--author", "demo", "--estimate"]);
  assert.match(after.stdout, /^estimate fake: 生成 0 本（新規 0・作り直し 0）、既存 8 本、目標 0 字$/mu);
  assert.equal(run(["pipeline", "--root", root, "--author", "demo"]).code, 0);
  fs.writeFileSync(config, fs.readFileSync(config, "utf8").replace("約{chars}字で", "およそ{chars}字で"));
  const control = run(["control", "--root", root, "--author", "demo", "--runner", "fake", "--set", "all", "--estimate"]);
  assert.match(control.stdout, /^fake: 生成 8 本（新規 0・作り直し 8）、既存 0 本、目標 800 字、約 \d+ 秒/u);
  assert.equal(fs.readFileSync(log, "utf8").split("\n").filter(Boolean).length, 8);
});

test("eval --details prints dev findings with the corpus exclusions and refuses test and holdout", () => {
  const { root } = makeCorpusRoot({
    a: post({ title: "A", date: "2021-01-01", body: "本文です。" }),
    b: post({ title: "B", date: "2021-01-02", body: "本文です。" }),
    "with-extra": post({ title: "W", date: "2021-01-03", body: "# 本題\n\n本文が静かに壊れた。\n\n> 引用が静かに壊れた。\n\n# おまけ\n\n寄稿が静かに壊れた。\n" }),
    d: post({ title: "D", date: "2021-01-04", body: "試験が静かに壊れた。\n" }),
  }, { devRatio: 0.25 });
  run(["split", "--root", root, "--author", "demo"]);
  run(["build", "--root", root, "--author", "demo"]);
  const dev = run(["eval", "--root", root, "--author", "demo", "--set", "dev", "--details"]);
  assert.equal(dev.code, 0, dev.stderr);
  const findings = dev.stdout.split("\n\n")[1].trimEnd().split("\n");
  assert.deepEqual(findings, ["with-extra:10 model-leaning 「静かに壊れる」は筆者の言い方ではない。 ｜ 本文が静かに壊れた。"]);
  for (const set of ["test", "holdout"]) {
    const refused = run(["eval", "--root", root, "--author", "demo", "--set", set, "--details"]);
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /--details は test・holdout には使えない/u);
    assert.equal(refused.stdout, "");
  }
});
