import os from "node:os";
import path from "node:path";

export const dataRoot = (env = process.env, home = os.homedir()) =>
  path.join(env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, ".local", "share"), "onajimi");

export const resolveRoot = (explicit, env = process.env, home = os.homedir()) => {
  if (explicit !== undefined) {
    return { root: path.resolve(explicit), source: "--root" };
  }
  if (env.ONAJIMI_ROOT) {
    return { root: path.resolve(env.ONAJIMI_ROOT), source: "ONAJIMI_ROOT" };
  }
  return { root: dataRoot(env, home), source: "default" };
};

export const authorDir = (root, author) => {
  if (!/^[A-Za-z0-9_-]+$/.test(author)) {
    throw new Error(`筆者名に使えない文字がある: ${author}`);
  }
  return path.join(root, "authors", author);
};

export const generatedDir = (root, author) => path.join(authorDir(root, author), "generated");
