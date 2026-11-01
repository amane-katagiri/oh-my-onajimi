import { tokenize } from "kuromojin";
import { addCount, formatCounts, isAscii, mergeCounts, nextKey, snippet, topCounts } from "./tokens.js";

const HAN = /[\p{Script=Han}々〆ヶ]/u;
const SINGLE_HAN = /^\p{Script=Han}$/u;
const KANA_ONLY = /^[\p{Script=Hiragana}\p{Script=Katakana}ー]+$/u;
const HAS_LETTER = /\p{L}/u;
const KATAKANA_ONLY = /^[\p{Script=Katakana}ー]+$/u;

const kanjiOf = (word) => new Set([...word].filter((char) => HAN.test(char)));
const isSubset = (a, b) => [...a].every((char) => b.has(char));

export const isScriptVariant = (a, b) => {
  if (a === b) {
    return false;
  }
  const ka = kanjiOf(a);
  const kb = kanjiOf(b);
  return isSubset(ka, kb) || isSubset(kb, ka);
};

const toKatakana = (word) => word.replace(/[ぁ-ゖ]/gu, (char) => String.fromCharCode(char.charCodeAt(0) + 0x60));

const readings = new Map();

const readingOf = async (word) => {
  if (!readings.has(word)) {
    const tokens = await tokenize(word);
    const known = tokens.length > 0 && tokens.every((token) => token.reading && token.reading !== "*");
    readings.set(word, known ? tokens.map((token) => token.reading).join("") : KANA_ONLY.test(word) ? toKatakana(word) : null);
  }
  return readings.get(word);
};

const isVariantToken = (token) =>
  token.pos !== "記号" && token.basic_form !== "*" && token.pos_detail_1 !== "数" && HAS_LETTER.test(token.basic_form) && !isAscii(token);

const touches = (a, b) => a.word_position + a.surface_form.length === b.word_position;

const isKatakanaFragment = (tokens, index) => {
  const token = tokens[index];
  if (!KATAKANA_ONLY.test(token.surface_form)) {
    return false;
  }
  const prev = tokens[index - 1];
  const next = tokens[index + 1];
  return (prev && KATAKANA_ONLY.test(prev.surface_form) && touches(prev, token)) || (next && KATAKANA_ONLY.test(next.surface_form) && touches(token, next));
};

const occurrences = (text, word) => {
  let n = 0;
  for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + word.length)) {
    n += 1;
  }
  return n;
};

export const docVariants = (id, strTokens) => {
  const variants = new Map();
  for (const { text, tokens } of strTokens) {
    tokens.forEach((token, index) => {
      if (!isVariantToken(token) || isKatakanaFragment(tokens, index)) {
        return;
      }
      const key = `${token.basic_form}/${token.pos}`;
      let entry = variants.get(key);
      if (!entry) {
        const start = token.word_position - 1;
        const example = snippet(text, start, start + token.surface_form.length);
        entry = { basic: token.basic_form, pos: token.pos, count: 0, raw: 0, docs: 1, surfaces: new Map(), details: new Map(), next: new Map(), example: id ? `${id}: ${example}` : example };
        variants.set(key, entry);
      }
      entry.count += 1;
      addCount(entry.surfaces, token.surface_form);
      addCount(entry.details, token.pos_detail_1);
      addCount(entry.next, nextKey(tokens[index + 1]));
    });
  }
  const text = strTokens.map((str) => str.text).join("\n");
  for (const entry of variants.values()) {
    entry.raw = [...entry.surfaces.keys()].reduce((sum, surface) => sum + occurrences(text, surface), 0);
  }
  return variants;
};

export const aggregateVariants = (docs) => {
  const total = new Map();
  for (const variants of docs) {
    for (const [key, entry] of variants) {
      const into = total.get(key);
      if (!into) {
        total.set(key, { ...entry, surfaces: new Map(entry.surfaces), details: new Map(entry.details), next: new Map(entry.next) });
        continue;
      }
      into.count += entry.count;
      into.raw += entry.raw;
      into.docs += entry.docs;
      mergeCounts(into.surfaces, entry.surfaces);
      mergeCounts(into.details, entry.details);
      mergeCounts(into.next, entry.next);
    }
  }
  return total;
};

const choiceZ = (ax, ay, cx, cy) => {
  const delta = Math.log((ax + 0.5) / (ay + 0.5)) - Math.log((cx + 0.5) / (cy + 0.5));
  return delta / Math.sqrt(1 / (ax + 0.5) + 1 / (ay + 0.5) + 1 / (cx + 0.5) + 1 / (cy + 0.5));
};

const commonPrefix = (words) =>
  words.reduce((prefix, word) => {
    let at = 0;
    while (at < prefix.length && at < word.length && prefix[at] === word[at]) {
      at += 1;
    }
    return prefix.slice(0, at);
  });

export const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");

export const prhEntry = (expected, pattern, patternSurfaces) => {
  const forms = [pattern, ...patternSurfaces];
  const stem = commonPrefix(forms);
  const suffix = pattern.slice(stem.length);
  if (stem === "" || forms.every((form) => form === stem) || !expected.endsWith(suffix)) {
    return { expected, pattern };
  }
  const follow = [...new Set(forms.map((form) => form.slice(stem.length, stem.length + 1)).filter(Boolean))].sort();
  return { expected: expected.slice(0, expected.length - suffix.length), pattern: `/${escapeRegExp(stem)}(?=[${follow.join("")}])/` };
};

const dominant = (details) => topCounts(details, 1)[0]?.[0];

const suspectReasons = (x, y) => {
  const reasons = [];
  for (const word of [x.basic, y.basic]) {
    if (SINGLE_HAN.test(word)) {
      reasons.push(`「${word}」は 1 字の漢字で、別の読み・別の語のことがある`);
    }
  }
  if (y.raw - y.count > Math.max(2, y.count * 0.1)) {
    reasons.push(`「${y.basic}」は文字列として ${y.raw} 回出るが、語としては ${y.count} 回。ほかの語の一部にも当たる`);
  }
  const dx = dominant(x.details);
  const dy = dominant(y.details);
  if (dx !== dy) {
    reasons.push(`品詞の細分類が違う（${x.basic}: ${dx}、${y.basic}: ${dy}）`);
  }
  return reasons;
};

const merged = (entries) => {
  const present = entries.filter(Boolean);
  if (present.length === 0) {
    return null;
  }
  return aggregateVariants(present.map((entry) => new Map([["k", entry]]))).get("k");
};

export const proposeOrthography = async (author, controls, params) => {
  const { orthography_min_count: minCount, orthography_min_share: minShare, orthography_z: zMin, orthography_limit: limit } = params;
  const runners = Object.keys(controls);
  if (runners.length === 0) {
    return { orthography: [], orthography_review: [] };
  }
  const groups = new Map();
  const keys = new Set([...author.keys(), ...runners.flatMap((runner) => [...controls[runner].keys()])]);
  for (const key of keys) {
    const sample = author.get(key) ?? runners.map((runner) => controls[runner].get(key)).find(Boolean);
    const reading = await readingOf(sample.basic);
    if (!reading) {
      continue;
    }
    const group = `${reading}/${sample.pos}`;
    groups.set(group, [...(groups.get(group) ?? []), key]);
  }
  const count = (side, key) => side.get(key)?.count ?? 0;
  const controlCount = (key) => runners.reduce((sum, runner) => sum + count(controls[runner], key), 0);
  const found = [];
  for (const [group, members] of groups) {
    if (members.length < 2) {
      continue;
    }
    const x = members.reduce((best, key) => (count(author, key) > count(author, best) ? key : best));
    const rest = members.filter((key) => key !== x);
    const y = rest.reduce((best, key) => (controlCount(key) > controlCount(best) ? key : best));
    const ax = count(author, x);
    const ay = count(author, y);
    const xBasic = (author.get(x) ?? merged(runners.map((runner) => controls[runner].get(x)))).basic;
    const yBasic = merged(runners.map((runner) => controls[runner].get(y)))?.basic;
    if (!yBasic || !isScriptVariant(xBasic, yBasic) || ax + ay < minCount || ax / (ax + ay) < minShare) {
      continue;
    }
    const z = {};
    const control = {};
    let clear = true;
    for (const runner of runners) {
      const cx = count(controls[runner], x);
      const cy = count(controls[runner], y);
      z[runner] = Number(choiceZ(ax, ay, cx, cy).toFixed(2));
      control[runner] = { [xBasic]: cx, [yBasic]: cy };
      if (cx + cy < minCount || cy <= cx || z[runner] < zMin) {
        clear = false;
      }
    }
    if (!clear) {
      continue;
    }
    const xAll = merged([author.get(x), ...runners.map((runner) => controls[runner].get(x))]);
    const yAll = merged([author.get(y), ...runners.map((runner) => controls[runner].get(y))]);
    const yControl = merged(runners.map((runner) => controls[runner].get(y)));
    const entry = prhEntry(xBasic, yBasic, [...yAll.surfaces.keys()]);
    found.push({
      ...entry,
      reasons: suspectReasons(xAll, yAll),
      evidence: {
        group,
        z,
        author: { [xBasic]: ax, [yBasic]: ay },
        author_docs: author.get(x).docs,
        control,
        author_next: formatCounts(author.get(x).next),
        control_next: formatCounts(yControl.next),
        author_example: author.get(x).example,
        control_example: yControl.example,
      },
      score: Math.min(...Object.values(z)),
    });
  }
  found.sort((a, b) => b.score - a.score || a.expected.localeCompare(b.expected));
  const clean = (entry) => {
    const { score, reasons, ...rest } = entry;
    return reasons.length > 0 ? { ...rest, check: reasons } : rest;
  };
  return {
    orthography: found.filter((entry) => entry.reasons.length === 0).slice(0, limit).map(clean),
    orthography_review: found.filter((entry) => entry.reasons.length > 0).slice(0, limit).map(clean),
  };
};
