import fs from "node:fs";
import path from "node:path";
import { HIDDEN_SETS, SETS, corpusPaths, loadCorpus } from "./corpus.js";
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

const flat = (message) => message.replace(/\s*\n\s*/gu, " ");

const ruleName = (ruleId) => (ruleId === "prh" ? "orthography" : ruleId.replace(/^onajimi\//u, ""));

export const lintDoc = async (lintText, doc) => {
  const skip = quotedLines(doc.text);
  const lines = doc.text.split("\n");
  const messages = await lintText(doc.text, `${doc.slug}.md`);
  const findings = messages
    .filter((message) => !skip.has(message.line))
    .sort((a, b) => a.line - b.line || a.column - b.column)
    .map((message) => ({
      slug: doc.slug,
      line: message.line,
      column: message.column,
      rule: ruleName(message.ruleId),
      message: flat(message.message),
      text: (lines[message.line - 1] ?? "").trim(),
    }));
  return { findings, quoted: messages.length - findings.length };
};

export const documentKeyOf = (rules, preset) => {
  const phrase = rules.find(({ ruleId }) => ruleId === "onajimi/phrase-density");
  // 長い順に試すのは、ある項目のメッセージが別の項目のメッセージで始まるときに長いほうを取るため。
  const entries = (phrase?.options.entries ?? [])
    .map(({ message }, index) => ({ lead: flat(message), key: `phrase-density#${index}` }))
    .sort((a, b) => b.lead.length - a.lead.length);
  const boldLead = preset.rules["decoration-density"].BOLD_LEAD;
  return ({ rule, message }) => {
    if (rule === "phrase-density") {
      return entries.find(({ lead }) => message.startsWith(lead))?.key;
    }
    if (rule === "decoration-density" && message.startsWith(boldLead)) {
      return "decoration-density#bold";
    }
    return undefined;
  };
};

const documentLevel = (findings, documentKey) => {
  const seen = new Set();
  return findings.filter((finding) => {
    const key = documentKey(finding);
    if (key === undefined) {
      return true;
    }
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

const tally = (byRule, findings, field) => {
  for (const { rule } of findings) {
    byRule[rule] ??= { findings: 0, documentLevel: 0 };
    byRule[rule][field] += 1;
  }
};

export const scoreDocs = async (lintText, docs, options, documentKey) => {
  const byRule = {};
  let findings = 0;
  let documentLevelFindings = 0;
  let quoted = 0;
  let chars = 0;
  for (const doc of docs) {
    const result = await lintDoc(lintText, doc);
    const collapsed = documentLevel(result.findings, documentKey);
    quoted += result.quoted;
    findings += result.findings.length;
    documentLevelFindings += collapsed.length;
    tally(byRule, result.findings, "findings");
    tally(byRule, collapsed, "documentLevel");
    chars += analyzeProse(doc.text, options).chars;
  }
  return { docs: docs.length, chars, findings, documentLevel: documentLevelFindings, quoted, per1000: chars === 0 ? null : (findings / chars) * 1000, byRule };
};

export const authorDocsOf = (posts) => posts.map((post) => ({ slug: post.slug, text: stripTitle(post.text, post.meta) }));

export const controlDocsOf = (root, author, runner, posts) => {
  const dir = path.join(corpusPaths(root, author).control, runner);
  return posts
    .map((post) => ({ post, file: path.join(dir, `${post.slug}.md`) }))
    .filter(({ file }) => fs.existsSync(file))
    .map(({ post, file }) => ({ slug: post.slug, text: stripTitle(fs.readFileSync(file, "utf8"), post.meta) }));
};

export const runEval = async ({ root, author, preset, set = "test", details = false }) => {
  if (!SETS.includes(set)) {
    throw new Error(`--set は ${SETS.join("・")} のどれか`);
  }
  if (details && HIDDEN_SETS.includes(set)) {
    throw new Error(`--details は ${HIDDEN_SETS.join("・")} には使えない。最終評価までは件数の表だけを見る。`);
  }
  const corpus = loadCorpus(root, author);
  const options = { skipParagraphs: corpus.config.skipParagraphs };
  const { lintText, rules } = await createAuthorLinter(root, author, preset);
  const documentKey = documentKeyOf(rules, preset);
  const authorDocs = authorDocsOf(corpus[set]);
  const rows = [{ label: `誤検出: 筆者 ${set}`, ...(await scoreDocs(lintText, authorDocs, options, documentKey)) }];
  for (const runner of Object.keys(corpus.config.control.runners)) {
    rows.push({ label: `検出: ${runner} ${set}`, ...(await scoreDocs(lintText, controlDocsOf(root, author, runner, corpus[set]), options, documentKey)) });
  }
  if (!details) {
    return { rows };
  }
  const findings = [];
  for (const doc of authorDocs) {
    findings.push(...(await lintDoc(lintText, doc)).findings);
  }
  return { rows, findings };
};

const LINE_TEXT_MAX = 60;
const LEAD = 20;

export const truncate = (text, max) => {
  const chars = [...String(text ?? "")];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
};

export const around = (text, column = 1) => {
  const chars = [...text];
  if (chars.length <= LINE_TEXT_MAX) {
    return text;
  }
  const from = Math.max(0, Math.min(column - 1 - LEAD, chars.length - LINE_TEXT_MAX + 1));
  const head = from > 0 ? "…" : "";
  const rest = chars.slice(from);
  const room = LINE_TEXT_MAX - head.length;
  return `${head}${rest.length > room ? `${rest.slice(0, room - 1).join("")}…` : rest.join("")}`;
};

export const renderFinding = (finding, { messageMax, separator = " ｜ " } = {}) =>
  `${finding.slug}:${finding.line} ${finding.rule} ${messageMax ? truncate(finding.message, messageMax) : finding.message}${separator}${around(finding.text, finding.column)}`;

export const renderEval = (rows) => {
  const header = "| 対象 | 記事数 | 字数 | 指摘 | 文書単位 | 1000字あたり | 内訳（文書単位） | 引用・表で除外 |";
  const lines = rows.map((row) => {
    const per1000 = row.docs === 0 ? "対照なし" : row.per1000 === null ? "-" : row.per1000.toFixed(2);
    const breakdown = Object.entries(row.byRule)
      .sort((a, b) => b[1].findings - a[1].findings)
      .map(([name, count]) => (count.documentLevel === count.findings ? `${name} ${count.findings}` : `${name} ${count.findings}（${count.documentLevel}）`))
      .join(", ");
    return `| ${row.label} | ${row.docs} | ${row.chars} | ${row.findings} | ${row.documentLevel} | ${per1000} | ${breakdown || "-"} | ${row.quoted} |`;
  });
  return [header, "|---|---|---|---|---|---|---|---|", ...lines].join("\n");
};
