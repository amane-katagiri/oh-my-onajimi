import { centroid, delta, fitScaler, mostFrequent, zVector } from "./delta.js";
import { escapeRegExp } from "./orthography.js";
import { parseRegExpLiteral } from "./preset.js";

const BOOTSTRAP_SAMPLES = 10000;
const DELTA_SIZES = [50, 150, 300];
export const MAIN_SIZE = 150;

export const mean = (values) => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length);

export const editRatio = (before, after) => {
  if (before === after) {
    return 0;
  }
  const a = [...before];
  const b = [...after];
  let previous = new Int32Array(b.length + 1);
  let current = new Int32Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = a[i - 1] === b[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
    }
    [previous, current] = [current, previous];
  }
  return 1 - (2 * previous[b.length]) / (a.length + b.length);
};

const choose = (n, k) => {
  let value = 1;
  for (let i = 1; i <= k; i += 1) {
    value = (value * (n - k + i)) / i;
  }
  return value;
};

export const signTest = (wins, losses) => {
  const n = wins + losses;
  if (n === 0) {
    return 1;
  }
  let tail = 0;
  for (let k = 0; k <= Math.min(wins, losses); k += 1) {
    tail += choose(n, k);
  }
  return Math.min(1, (2 * tail) / 2 ** n);
};

const mulberry32 = (seed) => () => {
  let t = (seed += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export const bootstrapMeanCi = (values, { samples = BOOTSTRAP_SAMPLES, seed = 1 } = {}) => {
  const random = mulberry32(seed);
  const means = [];
  for (let s = 0; s < samples; s += 1) {
    let sum = 0;
    for (let i = 0; i < values.length; i += 1) {
      sum += values[Math.floor(random() * values.length)];
    }
    means.push(sum / values.length);
  }
  means.sort((x, y) => x - y);
  return [means[Math.floor(samples * 0.025)], means[Math.ceil(samples * 0.975) - 1]];
};

export const median = (values) => {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const tallyPaired = (diffs) => {
  const wins = diffs.filter((d) => d < 0).length;
  const losses = diffs.filter((d) => d > 0).length;
  return { wins, losses, ties: diffs.length - wins - losses };
};

const comparePaired = (xs, ys) => {
  const diffs = xs.map((x, i) => x - ys[i]);
  const tally = tallyPaired(diffs);
  return { ...tally, meanDiff: mean(diffs), ci: bootstrapMeanCi(diffs), p: signTest(tally.wins, tally.losses) };
};

const winsPaired = (xs, ys) => tallyPaired(xs.map((x, i) => x - ys[i]));

const formRegExp = (pattern) => {
  const literal = parseRegExpLiteral(pattern);
  return literal ? new RegExp(literal.source, [...new Set([...literal.flags, "g", "u"])].join("")) : new RegExp(escapeRegExp(pattern), "gu");
};

const lookahead = (pattern) => /\(\?=[^)]*\)\/[a-z]*$/u.exec(pattern)?.[0].replace(/\/[a-z]*$/u, "") ?? "";

export const orthographyCounts = (entry, strs) => {
  const patterns = entry.patterns ?? [entry.pattern];
  const author = new RegExp(`${escapeRegExp(entry.expected)}${lookahead(patterns[0])}`, "gu");
  const count = (regExp) => strs.reduce((sum, text) => sum + [...text.matchAll(regExp)].length, 0);
  return { author: count(author), model: patterns.reduce((sum, pattern) => sum + count(formRegExp(pattern)), 0) };
};

export const computeDeltas = ({ reference, authorProfile, authorTest, outputs, conditions, comparisons, variants }) => {
  const deltas = [];
  for (const size of DELTA_SIZES) {
    const main = size === MAIN_SIZE;
    for (const variant of variants) {
      const features = fitScaler(reference, mostFrequent(reference, size, variant.exclude));
      const own = authorTest.map((doc) => zVector(features, doc));
      const zs = Object.fromEntries(conditions.map((condition) => [condition, outputs[condition].map((doc) => zVector(features, doc))]));
      const pair = Object.fromEntries(conditions.map((condition) => [condition, zs[condition].map((z, i) => delta(z, own[i]))]));
      const entry = { size, variant: variant.label, features: features.length, pair };
      if (!main) {
        deltas.push({ ...entry, comparisons: comparisons.map(([x, y]) => ({ x, y, ...winsPaired(pair[x], pair[y]) })) });
        continue;
      }
      const center = centroid(authorProfile.map((doc) => zVector(features, doc)));
      const toCenter = { 筆者: own.map((z) => delta(z, center)), ...Object.fromEntries(conditions.map((condition) => [condition, zs[condition].map((z) => delta(z, center))])) };
      deltas.push({
        ...entry,
        toCenter,
        comparisons: comparisons.map(([x, y]) => ({ x, y, ...comparePaired(pair[x], pair[y]) })),
        centerComparisons: comparisons.map(([x, y]) => ({ x, y, ...comparePaired(toCenter[x], toCenter[y]) })),
      });
    }
  }
  return deltas;
};
