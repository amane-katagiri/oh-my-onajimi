import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { authorDir, generatedDir } from "./paths.js";

const TOP_LEVEL_KEYS = new Set(["note", "model_leaning", "author_leaning", "orthography", "thresholds", "allow"]);
const THRESHOLD_KEYS = new Set(["sentence_length", "max_ten", "bold_per_1000", "list_ratio"]);
const PRH_KEYS = new Set(["expected", "pattern", "patterns", "regexpMustEmpty", "specs", "options", "prh"]);

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
    checkKeys(where, entry, new Set(["tokens", "message", "evidence"]));
    if (typeof entry.message !== "string" || entry.message === "") {
      fail(where, "message が要る");
    }
    return { message: entry.message, tokens: checkTokens(where, entry.tokens) };
  });

  const authorLeaning = asList(profile, "author_leaning").map((entry, index) => {
    const where = `author_leaning[${index}]`;
    checkKeys(where, entry, new Set(["tokens", "author", "message", "evidence"]));
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
    return entry;
  });

  const thresholds = profile.thresholds ?? {};
  checkKeys("thresholds", thresholds, THRESHOLD_KEYS);
  for (const [key, value] of Object.entries(thresholds)) {
    if (typeof value !== "number" || !(value > 0)) {
      fail(`thresholds.${key}`, "正の数で書く");
    }
  }

  const allow = asList(profile, "allow");
  allow.forEach((value, index) => {
    if (typeof value !== "string" || value === "") {
      fail(`allow[${index}]`, "文字列で書く");
    }
  });

  return { modelLeaning, authorLeaning, orthography, thresholds, allow };
};

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

const textlintrc = ({ thresholds, allow }) => {
  const leaning = (file) => ({
    dictionaryPath: `./${file}`,
    dictionaryMode: "override",
    ...(allow.length > 0 ? { allows: allow } : {}),
  });
  const decoration = {
    ...(thresholds.bold_per_1000 !== undefined ? { maxBoldPer1000: thresholds.bold_per_1000 } : {}),
    ...(thresholds.list_ratio !== undefined ? { maxListRatio: thresholds.list_ratio } : {}),
  };
  const rules = {
    "preset-onajimi": {
      "model-leaning": leaning("model-leaning.json"),
      "author-leaning": { severity: "warning", ...leaning("author-leaning.json") },
      "decoration-density": { severity: "warning", ...decoration },
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
