"use strict";

const round = (value, digits) => Number(value.toFixed(digits));

module.exports = (context, options = {}) => {
  const { Syntax, RuleError, report } = context;
  const { maxBoldPer1000, maxListRatio } = options;
  let proseChars = 0;
  let listChars = 0;
  let boldCount = 0;
  let listDepth = 0;
  let skipDepth = 0;
  const enterSkip = () => {
    skipDepth += 1;
  };
  const exitSkip = () => {
    skipDepth -= 1;
  };

  return {
    [Syntax.List]() {
      listDepth += 1;
    },
    [Syntax.ListExit]() {
      listDepth -= 1;
    },
    [Syntax.BlockQuote]: enterSkip,
    [Syntax.BlockQuoteExit]: exitSkip,
    [Syntax.Table]: enterSkip,
    [Syntax.TableExit]: exitSkip,
    [Syntax.Strong]() {
      if (skipDepth === 0) {
        boldCount += 1;
      }
    },
    [Syntax.Str](node) {
      if (skipDepth > 0) {
        return;
      }
      const length = [...node.value.replace(/\s/g, "")].length;
      proseChars += length;
      if (listDepth > 0) {
        listChars += length;
      }
    },
    [Syntax.DocumentExit](node) {
      if (proseChars === 0) {
        return;
      }
      if (typeof maxBoldPer1000 === "number") {
        const per1000 = round((boldCount / proseChars) * 1000, 1);
        if (per1000 > maxBoldPer1000) {
          report(node, new RuleError(`太字が多い: 1000字あたり ${per1000} 個（目安 ${maxBoldPer1000} 以下）。強調を減らす。`));
        }
      }
      if (typeof maxListRatio === "number") {
        const ratio = round(listChars / proseChars, 2);
        if (ratio > maxListRatio) {
          report(node, new RuleError(`箇条書きが多い: 地の文の ${ratio} が箇条書き（目安 ${maxListRatio} 以下）。文章で書ける項目は段落にする。`));
        }
      }
    },
  };
};
