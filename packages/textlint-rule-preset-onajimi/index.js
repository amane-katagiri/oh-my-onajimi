"use strict";

const leaning = require("textlint-rule-preset-ai-words-ja").default.rules["no-ai-words"];
const decorationDensity = require("./rules/decoration-density");
const phraseDensity = require("./rules/phrase-density");

module.exports = {
  rules: {
    "model-leaning": leaning,
    "author-leaning": leaning,
    "decoration-density": decorationDensity,
    "phrase-density": phraseDensity,
  },
  // 既定で有効にすると ai-words-ja の組み込み辞書がそのまま走るので、辞書を渡されたときだけ動かす。
  rulesConfig: {
    "model-leaning": false,
    "author-leaning": false,
    "decoration-density": true,
    "phrase-density": false,
  },
};
