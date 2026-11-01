import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { tokenize } from "kuromojin";
import { corpusPaths, loadCorpus } from "./corpus.js";
import { analyzeProse, stripTitle } from "./prose.js";
import { measureArticle, proposeThresholds } from "./stats.js";

const CONTENT_POS = new Set(["名詞", "動詞", "形容詞", "副詞"]);
const NON_CONTENT_DETAIL = new Set(["非自立", "数", "接尾"]);
const HAS_LETTER = /\p{L}/u;
const ASCII_ONLY = /^[\x21-\x7e]+$/u;
const SNIPPET_MAX = 40;
const TSV_MIN_ABS_Z = 2;
const SENTENCE_END = /[。！？!?\n]/u;

const base = (token) => (token.basic_form === "*" ? token.surface_form : token.basic_form);
const condition = (token) => (token.basic_form === "*" ? { surface_form: token.surface_form } : { basic_form: token.basic_form });
const isBreak = (token) => /^\s+$/u.test(token.surface_form) || token.pos_detail_1 === "空白" || token.pos_detail_1 === "数";

const isAscii = (token) => ASCII_ONLY.test(token.surface_form);

export const isContentWord = (token) =>
  CONTENT_POS.has(token.pos) && !NON_CONTENT_DETAIL.has(token.pos_detail_1) && HAS_LETTER.test(token.surface_form) && !isAscii(token);

export const snippet = (text, start, end) => {
  let from = start;
  while (from > 0 && !SENTENCE_END.test(text[from - 1])) {
    from -= 1;
  }
  let to = end;
  while (to < text.length && !SENTENCE_END.test(text[to])) {
    to += 1;
  }
  if (to < text.length && text[to] !== "\n") {
    to += 1;
  }
  let sentence = text.slice(from, to).trim();
  if ([...sentence].length > SNIPPET_MAX) {
    const left = Math.max(from, start - 15);
    sentence = `…${text.slice(left, Math.min(to, left + SNIPPET_MAX - 2)).trim()}…`;
  }
  return sentence.replace(/\s+/gu, " ");
};

export const docFeatures = (strTokens) => {
  const features = new Map();
  const add = (key, kind, tokens, surface, text, start, end) => {
    let entry = features.get(key);
    if (!entry) {
      entry = { kind, tokens, count: 0, surfaces: new Map(), example: snippet(text, start, end) };
      features.set(key, entry);
    }
    entry.count += 1;
    entry.surfaces.set(surface, (entry.surfaces.get(surface) ?? 0) + 1);
  };
  for (const { text, tokens } of strTokens) {
    tokens.forEach((token, index) => {
      const start = token.word_position - 1;
      const end = start + token.surface_form.length;
      if (isContentWord(token)) {
        add(`${base(token)}/${token.pos}`, "unigram", [{ pos: token.pos, ...condition(token) }], token.surface_form, text, start, end);
      }
      const next = tokens[index + 1];
      if (next && !isBreak(token) && !isBreak(next) && !(isAscii(token) && isAscii(next))) {
        add(
          `${base(token)}+${base(next)}`,
          "bigram",
          [condition(token), condition(next)],
          `${token.surface_form}${next.surface_form}`,
          text,
          start,
          end + next.surface_form.length,
        );
      }
    });
  }
  return features;
};

export const featuresOfMarkdown = async (markdown, options) => {
  const { strs, chars } = analyzeProse(markdown, options);
  const strTokens = [];
  for (const text of strs) {
    strTokens.push({ text, tokens: await tokenize(text) });
  }
  return { features: docFeatures(strTokens), chars };
};

export const aggregate = (docs) => {
  const counts = new Map();
  const totals = { unigram: 0, bigram: 0 };
  for (const { id, features } of docs) {
    for (const [key, entry] of features) {
      let total = counts.get(key);
      if (!total) {
        total = { kind: entry.kind, tokens: entry.tokens, count: 0, docs: 0, surfaces: new Map(), examples: [] };
        counts.set(key, total);
      }
      total.count += entry.count;
      total.docs += 1;
      totals[entry.kind] += entry.count;
      for (const [surface, n] of entry.surfaces) {
        total.surfaces.set(surface, (total.surfaces.get(surface) ?? 0) + n);
      }
      if (total.examples.length < 2) {
        total.examples.push(id ? `${id}: ${entry.example}` : entry.example);
      }
    }
  }
  return { counts, totals };
};

export const logOddsZ = (ya, yc, na, nc, alpha0) => {
  const alpha = (alpha0 * (ya + yc)) / (na + nc);
  const delta = Math.log((ya + alpha) / (na + alpha0 - ya - alpha)) - Math.log((yc + alpha) / (nc + alpha0 - yc - alpha));
  return delta / Math.sqrt(1 / (ya + alpha) + 1 / (yc + alpha));
};

const EMPTY = { count: 0, docs: 0, surfaces: new Map(), examples: [] };

export const compare = (author, controls, { alpha0, min_docs: minDocs, min_count: minCount }) => {
  const runners = Object.keys(controls);
  const keys = new Set(author.counts.keys());
  for (const control of Object.values(controls)) {
    for (const key of control.counts.keys()) {
      keys.add(key);
    }
  }
  const rows = [];
  for (const key of keys) {
    const a = author.counts.get(key) ?? EMPTY;
    const sample = author.counts.get(key) ?? Object.values(controls).map((c) => c.counts.get(key)).find(Boolean);
    const kind = sample.kind;
    const row = { feature: key, kind, tokens: sample.tokens, author: a, z: {}, control: {}, modelLeaning: {}, authorLeaning: false };
    for (const runner of runners) {
      const c = controls[runner].counts.get(key) ?? EMPTY;
      if (a.count + c.count === 0) {
        row.modelLeaning[runner] = false;
        continue;
      }
      const z = logOddsZ(a.count, c.count, author.totals[kind], controls[runner].totals[kind], alpha0);
      row.z[runner] = z;
      row.control[runner] = c;
      row.modelLeaning[runner] = z < 0 && c.docs >= minDocs && c.count >= minCount;
      if (z > 0 && a.docs >= minDocs && a.count >= minCount) {
        row.authorLeaning = true;
      }
    }
    row.score = Math.max(...Object.values(row.z));
    if (row.authorLeaning || runners.some((runner) => row.modelLeaning[runner])) {
      rows.push(row);
    }
  }
  return rows.sort((x, y) => x.score - y.score || x.feature.localeCompare(y.feature));
};

const cell = (value) => String(value ?? "").replace(/[\t\n\r]/gu, " ");
const fixed = (value) => (value === undefined ? "" : value.toFixed(2));
const topSurfaces = (surfaces) =>
  [...surfaces]
    .sort((x, y) => y[1] - x[1])
    .slice(0, 3)
    .map(([surface]) => surface)
    .join("|");

export const renderCandidates = (rows, allRunners) => {
  const header = [
    "feature",
    "kind",
    ...allRunners.map((runner) => `z_${runner}`),
    "author_count",
    "author_docs",
    ...allRunners.flatMap((runner) => [`${runner}_count`, `${runner}_docs`]),
    "surfaces",
    "author_example_1",
    "author_example_2",
    "control_example_1",
    "control_example_2",
  ];
  const lines = rows.map((row) => {
    const controlExamples = allRunners.flatMap((runner) => (row.control[runner]?.examples ?? []).map((example) => `${runner} ${example}`));
    const surfaces = new Map(row.author.surfaces);
    for (const runner of allRunners) {
      for (const [surface, n] of row.control[runner]?.surfaces ?? []) {
        surfaces.set(surface, (surfaces.get(surface) ?? 0) + n);
      }
    }
    return [
      row.feature,
      row.kind,
      ...allRunners.map((runner) => fixed(row.z[runner])),
      row.author.count,
      row.author.docs,
      ...allRunners.flatMap((runner) => (row.control[runner] ? [row.control[runner].count, row.control[runner].docs] : ["", ""])),
      topSurfaces(surfaces),
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

export const proposeModelLeaning = (rows, runners, { proposal_z: zMax, proposal_limit: limit }) =>
  rows
    .filter((row) => runners.every((runner) => row.modelLeaning[runner] && row.z[runner] <= zMax))
    .slice(0, limit)
    .map((row) => ({
      tokens: row.tokens,
      message: `「${topSurfaces(new Map(runners.flatMap((runner) => [...row.control[runner].surfaces]))).split("|")[0]}」は筆者の言い方ではない。`,
      evidence: {
        feature: row.feature,
        z: Object.fromEntries(runners.map((runner) => [runner, Number(row.z[runner].toFixed(2))])),
        author_count: row.author.count,
        author_docs: row.author.docs,
        control: Object.fromEntries(runners.map((runner) => [runner, { count: row.control[runner].count, docs: row.control[runner].docs }])),
      },
    }));

const readControls = (root, author, runnerNames, posts) => {
  const metaBySlug = new Map(posts.map((post) => [post.slug, post.meta]));
  const slugs = posts.map((post) => post.slug);
  const found = {};
  for (const runner of runnerNames) {
    const dir = path.join(corpusPaths(root, author).control, runner);
    const docs = slugs
      .map((slug) => ({ slug, file: path.join(dir, `${slug}.md`) }))
      .filter(({ file }) => fs.existsSync(file))
      .map(({ slug, file }) => ({ slug, text: stripTitle(fs.readFileSync(file, "utf8"), metaBySlug.get(slug)) }));
    if (docs.length > 0) {
      found[runner] = docs;
    }
  }
  return found;
};

export const runProfile = async ({ root, author, paired = false, outDir }) => {
  const corpus = loadCorpus(root, author);
  const options = { skipParagraphs: corpus.config.skipParagraphs };
  const allRunners = Object.keys(corpus.config.control.runners);
  const controlDocs = readControls(root, author, allRunners, corpus.profile);
  const runners = Object.keys(controlDocs);
  let authorPosts = corpus.profile;
  if (paired) {
    authorPosts = authorPosts.filter((post) => runners.every((runner) => controlDocs[runner].some((doc) => doc.slug === post.slug)));
  }
  const authorDocs = [];
  for (const post of authorPosts) {
    authorDocs.push({ id: post.slug, ...(await featuresOfMarkdown(stripTitle(post.text, post.meta), options)) });
  }
  const controls = {};
  for (const runner of runners) {
    const docs = [];
    for (const doc of controlDocs[runner]) {
      docs.push({ id: doc.slug, ...(await featuresOfMarkdown(doc.text, options)) });
    }
    controls[runner] = aggregate(docs);
    controls[runner].docCount = docs.length;
    controls[runner].chars = docs.reduce((sum, doc) => sum + doc.chars, 0);
  }
  const authorTotal = aggregate(authorDocs);
  const rows = runners.length > 0 ? compare(authorTotal, controls, corpus.config.profile) : [];

  const articles = [];
  for (const post of corpus.profile) {
    articles.push(await measureArticle(stripTitle(post.text, post.meta)));
  }
  const thresholds = proposeThresholds(articles);

  const target = outDir ?? corpusPaths(root, author).profile;
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(path.join(target, "_full"), { recursive: true });
  fs.writeFileSync(path.join(target, "_full", "candidates.tsv"), renderCandidates(rows, allRunners));
  const strong = rows.filter((row) => Object.values(row.z).some((z) => Math.abs(z) >= TSV_MIN_ABS_Z));
  fs.writeFileSync(path.join(target, "candidates.tsv"), renderCandidates(strong, allRunners));
  const sides = {
    author: { docs: authorDocs.length, chars: authorDocs.reduce((sum, doc) => sum + doc.chars, 0), paired },
    ...Object.fromEntries(runners.map((runner) => [runner, { docs: controls[runner].docCount, chars: controls[runner].chars }])),
  };
  const proposal = {
    note: "onajimi profile の提案。人が見直して profile.yml に写す。evidence の z は負ほどモデル寄り。",
    sides,
    model_leaning: proposeModelLeaning(rows, runners, corpus.config.profile),
    thresholds: Object.fromEntries(["sentence_length", "max_ten", "bold_per_1000", "list_ratio"].map((key) => [key, thresholds[key].proposed])),
  };
  fs.writeFileSync(path.join(target, "proposal.yml"), YAML.stringify(proposal));
  fs.writeFileSync(
    path.join(target, "thresholds.yml"),
    YAML.stringify({
      note: "プロファイル用の記事ごとの値。proposed はどの記事も超えない値、stricter は 90 パーセンタイルを外側に丸めた値。",
      ...thresholds,
    }),
  );
  return { sides, rows, strong, runners, thresholds, target };
};
