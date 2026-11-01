"use strict";

const path = require("node:path");
const fs = require("node:fs");

const nodeModulesDir = path.resolve(__dirname, "../../../node_modules");

const lintFixture = async (fixture, file) => {
  const { createLinter, loadTextlintrc } = await import("textlint");
  const dir = path.join(__dirname, "fixtures", fixture);
  const descriptor = await loadTextlintrc({
    configFilePath: path.join(dir, ".textlintrc.json"),
    node_modulesDir: nodeModulesDir,
  });
  const linter = createLinter({ descriptor });
  const filePath = path.join(dir, file);
  const result = await linter.lintText(fs.readFileSync(filePath, "utf8"), filePath);
  return result.messages;
};

module.exports = { lintFixture };
