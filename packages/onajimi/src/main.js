import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { build } from "./build.js";
import { lint } from "./lint.js";
import { guard } from "./guard.js";
import { authorDir, dataRoot, resolveRoot } from "./paths.js";
import { SETS, loadCorpus, splitText, writeSplit } from "./corpus.js";
import { analyzeProse } from "./prose.js";
import { estimateControl, renderEstimate, runControl } from "./control.js";
import { runProfile } from "./profile.js";
import { renderEval, renderFinding, runEval } from "./eval.js";
import { writeReview } from "./review.js";
import { runPipeline } from "./pipeline.js";
import { EXIT, needsYesMessage, stopOf } from "./exit.js";
import { acceptIds } from "./accept.js";
import { initAuthor } from "./init.js";
import { importAuthor } from "./import-author.js";
import { abcCommand } from "./abc.js";

const usage = () => `使い方:
  onajimi build --author <name> [--check]
  onajimi lint --author <name> <file>      ファイルをそのまま検査する（corpus.yml の exclude_sections などは当てない。コーパスの記事は eval --details で見る）
  onajimi guard <before> <after>
  onajimi init --author <name> [--posts <dir>]  corpus.yml のひな形と空の profile.yml を作る
  onajimi root                               使う root と、その決まり方を出す
  onajimi import --author <name> --from <dir> [--force]  別の root から profile.yml などを取り込んで build する（corpus/ は取り込まない）。
                                             --force はあるものを上書きする
  onajimi split --author <name>              コーパスを選んで split.yml に分ける。2 回目からは分けた記事を動かさず、新しい記事を holdout に足す
  onajimi corpus --author <name>             選んだ記事の本数と字数
  onajimi control --author <name> --runner <name> [--set profile|dev|test|holdout|all] [--only a,b] [--limit n] [--delay 秒] [--dry-run] [--estimate] [--yes]
                                             生成するものがあるのに --yes がなければ、見積もりだけを出して 5 で終わる
  onajimi profile --author <name> [--paired] [--out <dir>]
  onajimi review --author <name>             profile/review.md を書く（提案と dev での指摘）
  onajimi pipeline --author <name> [--estimate] [--yes] [--limit n] [--delay 秒]   split → control（全 runner）→ profile → build → review。
                                             生成するものがあるのに --yes がなければ、見積もりだけを出して 5 で終わる
  onajimi accept --author <name> <番号...>   review.md の番号（M3 O2 R1 D5 'D5=メッセージ' T T.<項目>[=値]）を profile.yml に足して build する
  onajimi eval --author <name> [--set test|dev|profile|holdout] [--details]   --details は dev と profile だけ
  onajimi abc --author <name> [--runner <name>] [--set test] [--only a,b] [--example-category <category>] [--limit n] [--delay 秒] [--dry-run] [--estimate] [--yes] [--report]
                                             A（対照）・B（文体の指示と例）・C（A を lint の指摘で 1 回直す）・BC（B を同じく直す）を比べる。
                                             呼び出すものがあるのに --yes がなければ、見積もりだけを出して 5 で終わる。--report は生成せずに指標を出す
共通: --root <dir>（authors/ のあるディレクトリ。省略時は環境変数 ONAJIMI_ROOT、それもなければ ${dataRoot()}）`;

const CREATES_AUTHOR = new Set(["init", "import"]);

const OPTIONS = {
  author: { type: "string" },
  check: { type: "boolean" },
  runner: { type: "string" },
  set: { type: "string" },
  only: { type: "string" },
  "example-category": { type: "string" },
  limit: { type: "string" },
  delay: { type: "string" },
  "dry-run": { type: "boolean" },
  estimate: { type: "boolean" },
  yes: { type: "boolean" },
  details: { type: "boolean" },
  paired: { type: "boolean" },
  out: { type: "string" },
  posts: { type: "string" },
  from: { type: "string" },
  force: { type: "boolean" },
  root: { type: "string" },
  report: { type: "boolean" },
};

const ALLOWED = {
  build: ["author", "check"],
  lint: ["author"],
  guard: [],
  init: ["author", "posts"],
  root: [],
  import: ["author", "from", "force"],
  split: ["author"],
  corpus: ["author"],
  control: ["author", "runner", "set", "only", "limit", "delay", "dry-run", "estimate", "yes"],
  profile: ["author", "paired", "out"],
  review: ["author"],
  pipeline: ["author", "estimate", "yes", "limit", "delay"],
  accept: ["author"],
  eval: ["author", "set", "details"],
  abc: ["author", "runner", "set", "only", "example-category", "limit", "delay", "dry-run", "estimate", "yes", "report"],
};

const checkOptions = (command, values) => {
  const allowed = ALLOWED[command];
  if (!allowed) {
    return;
  }
  const extra = Object.keys(values).filter((name) => name !== "root" && !allowed.includes(name));
  if (extra.length > 0) {
    throw new Error(`${command} には ${extra.map((name) => `--${name}`).join("・")} を使えない`);
  }
};

const nonNegativeInteger = (values, name) => {
  const raw = values[name];
  if (raw === undefined) {
    return undefined;
  }
  if (!/^\d+$/u.test(raw)) {
    throw new Error(`--${name} は 0 以上の整数で書く: ${raw}`);
  }
  return Number(raw);
};

const ROOT_SOURCES = {
  "--root": "--root で指定した",
  ONAJIMI_ROOT: "環境変数 ONAJIMI_ROOT から",
  default: "既定値（${XDG_DATA_HOME:-~/.local/share}/onajimi）",
};

const dispatch = async ({ argv, preset }) => {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: OPTIONS });
  checkOptions(command, values);
  const limit = nonNegativeInteger(values, "limit");
  const delaySeconds = nonNegativeInteger(values, "delay");
  const { root, source } = resolveRoot(values.root);
  const needAuthor = () => {
    if (!values.author) {
      throw new Error("--author が要る");
    }
    const dir = authorDir(root, values.author);
    if (!CREATES_AUTHOR.has(command) && !fs.existsSync(dir)) {
      throw new Error(`${dir} がない。onajimi init --author ${values.author} で作るか、--root か ONAJIMI_ROOT で筆者のデータのある root を指す。`);
    }
    return values.author;
  };

  if (command === "root" && positionals.length === 0) {
    console.log(root);
    console.log(ROOT_SOURCES[source]);
    return 0;
  }
  if (command === "build" && positionals.length === 0) {
    const result = build({ root: root, author: needAuthor(), check: values.check });
    if (values.check && result.stale.length > 0) {
      for (const name of result.stale) {
        console.log(`generated/${name} が profile.yml と食い違っている。onajimi build を実行する。`);
      }
      return EXIT.FAILED;
    }
    return 0;
  }
  if (command === "lint" && positionals.length === 1) {
    const lines = await lint({ root, author: needAuthor(), file: positionals[0], preset });
    for (const line of lines) {
      console.log(line);
    }
    return lines.length > 0 ? EXIT.FAILED : 0;
  }
  if (command === "guard" && positionals.length === 2) {
    const [before, after] = positionals.map((file) => fs.readFileSync(file, "utf8"));
    const problems = guard(before, after);
    for (const problem of problems) {
      console.log(problem);
    }
    return problems.length > 0 ? EXIT.FAILED : 0;
  }
  if (command === "split" && positionals.length === 0) {
    const { split, added, changed } = writeSplit({ root: root, author: needAuthor() });
    console.log(splitText(split));
    console.log(changed ? (added.length > 0 ? `holdout に入れた記事: ${added.join(", ")}` : "split.yml を書いた。") : "変更なし。");
    return 0;
  }
  if (command === "corpus" && positionals.length === 0) {
    const corpus = loadCorpus(root, needAuthor());
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
    if (values.estimate || (!values.yes && !values["dry-run"])) {
      const author = needAuthor();
      const estimate = estimateControl({
        root: root,
        author,
        corpus: loadCorpus(root, author),
        runner: values.runner,
        set: values.set ?? "profile",
        only: values.only?.split(",").filter(Boolean),
        delaySeconds,
      });
      console.log(renderEstimate(estimate));
      if (values.estimate) {
        return 0;
      }
      if (estimate.generate > 0) {
        console.log(needsYesMessage("対照を"));
        return EXIT.NEEDS_YES;
      }
    }
    const summary = await runControl({
      root: root,
      author: needAuthor(),
      runner: values.runner,
      set: values.set ?? "profile",
      only: values.only?.split(",").filter(Boolean),
      limit,
      delaySeconds,
      dryRun: values["dry-run"],
      log: (line) => console.error(line),
    });
    if (!values["dry-run"]) {
      console.log(`生成 ${summary.generated.length}（うち作り直し ${summary.stale.length}）、既存 ${summary.skipped.length}、失敗 ${summary.failed.length}`);
    }
    const stop = stopOf(summary, "slug");
    if (stop) {
      console.log(stop.message);
      return stop.code;
    }
    return summary.failed.length > 0 ? EXIT.FAILED : 0;
  }
  if (command === "profile" && positionals.length === 0) {
    const result = await runProfile({ root: root, author: needAuthor(), paired: values.paired, outDir: values.out });
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
    for (const file of initAuthor({ root: root, author: needAuthor(), posts: values.posts })) {
      console.log(`${path.relative(process.cwd(), file)} を書いた。`);
    }
    return 0;
  }
  if (command === "import" && positionals.length === 0) {
    if (!values.from) {
      throw new Error("--from が要る");
    }
    const result = importAuthor({ root, from: values.from, author: needAuthor(), force: values.force });
    for (const file of result.copied) {
      console.log(`${file} に写した。`);
    }
    console.log(`${result.generated} を作った。`);
    return 0;
  }
  if (command === "review" && positionals.length === 0) {
    const result = await writeReview({ root, author: needAuthor(), preset });
    console.log(`${path.relative(process.cwd(), result.file)} に ${result.lines} 行を書いた。`);
    return 0;
  }
  if (command === "pipeline" && positionals.length === 0) {
    return runPipeline({
      root,
      author: needAuthor(),
      preset,
      limit,
      delaySeconds,
      estimate: values.estimate,
      yes: values.yes,
      log: (line) => console.error(line),
      say: (line) => console.log(line),
    });
  }
  if (command === "eval" && positionals.length === 0) {
    const result = await runEval({ root, author: needAuthor(), preset, set: values.set ?? "test", details: values.details });
    console.log(renderEval(result.rows));
    if (result.findings) {
      console.log("");
      for (const finding of result.findings) {
        console.log(renderFinding(finding));
      }
    }
    return 0;
  }
  if (command === "abc" && positionals.length === 0) {
    return abcCommand({
      root,
      author: needAuthor(),
      preset,
      runner: values.runner,
      set: values.set ?? "test",
      only: values.only?.split(",").filter(Boolean),
      exampleCategory: values["example-category"],
      limit,
      delaySeconds,
      estimate: values.estimate,
      yes: values.yes,
      dryRun: values["dry-run"],
      report: values.report,
      say: (line) => console.log(line),
      log: (line) => console.error(line),
    });
  }
  if (command === "accept" && positionals.length > 0) {
    const result = acceptIds({ root: root, author: needAuthor(), ids: positionals });
    console.log(`profile.yml に足して build した: ${result.accepted.join(" ")}`);
    return 0;
  }
  console.error(usage());
  return EXIT.USAGE;
};

export const main = async (options) => {
  try {
    return await dispatch(options);
  } catch (error) {
    console.error(error.message);
    return EXIT.USAGE;
  }
};
