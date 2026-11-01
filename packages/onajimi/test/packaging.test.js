import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "./helpers.js";

const read = (file) => fs.readFileSync(path.join(repoRoot, file), "utf8");
const manifest = (dir) => JSON.parse(read(path.join(dir, "package.json")));

test("the root NOTICE is the CLI's NOTICE followed by the preset's", () => {
  assert.equal(read("NOTICE"), `${read("packages/onajimi/NOTICE")}\n${read("packages/textlint-rule-preset-onajimi/NOTICE")}`);
});

test("the plugin root pins every runtime dependency of both packages from the registry", () => {
  const cli = manifest("packages/onajimi");
  const preset = manifest("packages/textlint-rule-preset-onajimi");
  const root = manifest(".").dependencies;
  for (const version of Object.values(root)) {
    assert.match(version, /^\d+\.\d+\.\d+$/u);
  }
  assert.equal(cli.dependencies[preset.name], preset.version);
  const needed = { ...preset.dependencies, ...cli.dependencies };
  delete needed[preset.name];
  for (const [name, version] of Object.entries(needed)) {
    assert.equal(root[name], version, name);
  }
});
