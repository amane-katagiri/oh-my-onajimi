import { parse } from "@textlint/markdown-to-ast";
import { createTester, presetCount } from "./preset.js";

export const FRONTMATTER_LINE = /^[A-Za-z_][A-Za-z0-9_-]*:(?:\s|$)/;

export const blankLooseFrontmatter = (text) => {
  const lines = text.split("\n");
  const end = lines.findIndex((line) => line.trim() === "");
  const block = lines.slice(0, end === -1 ? lines.length : end);
  if (block.length === 0 || !block.every((line) => FRONTMATTER_LINE.test(line))) {
    return text;
  }
  return [...block.map(() => ""), ...lines.slice(block.length)].join("\n");
};

export const parseMarkdown = (markdown) => parse(blankLooseFrontmatter(markdown));

export const proseText = (markdown) => {
  const pieces = [];
  const walk = (node) => {
    if (node.type === "Str") {
      pieces.push(node.value);
    }
    for (const child of node.children ?? []) {
      walk(child);
    }
  };
  walk(parseMarkdown(markdown));
  return pieces.join("\n");
};

const NOT_ANALYZED = new Set(["BlockQuote", "Table", "Html", "Header", "Code", "CodeBlock", "Yaml"]);

const paragraphTester = (pattern) => createTester(pattern, (text) => text === pattern);

export const analyzeProse = (markdown, { skipParagraphs = [] } = {}) => {
  const count = presetCount();
  const testers = skipParagraphs.map(paragraphTester);
  const strs = [];
  const headings = [];
  const walk = (node, skipped, inQuote) => {
    if (node.type === "Header" && !inQuote) {
      headings.push({ depth: node.depth, text: count.textOf(node).trim() });
    }
    const skipHere = skipped || NOT_ANALYZED.has(node.type) || (node.type === "Paragraph" && testers.some((test) => test(count.textOf(node).trim())));
    if (node.type === "Str" && !skipHere) {
      strs.push(node.value);
    }
    for (const child of node.children ?? []) {
      walk(child, skipHere, inQuote || node.type === "BlockQuote");
    }
  };
  walk(parseMarkdown(markdown), false, false);
  return { strs, headings, chars: strs.reduce((sum, text) => sum + count.proseLength(text), 0) };
};

export const proseParagraphs = (markdown, { skipParagraphs = [] } = {}) => {
  const count = presetCount();
  const testers = skipParagraphs.map(paragraphTester);
  const paragraphs = [];
  const walk = (node) => {
    if (NOT_ANALYZED.has(node.type)) {
      return;
    }
    if (node.type === "Paragraph") {
      const text = count.textOf(node).trim();
      if (text !== "" && !testers.some((test) => test(text))) {
        paragraphs.push(text);
      }
      return;
    }
    for (const child of node.children ?? []) {
      walk(child);
    }
  };
  walk(parseMarkdown(markdown));
  return paragraphs;
};

const HEADING_LINE = /^#{1,6}\s+(.*?)\s*#*\s*$/u;
const BOLD_ONLY_LINE = /^(\*\*|__)(?:(?!\1).)+\1$/u;

const normalizeTitle = (text) => text.normalize("NFKC").replace(/[\s*_`#]/gu, "").toLowerCase();

export const stripTitle = (markdown, { title, summary }) => {
  const lines = blankLooseFrontmatter(markdown).split("\n");
  const nextLine = (from) => {
    let at = from;
    while (at < lines.length && lines[at].trim() === "") {
      at += 1;
    }
    return at;
  };
  const first = nextLine(0);
  const heading = HEADING_LINE.exec(lines[first] ?? "");
  if (!title || !heading || normalizeTitle(heading[1]) !== normalizeTitle(title)) {
    return lines.join("\n");
  }
  lines[first] = "";
  const second = nextLine(first + 1);
  const line = (lines[second] ?? "").trim();
  const subheading = HEADING_LINE.exec(line);
  if (BOLD_ONLY_LINE.test(line) || (summary && subheading && normalizeTitle(subheading[1]) === normalizeTitle(summary))) {
    lines[second] = "";
  }
  return lines.join("\n");
};
