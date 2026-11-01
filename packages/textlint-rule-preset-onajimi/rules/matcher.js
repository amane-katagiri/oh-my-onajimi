"use strict";

const { tokenize } = require("kuromojin");
const { createTextlintMatcher } = require("morpheme-match-textlint");

const createMatcher = (entries) =>
  createTextlintMatcher({
    tokenize: async (text) => [...(await tokenize(text))],
    dictionaries: entries,
  });

module.exports = { createMatcher };
