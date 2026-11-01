#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { build } from "../src/build.js";
import { lint } from "../src/lint.js";
import { guard } from "../src/guard.js";
import { defaultRoot } from "../src/paths.js";
import { SETS, loadCorpus, writeSplit } from "../src/corpus.js";
import { analyzeProse } from "../src/prose.js";
import { runControl } from "../src/control.js";
import { runProfile } from "../src/profile.js";
import { renderEval, runEval } from "../src/eval.js";
import { writeReview } from "../src/review.js";
import { runPipeline } from "../src/pipeline.js";
import { initAuthor } from "../src/init.js";

const USAGE = `使い方:
  onajimi build --author <name> [--check]
  onajimi lint --author <name> <file>
  onajimi guard <before> <after>
  onajimi init --author <name> [--posts <dir>]  corpus.yml のひな形と空の profile.yml を作る
  onajimi split --author <name>              コーパスを選んで split.yml に分ける（一度だけ）
  onajimi corpus --author <name>             選んだ記事の本数と字数
  onajimi control --author <name> --runner <name> [--set profile|dev|test|all] [--only a,b] [--limit n] [--delay 秒] [--dry-run]
  onajimi profile --author <name> [--paired] [--out <dir>]
  onajimi review --author <name>             profile/review.md を書く（提案と dev での指摘）
  onajimi pipeline --author <name> [--limit n] [--delay 秒]   split → control（全 runner）→ profile → build → review
  onajimi eval --author <name> [--set test|dev|profile]
共通: --root <dir>（authors/ のあるディレクトリ）`;

const main = async (argv) => {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      author: { type: "string" },
      check: { type: "boolean", default: false },
      runner: { type: "string" },
      set: { type: "string" },
      only: { type: "string" },
      limit: { type: "string" },
      delay: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      paired: { type: "boolean", default: false },
      out: { type: "string" },
      posts: { type: "string" },
      root: { type: "string", default: defaultRoot },
    },
  });
  const needAuthor = () => {
    if (!values.author) {
      throw new Error("--author が要る");
    }
    return values.author;
  };

  if (command === "build" && positionals.length === 0) {
    const result = build({ root: values.root, author: needAuthor(), check: values.check });
    if (values.check && result.stale.length > 0) {
      for (const name of result.stale) {
        console.log(`generated/${name} が profile.yml と食い違っている。onajimi build を実行する。`);
      }
      return 1;
    }
    return 0;
  }
  if (command === "lint" && positionals.length === 1) {
    const lines = await lint({ root: values.root, author: needAuthor(), file: positionals[0] });
    for (const line of lines) {
      console.log(line);
    }
    return lines.length > 0 ? 1 : 0;
  }
  if (command === "guard" && positionals.length === 2) {
    const [before, after] = positionals.map((file) => fs.readFileSync(file, "utf8"));
    const problems = guard(before, after);
    for (const problem of problems) {
      console.log(problem);
    }
    return problems.length > 0 ? 1 : 0;
  }
  if (command === "split" && positionals.length === 0) {
    const split = writeSplit({ root: values.root, author: needAuthor() });
    console.log(`profile ${split.profile.length} 本、dev ${split.dev.length} 本、test ${split.test.length} 本`);
    return 0;
  }
  if (command === "corpus" && positionals.length === 0) {
    const corpus = loadCorpus(values.root, needAuthor());
    for (const set of SETS) {
      const chars = corpus[set].reduce((sum, post) => sum + analyzeProse(post.text, { skipParagraphs: corpus.config.skipParagraphs }).chars, 0);
      const dates = corpus[set].map((post) => (post.meta.date ?? "").slice(0, 10));
      console.log(`${set}\t${corpus[set].length} 本\t${chars} 字${dates.length > 0 ? `\t${dates[0]}〜${dates.at(-1)}` : ""}`);
    }
    return 0;
  }
  if (command === "control" && positionals.length === 0) {
    if (!values.runner) {
      throw new Error("--runner が要る");
    }
    const summary = await runControl({
      root: values.root,
      author: needAuthor(),
      runner: values.runner,
      set: values.set ?? "profile",
      only: values.only?.split(",").filter(Boolean),
      limit: values.limit === undefined ? undefined : Number(values.limit),
      delaySeconds: values.delay === undefined ? undefined : Number(values.delay),
      dryRun: values["dry-run"],
      log: (line) => console.error(line),
    });
    if (!values["dry-run"]) {
      console.log(`生成 ${summary.generated.length}（うち作り直し ${summary.stale.length}）、既存 ${summary.skipped.length}、失敗 ${summary.failed.length}`);
    }
    if (summary.rateLimited) {
      console.log(`${summary.rateLimited.slug} で回数制限に当たって止めた。時間をおいて同じコマンドで再開する。`);
      return 3;
    }
    if (summary.unavailable) {
      console.log(`${summary.unavailable.slug} で混雑が続いたので止めた。時間をおいて同じコマンドで再開する。`);
      return 4;
    }
    return summary.failed.length > 0 ? 1 : 0;
  }
  if (command === "profile" && positionals.length === 0) {
    const result = await runProfile({ root: values.root, author: needAuthor(), paired: values.paired, outDir: values.out });
    const sides = Object.entries(result.sides)
      .map(([name, side]) => `${name} ${side.docs} 本 ${side.chars} 字`)
      .join("、");
    const shown = path.relative(process.cwd(), result.target);
    console.log(`${sides}。候補 ${result.rows.length} 件（|z| ≥ 2 は ${result.strong.length} 件）を ${shown.startsWith("..") ? result.target : shown || "."} に書いた。`);
    if (result.runners.length === 0) {
      console.log("対照がないので語の候補は出していない。しきい値の提案だけを書いた。");
    }
    return 0;
  }
  if (command === "init" && positionals.length === 0) {
    for (const file of initAuthor({ root: values.root, author: needAuthor(), posts: values.posts })) {
      console.log(`${path.relative(process.cwd(), file)} を書いた。`);
    }
    return 0;
  }
  if (command === "review" && positionals.length === 0) {
    const result = await writeReview({ root: values.root, author: needAuthor() });
    console.log(`${path.relative(process.cwd(), result.file)} に ${result.lines} 行を書いた。`);
    return 0;
  }
  if (command === "pipeline" && positionals.length === 0) {
    return runPipeline({
      root: values.root,
      author: needAuthor(),
      limit: values.limit === undefined ? undefined : Number(values.limit),
      delaySeconds: values.delay === undefined ? undefined : Number(values.delay),
      log: (line) => console.error(line),
      say: (line) => console.log(line),
    });
  }
  if (command === "eval" && positionals.length === 0) {
    console.log(renderEval(await runEval({ root: values.root, author: needAuthor(), set: values.set ?? "test" })));
    return 0;
  }
  console.error(USAGE);
  return 2;
};

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
