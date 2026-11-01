import { createTester } from "./preset.js";
import { base, isAscii, isBreak, tokenizeProse } from "./tokens.js";

export const countsOf = (strTokens) => {
  const counts = new Map();
  let total = 0;
  for (const { tokens } of strTokens) {
    for (const token of tokens) {
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

export const tokenCounts = async (markdown, options) => countsOf((await tokenizeProse(markdown, options)).strTokens);

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

export const dictionaryTokens = (profile) => {
  const matchers = profile.orthography.flatMap((entry) => [entry.expected, ...(entry.patterns ?? [entry.pattern])].map((pattern) => createTester(pattern)));
  const exact = new Set(
    [...profile.density, ...profile.modelLeaning, ...profile.authorLeaning].flatMap(({ tokens }) =>
      tokens.flatMap((token) => [token.basic_form, token.surface_form].filter((value) => typeof value === "string")),
    ),
  );
  return (key) => exact.has(key) || matchers.some((match) => match(key));
};
