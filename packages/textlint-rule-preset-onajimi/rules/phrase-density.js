"use strict";

const { matchText } = require("./matcher");

const SKIPPED = ["BlockQuote", "Table", "Html", "Header", "CodeBlock", "Yaml"];

// 0.3 × 10000 / 1000 が 2.999… になるのを丸めてから切り捨てる。
const allowed = (per1000, chars) => Math.floor(Number(((per1000 * chars) / 1000).toFixed(6)));

module.exports = (context, options = {}) => {
  const { Syntax, RuleError, report, getSource } = context;
  const entries = options.entries || [];
  const hits = entries.map(() => []);
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
        matchText(entries, getSource(node)).then((results) => {
          for (const result of results) {
            hits[entries.indexOf(result.dict)].push({ node, index: result.index });
          }
        }),
      );
    },
    async [Syntax.DocumentExit]() {
      await Promise.all(pending);
      if (chars === 0) {
        return;
      }
      entries.forEach((entry, index) => {
        if (chars < (entry.min_chars || 0)) {
          return;
        }
        const count = hits[index].length;
        const limit = allowed(entry.max_per_1000, chars);
        if (count <= limit) {
          return;
        }
        const message = `${entry.message}この文書では ${count} 回（目安 ${limit} 回まで）。${count - limit} 回減らす。`;
        for (const hit of hits[index]) {
          report(hit.node, new RuleError(message, { index: hit.index }));
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
