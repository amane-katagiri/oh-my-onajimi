import { tokenize } from "kuromojin";
import { analyzeProse } from "./prose.js";
import { mapSeries } from "./util.js";

const ASCII_ONLY = /^[\x21-\x7e]+$/u;
const SENTENCE_END = /[。！？!?\n]/u;
const SNIPPET_MAX = 40;

export const base = (token) => (token.basic_form === "*" ? token.surface_form : token.basic_form);
export const condition = (token) => (token.basic_form === "*" ? { surface_form: token.surface_form } : { basic_form: token.basic_form });
export const isBreak = (token) => /^\s+$/u.test(token.surface_form) || token.pos_detail_1 === "空白" || token.pos_detail_1 === "数";
export const isAscii = (token) => ASCII_ONLY.test(token.surface_form);
export const nextKey = (token) => (token && !isBreak(token) ? `${base(token)}/${token.pos}` : null);

export const addCount = (map, key, n = 1) => {
  if (key !== null && key !== undefined) {
    map.set(key, (map.get(key) ?? 0) + n);
  }
  return map;
};

export const mergeCounts = (into, from) => {
  for (const [key, n] of from ?? []) {
    addCount(into, key, n);
  }
  return into;
};

export const topCounts = (map, n = 3) => [...(map ?? [])].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, n);

export const formatCounts = (map, n = 3) => topCounts(map, n).map(([key, count]) => `${key} ${count}`).join(", ");

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

const matchesAt = (tokens, at, conditions) =>
  conditions.every((cond, offset) => {
    const token = tokens[at + offset];
    return token !== undefined && Object.entries(cond).every(([key, value]) => token[key] === value);
  });

const matchCount = (tokens, conditions) => {
  let count = 0;
  for (let at = 0; at + conditions.length <= tokens.length; at += 1) {
    if (matchesAt(tokens, at, conditions)) {
      count += 1;
    }
  }
  return count;
};

export const tokenizeProse = async (markdown, options) => {
  const { strs, chars } = analyzeProse(markdown, options);
  return { strTokens: await mapSeries(strs, async (text) => ({ text, tokens: await tokenize(text) })), chars };
};

export const docMatchCount = (doc, conditions) => doc.strTokens.reduce((sum, str) => sum + matchCount(str.tokens, conditions), 0);

export const docRates = (docs, conditions, minChars) =>
  docs.filter((doc) => doc.chars >= minChars).map((doc) => (docMatchCount(doc, conditions) / doc.chars) * 1000);
