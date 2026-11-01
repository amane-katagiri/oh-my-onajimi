import fs from "node:fs";
import path from "node:path";
import { TextlintKernel } from "@textlint/kernel";
import markdownPlugin from "@textlint/textlint-plugin-markdown";
import textPlugin from "@textlint/textlint-plugin-text";
import prh from "textlint-rule-prh";
import sentenceLength from "textlint-rule-sentence-length";
import maxTen from "textlint-rule-max-ten";
import preset from "../../textlint-rule-preset-onajimi/index.js";
import { generatedDir } from "./paths.js";
import { blankLooseFrontmatter } from "./prose.js";

const RULE_NAMES = { prh: "orthography" };

const ruleName = (ruleId) => RULE_NAMES[ruleId] ?? ruleId.replace(/^onajimi\//u, "");

const rewriteMessage = (ruleId, message) => {
  if (ruleId === "sentence-length") {
    const match = /sentence length\((\d+)\) exceeds the maximum sentence length of (\d+)/u.exec(message);
    if (match) {
      return `文が長い: ${match[1]}字（目安 ${match[2]} 字以下）。`;
    }
  }
  if (ruleId === "max-ten") {
    const match = /"(.)"を(\d+)つ以上使用/u.exec(message);
    if (match) {
      return `読点が多い: 1文に「${match[1]}」が${match[2]}個以上（目安 ${Number(match[2]) - 1} 個以下）。`;
    }
  }
  return message.replace(/\s*\n\s*/gu, " ");
};

export const formatMessages = (messages) =>
  [...messages]
    .sort((a, b) => a.line - b.line || a.column - b.column)
    .map((m) => `${m.line}:${m.column} ${ruleName(m.ruleId)} ${rewriteMessage(m.ruleId, m.message)}`);

const interop = (mod) => (mod && mod.__esModule ? mod.default : mod);

const PRESET = "preset-onajimi";
const RULES = { prh: interop(prh), "sentence-length": interop(sentenceLength), "max-ten": interop(maxTen) };
const PLUGINS = [
  { pluginId: "@textlint/textlint-plugin-text", plugin: interop(textPlugin), options: true },
  { pluginId: "@textlint/textlint-plugin-markdown", plugin: interop(markdownPlugin), options: true },
];

const presetRules = (userOptions) =>
  Object.entries(preset.rules).map(([key, rule]) => {
    const user = userOptions[key];
    const options = user === false ? false : user === undefined || user === true ? preset.rulesConfig[key] : user;
    return { ruleId: `onajimi/${key}`, rule, options };
  });

export const kernelRules = (config) =>
  Object.entries(config.rules ?? {}).flatMap(([ruleId, options]) => {
    if (ruleId === PRESET) {
      return presetRules(options === true ? {} : options);
    }
    if (!(ruleId in RULES)) {
      throw new Error(`知らないルール ${ruleId}`);
    }
    return [{ ruleId, rule: RULES[ruleId], options }];
  }).filter((rule) => rule.options !== false);

export const createAuthorLinter = async (root, author) => {
  const configFilePath = path.join(generatedDir(root, author), ".textlintrc.json");
  if (!fs.existsSync(configFilePath)) {
    throw new Error(`${path.relative(process.cwd(), configFilePath)} がない。先に onajimi build --author ${author} を実行する。`);
  }
  const options = {
    configBaseDir: path.dirname(configFilePath),
    rules: kernelRules(JSON.parse(fs.readFileSync(configFilePath, "utf8"))),
    plugins: PLUGINS,
  };
  const kernel = new TextlintKernel();
  return async (text, filePath) =>
    (await kernel.lintText(blankLooseFrontmatter(text), { ...options, ext: path.extname(filePath), filePath })).messages;
};

export const lint = async ({ root, author, file }) => {
  const lintText = await createAuthorLinter(root, author);
  const filePath = path.resolve(file);
  return formatMessages(await lintText(fs.readFileSync(filePath, "utf8"), filePath));
};
