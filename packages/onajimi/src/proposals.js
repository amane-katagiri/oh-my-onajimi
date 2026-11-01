import { per1000, topList } from "./features.js";
import { ceilTo, percentile } from "./stats.js";
import { docRates, formatCounts, mergeCounts } from "./tokens.js";

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

const QUOTE_NOTE = "かぎかっこに掛かる語。会話文や引用した問いを地の文に変えさせるおそれがある";

const touchesQuote = (tokens) => tokens.some((token) => /[「」]/u.test(token.basic_form ?? token.surface_form ?? ""));

const modelSurface = (row, runners) => topList(runners.reduce((into, runner) => mergeCounts(into, row.control[runner].surfaces), new Map()))[0];

export const proposeModelLeaning = (rows, runners, { proposal_z: zMax, proposal_max_author_docs: maxAuthorDocs, proposal_limit: limit }) => {
  const picked = rows.filter((row) => leansToEveryModel(row, runners, zMax) && row.author.docs <= maxAuthorDocs);
  const entry = (row) => {
    const note = [registerNote(row), touchesQuote(row.tokens) ? QUOTE_NOTE : undefined].filter(Boolean).join("。");
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
        ...(touchesQuote(rate.tokens) ? { note: QUOTE_NOTE } : {}),
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

