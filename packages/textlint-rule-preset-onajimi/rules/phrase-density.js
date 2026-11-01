"use strict";

const { tokenize } = require("kuromojin");

const SKIPPED = ["BlockQuote", "Table", "Html", "Header", "CodeBlock", "Yaml"];

const matchesAt = (tokens, at, conditions) =>
  conditions.every((condition, offset) => {
    const token = tokens[at + offset];
    return token !== undefined && Object.keys(condition).every((key) => token[key] === condition[key]);
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

const round = (value) => Number(value.toFixed(1));

module.exports = (context, options = {}) => {
  const { Syntax, RuleError, report } = context;
  const entries = options.entries || [];
  const counts = entries.map(() => 0);
  const pending = [];
  let chars = 0;
  let skipDepth = 0;
  const handlers = {
    [Syntax.Str](node) {
      if (skipDepth > 0 || entries.length === 0) {
        return;
      }
      chars += [...node.value.replace(/\s/g, "")].length;
      pending.push(
        tokenize(node.value).then((tokens) => {
          entries.forEach((entry, index) => {
            counts[index] += matchCount(tokens, entry.tokens);
          });
        }),
      );
    },
    async [Syntax.DocumentExit](node) {
      await Promise.all(pending);
      if (chars === 0) {
        return;
      }
      entries.forEach((entry, index) => {
        if (chars < (entry.min_chars || 0)) {
          return;
        }
        const per1000 = (counts[index] / chars) * 1000;
        if (per1000 > entry.max_per_1000) {
          const typical = typeof entry.typical_per_1000 === "number" ? `筆者はふつう ${entry.typical_per_1000}、` : "";
          report(node, new RuleError(`${entry.message} 1000字あたり ${round(per1000)}（${typical}目安 ${entry.max_per_1000} 以下）。`));
        }
      });
    },
  };
  for (const type of SKIPPED) {
    handlers[type] = () => {
      skipDepth += 1;
    };
    handlers[`${type}:exit`] = () => {
      skipDepth -= 1;
    };
  }
  return handlers;
};
