"use strict";

const round = (value, digits) => Number(value.toFixed(digits));

const COLON_END = /[:：]\s*$/;
const COLON_START = /^\s*[:：]/;

const textOf = (node) => (node.type === "Str" || node.type === "Code" ? node.value : (node.children || []).map(textOf).join(""));

const isBoldLabelItem = (item) => {
  const paragraph = item.children && item.children[0];
  const [first, second] = paragraph && paragraph.type === "Paragraph" ? paragraph.children : [];
  if (!first || first.type !== "Strong") {
    return false;
  }
  return COLON_END.test(textOf(first)) || (second !== undefined && second.type === "Str" && COLON_START.test(second.value));
};

module.exports = (context, options = {}) => {
  const { Syntax, RuleError, report } = context;
  const { maxBoldPer1000, maxListRatio, minChars = 0, maxBoldLabelItems, minEmphasisShare, minEmphasisMarks = 3, typicalEmphasisShare } = options;
  let proseChars = 0;
  let listChars = 0;
  let boldCount = 0;
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
    [Syntax.Strong]() {
      if (skipDepth === 0) {
        boldCount += 1;
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
            new RuleError(`太字のラベルと「:」で始まる箇条書き（この文書に ${boldLabels.length} 個、目安 ${maxBoldLabelItems} 個以下）。ラベルを外して文で書くか、段落にする。`),
          );
        }
      }
      const marks = boldCount + emphasisCount;
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
