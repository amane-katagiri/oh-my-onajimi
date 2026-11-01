"use strict";

const tokenLeaning = require("./rules/token-leaning");
const decorationDensity = require("./rules/decoration-density");
const phraseDensity = require("./rules/phrase-density");

module.exports = {
  rules: {
    "model-leaning": tokenLeaning,
    "author-leaning": tokenLeaning,
    "decoration-density": decorationDensity,
    "phrase-density": phraseDensity,
  },
  rulesConfig: {
    "model-leaning": false,
    "author-leaning": false,
    "decoration-density": true,
    "phrase-density": false,
  },
};
