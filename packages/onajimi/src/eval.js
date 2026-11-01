import fs from "node:fs";
import path from "node:path";
import { corpusPaths, loadCorpus } from "./corpus.js";
import { createAuthorLinter } from "./lint.js";
import { analyzeProse, parseMarkdown, stripTitle } from "./prose.js";

const QUOTED = new Set(["BlockQuote", "Table", "Html", "CodeBlock"]);

const quotedLines = (markdown) => {
  const lines = new Set();
  const walk = (node) => {
    if (QUOTED.has(node.type)) {
      for (let line = node.loc.start.line; line <= node.loc.end.line; line += 1) {
        lines.add(line);
      }
      return;
    }
    for (const child of node.children ?? []) {
      walk(child);
    }
  };
  walk(parseMarkdown(markdown));
  return lines;
};

const ruleName = (ruleId) => (ruleId === "prh" ? "orthography" : ruleId.replace(/^onajimi\//u, ""));

export const scoreDocs = async (lintText, docs, options) => {
  const byRule = {};
  let findings = 0;
  let quoted = 0;
  let chars = 0;
  for (const doc of docs) {
    const skip = quotedLines(doc.text);
    const messages = await lintText(doc.text, `${doc.slug}.md`);
    for (const message of messages) {
      if (skip.has(message.line)) {
        quoted += 1;
        continue;
      }
      findings += 1;
      const name = ruleName(message.ruleId);
      byRule[name] = (byRule[name] ?? 0) + 1;
    }
    chars += analyzeProse(doc.text, options).chars;
  }
  return { docs: docs.length, chars, findings, quoted, per1000: chars === 0 ? null : (findings / chars) * 1000, byRule };
};

export const runEval = async ({ root, author, set = "test" }) => {
  const corpus = loadCorpus(root, author);
  const options = { skipParagraphs: corpus.config.skipParagraphs };
  const lintText = await createAuthorLinter(root, author);
  const posts = corpus[set];
  if (!posts) {
    throw new Error("--set は profile か test");
  }
  const authorDocs = posts.map((post) => ({ slug: post.slug, text: stripTitle(post.text, post.meta) }));
  const rows = [{ label: `誤検出: 筆者 ${set}`, ...(await scoreDocs(lintText, authorDocs, options)) }];
  for (const runner of Object.keys(corpus.config.control.runners)) {
    const dir = path.join(corpusPaths(root, author).control, runner);
    const docs = posts
      .map((post) => ({ post, file: path.join(dir, `${post.slug}.md`) }))
      .filter(({ file }) => fs.existsSync(file))
      .map(({ post, file }) => ({ slug: post.slug, text: stripTitle(fs.readFileSync(file, "utf8"), post.meta) }));
    rows.push({ label: `検出: ${runner} ${set}`, ...(await scoreDocs(lintText, docs, options)) });
  }
  return rows;
};

export const renderEval = (rows) => {
  const header = "| 対象 | 記事数 | 字数 | 指摘 | 1000字あたり | 内訳 | 引用・表で除外 |";
  const lines = rows.map((row) => {
    const per1000 = row.docs === 0 ? "対照なし" : row.per1000 === null ? "-" : row.per1000.toFixed(2);
    const breakdown = Object.entries(row.byRule)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `${name} ${count}`)
      .join(", ");
    return `| ${row.label} | ${row.docs} | ${row.chars} | ${row.findings} | ${per1000} | ${breakdown || "-"} | ${row.quoted} |`;
  });
  return [header, "|---|---|---|---|---|---|---|", ...lines].join("\n");
};
