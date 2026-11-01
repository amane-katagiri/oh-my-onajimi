import fs from "node:fs";
import path from "node:path";
import { createLinter, loadTextlintrc } from "textlint";
import { generatedDir, nodeModulesDir } from "./paths.js";
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

export const lint = async ({ root, author, file }) => {
  const configFilePath = path.join(generatedDir(root, author), ".textlintrc.json");
  if (!fs.existsSync(configFilePath)) {
    throw new Error(`${path.relative(process.cwd(), configFilePath)} がない。先に onajimi build --author ${author} を実行する。`);
  }
  const descriptor = await loadTextlintrc({ configFilePath, node_modulesDir: nodeModulesDir });
  const linter = createLinter({ descriptor });
  const filePath = path.resolve(file);
  const text = blankLooseFrontmatter(fs.readFileSync(filePath, "utf8"));
  const result = await linter.lintText(text, filePath);
  return formatMessages(result.messages);
};
