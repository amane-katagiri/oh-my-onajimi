import { tokenize } from "kuromojin";
import { analyzeProse } from "./prose.js";
import { base, isAscii, isBreak } from "./tokens.js";

export const tokenCounts = async (markdown, options) => {
  const counts = new Map();
  let total = 0;
  for (const text of analyzeProse(markdown, options).strs) {
    for (const token of await tokenize(text)) {
      if (isBreak(token) || isAscii(token)) {
        continue;
      }
      const key = base(token);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      total += 1;
    }
  }
  return { counts, total };
};

export const mostFrequent = (docs, n, exclude = () => false) => {
  const totals = new Map();
  for (const { counts } of docs) {
    for (const [key, count] of counts) {
      totals.set(key, (totals.get(key) ?? 0) + count);
    }
  }
  return [...totals]
    .filter(([key]) => !exclude(key))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([key]) => key);
};

const relative = (doc, key) => (doc.total === 0 ? 0 : (doc.counts.get(key) ?? 0) / doc.total);

export const fitScaler = (docs, vocabulary) => {
  const features = [];
  for (const key of vocabulary) {
    const values = docs.map((doc) => relative(doc, key));
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const sd = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
    if (sd > 0) {
      features.push({ key, mean, sd });
    }
  }
  return features;
};

export const zVector = (features, doc) => features.map(({ key, mean, sd }) => (relative(doc, key) - mean) / sd);

export const centroid = (vectors) => vectors[0].map((_, i) => vectors.reduce((sum, vector) => sum + vector[i], 0) / vectors.length);

export const delta = (a, b) => a.reduce((sum, value, i) => sum + Math.abs(value - b[i]), 0) / a.length;

const REGEXP_LITERAL = /^\/(.+)\/([gimsuy]*)$/su;

const matcherOf = (pattern) => {
  const literal = REGEXP_LITERAL.exec(pattern);
  if (literal) {
    const regExp = new RegExp(literal[1], literal[2].replace("g", ""));
    return (key) => regExp.test(key);
  }
  return (key) => key.includes(pattern);
};

export const dictionaryTokens = (profile) => {
  const matchers = profile.orthography.flatMap((entry) => [entry.expected, ...(entry.patterns ?? [entry.pattern])].map(matcherOf));
  const exact = new Set(
    [...profile.density, ...profile.modelLeaning, ...profile.authorLeaning].flatMap(({ tokens }) =>
      tokens.flatMap((token) => [token.basic_form, token.surface_form].filter((value) => typeof value === "string")),
    ),
  );
  return (key) => exact.has(key) || matchers.some((match) => match(key));
};
