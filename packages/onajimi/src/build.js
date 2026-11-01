import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { authorDir, generatedDir } from "./paths.js";

const TOP_LEVEL_KEYS = new Set(["note", "model_leaning", "author_leaning", "orthography", "density", "thresholds", "allow"]);
const POSITIVE = (value) => value > 0;
const NON_NEGATIVE = (value) => value >= 0;
const SHARE = (value) => value >= 0 && value <= 1;
const THRESHOLDS = {
  sentence_length: [POSITIVE, "正の数"],
  max_ten: [POSITIVE, "正の数"],
  bold_per_1000: [POSITIVE, "正の数"],
  list_ratio: [POSITIVE, "正の数"],
  decoration_min_chars: [NON_NEGATIVE, "0 以上の数"],
  bold_label_items: [(value) => Number.isInteger(value) && value >= 0, "0 以上の整数"],
  emphasis_share_min: [SHARE, "0 以上 1 以下の数"],
  emphasis_share_typical: [SHARE, "0 以上 1 以下の数"],
  emphasis_min_marks: [NON_NEGATIVE, "0 以上の数"],
  density_min_chars: [NON_NEGATIVE, "0 以上の数"],
};
export const THRESHOLD_KEYS = new Set(Object.keys(THRESHOLDS));
const PRH_KEYS = new Set(["expected", "pattern", "patterns", "regexpMustEmpty", "specs", "options", "prh", "note", "evidence"]);

const fail = (where, problem) => {
  throw new Error(`profile.yml の ${where}: ${problem}`);
};

const checkTokens = (where, tokens) => {
  if (!Array.isArray(tokens) || tokens.length === 0) {
    fail(where, "tokens は 1 つ以上のトークン条件の配列で書く");
  }
  tokens.forEach((token, index) => {
    if (typeof token !== "object" || token === null || Array.isArray(token) || Object.keys(token).length === 0) {
      fail(`${where}.tokens[${index}]`, "トークン条件は surface_form や basic_form を持つ対応表で書く");
    }
  });
  return tokens;
};

const checkKeys = (where, object, allowed) => {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      fail(where, `知らないキー ${key}`);
    }
  }
};

const asList = (profile, key) => {
  const value = profile[key] ?? [];
  if (!Array.isArray(value)) {
    fail(key, "配列で書く");
  }
  return value;
};

export const parseProfile = (text) => {
  const profile = YAML.parse(text) ?? {};
  if (typeof profile !== "object" || Array.isArray(profile)) {
    fail("最上位", "対応表で書く");
  }
  checkKeys("最上位", profile, TOP_LEVEL_KEYS);

  const modelLeaning = asList(profile, "model_leaning").map((entry, index) => {
    const where = `model_leaning[${index}]`;
    checkKeys(where, entry, new Set(["tokens", "message", "note", "evidence"]));
    if (typeof entry.message !== "string" || entry.message === "") {
      fail(where, "message が要る");
    }
    return { message: entry.message, tokens: checkTokens(where, entry.tokens) };
  });

  const authorLeaning = asList(profile, "author_leaning").map((entry, index) => {
    const where = `author_leaning[${index}]`;
    checkKeys(where, entry, new Set(["tokens", "author", "message", "note", "evidence"]));
    if (typeof entry.author !== "string" || entry.author === "") {
      fail(where, "author（筆者側の言い方）が要る");
    }
    return {
      message: entry.message ?? `筆者は「${entry.author}」と書く。`,
      tokens: checkTokens(where, entry.tokens),
    };
  });

  const orthography = asList(profile, "orthography").map((entry, index) => {
    const where = `orthography[${index}]`;
    checkKeys(where, entry, PRH_KEYS);
    if (typeof entry.expected !== "string") {
      fail(where, "expected が要る");
    }
    if (entry.pattern === undefined && entry.patterns === undefined) {
      fail(where, "pattern か patterns が要る");
    }
    const { note, evidence, ...rule } = entry;
    return rule;
  });

  const thresholds = profile.thresholds ?? {};
  checkKeys("thresholds", thresholds, THRESHOLD_KEYS);
  for (const [key, value] of Object.entries(thresholds)) {
    const [valid, expected] = THRESHOLDS[key];
    if (typeof value !== "number" || !valid(value)) {
      fail(`thresholds.${key}`, `${expected}で書く`);
    }
  }

  const density = asList(profile, "density").map((entry, index) => {
    const where = `density[${index}]`;
    checkKeys(where, entry, new Set(["tokens", "max_per_1000", "min_chars", "typical_per_1000", "message", "note", "evidence"]));
    if (typeof entry.message !== "string" || entry.message === "") {
      fail(where, "message が要る");
    }
    for (const key of ["max_per_1000", "min_chars", "typical_per_1000"]) {
      if (entry[key] !== undefined && (typeof entry[key] !== "number" || entry[key] < 0)) {
        fail(`${where}.${key}`, "0 以上の数で書く");
      }
    }
    if (entry.max_per_1000 === undefined) {
      fail(where, "max_per_1000 が要る");
    }
    const minChars = entry.min_chars ?? thresholds.density_min_chars;
    return {
      tokens: checkTokens(where, entry.tokens),
      max_per_1000: entry.max_per_1000,
      ...(minChars === undefined ? {} : { min_chars: minChars }),
      ...(entry.typical_per_1000 === undefined ? {} : { typical_per_1000: entry.typical_per_1000 }),
      message: entry.message,
    };
  });

  const allow = asList(profile, "allow");
  allow.forEach((value, index) => {
    if (typeof value !== "string" || value === "") {
      fail(`allow[${index}]`, "文字列で書く");
    }
  });

  return { modelLeaning, authorLeaning, orthography, density, thresholds, allow };
};

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

const DECORATION_OPTIONS = {
  bold_per_1000: "maxBoldPer1000",
  list_ratio: "maxListRatio",
  decoration_min_chars: "minChars",
  bold_label_items: "maxBoldLabelItems",
  emphasis_share_min: "minEmphasisShare",
  emphasis_min_marks: "minEmphasisMarks",
  emphasis_share_typical: "typicalEmphasisShare",
};

const textlintrc = ({ thresholds, allow, density }) => {
  const leaning = (file) => ({
    dictionaryPath: `./${file}`,
    ...(allow.length > 0 ? { allows: allow } : {}),
  });
  const decoration = Object.fromEntries(
    Object.entries(DECORATION_OPTIONS)
      .filter(([key]) => thresholds[key] !== undefined)
      .map(([key, option]) => [option, thresholds[key]]),
  );
  const rules = {
    "preset-onajimi": {
      "model-leaning": leaning("model-leaning.json"),
      "author-leaning": { severity: "warning", ...leaning("author-leaning.json") },
      "decoration-density": { severity: "warning", ...decoration },
      ...(density.length > 0 ? { "phrase-density": { severity: "warning", entries: density } } : {}),
    },
    prh: { severity: "warning", rulePaths: ["./orthography.yml"] },
  };
  if (thresholds.sentence_length !== undefined) {
    rules["sentence-length"] = { severity: "warning", max: thresholds.sentence_length };
  }
  if (thresholds.max_ten !== undefined) {
    rules["max-ten"] = { severity: "warning", max: thresholds.max_ten };
  }
  return { rules };
};

export const renderGenerated = (profile) => ({
  "model-leaning.json": json({ entries: profile.modelLeaning }),
  "author-leaning.json": json({ entries: profile.authorLeaning }),
  "orthography.yml": YAML.stringify({ version: 1, rules: profile.orthography }),
  ".textlintrc.json": json(textlintrc(profile)),
});

export const build = ({ root, author, check = false }) => {
  const profilePath = path.join(authorDir(root, author), "profile.yml");
  const files = renderGenerated(parseProfile(fs.readFileSync(profilePath, "utf8")));
  const outDir = generatedDir(root, author);
  if (check) {
    const stale = Object.entries(files)
      .filter(([name, content]) => {
        const target = path.join(outDir, name);
        return !fs.existsSync(target) || fs.readFileSync(target, "utf8") !== content;
      })
      .map(([name]) => name);
    return { stale };
  }
  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(outDir, name), content);
  }
  return { written: Object.keys(files) };
};
