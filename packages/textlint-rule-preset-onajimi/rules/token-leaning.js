"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { matchText } = require("./matcher");

const isEntry = (value) =>
  typeof value === "object" &&
  value !== null &&
  typeof value.message === "string" &&
  Array.isArray(value.tokens) &&
  value.tokens.length > 0 &&
  value.tokens.every((token) => typeof token === "object" && token !== null && !Array.isArray(token));

const loadDictionary = (file) => {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const entries = typeof data === "object" && data !== null ? data.entries : undefined;
  if (!Array.isArray(entries)) {
    throw new Error(`${file} の辞書は、entries に配列を持つオブジェクトで書く。`);
  }
  entries.forEach((entry, index) => {
    if (!isEntry(entry)) {
      throw new Error(`${file} の ${index} 番目の要素は、message と 1 つ以上の tokens を持つオブジェクトで書く。`);
    }
  });
  return entries;
};

const REGEXP_LITERAL = /^\/(.+)\/([gimsuy]*)$/;

const createTester = (pattern) => {
  const literal = REGEXP_LITERAL.exec(pattern);
  if (literal) {
    // g を残すと lastIndex が持ち越され、同じ文字列でも結果が交互に変わる。
    const regExp = new RegExp(literal[1], literal[2].replace("g", ""));
    return (text) => regExp.test(text);
  }
  return (text) => text.includes(pattern);
};

module.exports = (context, options = {}) => {
  const { Syntax, RuleError, report, getSource } = context;
  if (typeof options.dictionaryPath !== "string") {
    throw new Error("dictionaryPath に辞書の JSON を指定する。");
  }
  const testers = (options.allows || []).map(createTester);
  const entries = loadDictionary(path.resolve(context.getConfigBaseDir() || process.cwd(), options.dictionaryPath));
  return {
    async [Syntax.Str](node) {
      const text = getSource(node);
      for (const result of await matchText(entries, text)) {
        if (testers.some((tester) => tester(text.slice(result.range[0], result.range[1])))) {
          continue;
        }
        report(node, new RuleError(result.message, { index: result.index }));
      }
    },
  };
};
