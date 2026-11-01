import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { build } from "./build.js";
import { corpusPaths, loadCorpus } from "./corpus.js";
import { disablesCheck } from "./accept.js";
import { authorDocsOf, renderEval, renderFinding, runEval, truncate } from "./eval.js";
import { docRates, featuresOfMarkdown } from "./profile.js";
import { matchCount } from "./tokens.js";

const MESSAGE_MAX = 70;
const REVIEW_LIMITS = { orthography: 30, orthography_review: 15, density: 30, findings: 100, hints_per_line: 8 };

export { truncate };

const zText = (z) =>
  Object.entries(z ?? {})
    .map(([runner, value]) => `${runner} ${value}`)
    .join(" / ");

const surfaceOf = (entry) => /「(.+?)」/u.exec(entry.message ?? "")?.[1] ?? entry.evidence.feature;

const exampleText = (example) => truncate(String(example ?? "").replace(/^[^:]+: /u, ""), 40);

const contextLines = (evidence) => [
  `  - 後ろ: 筆者 ${evidence.author_next || "-"}｜対照 ${evidence.control_next || "-"}`,
  `  - 例: 筆者「${exampleText(evidence.author_example) || "-"}」｜対照「${exampleText(evidence.control_example) || "-"}」`,
];

const otherText = (evidence) =>
  evidence.author_other_per_1000 === undefined ? "" : `｜他ジャンル ${evidence.author_other_per_1000}/1000（対照 ${evidence.control_per_1000}）`;

const briefText = (evidence) => (evidence.in_brief_docs === undefined ? "指示 -" : `指示 ${evidence.in_brief_docs}本`);

const idText = (entry) => (entry.id ? `${entry.id} ` : "");

const devLeaningText = (stats) => (stats ? `｜dev ${stats.count}回・${stats.docs}本` : "");

const leaningRow = (entry, dev = {}) => {
  const e = entry.evidence;
  const controls = Object.entries(e.control)
    .map(([runner, c]) => `${runner} ${c.count}回・${c.docs}本`)
    .join("、");
  return [
    `- ${idText(entry)}**${surfaceOf(entry)}**（${e.feature}）z ${zText(e.z)}｜筆者 ${e.author_count}回・${e.author_docs}本${devLeaningText(dev[entry.id])}｜${controls}｜${briefText(e)}${otherText(e)}${e.orthography_pair ? `｜表記の組 ${e.orthography_pair}` : ""}`,
    ...contextLines(e),
    ...(entry.note ? [`  - 注: ${entry.note}`] : []),
  ];
};

const choiceText = (counts) =>
  Object.entries(counts)
    .map(([word, n]) => `${word} ${n}`)
    .join("・");

const orthographyRow = (entry) => {
  const e = entry.evidence;
  const controls = Object.entries(e.control)
    .map(([runner, counts]) => `${runner} ${choiceText(counts)}`)
    .join("、");
  return [
    `- ${idText(entry)}**${entry.expected}** ← \`${entry.pattern}\` z ${zText(e.z)}｜筆者 ${choiceText(e.author)}（${e.author_docs}本）｜${controls}`,
    ...contextLines(e),
    ...(entry.check ? [`  - 要確認: ${entry.check.join("。")}`] : []),
  ];
};

const devDensityText = (stats) => (stats ? `｜dev 最大 ${stats.max}・超え ${stats.fires}/${stats.docs}本` : "");

const densityRow = (entry, dev = {}) => {
  const e = entry.evidence;
  const controls = Object.entries(e.control)
    .map(([runner, c]) => `${runner} 中央 ${c.p50}・超え ${c.fires}/${c.docs}本`)
    .join("、");
  return `- ${idText(entry)}${entry.message}（${e.feature}）目安 ${entry.max_per_1000}/1000｜筆者 中央 ${entry.typical_per_1000}・最大 ${e.author_max}（${e.author_articles}本、${entry.min_chars}字以上）${devDensityText(dev[entry.id])}｜${controls}｜${briefText(e)}`;
};

const hintLines = (hints) => {
  const items = hints.map((hint) => `${hint.feature.replace(/\/.*$/u, "")}（${Object.values(hint.z).join("/")}、筆者 ${hint.author_count}）`);
  const lines = [];
  for (let at = 0; at < items.length; at += REVIEW_LIMITS.hints_per_line) {
    lines.push(items.slice(at, at + REVIEW_LIMITS.hints_per_line).join("、"));
  }
  return lines;
};

const statText = (stat, lower) => {
  if (!stat || stat.articles === 0) {
    return "-";
  }
  const edge = lower ? stat.min : stat.max;
  const fires = stat.fires === undefined || stat.fires === null ? "" : ` / ${stat.fires}本（厳しめ ${stat.fires_stricter}本）`;
  return `${stat.p50} / ${edge}${fires}`;
};

const THRESHOLD_ROWS = [
  ["sentence_length", "文の長さ（最大）"],
  ["max_ten", "1 文の読点（最大）"],
  ["bold_per_1000", "太字/1000字"],
  ["list_ratio", "箇条書きの比率"],
  ["bold_label_items", "太字ラベルの箇条書き（個）"],
  ["emphasis_share_min", "斜体の割合（下限）"],
];

const thresholdLines = (thresholds, proposal) => {
  const runners = Object.keys(thresholds.controls ?? {});
  const lines = [
    `| 番号 | 項目 | 提案（厳しめ） | 筆者 中央 / 端 | ${runners.map((runner) => `${runner} 中央 / 端 / 引っかかる本数`).join(" | ")} |`,
    `|---|---|---|---|${runners.map(() => "---|").join("")}`,
  ];
  for (const [key, label] of THRESHOLD_ROWS) {
    const lower = key === "emphasis_share_min";
    const stat = thresholds[key];
    const off = disablesCheck(key, stat?.proposed) ? "（検査が止まる）" : "";
    lines.push(`| T.${key} | ${label} \`${key}\` | ${stat?.proposed ?? "-"}${off}（${stat?.stricter ?? "-"}） | ${statText(stat, lower)} | ${runners.map((runner) => statText(thresholds.controls[runner][key], lower)).join(" | ")} |`);
  }
  const p = proposal.thresholds ?? {};
  lines.push(
    "",
    `T.decoration_min_chars ${p.decoration_min_chars}、T.density_min_chars ${p.density_min_chars}、T.emphasis_min_marks ${p.emphasis_min_marks}、T.emphasis_share_typical ${p.emphasis_share_typical}（太字/1000字は decoration_min_chars 字以上、斜体の割合は強調 emphasis_min_marks 個以上の記事だけで数える）。T だけを渡すと、検査が止まる値（と、斜体の割合が止まるときの emphasis_*）を除いた提案をまとめて受け入れる。`,
  );
  return lines;
};

const section = (title, intro, lines) => [`## ${title}`, "", ...(intro ? [intro, ""] : []), ...(lines.length > 0 ? lines : ["（なし）"]), ""];

export const renderReview = ({ author, proposal, thresholds, evalRows, findings, stale, dev = {} }) => {
  const sides = Object.entries(proposal.sides ?? {})
    .map(([name, side]) => `${name} ${side.docs}本 ${side.chars}字`)
    .join("、");
  const shown = findings.slice(0, REVIEW_LIMITS.findings);
  const lines = [
    `# ${author} のプロファイル見直し`,
    "",
    `- 比べた記事: ${sides}`,
    "- z は負ほどモデル寄り（orthography は正ほど筆者の表記に寄る）。「指示」は対照の指示にその語が入っていた記事の数（内容語を含む特徴だけ。助詞・記号だけの特徴は -）、「他ジャンル」は選んでいないカテゴリーの筆者の記事での頻度、「dev」は筆者の dev の記事での回数（density は 1000 字あたりの最大と目安の超え）。test と holdout は数えていない。",
    `- 行頭の M3・O2・R1・D5・T.<項目> が番号。\`onajimi accept --author ${author} M3 O2 'D5=メッセージ' T\` で profile.yml に足して build する（M と D は =メッセージ で message を差し替える）。`,
    ...(stale.length > 0 ? [`- generated/ が profile.yml と食い違っている（${stale.join(", ")}）。onajimi build を実行してから review をやり直す。`] : []),
    "",
    ...section("model_leaning の候補", "筆者がほぼ使わず、どの対照も多く使う語。", (proposal.model_leaning ?? []).flatMap((entry) => leaningRow(entry, dev))),
    ...section(
      "指示に入っていたので外した候補（excluded_in_brief）",
      "対照の指示に語が入っていた。指示から写った恐れがあるので辞書に入れない。",
      (proposal.excluded_in_brief ?? []).map((entry) => `- ${surfaceOf(entry)}（${entry.evidence.feature}）z ${zText(entry.evidence.z)}｜筆者 ${entry.evidence.author_count}回｜${briefText(entry.evidence)}${entry.note ? "｜他ジャンルで多い" : ""}`),
    ),
    ...section("表記の候補（orthography）", "読みと品詞が同じで表記だけが違う組。expected が筆者の表記、pattern がモデルの表記。", (proposal.orthography ?? []).slice(0, REVIEW_LIMITS.orthography).flatMap(orthographyRow)),
    ...section("表記の候補・要確認（orthography_review）", "別の語が同じ読みにまとまっているかもしれない組。例文で確かめる。", (proposal.orthography_review ?? []).slice(0, REVIEW_LIMITS.orthography_review).flatMap(orthographyRow)),
    ...section("密度の候補（density）", "筆者も使うが頻度が違う語。プロファイル用の記事が 1 本も超えない値を目安にした。超えは目安で引っかかる対照の記事の数。", (proposal.density ?? []).slice(0, REVIEW_LIMITS.density).map((entry) => densityRow(entry, dev))),
    ...section("筆者寄りの語（author_leaning の手がかり）", "筆者が多く使い、対照が少ない語。モデル側の言い方との対応は人が決める。", hintLines(proposal.author_leaning_hints ?? [])),
    ...section("しきい値", "記事ごとの値。端は最大（斜体の割合は最小）。引っかかる本数は提案の値で引っかかる対照の記事の数。", thresholdLines(thresholds, proposal)),
    ...section("今の profile.yml での dev の指摘", null, [
      renderEval(evalRows),
      "",
      ...shown.map((f) => `- ${renderFinding(f, { messageMax: MESSAGE_MAX, separator: "｜" })}`),
      ...(findings.length > shown.length ? [`- ほか ${findings.length - shown.length} 件`] : []),
    ]),
  ];
  return `${lines.join("\n").trimEnd()}\n`;
};

export const devStats = async (corpus, proposal) => {
  const options = { skipParagraphs: corpus.config.skipParagraphs };
  const docs = [];
  for (const doc of authorDocsOf(corpus.dev)) {
    docs.push(await featuresOfMarkdown(doc.text, options));
  }
  const stats = {};
  for (const entry of proposal.model_leaning ?? []) {
    const counts = docs.map((doc) => doc.strTokens.reduce((sum, str) => sum + matchCount(str.tokens, entry.tokens), 0));
    stats[entry.id] = { count: counts.reduce((sum, n) => sum + n, 0), docs: counts.filter((n) => n > 0).length };
  }
  for (const entry of proposal.density ?? []) {
    const rates = docRates(docs, entry.tokens, entry.min_chars ?? 0);
    stats[entry.id] = {
      max: rates.length === 0 ? 0 : Number(Math.max(...rates).toFixed(1)),
      fires: rates.filter((rate) => rate > entry.max_per_1000).length,
      docs: rates.length,
    };
  }
  return stats;
};

export const writeReview = async ({ root, author }) => {
  const dir = corpusPaths(root, author).profile;
  const read = (name) => {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) {
      throw new Error(`${path.relative(process.cwd(), file)} がない。先に onajimi profile --author ${author} を実行する。`);
    }
    return YAML.parse(fs.readFileSync(file, "utf8"));
  };
  const proposal = read("proposal.yml");
  const thresholds = read("thresholds.yml");
  const { stale } = build({ root, author, check: true });
  const corpus = loadCorpus(root, author);
  const { rows: evalRows, findings } = await runEval({ root, author, set: "dev", details: true });
  const dev = await devStats(corpus, proposal);
  const text = renderReview({ author, proposal, thresholds, evalRows, findings, stale, dev });
  const file = path.join(dir, "review.md");
  fs.writeFileSync(file, text);
  return { file, lines: text.split("\n").length - 1 };
};
