import { parse } from "@textlint/markdown-to-ast";

const FRONTMATTER_LINE = /^[A-Za-z_][A-Za-z0-9_-]*:(?:\s|$)/;

export const blankLooseFrontmatter = (text) => {
  const lines = text.split("\n");
  const end = lines.findIndex((line) => line.trim() === "");
  const block = lines.slice(0, end === -1 ? lines.length : end);
  if (block.length === 0 || !block.every((line) => FRONTMATTER_LINE.test(line))) {
    return text;
  }
  return [...block.map(() => ""), ...lines.slice(block.length)].join("\n");
};

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
  walk(parse(blankLooseFrontmatter(markdown)));
  return pieces.join("\n");
};
