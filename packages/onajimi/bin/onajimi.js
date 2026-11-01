#!/usr/bin/env node
import fs from "node:fs";
import { parseArgs } from "node:util";
import { build } from "../src/build.js";
import { lint } from "../src/lint.js";
import { guard } from "../src/guard.js";
import { defaultRoot } from "../src/paths.js";

const USAGE = `使い方:
  onajimi build --author <name> [--check]
  onajimi lint --author <name> <file>
  onajimi guard <before> <after>
共通: --root <dir>（authors/ のあるディレクトリ）`;

const main = async (argv) => {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      author: { type: "string" },
      check: { type: "boolean", default: false },
      root: { type: "string", default: defaultRoot },
    },
  });
  const needAuthor = () => {
    if (!values.author) {
      throw new Error("--author が要る");
    }
    return values.author;
  };

  if (command === "build" && positionals.length === 0) {
    const result = build({ root: values.root, author: needAuthor(), check: values.check });
    if (values.check && result.stale.length > 0) {
      for (const name of result.stale) {
        console.log(`generated/${name} が profile.yml と食い違っている。onajimi build を実行する。`);
      }
      return 1;
    }
    return 0;
  }
  if (command === "lint" && positionals.length === 1) {
    const lines = await lint({ root: values.root, author: needAuthor(), file: positionals[0] });
    for (const line of lines) {
      console.log(line);
    }
    return lines.length > 0 ? 1 : 0;
  }
  if (command === "guard" && positionals.length === 2) {
    const [before, after] = positionals.map((file) => fs.readFileSync(file, "utf8"));
    const problems = guard(before, after);
    for (const problem of problems) {
      console.log(problem);
    }
    return problems.length > 0 ? 1 : 0;
  }
  console.error(USAGE);
  return 2;
};

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
