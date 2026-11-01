import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.resolve(here, "../bin/onajimi.js");

export const makeRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "onajimi-test-"));
  fs.cpSync(path.join(here, "fixtures/authors"), path.join(root, "authors"), { recursive: true });
  return root;
};

export const writeFile = (root, name, text) => {
  const file = path.join(root, name);
  fs.writeFileSync(file, text);
  return file;
};

export const run = (args) => {
  const result = spawnSync(process.execPath, [bin, ...args], { encoding: "utf8" });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
};
