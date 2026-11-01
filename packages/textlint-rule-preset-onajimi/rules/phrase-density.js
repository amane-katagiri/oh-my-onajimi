"use strict";

const { matchText } = require("./matcher");

const SKIPPED = ["BlockQuote", "Table", "Html", "Header", "CodeBlock", "Yaml"];

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
        matchText(entries, node.value).then((results) => {
          for (const result of results) {
            counts[entries.indexOf(result.dict)] += 1;
          }
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
