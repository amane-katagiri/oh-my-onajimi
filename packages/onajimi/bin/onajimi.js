#!/usr/bin/env node
import preset from "textlint-rule-preset-onajimi";
import { main } from "../src/main.js";
import { dataRoot } from "../src/paths.js";

process.exitCode = await main({ argv: process.argv.slice(2), preset, defaultRoot: dataRoot() });
