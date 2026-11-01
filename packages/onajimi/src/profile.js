import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { buildBrief, renderPrompt } from "./brief.js";
import { corpusPaths, loadCorpus } from "./corpus.js";
import { authorDocsOf, controlDocsOf } from "./docs.js";
import { aggregate, annotate, compare, featuresOfMarkdown, topList } from "./features.js";
import { aggregateVariants, docVariants, proposeOrthography } from "./orthography.js";
import { proposeAuthorHints, proposeDensity, proposeModelLeaning, proposeRateDifferences } from "./proposals.js";
import { measureArticle, proposeThresholds } from "./stats.js";
import { formatCounts, mergeCounts } from "./tokens.js";
import { mapSeries } from "./util.js";

const TSV_MIN_ABS_Z = 2;

const cell = (value) => String(value ?? "").replace(/[\t\n\r]/gu, " ");
const fixed = (value) => (value === undefined || value === null ? "" : value.toFixed(2));

const renderCandidates = (rows, allRunners) => {
  const header = [
    "feature",
    "kind",
    ...allRunners.map((runner) => `z_${runner}`),
    "author_count",
    "author_docs",
    ...allRunners.flatMap((runner) => [`${runner}_count`, `${runner}_docs`]),
    "surfaces",
    "in_brief_docs",
    "author_other_per_1000",
    "author_next",
    "control_next",
    "author_example_1",
    "author_example_2",
    "control_example_1",
    "control_example_2",
  ];
  const lines = rows.map((row) => {
    const controlExamples = allRunners.flatMap((runner) => (row.control[runner]?.examples ?? []).map((example) => `${runner} ${example}`));
    const surfaces = mergeCounts(new Map(row.author.surfaces), row.controlSurfaces);
    return [
      row.feature,
      row.kind,
      ...allRunners.map((runner) => fixed(row.z[runner])),
      row.author.count,
      row.author.docs,
      ...allRunners.flatMap((runner) => (row.control[runner] ? [row.control[runner].count, row.control[runner].docs] : ["", ""])),
      topList(surfaces).join("|"),
      row.inBriefDocs ?? "-",
      fixed(row.authorOtherPer1000),
      formatCounts(row.author.next),
      formatCounts(row.controlNext),
      row.author.examples[0],
      row.author.examples[1],
      controlExamples[0],
      controlExamples[1],
    ]
      .map(cell)
      .join("\t");
  });
  return `${[header.join("\t"), ...lines].join("\n")}\n`;
};

const analyzeDocs = (docs, options, { variants = false } = {}) =>
  mapSeries(docs, async (doc) => {
    const result = await featuresOfMarkdown(doc.text, options);
    return { id: doc.slug, ...result, ...(variants ? { variants: docVariants(doc.slug, result.strTokens) } : {}) };
  });

const readControls = (root, author, runners, posts) =>
  Object.fromEntries(runners.map((runner) => [runner, controlDocsOf(root, author, runner, posts)]).filter(([, docs]) => docs.length > 0));

const THRESHOLD_KEYS = ["sentence_length", "max_ten", "bold_per_1000", "list_ratio", "decoration_min_chars", "bold_label_items", "emphasis_share_min", "emphasis_min_marks", "density_min_chars"];

export const runProfile = async ({ root, author, paired = false, outDir }) => {
  const corpus = loadCorpus(root, author);
  const params = corpus.config.profile;
  const options = { skipParagraphs: corpus.config.skipParagraphs };
  const allRunners = Object.keys(corpus.config.control.runners);
  const controlTexts = readControls(root, author, allRunners, corpus.profile);
  const runners = Object.keys(controlTexts);
  let authorPosts = corpus.profile;
  if (paired) {
    const slugs = runners.map((runner) => new Set(controlTexts[runner].map((doc) => doc.slug)));
    authorPosts = authorPosts.filter((post) => slugs.every((set) => set.has(post.slug)));
  }
  const authorDocs = await analyzeDocs(authorDocsOf(authorPosts), options, { variants: true });
  const controlDocs = {};
  const controls = {};
  for (const runner of runners) {
    controlDocs[runner] = await analyzeDocs(controlTexts[runner], options, { variants: true });
    controls[runner] = aggregate(controlDocs[runner]);
    controls[runner].docCount = controlDocs[runner].length;
    controls[runner].chars = controlDocs[runner].reduce((sum, doc) => sum + doc.chars, 0);
  }
  const authorTotal = aggregate(authorDocs);
  const otherDocs = await analyzeDocs(authorDocsOf(corpus.other), options);
  const other = otherDocs.length > 0 ? { ...aggregate(otherDocs), chars: otherDocs.reduce((sum, doc) => sum + doc.chars, 0) } : null;
  const prompted = new Set(runners.flatMap((runner) => controlTexts[runner].map((doc) => doc.slug)));
  const prompts = corpus.profile
    .filter((post) => prompted.has(post.slug))
    .map((post) => renderPrompt(corpus.config.control.prompt, buildBrief(post, options)));
  const rows = runners.length > 0 ? compare(authorTotal, controls, params) : [];
  annotate(rows, { prompts, other, controlChars: runners.reduce((sum, runner) => sum + controls[runner].chars, 0) });

  const measureAll = (docs) => mapSeries(docs, (doc) => measureArticle(doc.text));
  const articles = await measureAll(authorDocsOf(corpus.profile));
  const controlArticles = {};
  for (const runner of runners) {
    controlArticles[runner] = await measureAll(controlTexts[runner]);
  }
  const thresholds = proposeThresholds(articles, { minChars: params.min_chars, minMarks: params.emphasis_min_marks, controls: controlArticles });

  const target = outDir ?? corpusPaths(root, author).profile;
  fs.mkdirSync(path.join(target, "_full"), { recursive: true });
  fs.writeFileSync(path.join(target, "_full", "candidates.tsv"), renderCandidates(rows, allRunners));
  const strong = rows.filter((row) => Object.values(row.z).some((z) => Math.abs(z) >= TSV_MIN_ABS_Z));
  fs.writeFileSync(path.join(target, "candidates.tsv"), renderCandidates(strong, allRunners));
  const sides = {
    author: { docs: authorDocs.length, chars: authorDocs.reduce((sum, doc) => sum + doc.chars, 0), paired },
    ...(other ? { author_other: { docs: otherDocs.length, chars: other.chars } } : {}),
    ...Object.fromEntries(runners.map((runner) => [runner, { docs: controls[runner].docCount, chars: controls[runner].chars }])),
  };
  const rateDifferences = proposeRateDifferences(rows, runners, sides, params);
  const orthography = await proposeOrthography(
    aggregateVariants(authorDocs.map((doc) => doc.variants)),
    Object.fromEntries(runners.map((runner) => [runner, aggregateVariants(controlDocs[runner].map((doc) => doc.variants))])),
    params,
  );
  const leaning = proposeModelLeaning(rows, runners, params);
  const pairs = [...orthography.orthography, ...orthography.orthography_review].map((entry) => Object.keys(entry.evidence.author));
  for (const entry of [...leaning.model_leaning, ...leaning.excluded_in_brief]) {
    const words = entry.tokens.map((token) => token.basic_form ?? token.surface_form);
    const pair = pairs.find((variants) => variants.some((variant) => words.includes(variant)));
    if (pair) {
      entry.evidence.orthography_pair = pair.join("/");
    }
  }
  const numbered = (prefix, entries) => entries.map((entry, index) => ({ id: `${prefix}${index + 1}`, ...entry }));
  const proposal = {
    note: "onajimi profile の提案。人が見直して profile.yml に写す。evidence の z は負ほどモデル寄り。id は onajimi accept に渡す番号。model_leaning は筆者がほぼ使わない語で lint の辞書候補、excluded_in_brief は対照の指示に語が入っていたので外した候補（内容語を含む特徴だけを指示と照らす）、rate_differences は筆者も使うが頻度が違う語、density はそれを文書単位の密度で見るときの案、orthography_review は読みが同じでも別の語かもしれない組。",
    sides,
    model_leaning: numbered("M", leaning.model_leaning),
    excluded_in_brief: leaning.excluded_in_brief,
    orthography: numbered("O", orthography.orthography),
    orthography_review: numbered("R", orthography.orthography_review),
    rate_differences: rateDifferences,
    density: numbered("D", proposeDensity(rateDifferences, authorDocs, controlDocs, params)),
    author_leaning_hints: proposeAuthorHints(rows, runners, params),
    thresholds: {
      ...Object.fromEntries(THRESHOLD_KEYS.map((key) => [key, thresholds[key].proposed])),
      emphasis_share_typical: thresholds.emphasis_share_min.p50 ?? null,
    },
  };
  fs.writeFileSync(path.join(target, "proposal.yml"), YAML.stringify(proposal));
  fs.writeFileSync(
    path.join(target, "thresholds.yml"),
    YAML.stringify({
      note: "プロファイル用の記事ごとの値。proposed はどの記事も超えない（emphasis_share_min は下回らない）値、stricter は 90（10）パーセンタイルを外側に丸めた値。controls は対照の記事ごとの値と、proposed で引っかかる記事の数。",
      ...thresholds,
    }),
  );
  return { sides, rows, strong, runners, thresholds, target };
};
