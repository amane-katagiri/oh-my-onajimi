#!/usr/bin/env node
import preset from "textlint-rule-preset-onajimi";
import { main } from "../src/main.js";

process.exitCode = await main({ argv: process.argv.slice(2), preset });
