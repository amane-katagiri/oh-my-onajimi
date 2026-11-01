import fs from "node:fs";
import path from "node:path";
import { CONDITIONS, REVISED, abcDir, abcRunner } from "./abc.js";
import { MAIN_SIZE, computeDeltas, editRatio, mean, median, orthographyCounts } from "./abc-metrics.js";
import { buildBrief } from "./brief.js";
import { parseProfile } from "./build.js";
import { corpusPaths, loadCorpus } from "./corpus.js";
import { countsOf, dictionaryTokens } from "./delta.js";
import { authorDocsOf, controlDocsOf, controlFile, metaFileOf } from "./docs.js";
import { documentKeyOf, scoreDocs } from "./eval.js";
import { createAuthorLinter } from "./lint.js";
import { analyzeProse, stripTitle } from "./prose.js";
import { minutes, readMeta } from "./runner.js";
import { docRates, tokenizeProse } from "./tokens.js";
import { mapSeries, memoize } from "./util.js";

const REPORT_CONDITIONS = ["A", "B", "C", "C戻し", "BC", "BC戻し"];
const COMPARISONS = [["B", "A"], ["C", "A"], ["C", "B"], ["C戻し", "A"], ["BC", "B"], ["BC", "A"], ["BC戻し", "B"]];
const CARICATURE_CONDITIONS = ["筆者", "A", "B", "BC"];

const caricatureOf = async (profile, docsByCondition, tokenized) => {
  const features = {};
  for (const [condition, docs] of Object.entries(docsByCondition)) {
    features[condition] = await mapSeries(docs, tokenized);
  }
  const orthography = profile.orthography.map((entry) => ({
    label: `${entry.expected} / ${entry.patterns ?? entry.pattern}`,
    values: Object.fromEntries(
      Object.entries(features).map(([condition, docs]) => {
        const counts = docs.map((doc) => orthographyCounts(entry, doc.strTokens.map((str) => str.text)));
        const author = counts.reduce((sum, c) => sum + c.author, 0);
        const total = author + counts.reduce((sum, c) => sum + c.model, 0);
        return [condition, { author, total, share: total === 0 ? null : author / total }];
      }),
    ),
  }));
  const density = profile.density.map((entry) => ({
    label: entry.tokens.map((token) => token.basic_form ?? token.surface_form).join("+"),
    max: entry.max_per_1000,
    values: Object.fromEntries(
      Object.entries(features).map(([condition, docs]) => {
        const rates = docRates(docs, entry.tokens, 0);
        return [condition, { mean: mean(rates), over: rates.filter((rate) => rate > entry.max_per_1000).length }];
      }),
    ),
  }));
  return { orthography, density };
};

export const computeAbcReport = async ({ root, author, preset, corpus = loadCorpus(root, author), runner: name, set = "test" }) => {
  const { name: runner } = abcRunner(corpus, name);
  const dir = abcDir(root, author);
  const opts = { skipParagraphs: corpus.config.skipParagraphs };
  const tokenized = memoize((text) => tokenizeProse(text, opts));
  const counted = memoize(async (text) => countsOf((await tokenized(text)).strTokens));
  const countAll = (texts) => mapSeries(texts, counted);
  const posts = corpus[set].filter((post) => CONDITIONS.every((condition) => fs.existsSync(path.join(dir, condition, `${post.slug}.md`))) && fs.existsSync(controlFile(root, author, runner, post.slug)));
  if (posts.length === 0) {
    throw new Error(`${set} に B・C・BC がそろった記事がない。先に onajimi abc --yes を実行する。`);
  }
  const rows = posts.map((post) => {
    const aFile = controlFile(root, author, runner, post.slug);
    const raw = { A: fs.readFileSync(aFile, "utf8") };
    const meta = { A: readMeta(metaFileOf(aFile)) ?? {} };
    for (const condition of CONDITIONS) {
      raw[condition] = fs.readFileSync(path.join(dir, condition, `${post.slug}.md`), "utf8");
      meta[condition] = readMeta(path.join(dir, condition, `${post.slug}.json`)) ?? {};
    }
    const revision = Object.fromEntries(
      Object.entries(REVISED).map(([condition, before]) => {
        const m = meta[condition];
        const called = m.called !== false;
        return [condition, { called, findings: m.findings ?? 0, guardPass: !called || m.guard?.pass === true, problems: m.guard?.problems ?? [], editRatio: editRatio(raw[before], raw[condition]) }];
      }),
    );
    raw["C戻し"] = revision.C.guardPass ? raw.C : raw.A;
    raw["BC戻し"] = revision.BC.guardPass ? raw.BC : raw.B;
    const docs = Object.fromEntries(REPORT_CONDITIONS.map((condition) => [condition, stripTitle(raw[condition], post.meta)]));
    const target = buildBrief(post, opts).chars;
    return {
      slug: post.slug,
      author: stripTitle(post.text, post.meta),
      docs,
      meta,
      revision,
      lengthRatio: Object.fromEntries(REPORT_CONDITIONS.map((condition) => [condition, analyzeProse(docs[condition], opts).chars / target])),
    };
  });

  const runners = Object.keys(corpus.config.control.runners);
  const authorProfile = await countAll(authorDocsOf(corpus.profile).map((doc) => doc.text));
  const controlProfile = await countAll(runners.flatMap((r) => controlDocsOf(root, author, r, corpus.profile).map((doc) => doc.text)));
  const authorTest = await countAll(rows.map((row) => row.author));
  const outputs = {};
  for (const condition of REPORT_CONDITIONS) {
    outputs[condition] = await countAll(rows.map((row) => row.docs[condition]));
  }
  const profile = parseProfile(fs.readFileSync(corpusPaths(root, author).profileYml, "utf8"));
  const deltas = computeDeltas({
    reference: [...authorProfile, ...controlProfile],
    authorProfile,
    authorTest,
    outputs,
    conditions: REPORT_CONDITIONS,
    comparisons: COMPARISONS,
    variants: [
      { label: "全トークン", exclude: () => false },
      { label: "辞書の語を除く", exclude: dictionaryTokens(profile) },
    ],
  });

  const { lintText, rules } = await createAuthorLinter(root, author, preset);
  const linted = memoize((text) => lintText(text, "onajimi-abc.md"));
  const documentKey = documentKeyOf(rules, preset);
  const findings = {};
  for (const condition of REPORT_CONDITIONS) {
    findings[condition] = (await scoreDocs(linted, rows.map((row) => ({ slug: row.slug, text: row.docs[condition] })), opts, documentKey)).score;
  }

  const cost = Object.fromEntries(
    ["A", ...CONDITIONS].map((condition) => {
      const metas = rows.map((row) => row.meta[condition]).filter((meta) => meta.called !== false);
      const usd = metas.map((meta) => meta.total_cost_usd).filter((value) => typeof value === "number");
      const ms = metas.map((meta) => meta.duration_ms).filter((value) => typeof value === "number");
      return [condition, { calls: metas.length, totalUsd: usd.reduce((s, v) => s + v, 0), meanUsd: mean(usd), meanSeconds: ms.length === 0 ? null : mean(ms) / 1000, totalSeconds: ms.reduce((s, v) => s + v, 0) / 1000 }];
    }),
  );
  const caricature = await caricatureOf(profile, Object.fromEntries(CARICATURE_CONDITIONS.map((condition) => [condition, rows.map((row) => (condition === "筆者" ? row.author : row.docs[condition]))])), tokenized);
  return { set, runner, rows, deltas, findings, cost, caricature, referenceDocs: { author: authorProfile.length, controls: controlProfile.length } };
};

const f3 = (value) => (value === null || value === undefined || Number.isNaN(value) ? "-" : value.toFixed(3));
const f2 = (value) => (value === null || value === undefined || Number.isNaN(value) ? "-" : value.toFixed(2));

const deltaTable = (entry, key) => {
  const header = `| 条件 | 平均 | 中央値 |`;
  const lines = Object.entries(entry[key]).map(([condition, values]) => `| ${condition} | ${f3(mean(values))} | ${f3(median(values))} |`);
  return [header, "|---|---|---|", ...lines];
};

const comparisonTable = (comparisons) => [
  "| 比較 | 勝ち | 負け | 引き分け | 差の平均 | 95% CI（bootstrap） | 符号検定 p |",
  "|---|---|---|---|---|---|---|",
  ...comparisons.map((c) => `| ${c.x} vs ${c.y} | ${c.wins} | ${c.losses} | ${c.ties} | ${f3(c.meanDiff)} | [${f3(c.ci[0])}, ${f3(c.ci[1])}] | ${f3(c.p)} |`),
];

const pct = (value) => (value === null ? "-" : `${Math.round(value * 100)}%`);

const caricatureTable = ({ orthography, density }) => [
  `| 項目 | 目安 | ${CARICATURE_CONDITIONS.join(" | ")} |`,
  `|---|---|${CARICATURE_CONDITIONS.map(() => "---").join("|")}|`,
  ...orthography.map((row) => `| 表記 ${row.label} | - | ${CARICATURE_CONDITIONS.map((condition) => {
    const v = row.values[condition];
    return `${pct(v.share)}（${v.author}/${v.total}）`;
  }).join(" | ")} |`),
  ...density.map((row) => `| 密度 ${row.label} | ${row.max} | ${CARICATURE_CONDITIONS.map((condition) => {
    const v = row.values[condition];
    return `${f2(v.mean)}（超え ${v.over}）`;
  }).join(" | ")} |`),
];

const revisionLines = (rows, condition) => {
  const before = REVISED[condition];
  const called = rows.filter((row) => row.revision[condition].called);
  return [
    `- ${condition} で呼び出した ${called.length} 本のうち guard 通過 ${called.filter((row) => row.revision[condition].guardPass).length} 本。指摘なしで ${before} のままの記事 ${rows.length - called.length} 本`,
    `- ${condition} と ${before} の文字単位の編集率（1 − 2·LCS/(|${before}|+|${condition}|)）: 平均 ${f3(mean(rows.map((row) => row.revision[condition].editRatio)))}、中央値 ${f3(median(rows.map((row) => row.revision[condition].editRatio)))}`,
  ];
};

const revisionCells = (revision) => [revision.findings, revision.called ? (revision.guardPass ? "通過" : "失敗") : "しない", f3(revision.editRatio)];

export const renderAbcReport = (report) => {
  const { rows, deltas, findings, cost, caricature } = report;
  const main = deltas.filter((entry) => entry.size === MAIN_SIZE);
  const winPairs = [["B", "A"], ["C", "A"], ["C", "B"], ["BC", "A"], ["BC", "B"]];
  const out = [
    `# A/B/C（${report.set} ${rows.length} 本、runner ${report.runner}）`,
    "",
    "A は対照の素の出力、B は文体の指示と筆者の例 3 本を足した出力、C は A に lint の指摘を 1 回だけ直させた出力、BC は B に C と同じ手順で lint の指摘を 1 回だけ直させた出力。C戻し・BC戻し は guard に落ちた C・BC を A・B に戻したもの（スキルの手順どおりの最悪の場合）。",
    `Delta の語彙と z の平均・標準偏差は、筆者のプロファイル用 ${report.referenceDocs.author} 本と、その対照 ${report.referenceDocs.controls} 本から決めた（test は使っていない）。勝ちは Delta が小さいほう。差は前者 − 後者で、負なら前者が筆者に近い。`,
    report.set === "test" ? "注: 辞書づくりのあいだに test を見たことがあるなら、C と BC に有利な向きの偏りがある。" : "",
    "",
    `## 1. Burrows の Delta（同じ slug の筆者の記事との距離、N=${MAIN_SIZE}）`,
  ];
  for (const entry of main) {
    out.push("", `### ${entry.variant}（特徴 ${entry.features} 語）`, "", ...deltaTable(entry, "pair"), "", ...comparisonTable(entry.comparisons));
  }
  out.push("", `## 2. プロファイル用の筆者の重心との Delta（N=${MAIN_SIZE}）`);
  for (const entry of main) {
    out.push("", `### ${entry.variant}`, "", ...deltaTable(entry, "toCenter"), "", ...comparisonTable(entry.centerComparisons));
  }
  out.push(
    "",
    "## 3. N を変えたとき（同じ slug との Delta の平均）",
    "",
    `| N | 語彙 | 特徴 | ${REPORT_CONDITIONS.join(" | ")} | ${winPairs.map(([x, y]) => `${x} 勝ち/${y}`).join(" | ")} |`,
    `|---|---|---|${[...REPORT_CONDITIONS, ...winPairs].map(() => "---").join("|")}|`,
  );
  for (const entry of deltas) {
    const wins = (x, y) => {
      const c = entry.comparisons.find((item) => item.x === x && item.y === y);
      return `${c.wins}/${c.wins + c.losses + c.ties}`;
    };
    out.push(`| ${entry.size} | ${entry.variant} | ${entry.features} | ${REPORT_CONDITIONS.map((condition) => f3(mean(entry.pair[condition]))).join(" | ")} | ${winPairs.map(([x, y]) => wins(x, y)).join(" | ")} |`);
  }
  out.push(
    "",
    "## 4. lint の指摘（C と BC には循環。指摘を減らすように作っている）",
    "",
    "| 条件 | 記事 | 字数 | 指摘 | 文書単位 | 1000字あたり |",
    "|---|---|---|---|---|---|",
    ...REPORT_CONDITIONS.map((condition) => {
      const row = findings[condition];
      return `| ${condition} | ${row.docs} | ${row.chars} | ${row.findings} | ${row.documentLevel} | ${f2(row.per1000)} |`;
    }),
    "",
    "## 5. 壊していないか",
    "",
    ...revisionLines(rows, "C"),
    ...revisionLines(rows, "BC"),
    `- 指示した字数に対する地の文の字数の比: ${REPORT_CONDITIONS.map((condition) => `${condition} ${f2(mean(rows.map((row) => row.lengthRatio[condition])))}`).join("、")}`,
    "",
    "## 6. 費用と時間",
    "",
    "| 条件 | 呼び出し | 合計 USD | 1 本あたり USD | 合計時間 | 1 本あたり秒 |",
    "|---|---|---|---|---|---|",
    ...["A", ...CONDITIONS].map((condition) => {
      const c = cost[condition];
      return `| ${condition} | ${c.calls} | ${f2(c.totalUsd)} | ${f3(c.meanUsd)} | ${minutes(c.totalSeconds)} | ${c.meanSeconds === null ? "-" : c.meanSeconds.toFixed(0)} |`;
    }),
    "",
    "## 7. 記事ごと",
    "",
    `| slug | A の指摘 | C guard | 編集率 C/A | B の指摘 | BC guard | 編集率 BC/B | ${REPORT_CONDITIONS.map((condition) => `Delta ${condition}`).join(" | ")} | 字数比 A | 字数比 B | 字数比 BC |`,
    `|---|${[...Array(9 + REPORT_CONDITIONS.length)].map(() => "---").join("|")}|`,
    ...rows.map((row, i) => {
      const pair = main[0].pair;
      return `| ${row.slug} | ${[...revisionCells(row.revision.C), ...revisionCells(row.revision.BC)].join(" | ")} | ${REPORT_CONDITIONS.map((condition) => f3(pair[condition][i])).join(" | ")} | ${f2(row.lengthRatio.A)} | ${f2(row.lengthRatio.B)} | ${f2(row.lengthRatio.BC)} |`;
    }),
    "",
    "## 8. 筆者の癖を誇張していないか（辞書の語の出方）",
    "",
    `表記は筆者側の形の割合（筆者側/両方の回数）、密度は記事ごとの 1000 字あたりの平均（目安を超えた記事の数）。筆者は同じ slug の test の記事 ${rows.length} 本。`,
    "",
    ...caricatureTable(caricature),
  );
  const failed = rows.flatMap((row) => Object.keys(REVISED).flatMap((condition) => row.revision[condition].problems.map((problem) => `- ${condition} ${row.slug}: ${problem}`)));
  if (failed.length > 0) {
    out.push("", "guard の指摘:", ...failed);
  }
  return `${out.filter((line, i, all) => !(line === "" && all[i - 1] === "")).join("\n")}\n`;
};

