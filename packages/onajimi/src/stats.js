import { tokenize } from "kuromojin";
import { splitAST, SentenceSplitterSyntax } from "sentence-splitter";
import { StringSource } from "textlint-util-to-string";
import { nodeText, parseMarkdown } from "./prose.js";

const TEN_SEPARATORS = ["?", "!", "？", "！", "。"];

const round = (value, digits) => Number(value.toFixed(digits));

const sentencesOf = (paragraph, options) => splitAST(paragraph, options).children.filter((node) => node.type === SentenceSplitterSyntax.Sentence);

const isUrlStringLink = (node) => node.type === "Link" && node.url === new StringSource(node).toString();

const sentenceLengths = (paragraph) => {
  if (paragraph.children.length === 1 && paragraph.children[0].type === "Link") {
    return [];
  }
  return sentencesOf(paragraph).map((sentence) => {
    const filtered = { ...sentence, children: sentence.children.filter((child) => !isUrlStringLink(child)) };
    const source = new StringSource(filtered, {
      replacer: ({ node, emptyValue }) => (node.type === "Comment" ? emptyValue() : undefined),
    });
    return source.toString().length;
  });
};

const isBracket = (token) => (token.pos === "記号" && /^括弧/u.test(token.pos_detail_1)) || token.surface_form === "(" || token.surface_form === ")";

const sibling = (tokens, index, delta) => {
  let at = index + delta;
  while (tokens[at] && isBracket(tokens[at])) {
    at += delta;
  }
  return tokens[at];
};

const maxTenInSentence = async (sentence) => {
  const source = new StringSource(sentence, {
    replacer: ({ node, maskValue }) => (node.type === "Code" ? maskValue("_") : undefined),
  });
  const tokens = await tokenize(source.toString());
  let current = 0;
  let max = 0;
  tokens.forEach((token, index) => {
    if (token.surface_form === "、") {
      const before = sibling(tokens, index, -1);
      const after = sibling(tokens, index, 1);
      if (!(before?.pos === "名詞" && after?.pos === "名詞")) {
        current += 1;
        max = Math.max(max, current);
      }
    }
    if (TEN_SEPARATORS.includes(token.surface_form)) {
      current = 0;
    }
  });
  return max;
};

export const isBoldLabelItem = (item) => {
  const paragraph = item.children?.[0];
  const [first, ...rest] = paragraph?.type === "Paragraph" ? paragraph.children : [];
  return first?.type === "Strong" && rest.map(nodeText).join("").trim() !== "";
};

export const measureArticle = async (markdown) => {
  const lengths = [];
  const boldLabels = [];
  let emphasis = 0;
  const tens = [];
  const paragraphs = [];
  let proseChars = 0;
  let listChars = 0;
  let bold = 0;
  const walk = (node, inQuote, skip, inList) => {
    if (node.type === "Paragraph" && !inQuote) {
      paragraphs.push(node);
    }
    const skipHere = skip || node.type === "BlockQuote" || node.type === "Table";
    const listHere = inList || node.type === "List";
    if (node.type === "Strong" && !skipHere) {
      bold += 1;
    }
    if (node.type === "Emphasis" && !skipHere) {
      emphasis += 1;
    }
    if (node.type === "ListItem" && !skipHere && isBoldLabelItem(node)) {
      boldLabels.push({ line: node.loc.start.line, column: node.loc.start.column + 1 });
    }
    if (node.type === "Str" && !skipHere) {
      const length = [...node.value.replace(/\s/gu, "")].length;
      proseChars += length;
      if (listHere) {
        listChars += length;
      }
    }
    for (const child of node.children ?? []) {
      walk(child, inQuote || node.type === "BlockQuote", skipHere, listHere);
    }
  };
  walk(parseMarkdown(markdown), false, false, false);
  for (const paragraph of paragraphs) {
    lengths.push(...sentenceLengths(paragraph));
    for (const sentence of sentencesOf(paragraph, { SeparatorParser: { separatorCharacters: TEN_SEPARATORS } })) {
      tens.push(await maxTenInSentence(sentence));
    }
  }
  return {
    lengths,
    tens,
    proseChars,
    sentence_length: Math.max(0, ...lengths),
    max_ten: Math.max(0, ...tens),
    bold_per_1000: proseChars === 0 ? 0 : round((bold / proseChars) * 1000, 1),
    list_ratio: proseChars === 0 ? 0 : round(listChars / proseChars, 2),
    bold_label_items: boldLabels.length,
    boldLabels,
    marks: bold + emphasis,
    emphasis_share: bold + emphasis === 0 ? null : round(emphasis / (bold + emphasis), 2),
  };
};

export const percentile = (values, p) => {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
};

const ceilTo = (value, unit, floor = unit) => {
  const digits = unit === 1 ? 0 : String(unit).split(".")[1].length;
  return Math.max(floor, round(Math.ceil(round(value / unit, 6)) * unit, digits));
};

const floorTo = (value, unit) => {
  const digits = unit === 1 ? 0 : String(unit).split(".")[1].length;
  return Math.max(0, round(Math.floor(round(value / unit, 6)) * unit, digits));
};

export { ceilTo };

const SPECS = {
  sentence_length: { unit: 1 },
  max_ten: { unit: 1 },
  bold_per_1000: { unit: 0.1, needsChars: true },
  list_ratio: { unit: 0.01 },
  bold_label_items: { unit: 1, floor: 0 },
  emphasis_share_min: { unit: 0.01, lower: true, value: "emphasis_share", needsMarks: true },
};

const valuesOf = (articles, key, { needsChars, needsMarks, value = key }, { minChars, minMarks }) =>
  articles
    .filter((article) => (!needsChars || article.proseChars >= minChars) && (!needsMarks || article.marks >= minMarks))
    .map((article) => article[value])
    .filter((v) => typeof v === "number");

const breaks = (spec, value, limit) => (spec.lower ? value < limit : value > limit);

export const proposeThresholds = (articles, { strictP = 0.9, minChars = 0, minMarks = 3, controls = {} } = {}) => {
  const result = { articles: articles.length };
  const gates = { minChars, minMarks };
  for (const [key, spec] of Object.entries(SPECS)) {
    const values = valuesOf(articles, key, spec, gates);
    if (values.length === 0) {
      result[key] = { articles: 0, proposed: null };
      continue;
    }
    const proposed = spec.lower ? floorTo(Math.min(...values), spec.unit) : ceilTo(Math.max(...values), spec.unit, spec.floor);
    const stricter = spec.lower ? floorTo(percentile(values, 1 - strictP), spec.unit) : ceilTo(percentile(values, strictP), spec.unit, spec.floor);
    result[key] = {
      articles: values.length,
      p50: percentile(values, 0.5),
      p90: percentile(values, spec.lower ? 0.1 : 0.9),
      p95: percentile(values, spec.lower ? 0.05 : 0.95),
      [spec.lower ? "min" : "max"]: spec.lower ? Math.min(...values) : Math.max(...values),
      proposed,
      stricter,
      stricter_exceeds: values.filter((value) => breaks(spec, value, stricter)).length,
    };
  }
  result.decoration_min_chars = { proposed: minChars };
  result.density_min_chars = { proposed: minChars };
  result.emphasis_min_marks = { proposed: minMarks };
  const lengths = articles.flatMap((article) => article.lengths);
  const tens = articles.flatMap((article) => article.tens);
  result.sentences = {
    count: lengths.length,
    length_p50: percentile(lengths, 0.5),
    length_p90: percentile(lengths, 0.9),
    length_p99: percentile(lengths, 0.99),
    ten_p50: percentile(tens, 0.5),
    ten_p90: percentile(tens, 0.9),
    ten_p99: percentile(tens, 0.99),
  };
  if (Object.keys(controls).length > 0) {
    result.controls = Object.fromEntries(
      Object.entries(controls).map(([runner, docs]) => [
        runner,
        Object.fromEntries(
          Object.entries(SPECS).map(([key, spec]) => {
            const values = valuesOf(docs, key, spec, gates);
            const limit = result[key].proposed;
            const strict = result[key].stricter;
            return [
              key,
              {
                articles: values.length,
                p50: percentile(values, 0.5),
                [spec.lower ? "min" : "max"]: values.length === 0 ? null : spec.lower ? Math.min(...values) : Math.max(...values),
                fires: limit === null ? null : values.filter((value) => breaks(spec, value, limit)).length,
                fires_stricter: limit === null ? null : values.filter((value) => breaks(spec, value, strict)).length,
              },
            ];
          }),
        ),
      ]),
    );
  }
  return result;
};
