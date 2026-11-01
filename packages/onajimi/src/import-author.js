import fs from "node:fs";
import path from "node:path";
import { authorDir } from "./paths.js";
import { build } from "./build.js";

const FILES = ["profile.yml", "corpus.yml", "split.yml"];
const SKIPPED_IN_PROFILE = new Set(["_full"]);

export const importAuthor = ({ root, from, author }) => {
  const source = authorDir(path.resolve(from), author);
  const target = authorDir(root, author);
  if (path.resolve(source) === path.resolve(target)) {
    throw new Error("--from と --root が同じディレクトリを指している。");
  }
  if (!fs.existsSync(path.join(source, "profile.yml"))) {
    throw new Error(`${path.join(source, "profile.yml")} がない。`);
  }
  for (const name of [...FILES, "profile"]) {
    if (fs.existsSync(path.join(target, name))) {
      throw new Error(`${path.join(target, name)} はもうある。取り込み直すなら消してから実行する。`);
    }
  }
  fs.mkdirSync(target, { recursive: true });
  const copied = [];
  for (const name of FILES) {
    if (fs.existsSync(path.join(source, name))) {
      fs.copyFileSync(path.join(source, name), path.join(target, name));
      copied.push(path.join(target, name));
    }
  }
  if (fs.existsSync(path.join(source, "profile"))) {
    fs.cpSync(path.join(source, "profile"), path.join(target, "profile"), {
      recursive: true,
      filter: (file) => !SKIPPED_IN_PROFILE.has(path.relative(path.join(source, "profile"), file).split(path.sep)[0]),
    });
    copied.push(path.join(target, "profile"));
  }
  build({ root, author });
  return { copied, generated: path.join(target, "generated") };
};
