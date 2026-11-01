import path from "node:path";
import { fileURLToPath } from "node:url";

export const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const resolveRoot = (explicit, env = process.env) => path.resolve(explicit ?? (env.ONAJIMI_ROOT || defaultRoot));

export const authorDir = (root, author) => {
  if (!/^[A-Za-z0-9_-]+$/.test(author)) {
    throw new Error(`筆者名に使えない文字がある: ${author}`);
  }
  return path.join(root, "authors", author);
};

export const generatedDir = (root, author) => path.join(authorDir(root, author), "generated");
