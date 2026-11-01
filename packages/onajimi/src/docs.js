import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { corpusPaths } from "./corpus.js";
import { stripTitle } from "./prose.js";

export const controlFile = (root, author, runner, slug) => path.join(corpusPaths(root, author).control, runner, `${slug}.md`);

export const metaFileOf = (file) => file.replace(/\.md$/u, ".json");

export const authorDocsOf = (posts) => posts.map((post) => ({ slug: post.slug, text: stripTitle(post.text, post.meta) }));

export const controlDocsOf = (root, author, runner, posts) =>
  posts
    .map((post) => ({ post, file: controlFile(root, author, runner, post.slug) }))
    .filter(({ file }) => fs.existsSync(file))
    .map(({ post, file }) => ({ slug: post.slug, text: stripTitle(fs.readFileSync(file, "utf8"), post.meta) }));

export const readProfileOutput = (root, author, name) => {
  const file = path.join(corpusPaths(root, author).profile, name);
  if (!fs.existsSync(file)) {
    throw new Error(`${path.relative(process.cwd(), file)} がない。先に onajimi profile --author ${author} を実行する。`);
  }
  return YAML.parse(fs.readFileSync(file, "utf8"));
};
