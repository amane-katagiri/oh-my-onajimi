import { tokenize } from "kuromojin";
import { splitAST, SentenceSplitterSyntax } from "sentence-splitter";
import { StringSource } from "textlint-util-to-string";
import { parseMarkdown } from "./prose.js";

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

export const measureArticle = async (markdown) => {
  const lengths = [];
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
  };
};

export const percentile = (values, p) => {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
};

const UNITS = { sentence_length: 1, max_ten: 1, bold_per_1000: 0.1, list_ratio: 0.01 };

const ceilTo = (value, unit) => {
  const digits = unit === 1 ? 0 : String(unit).split(".")[1].length;
  return Math.max(unit, round(Math.ceil(round(value / unit, 6)) * unit, digits));
};

export const proposeThresholds = (articles, { strictP = 0.9 } = {}) => {
  const result = { articles: articles.length };
  for (const [key, unit] of Object.entries(UNITS)) {
    const values = articles.map((article) => article[key]);
    const proposed = ceilTo(Math.max(0, ...values), unit);
    const stricter = ceilTo(percentile(values, strictP) ?? 0, unit);
    result[key] = {
      p50: percentile(values, 0.5),
      p90: percentile(values, 0.9),
      p95: percentile(values, 0.95),
      max: Math.max(0, ...values),
      proposed,
      stricter,
      stricter_exceeds: values.filter((value) => value > stricter).length,
    };
  }
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
  return result;
};
