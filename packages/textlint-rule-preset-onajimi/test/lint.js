"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { TextlintKernel } = require("@textlint/kernel");
const markdown = require("@textlint/textlint-plugin-markdown").default;
const preset = require("..");

const presetRules = (userOptions) =>
  Object.entries(preset.rules).map(([key, rule]) => {
    const user = userOptions[key];
    const options = user === false ? false : user === undefined || user === true ? preset.rulesConfig[key] : user;
    return { ruleId: `onajimi/${key}`, rule, options };
  });

const lintFixture = async (fixture, file) => {
  const dir = path.join(__dirname, "fixtures", fixture);
  const config = JSON.parse(fs.readFileSync(path.join(dir, ".textlintrc.json"), "utf8"));
  const filePath = path.join(dir, file);
  const result = await new TextlintKernel().lintText(fs.readFileSync(filePath, "utf8"), {
    ext: ".md",
    filePath,
    configBaseDir: dir,
    plugins: [{ pluginId: "markdown", plugin: markdown }],
    rules: presetRules(config.rules["preset-onajimi"]).filter((rule) => rule.options !== false),
  });
  return result.messages;
};

module.exports = { lintFixture };
