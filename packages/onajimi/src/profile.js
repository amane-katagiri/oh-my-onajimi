import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { tokenize } from "kuromojin";
import { corpusPaths, loadCorpus } from "./corpus.js";
import { analyzeProse, stripTitle } from "./prose.js";
import { buildBrief, renderPrompt } from "./brief.js";
import { aggregateVariants, docVariants, proposeOrthography } from "./orthography.js";
import { ceilTo, measureArticle, percentile, proposeThresholds } from "./stats.js";
import { addCount, base, condition, formatCounts, isAscii, isBreak, matchCount, mergeCounts, nextKey, snippet } from "./tokens.js";

const CONTENT_POS = new Set(["名詞", "動詞", "形容詞", "副詞"]);
const NON_CONTENT_DETAIL = new Set(["非自立", "数", "接尾"]);
const HAS_LETTER = /\p{L}/u;
const TSV_MIN_ABS_Z = 2;

export { snippet };

export const isContentWord = (token) =>
  CONTENT_POS.has(token.pos) && !NON_CONTENT_DETAIL.has(token.pos_detail_1) && HAS_LETTER.test(token.surface_form) && !isAscii(token);

export const docFeatures = (strTokens) => {
  const features = new Map();
  const add = (key, kind, content, tokens, surface, text, start, end, following) => {
    let entry = features.get(key);
    if (!entry) {
      entry = { kind, content, tokens, count: 0, surfaces: new Map(), next: new Map(), example: snippet(text, start, end) };
      features.set(key, entry);
    }
    entry.count += 1;
    addCount(entry.surfaces, surface);
    addCount(entry.next, nextKey(following));
  };
  for (const { text, tokens } of strTokens) {
    tokens.forEach((token, index) => {
      const start = token.word_position - 1;
      const end = start + token.surface_form.length;
      const next = tokens[index + 1];
      if (isContentWord(token)) {
        add(`${base(token)}/${token.pos}`, "unigram", true, [{ pos: token.pos, ...condition(token) }], token.surface_form, text, start, end, next);
      }
      if (next && !isBreak(token) && !isBreak(next) && !(isAscii(token) && isAscii(next))) {
        add(
          `${base(token)}+${base(next)}`,
          "bigram",
          isContentWord(token) || isContentWord(next),
          [condition(token), condition(next)],
          `${token.surface_form}${next.surface_form}`,
          text,
          start,
          end + next.surface_form.length,
          tokens[index + 2],
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
  return { features: docFeatures(strTokens), chars, strTokens };
};

export const aggregate = (docs) => {
  const counts = new Map();
  const totals = { unigram: 0, bigram: 0 };
  for (const { id, features } of docs) {
    for (const [key, entry] of features) {
      let total = counts.get(key);
      if (!total) {
        total = { kind: entry.kind, content: entry.content, tokens: entry.tokens, count: 0, docs: 0, surfaces: new Map(), next: new Map(), examples: [] };
        counts.set(key, total);
      }
      total.count += entry.count;
      total.docs += 1;
      totals[entry.kind] += entry.count;
      mergeCounts(total.surfaces, entry.surfaces);
      mergeCounts(total.next, entry.next);
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

const EMPTY = { count: 0, docs: 0, surfaces: new Map(), next: new Map(), examples: [] };

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
    const row = { feature: key, kind, content: sample.content, tokens: sample.tokens, author: a, z: {}, control: {}, modelLeaning: {}, authorLeaning: false };
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
const fixed = (value) => (value === undefined || value === null ? "" : value.toFixed(2));
const topList = (surfaces) =>
  [...surfaces]
    .sort((x, y) => y[1] - x[1])
    .slice(0, 3)
    .map(([surface]) => surface);
const per1000 = (count, chars) => (chars === 0 ? 0 : Number(((count / chars) * 1000).toFixed(2)));

const scriptOf = (char) => {
  if (char === undefined) {
    return null;
  }
  if (/[\p{Script=Han}々]/u.test(char)) {
    return "han";
  }
  if (/[\p{Script=Katakana}ー]/u.test(char)) {
    return "katakana";
  }
  return /[A-Za-z0-9]/u.test(char) ? "latin" : null;
};

export const containsWord = (text, surface) => {
  const head = scriptOf(surface[0]);
  const tail = scriptOf(surface.at(-1));
  for (let at = text.indexOf(surface); at !== -1; at = text.indexOf(surface, at + 1)) {
    const before = scriptOf(text[at - 1]);
    const after = scriptOf(text[at + surface.length]);
    if (!(head !== null && before === head) && !(tail !== null && after === tail)) {
      return true;
    }
  }
  return false;
};

export const annotate = (rows, { prompts = [], other = null, controlChars = 0 }) => {
  for (const row of rows) {
    const controls = Object.values(row.control);
    row.controlSurfaces = controls.reduce((into, c) => mergeCounts(into, c.surfaces), new Map());
    row.controlNext = controls.reduce((into, c) => mergeCounts(into, c.next), new Map());
    const surfaces = topList(row.controlSurfaces.size > 0 ? row.controlSurfaces : row.author.surfaces);
    row.inBriefDocs = row.content === false ? null : prompts.filter((prompt) => surfaces.some((surface) => containsWord(prompt, surface))).length;
    row.authorOtherPer1000 = other ? per1000(other.counts.get(row.feature)?.count ?? 0, other.chars) : null;
    row.controlPer1000 = per1000(
      controls.reduce((sum, c) => sum + c.count, 0),
      controlChars,
    );
  }
  return rows;
};

export const renderCandidates = (rows, allRunners) => {
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

const evidenceOf = (row, runners) => ({
  feature: row.feature,
  z: Object.fromEntries(runners.map((runner) => [runner, Number(row.z[runner].toFixed(2))])),
  author_count: row.author.count,
  author_docs: row.author.docs,
  control: Object.fromEntries(runners.map((runner) => [runner, { count: row.control[runner].count, docs: row.control[runner].docs }])),
  ...(row.inBriefDocs === null ? {} : { in_brief_docs: row.inBriefDocs ?? 0 }),
  ...(row.authorOtherPer1000 === null || row.authorOtherPer1000 === undefined
    ? {}
    : { author_other_per_1000: row.authorOtherPer1000, control_per_1000: row.controlPer1000 }),
  author_next: formatCounts(row.author.next),
  control_next: formatCounts(row.controlNext),
  author_example: row.author.examples?.[0] ?? "",
  control_example: runners.map((runner) => row.control[runner].examples?.[0]).find(Boolean) ?? "",
});

const leansToEveryModel = (row, runners, zMax) => runners.every((runner) => row.modelLeaning[runner] && row.z[runner] <= zMax);

const registerNote = (row) =>
  row.authorOtherPer1000 > 0 && row.authorOtherPer1000 >= row.controlPer1000
    ? `筆者の他のカテゴリーでは 1000 字あたり ${row.authorOtherPer1000}（対照 ${row.controlPer1000}）。ジャンルで使い方が変わる語`
    : undefined;

const modelSurface = (row, runners) => topList(new Map(runners.flatMap((runner) => [...row.control[runner].surfaces])))[0];

export const proposeModelLeaning = (rows, runners, { proposal_z: zMax, proposal_max_author_docs: maxAuthorDocs, proposal_limit: limit }) => {
  const picked = rows.filter((row) => leansToEveryModel(row, runners, zMax) && row.author.docs <= maxAuthorDocs);
  const entry = (row) => {
    const note = registerNote(row);
    return {
      tokens: row.tokens,
      message: `「${modelSurface(row, runners)}」は筆者の言い方ではない。`,
      ...(note ? { note } : {}),
      evidence: evidenceOf(row, runners),
    };
  };
  return {
    model_leaning: picked.filter((row) => !(row.inBriefDocs > 0)).slice(0, limit).map(entry),
    excluded_in_brief: picked.filter((row) => row.inBriefDocs > 0).slice(0, limit).map(entry),
  };
};

export const proposeRateDifferences = (rows, runners, sides, { rate_z: zMax, proposal_max_author_docs: maxAuthorDocs, proposal_limit: limit }) =>
  rows
    .filter((row) => leansToEveryModel(row, runners, zMax) && row.author.docs > maxAuthorDocs)
    .slice(0, limit)
    .map((row) => ({
      feature: row.feature,
      tokens: row.tokens,
      per_1000_chars: {
        author: per1000(row.author.count, sides.author.chars),
        ...Object.fromEntries(runners.map((runner) => [runner, per1000(row.control[runner].count, sides[runner].chars)])),
      },
      evidence: evidenceOf(row, runners),
    }));

const round1 = (value) => Number(value.toFixed(1));

export const docRates = (docs, tokens, minChars) =>
  docs
    .filter((doc) => doc.chars >= minChars)
    .map((doc) => (doc.strTokens.reduce((sum, str) => sum + matchCount(str.tokens, tokens), 0) / doc.chars) * 1000);

export const proposeDensity = (rates, authorDocs, controlDocs, { min_chars: minChars }) =>
  rates
    .map((rate) => {
      const authorRates = docRates(authorDocs, rate.tokens, minChars);
      if (authorRates.length === 0) {
        return null;
      }
      const max = ceilTo(Math.max(...authorRates), 0.1);
      const control = Object.fromEntries(
        Object.entries(controlDocs).map(([runner, docs]) => {
          const values = docRates(docs, rate.tokens, minChars);
          return [runner, { p50: round1(percentile(values, 0.5) ?? 0), fires: values.filter((value) => value > max).length, docs: values.length }];
        }),
      );
      const fireShare = Math.min(...Object.values(control).map((c) => (c.docs === 0 ? 0 : c.fires / c.docs)));
      return {
        tokens: rate.tokens,
        max_per_1000: max,
        min_chars: minChars,
        typical_per_1000: round1(percentile(authorRates, 0.5)),
        message: `「${rate.feature.replace(/\/.*$/u, "").replaceAll("+", "")}」が多い。`,
        evidence: {
          feature: rate.feature,
          author_articles: authorRates.length,
          author_max: round1(Math.max(...authorRates)),
          control,
          ...(rate.evidence.in_brief_docs === undefined ? {} : { in_brief_docs: rate.evidence.in_brief_docs }),
        },
        fireShare,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.fireShare - a.fireShare || a.evidence.feature.localeCompare(b.evidence.feature))
    .map(({ fireShare, ...entry }) => entry);

export const proposeAuthorHints = (rows, runners, { hint_z: zMin, hint_limit: limit }) =>
  rows
    .filter((row) => row.kind === "unigram" && row.authorLeaning && runners.length > 0 && runners.every((runner) => (row.z[runner] ?? 0) >= zMin))
    .sort((a, b) => Math.min(...runners.map((r) => b.z[r])) - Math.min(...runners.map((r) => a.z[r])))
    .slice(0, limit)
    .map((row) => ({
      feature: row.feature,
      z: Object.fromEntries(runners.map((runner) => [runner, Number(row.z[runner].toFixed(2))])),
      author_count: row.author.count,
      control_count: Object.fromEntries(runners.map((runner) => [runner, row.control[runner]?.count ?? 0])),
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

const analyzeDocs = async (docs, options) => {
  const analyzed = [];
  for (const doc of docs) {
    const result = await featuresOfMarkdown(doc.text, options);
    analyzed.push({ id: doc.slug, ...result, variants: docVariants(doc.slug, result.strTokens) });
  }
  return analyzed;
};

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
    authorPosts = authorPosts.filter((post) => runners.every((runner) => controlTexts[runner].some((doc) => doc.slug === post.slug)));
  }
  const authorDocs = await analyzeDocs(
    authorPosts.map((post) => ({ slug: post.slug, text: stripTitle(post.text, post.meta) })),
    options,
  );
  const controlDocs = {};
  const controls = {};
  for (const runner of runners) {
    controlDocs[runner] = await analyzeDocs(controlTexts[runner], options);
    controls[runner] = aggregate(controlDocs[runner]);
    controls[runner].docCount = controlDocs[runner].length;
    controls[runner].chars = controlDocs[runner].reduce((sum, doc) => sum + doc.chars, 0);
  }
  const authorTotal = aggregate(authorDocs);
  const otherDocs = await analyzeDocs(
    corpus.other.map((post) => ({ slug: post.slug, text: stripTitle(post.text, post.meta) })),
    options,
  );
  const other = otherDocs.length > 0 ? { ...aggregate(otherDocs), chars: otherDocs.reduce((sum, doc) => sum + doc.chars, 0) } : null;
  const prompted = new Set(runners.flatMap((runner) => controlTexts[runner].map((doc) => doc.slug)));
  const prompts = corpus.profile
    .filter((post) => prompted.has(post.slug))
    .map((post) => renderPrompt(corpus.config.control.prompt, buildBrief(post, options)));
  const rows = runners.length > 0 ? compare(authorTotal, controls, params) : [];
  annotate(rows, { prompts, other, controlChars: runners.reduce((sum, runner) => sum + controls[runner].chars, 0) });

  const measureAll = async (texts) => {
    const measured = [];
    for (const text of texts) {
      measured.push(await measureArticle(text));
    }
    return measured;
  };
  const articles = await measureAll(corpus.profile.map((post) => stripTitle(post.text, post.meta)));
  const controlArticles = {};
  for (const runner of runners) {
    controlArticles[runner] = await measureAll(controlTexts[runner].map((doc) => doc.text));
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
