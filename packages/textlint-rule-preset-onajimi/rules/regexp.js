"use strict";

const REGEXP_LITERAL = /^\/(.+)\/([gimsuy]*)$/su;

const parseRegExpLiteral = (pattern) => {
  const literal = REGEXP_LITERAL.exec(pattern);
  return literal ? { source: literal[1], flags: literal[2] } : null;
};

const createTester = (pattern, plain = (text) => text.includes(pattern)) => {
  const literal = parseRegExpLiteral(pattern);
  if (literal) {
    // g を残すと lastIndex が持ち越され、同じ文字列でも結果が交互に変わる。
    const regExp = new RegExp(literal.source, literal.flags.replace("g", ""));
    return (text) => regExp.test(text);
  }
  return plain;
};

module.exports = { parseRegExpLiteral, createTester };
