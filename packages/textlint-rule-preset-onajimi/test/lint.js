"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { TextlintKernel } = require("@textlint/kernel");
const markdown = require("@textlint/textlint-plugin-markdown").default;
const preset = require("..");
const { presetRules } = require("../rules/preset-rules");

const lintFixture = async (fixture, file) => {
  const dir = path.join(__dirname, "fixtures", fixture);
  const config = JSON.parse(fs.readFileSync(path.join(dir, ".textlintrc.json"), "utf8"));
  const filePath = path.join(dir, file);
  const result = await new TextlintKernel().lintText(fs.readFileSync(filePath, "utf8"), {
    ext: ".md",
    filePath,
    configBaseDir: dir,
    plugins: [{ pluginId: "markdown", plugin: markdown }],
    rules: presetRules(preset, config.rules["preset-onajimi"]),
  });
  return result.messages;
};

module.exports = { lintFixture };
