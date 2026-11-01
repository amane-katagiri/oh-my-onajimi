import { parseMarkdown, proseText } from "./prose.js";

const NEGATION =
  /しないで|ません|なかっ|なけれ|ない|なく|禁止|(?<!必)(?<!は)ず(?=[に、。]|$)|ぬ(?=[。、]|$)|未(?![来明])(?=[一-龥])|不(?=要|可|明|正|足|在|備|具合|適|十分|一致|安定|許可|採用|使用|参加)|非(?=公開|対応|表示|推奨|同期|互換|同意)|無(?=効|料|視|関係|制限|断)/gmu;
const NEGATION_MASKED =
  /なければ(?:ならない|なりません|ならず|いけない|いけません)|なくては(?:ならない|なりません|いけない|いけません)|ないと(?:いけない|いけません)|ざるを得(?:ない|ません)|ねば(?:ならない|なりません)|かもしれ(?:ない|ません)|に違い(?:ない|ありません)|とは限(?:らない|りません)|わけでは(?:ない|ありません)|に(?:すぎ|過ぎ)(?:ない|ません)|しか(?:ない|ありません)|ほか(?:ない|ありません)|問題(?:は|が|も)?(?:ない|なく|ありません)|有無|(?:では|じゃ|でも)な(?=[いくかけ])|(?:では|じゃ)ありません/gu;
const NEGATION_WORDS =
  /(?:少|危|切|仕方|間違い|もったい|つまら|くだら|たまら|情け|頼り|あっけ|はか|ぎこち|さりげ|味気|素っ気)な(?=[いくかけ])/gu;
const ADVERB_MAZU = /(?<![一-龥々])まず/gu;

const hide = (match) => "＃".repeat(match.length);

export const countNegations = (text) => {
  const masked = text
    .replace(NEGATION_MASKED, hide)
    .replace(NEGATION_WORDS, (match) => `${match.slice(0, -1)}＃`)
    .replace(ADVERB_MAZU, hide);
  return [...masked.matchAll(NEGATION)].length;
};

const ARABIC = /(?<![A-Za-z0-9_])(?<![0-9][.,])[0-9]+(?:[.,][0-9]+)*/gu;
const THOUSANDS = /^[0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?$/u;
const KANJI_DIGITS = { 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const KANJI_UNITS = { 十: 10, 百: 100, 千: 1000 };
const KANJI_NUMERALS = "〇一二三四五六七八九十百千";
const KANJI_COUNTERS = [
  "週間", "時間", "か月", "ヶ月", "カ月", "ヵ月", "か所", "カ所", "ヶ所", "箇所", "種類",
  "年", "日", "件", "個", "人", "名", "回", "円", "倍", "割", "本", "枚", "台", "社", "歳",
  "章", "節", "項", "月", "つ", "条", "号", "階", "分", "時",
];
const KANJI_NUMBER = new RegExp(
  `(?<![${KANJI_NUMERALS}])([${KANJI_NUMERALS}]+)(?=${KANJI_COUNTERS.join("|")})`,
  "gu",
);
const KANJI_EXCLUDED =
  /一時(?!間)|一度|一部|一方|一般|一緒|一切|一応|一番|一定|一致|一意|一括|一本化|一日中|一年中|一日も|一人ひとり|一人一人|一回り|一枚岩|十人十色|万一|四六時中/gu;
const JUUBUN = /(?<![〇一二三四五六七八九十百千])十分(?!間(?!に合))/gu;
const KANJI = /[一-龥々〆ヵヶ]/u;
const KANJI_BEFORE = new Set("約後計全第毎各残大小長短年月週日");
const KANJI_BEFORE_WORDS = new Set(["午前", "午後", "令和", "平成", "昭和", "大正", "明治"]);
const KANA_NUMBERS = { ひとつ: "1", ふたつ: "2", みっつ: "3" };
const KANA_NUMBER = /ひとつ|ふたつ|みっつ/gu;

const plainNumber = (digits) => digits.replace(/^0+(?=\d)/u, "");

const kanjiValue = (text) => {
  if (![...text].some((ch) => ch in KANJI_UNITS)) {
    return Number([...text].map((ch) => KANJI_DIGITS[ch]).join(""));
  }
  let total = 0;
  let current = null;
  let last = 10000;
  for (const ch of text) {
    if (ch in KANJI_UNITS) {
      const unit = KANJI_UNITS[ch];
      if (unit >= last) {
        return null;
      }
      total += (current ?? 1) * unit;
      current = null;
      last = unit;
    } else {
      if (current !== null || ch === "〇") {
        return null;
      }
      current = KANJI_DIGITS[ch];
    }
  }
  return total + (current ?? 0);
};

const kanjiBeforeOk = (text, start) => {
  const before = text[start - 1];
  return !before || !KANJI.test(before) || KANJI_BEFORE.has(before) || KANJI_BEFORE_WORDS.has(text.slice(start - 2, start));
};

export const extractNumbers = (rawText) => {
  const text = rawText.normalize("NFKC");
  const found = [];
  for (const match of text.matchAll(ARABIC)) {
    const digits = match[0];
    const end = match.index + digits.length;
    if (text[end] === "千" && !/[.,]/u.test(digits)) {
      found.push(String(Number(digits) * 1000));
    } else if (digits.includes(",") && !THOUSANDS.test(digits)) {
      found.push(...digits.split(",").map(plainNumber));
    } else {
      found.push(plainNumber(digits.replaceAll(",", "")));
    }
  }
  const kanjiText = text
    .replace(/[0-9]+千/gu, hide)
    .replace(KANJI_EXCLUDED, hide)
    .replace(JUUBUN, hide);
  for (const match of kanjiText.matchAll(KANJI_NUMBER)) {
    if (!kanjiBeforeOk(kanjiText, match.index)) {
      continue;
    }
    const value = kanjiValue(match[1]);
    if (value !== null) {
      found.push(String(value));
    }
  }
  for (const match of kanjiText.matchAll(KANA_NUMBER)) {
    found.push(KANA_NUMBERS[match[0]]);
  }
  return found;
};

const SENTENCE = /[^。？?！!]+(?:[。？?！!]+[」』）)]*)?/gu;
const SENTENCE_BLOCKS = new Set(["Paragraph", "Header", "TableCell"]);
const QUESTION_END = /(?:[？?]|か[。？?]?)[」』）)]*$/u;
const NOT_QUESTION_KA =
  /(?:明ら|確|わず|僅|静|豊|ほ|速や|穏や|鮮や|細や|爽や|健や|和や|緩や|賑や|にぎや|華や|密|愚|疎|おろ|遥|はる|ほの|柔ら|滑ら|なめら|清ら|朗ら|安ら|大ま)か。?[」』）)]*$/u;
const NAIKA_END = /ではない(?:か|だろうか|でしょうか)と(?:思|考|感じ)[^。？?！!]*[。！!]?[」』）)]*$/u;
const CONJECTURE_END =
  /(?:だろう|でしょう|かもしれ(?:ない|ません)|(?<!素晴)(?<!すば)(?<!めずら)(?<!珍)(?<!わざと)(?<!可愛)(?<!かわい)(?<!憎)(?<!馬鹿)(?<!ばか)(?<!いや)(?<!汚)らしい(?:です)?|よう(?:だ|です))[ねよな]*[。！!]?[」』）)]*$/u;

const inlineText = (node) => {
  if (node.type === "Str") {
    return node.value;
  }
  if (node.type === "Code") {
    return "＿";
  }
  return (node.children ?? []).map(inlineText).join("");
};

export const sentencesOf = (markdown) => {
  const sentences = [];
  const walk = (node) => {
    if (SENTENCE_BLOCKS.has(node.type)) {
      const text = inlineText(node).replace(/\s*\n\s*/gu, "");
      sentences.push(...(text.match(SENTENCE) ?? []).map((sentence) => sentence.trim()).filter(Boolean));
      return;
    }
    for (const child of node.children ?? []) {
      walk(child);
    }
  };
  walk(parseMarkdown(markdown));
  return sentences;
};

export const isQuestion = (sentence) => (QUESTION_END.test(sentence) && !NOT_QUESTION_KA.test(sentence)) || NAIKA_END.test(sentence);

export const isConjecture = (sentence) => CONJECTURE_END.test(sentence);

const tally = (values) => {
  const counts = new Map();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
};

const compareNumber = (a, b) => Number(a) - Number(b) || a.localeCompare(b);

export const guard = (beforeMarkdown, afterMarkdown) => {
  const before = proseText(beforeMarkdown);
  const after = proseText(afterMarkdown);
  const problems = [];

  const beforeNumbers = tally(extractNumbers(before));
  const afterNumbers = tally(extractNumbers(after));
  const keys = [...new Set([...beforeNumbers.keys(), ...afterNumbers.keys()])].sort(compareNumber);
  for (const key of keys) {
    const was = beforeNumbers.get(key) ?? 0;
    const now = afterNumbers.get(key) ?? 0;
    if (was > now) {
      problems.push(`数値 ${key} が減った（${was} → ${now} 個）。元に戻す。`);
    } else if (was < now) {
      problems.push(`数値 ${key} が増えた（${was} → ${now} 個）。元にない数値を足していないか見る。`);
    }
  }

  const negationsBefore = countNegations(before);
  const negationsAfter = countNegations(after);
  if (negationsBefore !== negationsAfter) {
    problems.push(`否定の数が変わった（${negationsBefore} → ${negationsAfter}）。肯定と否定が入れ替わった文を元に戻す。`);
  }

  const sentencesBefore = sentencesOf(beforeMarkdown);
  const sentencesAfter = sentencesOf(afterMarkdown);
  const kinds = [
    [isQuestion, "問い", "断定や地の文に変えた問いを元に戻す。", "元にない問いを足していないか見る。"],
    [isConjecture, "推量", "断定に変えた推量を元に戻す。", "断定を推量に変えていないか見る。"],
  ];
  for (const [test, label, fewer, more] of kinds) {
    const was = sentencesBefore.filter(test).length;
    const now = sentencesAfter.filter(test).length;
    if (was > now) {
      problems.push(`${label}の文が減った（${was} → ${now}）。${fewer}`);
    } else if (was < now) {
      problems.push(`${label}の文が増えた（${was} → ${now}）。${more}`);
    }
  }
  return problems;
};
