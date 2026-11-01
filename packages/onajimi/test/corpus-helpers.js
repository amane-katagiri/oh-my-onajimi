import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { makeRoot } from "./helpers.js";

const fakeRunner = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/fake-runner.js");

export const post = ({ title, date, category = "tech", author = "Demo", aiSummary = "要点。", body }) =>
  [`title: ${title}`, `author: ${author}`, "summary: 副題", `date: ${date}T10:00:00+09:00`, `category: ${category}`, `ai_summary: ${aiSummary}`, "", body, ""].join("\n");

export const makeCorpusRoot = (posts, { runners } = {}) => {
  const root = makeRoot();
  const dir = path.join(root, "authors/demo");
  fs.mkdirSync(path.join(dir, "corpus/post"), { recursive: true });
  for (const [slug, text] of Object.entries(posts)) {
    fs.writeFileSync(path.join(dir, "corpus/post", `${slug}.md`), text);
  }
  const log = path.join(root, "calls.log");
  const config = {
    select: { author: "Demo", categories: ["tech", "ugoki"], since: "2020-01-01" },
    test_ratio: 0.25,
    exclude_sections: [{ post: "with-extra", from_heading: "おまけ" }],
    skip_paragraphs: ["[TOC]"],
    control: {
      prompt: "約{chars}字で書いてください。\nタイトル: {title}\n{outline}\n要点: {points}",
      delay_seconds: 0,
      retry_delays_seconds: [0, 0, 0],
      runners: runners ?? {
        fake: { command: [process.execPath, fakeRunner, log, "ok"], output: "json", meta_fields: ["total_cost_usd"], rate_limit: "429" },
        limited: { command: [process.execPath, fakeRunner, log, "limited"], output: "json", rate_limit: "429" },
        flaky: { command: [process.execPath, fakeRunner, log, "flaky", "2"], output: "json", rate_limit: "429", unavailable: "503" },
        down: { command: [process.execPath, fakeRunner, log, "flaky", "99"], output: "json", rate_limit: "429", unavailable: "503" },
      },
    },
    profile: { alpha0: 100, min_docs: 1, min_count: 1, proposal_z: -0.5, proposal_max_author_docs: 1, rate_z: -0.5, proposal_limit: 10 },
  };
  fs.writeFileSync(path.join(dir, "corpus.yml"), YAML.stringify(config));
  return { root, log };
};
