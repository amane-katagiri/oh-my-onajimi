import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "../../..");
export const bin = path.join(repoRoot, "bin/onajimi");

export const makeRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "onajimi-test-"));
  fs.cpSync(path.join(here, "fixtures/authors"), path.join(root, "authors"), { recursive: true });
  return root;
};

export const writeFile = (root, name, text) => {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};

export const isolatedHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "onajimi-home-"));
  return { HOME: home, XDG_DATA_HOME: path.join(home, "data"), ONAJIMI_ROOT: "" };
};

export const run = (args, { env, cwd, command = [bin] } = {}) => {
  const [file, ...head] = command;
  const result = spawnSync(file, [...head, ...args], { encoding: "utf8", cwd, env: { ...process.env, ...isolatedHome(), ...env } });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
};
