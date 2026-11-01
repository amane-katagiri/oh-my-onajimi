import { addCount, base, condition, isAscii, isBreak, mergeCounts, nextKey, snippet, tokenizeProse } from "./tokens.js";

const CONTENT_POS = new Set(["名詞", "動詞", "形容詞", "副詞"]);
const NON_CONTENT_DETAIL = new Set(["非自立", "数", "接尾"]);
const HAS_LETTER = /\p{L}/u;

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
  const { strTokens, chars } = await tokenizeProse(markdown, options);
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

export const topList = (surfaces) =>
  [...surfaces]
    .sort((x, y) => y[1] - x[1])
    .slice(0, 3)
    .map(([surface]) => surface);

export const per1000 = (count, chars) => (chars === 0 ? 0 : Number(((count / chars) * 1000).toFixed(2)));

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

