"use strict";

const { DECORATION_SKIPPED, allowedCount, boldPer1000, emphasisShare, isBoldLabelItem, listRatio, proseLength, skipRegions } = require("./count");

const BOLD_LEAD = "この文書の太字は ";

const rule = (context, options = {}) => {
  const { Syntax, RuleError, report } = context;
  const { maxBoldPer1000, maxListRatio, minChars = 0, maxBoldLabelItems, minEmphasisShare, minEmphasisMarks = 3, typicalEmphasisShare } = options;
  let proseChars = 0;
  let listChars = 0;
  const bolds = [];
  let emphasisCount = 0;
  let listDepth = 0;
  const boldLabels = [];
  const handlers = {
    [Syntax.List]() {
      listDepth += 1;
    },
    [Syntax.ListExit]() {
      listDepth -= 1;
    },
    [Syntax.ListItem](node) {
      if (!skipped() && isBoldLabelItem(node)) {
        boldLabels.push(node);
      }
    },
    [Syntax.Strong](node) {
      if (!skipped()) {
        bolds.push(node);
      }
    },
    [Syntax.Emphasis]() {
      if (!skipped()) {
        emphasisCount += 1;
      }
    },
    [Syntax.Str](node) {
      if (skipped()) {
        return;
      }
      const length = proseLength(node.value);
      proseChars += length;
      if (listDepth > 0) {
        listChars += length;
      }
    },
    [Syntax.DocumentExit](node) {
      if (typeof maxBoldLabelItems === "number" && boldLabels.length > maxBoldLabelItems) {
        for (const item of boldLabels) {
          report(
            item,
            new RuleError(`頭を太字にした箇条書き（この文書に ${boldLabels.length} 個、目安 ${maxBoldLabelItems} 個以下）。頭の太字を外して文で書くか、段落にする。`),
          );
        }
      }
      const marks = bolds.length + emphasisCount;
      if (typeof minEmphasisShare === "number" && marks >= minEmphasisMarks) {
        const share = emphasisShare(emphasisCount, marks);
        if (share !== null && share < minEmphasisShare) {
          const typical = typeof typicalEmphasisShare === "number" ? `筆者はふつう ${typicalEmphasisShare}、` : "";
          report(
            node,
            new RuleError(`強調が太字に偏っている: 斜体の割合 ${share}（${typical}目安 ${minEmphasisShare} 以上）。軽い強調は *…* にする。`),
          );
        }
      }
      if (proseChars === 0) {
        return;
      }
      if (typeof maxBoldPer1000 === "number" && proseChars >= minChars && boldPer1000(bolds.length, proseChars) > maxBoldPer1000) {
        const limit = allowedCount(maxBoldPer1000, proseChars);
        const message = `${BOLD_LEAD}${bolds.length} 個（目安 ${limit} 個まで）。${bolds.length - limit} 個減らす。`;
        for (const bold of bolds) {
          report(bold, new RuleError(message));
        }
      }
      if (typeof maxListRatio === "number") {
        const ratio = listRatio(listChars, proseChars);
        if (ratio > maxListRatio) {
          report(node, new RuleError(`箇条書きが多い: 地の文の ${ratio} が箇条書き（目安 ${maxListRatio} 以下）。文章で書ける項目は段落にする。`));
        }
      }
    },
  };
  const skipped = skipRegions(DECORATION_SKIPPED, handlers);
  return handlers;
};

module.exports = rule;
module.exports.BOLD_LEAD = BOLD_LEAD;
