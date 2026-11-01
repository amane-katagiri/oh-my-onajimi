import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const nodeModulesDir = path.resolve(path.dirname(require.resolve("textlint-rule-prh/package.json")), "..");

export const authorDir = (root, author) => {
  if (!/^[A-Za-z0-9_-]+$/.test(author)) {
    throw new Error(`筆者名に使えない文字がある: ${author}`);
  }
  return path.join(root, "authors", author);
};

export const generatedDir = (root, author) => path.join(authorDir(root, author), "generated");
