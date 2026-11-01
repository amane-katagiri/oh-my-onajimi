"use strict";

const { matchText } = require("./matcher");
const { PHRASE_SKIPPED, allowedCount, proseLength, skipRegions } = require("./count");

module.exports = (context, options = {}) => {
  const { Syntax, RuleError, report, getSource } = context;
  const entries = options.entries || [];
  const hits = entries.map(() => []);
  const pending = [];
  let chars = 0;
  const handlers = {
    [Syntax.Str](node) {
      if (skipped() || entries.length === 0) {
        return;
      }
      chars += proseLength(node.value);
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
        const limit = allowedCount(entry.max_per_1000, chars);
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
  const skipped = skipRegions(PHRASE_SKIPPED, handlers);
  return handlers;
};
