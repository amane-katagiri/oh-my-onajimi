import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import os from "node:os";
import { authorDir } from "./paths.js";
import { FRONTMATTER_LINE } from "./prose.js";

const fail = (where, problem) => {
  throw new Error(`corpus.yml の ${where}: ${problem}`);
};

const TOP_LEVEL_KEYS = new Set(["note", "posts", "select", "test_ratio", "dev_ratio", "exclude_sections", "skip_paragraphs", "control", "profile"]);

export const PROFILE_DEFAULTS = {
  alpha0: 1000,
  min_docs: 2,
  min_count: 3,
  proposal_z: -2,
  proposal_max_author_docs: 1,
  rate_z: -4,
  proposal_limit: 40,
  min_chars: 1500,
  emphasis_min_marks: 3,
  orthography_min_count: 5,
  orthography_min_share: 0.8,
  orthography_z: 2,
  orthography_limit: 30,
  hint_z: 4,
  hint_limit: 40,
};

export const parseCorpusConfig = (text) => {
  const config = YAML.parse(text) ?? {};
  for (const key of Object.keys(config)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      fail("最上位", `知らないキー ${key}`);
    }
  }
  const select = config.select ?? {};
  if (select.author !== undefined && (typeof select.author !== "string" || select.author === "")) {
    fail("select.author", "空でない文字列で書く");
  }
  if (select.categories !== undefined && (!Array.isArray(select.categories) || select.categories.length === 0)) {
    fail("select.categories", "1 つ以上の配列で書く");
  }
  const since = select.since === undefined ? "" : String(select.since);
  if (since !== "" && !/^\d{4}-\d{2}-\d{2}$/u.test(since)) {
    fail("select.since", "YYYY-MM-DD で書く");
  }
  const testRatio = config.test_ratio ?? 0.25;
  if (!(testRatio > 0 && testRatio < 1)) {
    fail("test_ratio", "0 より大きく 1 より小さい数で書く");
  }
  const devRatio = config.dev_ratio ?? 0.1;
  if (!(devRatio >= 0 && testRatio + devRatio < 1)) {
    fail("dev_ratio", "0 以上で、test_ratio との和が 1 より小さい数で書く");
  }
  if (config.posts !== undefined && (typeof config.posts !== "string" || config.posts === "")) {
    fail("posts", "記事の Markdown を置いたディレクトリを文字列で書く");
  }
  const excludeSections = (config.exclude_sections ?? []).map((entry, index) => {
    if (typeof entry?.post !== "string" || typeof entry?.from_heading !== "string") {
      fail(`exclude_sections[${index}]`, "post と from_heading が要る");
    }
    return { post: entry.post, fromHeading: entry.from_heading };
  });
  const skipParagraphs = (config.skip_paragraphs ?? []).map((pattern, index) => {
    if (typeof pattern !== "string" || pattern === "") {
      fail(`skip_paragraphs[${index}]`, "文字列で書く");
    }
    return pattern;
  });
  const control = config.control ?? {};
  const runners = control.runners ?? {};
  for (const [name, runner] of Object.entries(runners)) {
    if (!/^[A-Za-z0-9_-]+$/u.test(name)) {
      fail(`control.runners.${name}`, "名前に使えない文字がある");
    }
    if (runner?.api !== undefined) {
      if (runner.api !== "gemini") {
        fail(`control.runners.${name}.api`, "gemini だけを扱う");
      }
      continue;
    }
    if (!Array.isArray(runner?.command) || runner.command.length === 0 || runner.command.some((arg) => typeof arg !== "string")) {
      fail(`control.runners.${name}.command`, "文字列の配列で書く");
    }
    if (runner.output !== undefined && !["text", "json"].includes(runner.output)) {
      fail(`control.runners.${name}.output`, "text か json");
    }
  }
  const retry = control.retry_delays_seconds;
  if (retry !== undefined && (!Array.isArray(retry) || retry.some((value) => typeof value !== "number" || value < 0))) {
    fail("control.retry_delays_seconds", "0 以上の秒数の配列で書く");
  }
  if (Object.keys(runners).length > 0 && typeof control.prompt !== "string") {
    fail("control.prompt", "プロンプトのひな形が要る");
  }
  for (const key of Object.keys(config.profile ?? {})) {
    if (!(key in PROFILE_DEFAULTS)) {
      fail("profile", `知らないキー ${key}`);
    }
  }
  return {
    posts: config.posts ?? "corpus/post",
    select: { author: select.author, categories: select.categories?.map(String), since },
    testRatio,
    devRatio,
    excludeSections,
    skipParagraphs,
    control: {
      prompt: control.prompt,
      delaySeconds: control.delay_seconds ?? 0,
      timeoutSeconds: control.timeout_seconds ?? 900,
      retryDelaysSeconds: control.retry_delays_seconds ?? [30, 60, 120],
      runners,
    },
    profile: { ...PROFILE_DEFAULTS, ...(config.profile ?? {}) },
  };
};

const fencedMeta = (lines) => {
  const end = lines.indexOf("---", 1);
  if (lines[0] !== "---" || end === -1) {
    return null;
  }
  const data = YAML.parse(lines.slice(1, end).join("\n"), { schema: "failsafe" }) ?? {};
  return Object.fromEntries(Object.entries(data).filter(([, value]) => typeof value === "string"));
};

export const parsePost = (slug, text) => {
  const lines = text.split("\n");
  const fenced = fencedMeta(lines.map((line) => line.trimEnd()));
  if (fenced) {
    return { slug, meta: fenced, text };
  }
  const meta = {};
  for (const line of lines) {
    if (!FRONTMATTER_LINE.test(line)) {
      break;
    }
    const at = line.indexOf(":");
    meta[line.slice(0, at)] = line.slice(at + 1).trim();
  }
  return { slug, meta, text };
};

export const cutSection = (text, heading) => {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => /^#{1,6}\s/u.test(line) && line.replace(/^#{1,6}\s+/u, "").trim() === heading);
  return at === -1 ? null : lines.slice(0, at).join("\n");
};

export const applyExclusions = (post, excludeSections) => {
  let { text } = post;
  for (const { post: slug, fromHeading } of excludeSections) {
    if (slug !== post.slug) {
      continue;
    }
    const cut = cutSection(text, fromHeading);
    if (cut === null) {
      throw new Error(`corpus.yml の exclude_sections: ${slug} に見出し「${fromHeading}」がない`);
    }
    text = cut;
  }
  return { ...post, text };
};

const postDate = (post) => (post.meta.date ?? "").slice(0, 10);

const byAuthor = (post, { author }) => author === undefined || post.meta.author === author;

export const selectPosts = (posts, config) =>
  posts.filter(
    (post) =>
      byAuthor(post, config.select) &&
      (config.select.categories === undefined || config.select.categories.includes(post.meta.category)) &&
      postDate(post) >= config.select.since,
  );

export const otherRegisterPosts = (posts, config) =>
  config.select.categories === undefined
    ? []
    : posts.filter((post) => byAuthor(post, config.select) && !config.select.categories.includes(post.meta.category));

export const SETS = ["profile", "dev", "test"];

export const splitByDate = (posts, testRatio, devRatio = 0) => {
  const ordered = [...posts].sort((a, b) => (a.meta.date ?? "").localeCompare(b.meta.date ?? "") || a.slug.localeCompare(b.slug));
  const testCut = ordered.length - Math.ceil(ordered.length * testRatio);
  const devCut = Math.max(0, testCut - Math.ceil(ordered.length * devRatio));
  const slugs = (from, to) => ordered.slice(from, to).map((post) => post.slug);
  return { profile: slugs(0, devCut), dev: slugs(devCut, testCut), test: slugs(testCut) };
};

export const corpusPaths = (root, author) => {
  const dir = authorDir(root, author);
  return {
    config: path.join(dir, "corpus.yml"),
    split: path.join(dir, "split.yml"),
    control: path.join(dir, "corpus", "_control"),
    profile: path.join(dir, "profile"),
  };
};

export const loadCorpusConfig = (root, author) => {
  const { config } = corpusPaths(root, author);
  if (!fs.existsSync(config)) {
    throw new Error(`${path.relative(process.cwd(), config)} がない`);
  }
  return parseCorpusConfig(fs.readFileSync(config, "utf8"));
};

const expandHome = (file) => (file === "~" || file.startsWith("~/") ? path.join(os.homedir(), file.slice(1)) : file);

export const postsDir = (root, author, config) => path.resolve(authorDir(root, author), expandHome(config.posts));

export const loadPosts = (root, author, config = loadCorpusConfig(root, author)) => {
  const dir = postsDir(root, author, config);
  if (!fs.existsSync(dir)) {
    throw new Error(`${path.relative(process.cwd(), dir)} がない。筆者の記事を先に取得する。`);
  }
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => parsePost(name.slice(0, -3), fs.readFileSync(path.join(dir, name), "utf8")));
};

export const writeSplit = ({ root, author }) => {
  const config = loadCorpusConfig(root, author);
  const target = corpusPaths(root, author).split;
  if (fs.existsSync(target)) {
    throw new Error(`${path.relative(process.cwd(), target)} はもうある。分け直すなら消してから実行する。`);
  }
  const split = splitByDate(selectPosts(loadPosts(root, author, config), config), config.testRatio, config.devRatio);
  fs.writeFileSync(target, YAML.stringify(split));
  return split;
};

export const loadCorpus = (root, author) => {
  const config = loadCorpusConfig(root, author);
  const splitPath = corpusPaths(root, author).split;
  if (!fs.existsSync(splitPath)) {
    throw new Error(`${path.relative(process.cwd(), splitPath)} がない。先に onajimi split --author ${author} を実行する。`);
  }
  const split = YAML.parse(fs.readFileSync(splitPath, "utf8")) ?? {};
  const posts = loadPosts(root, author, config);
  const bySlug = new Map(posts.map((post) => [post.slug, post]));
  const pick = (slugs) =>
    slugs.map((slug) => {
      const post = bySlug.get(slug);
      if (!post) {
        throw new Error(`split.yml の記事 ${slug} がコーパスにない`);
      }
      return applyExclusions(post, config.excludeSections);
    });
  const missing = SETS.filter((set) => !Array.isArray(split[set] ?? null) && split[set] !== null);
  if (missing.length > 0) {
    throw new Error(`split.yml に ${missing.join(", ")} がない。onajimi split で作り直す`);
  }
  const listOf = (set) => split[set] ?? [];
  const selected = new Set(SETS.flatMap(listOf));
  const other = otherRegisterPosts(posts, config)
    .filter((post) => !selected.has(post.slug))
    .map((post) => applyExclusions(post, config.excludeSections));
  return { config, profile: pick(listOf("profile")), dev: pick(listOf("dev")), test: pick(listOf("test")), other };
};
