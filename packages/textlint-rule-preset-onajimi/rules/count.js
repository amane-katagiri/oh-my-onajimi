"use strict";

const round = (value, digits) => Number(value.toFixed(digits));

const DECORATION_SKIPPED = ["BlockQuote", "Table"];
const PHRASE_SKIPPED = ["BlockQuote", "Table", "Html", "Header", "CodeBlock", "Yaml"];

const textOf = (node) => (node.type === "Str" || node.type === "Code" ? node.value : (node.children || []).map(textOf).join(""));

const proseLength = (text) => [...text.replace(/\s/gu, "")].length;

const isBoldLabelItem = (item) => {
  const paragraph = item.children && item.children[0];
  const [first, ...rest] = paragraph && paragraph.type === "Paragraph" ? paragraph.children : [];
  return first !== undefined && first.type === "Strong" && rest.map(textOf).join("").trim() !== "";
};

const skipRegions = (types, handlers) => {
  let depth = 0;
  for (const type of types) {
    handlers[type] = () => {
      depth += 1;
    };
    handlers[`${type}:exit`] = () => {
      depth -= 1;
    };
  }
  return () => depth > 0;
};

// 0.3 × 10000 / 1000 が 2.999… になるのを丸めてから切り捨てる。
const allowedCount = (per1000, chars) => Math.floor(Number(((per1000 * chars) / 1000).toFixed(6)));

const boldPer1000 = (bolds, chars) => (chars === 0 ? 0 : round((bolds / chars) * 1000, 1));
const listRatio = (listChars, chars) => (chars === 0 ? 0 : round(listChars / chars, 2));
const emphasisShare = (emphasis, marks) => (marks === 0 ? null : round(emphasis / marks, 2));

module.exports = {
  DECORATION_SKIPPED,
  PHRASE_SKIPPED,
  textOf,
  proseLength,
  isBoldLabelItem,
  skipRegions,
  allowedCount,
  boldPer1000,
  listRatio,
  emphasisShare,
};
