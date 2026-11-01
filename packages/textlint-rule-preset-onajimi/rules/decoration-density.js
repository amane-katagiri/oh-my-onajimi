"use strict";

const round = (value, digits) => Number(value.toFixed(digits));

const BOLD_LEAD = "この文書の太字は ";

const textOf = (node) => (node.type === "Str" || node.type === "Code" ? node.value : (node.children || []).map(textOf).join(""));

const isBoldLabelItem = (item) => {
  const paragraph = item.children && item.children[0];
  const [first, ...rest] = paragraph && paragraph.type === "Paragraph" ? paragraph.children : [];
  return first !== undefined && first.type === "Strong" && rest.map(textOf).join("").trim() !== "";
};

const rule = (context, options = {}) => {
  const { Syntax, RuleError, report } = context;
  const { maxBoldPer1000, maxListRatio, minChars = 0, maxBoldLabelItems, minEmphasisShare, minEmphasisMarks = 3, typicalEmphasisShare } = options;
  let proseChars = 0;
  let listChars = 0;
  const bolds = [];
  let emphasisCount = 0;
  let listDepth = 0;
  let skipDepth = 0;
  const boldLabels = [];
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
    [Syntax.ListItem](node) {
      if (skipDepth === 0 && isBoldLabelItem(node)) {
        boldLabels.push(node);
      }
    },
    [Syntax.BlockQuote]: enterSkip,
    [Syntax.BlockQuoteExit]: exitSkip,
    [Syntax.Table]: enterSkip,
    [Syntax.TableExit]: exitSkip,
    [Syntax.Strong](node) {
      if (skipDepth === 0) {
        bolds.push(node);
      }
    },
    [Syntax.Emphasis]() {
      if (skipDepth === 0) {
        emphasisCount += 1;
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
        const share = round(emphasisCount / marks, 2);
        if (share < minEmphasisShare) {
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
      if (typeof maxBoldPer1000 === "number" && proseChars >= minChars) {
        const per1000 = round((bolds.length / proseChars) * 1000, 1);
        if (per1000 > maxBoldPer1000) {
          // 0.3 × 10000 / 1000 が 2.999… になるのを丸めてから切り捨てる。
          const limit = Math.floor(Number(((maxBoldPer1000 * proseChars) / 1000).toFixed(6)));
          const message = `${BOLD_LEAD}${bolds.length} 個（目安 ${limit} 個まで）。${bolds.length - limit} 個減らす。`;
          for (const bold of bolds) {
            report(bold, new RuleError(message));
          }
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

module.exports = rule;
module.exports.BOLD_LEAD = BOLD_LEAD;
