"use strict";

const presetRules = (preset, userOptions) =>
  Object.entries(preset.rules)
    .map(([key, rule]) => {
      const user = userOptions[key];
      const options = user === false ? false : user === undefined || user === true ? preset.rulesConfig[key] : user;
      return { ruleId: `onajimi/${key}`, rule, options };
    })
    .filter((rule) => rule.options !== false);

module.exports = { presetRules };
