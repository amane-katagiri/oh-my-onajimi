import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import { THRESHOLD_KEYS, build, parseProfile } from "./build.js";
import { corpusPaths } from "./corpus.js";
import { readProfileOutput } from "./docs.js";

const SECTIONS = { M: "model_leaning", O: "orthography", R: "orthography_review", D: "density" };
const TARGETS = { model_leaning: "model_leaning", orthography: "orthography", orthography_review: "orthography", density: "density" };
const ENTRY_KEYS = {
  model_leaning: ["tokens", "message", "note", "evidence"],
  orthography: ["expected", "pattern", "patterns", "note", "evidence"],
  density: ["tokens", "max_per_1000", "min_chars", "typical_per_1000", "message", "note", "evidence"],
};
const EMPHASIS_KEYS = ["emphasis_share_min", "emphasis_min_marks", "emphasis_share_typical"];

const ID = /^(?<id>T|T\.[a-z_0-9]+|[MORD]\d+)(?:=(?<value>[\s\S]+))?$/u;

export const disablesCheck = (key, value) => value === null || value === undefined || (key === "emphasis_share_min" && value <= 0);

const proposedThresholds = (proposal) => {
  const proposed = proposal.thresholds ?? {};
  const keys = Object.keys(proposed).filter((key) => THRESHOLD_KEYS.has(key));
  const emphasisOff = disablesCheck("emphasis_share_min", proposed.emphasis_share_min);
  return Object.fromEntries(
    keys.filter((key) => !disablesCheck(key, proposed[key]) && !(emphasisOff && EMPHASIS_KEYS.includes(key))).map((key) => [key, proposed[key]]),
  );
};

const plain = (value) => JSON.parse(JSON.stringify(value));

const pick = (entry, keys) => Object.fromEntries(keys.filter((key) => entry[key] !== undefined).map((key) => [key, plain(entry[key])]));

const sameEntry = (section, a, b) =>
  section === "orthography"
    ? a.expected === b.expected && isDeepStrictEqual(a.pattern ?? a.patterns, b.pattern ?? b.patterns)
    : isDeepStrictEqual(a.tokens, b.tokens);

const resolve = (proposal, raw) => {
  const match = ID.exec(raw);
  if (!match) {
    throw new Error(`${raw} は番号として読めない（M3・O2・R1・D5・T・T.sentence_length のように書く。M と D は M3=メッセージ で message を差し替えられる）`);
  }
  const { id, value } = match.groups;
  if (id === "T") {
    if (value !== undefined) {
      throw new Error("T には値を付けられない。1 項目だけ変えるなら T.<項目>=値 と書く");
    }
    return Object.entries(proposedThresholds(proposal)).map(([key, proposed]) => ({ id: `T.${key}`, section: "thresholds", key, value: proposed }));
  }
  if (id.startsWith("T.")) {
    const key = id.slice(2);
    if (!THRESHOLD_KEYS.has(key)) {
      throw new Error(`${id}: thresholds に ${key} という項目はない`);
    }
    const number = value === undefined ? proposal.thresholds?.[key] : Number(value);
    if (typeof number !== "number" || Number.isNaN(number)) {
      throw new Error(`${id}: 提案の値がないので T.${key}=値 と書く`);
    }
    return [{ id, section: "thresholds", key, value: number }];
  }
  const from = SECTIONS[id[0]];
  const entry = (proposal[from] ?? []).find((candidate) => candidate.id === id);
  if (!entry) {
    throw new Error(`${id} は proposal.yml の ${from} にない。onajimi profile と review をやり直したなら review.md の番号を見直す`);
  }
  const section = TARGETS[from];
  if (value !== undefined && section === "orthography") {
    throw new Error(`${id}: orthography には message を付けられない`);
  }
  const copied = pick(entry, ENTRY_KEYS[section]);
  return [{ id, section, entry: value === undefined ? copied : { ...copied, message: value.trim() } }];
};

const ensure = (doc, key, makeSeq) => {
  let node = doc.get(key, true);
  if (!(makeSeq ? YAML.isSeq(node) : YAML.isMap(node))) {
    node = doc.createNode(makeSeq ? [] : {});
    doc.set(key, node);
  }
  node.flow = false;
  return node;
};

export const acceptIds = ({ root, author, ids }) => {
  if (ids.length === 0) {
    throw new Error("受け入れる番号を 1 つ以上渡す（review.md の M3・O2・D5・T など）");
  }
  const proposal = readProfileOutput(root, author, "proposal.yml") ?? {};
  const profileFile = corpusPaths(root, author).profileYml;
  const text = fs.readFileSync(profileFile, "utf8");
  const current = YAML.parse(text) ?? {};
  const picked = ids.flatMap((raw) => resolve(proposal, raw));
  const duplicates = [];
  const seen = { model_leaning: [...(current.model_leaning ?? [])], orthography: [...(current.orthography ?? [])], density: [...(current.density ?? [])] };
  const thresholds = { ...(current.thresholds ?? {}) };
  for (const item of picked) {
    if (item.section === "thresholds") {
      if (item.key in thresholds) {
        duplicates.push(`${item.id}（thresholds.${item.key} はもう ${thresholds[item.key]}）`);
      }
      thresholds[item.key] = item.value;
      continue;
    }
    const pools = item.section === "orthography" ? ["orthography"] : ["model_leaning", "density"];
    const clash = pools.find((pool) => seen[pool].some((existing) => sameEntry(item.section, existing, item.entry)));
    if (clash) {
      duplicates.push(`${item.id}（同じ${item.section === "orthography" ? "表記" : " tokens "}が ${clash} にある）`);
    }
    seen[item.section].push(item.entry);
  }
  if (duplicates.length > 0) {
    throw new Error(`重なる項目があるので何も書いていない: ${duplicates.join("、")}`);
  }
  const doc = YAML.parseDocument(text);
  for (const item of picked) {
    if (item.section === "thresholds") {
      ensure(doc, "thresholds", false).set(item.key, item.value);
    } else {
      ensure(doc, item.section, true).items.push(doc.createNode(item.entry, { aliasDuplicateObjects: false }));
    }
  }
  const next = doc.toString({ lineWidth: 0 });
  parseProfile(next);
  fs.writeFileSync(profileFile, next);
  build({ root, author });
  return { accepted: picked.map((item) => (item.section === "thresholds" ? `${item.id}=${item.value}` : item.id)) };
};
