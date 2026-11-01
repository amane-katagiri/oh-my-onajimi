"use strict";

const { tokenize } = require("kuromojin");
const { createTextlintMatcher } = require("morpheme-match-textlint");

// 照合器は前の呼び出しで途中まで合った状態を持ち越すので、ノードをまたいで合わないよう呼ぶたびに作る。
const matchText = (entries, text) =>
  createTextlintMatcher({
    tokenize: async (value) => [...(await tokenize(value))],
    dictionaries: entries,
  })(text);

module.exports = { matchText };
