import fs from "node:fs";
import path from "node:path";
import { buildBrief, renderPrompt } from "./brief.js";
import { parseProfile } from "./build.js";
import { loadCorpus } from "./corpus.js";
import { RateLimitError, UnavailableError, controlFile, generateWithRetry, minutes, pickPosts, readMeta, sha256, sleep } from "./control.js";
import { centroid, delta, dictionaryTokens, fitScaler, mostFrequent, tokenCounts, zVector } from "./delta.js";
import { around, documentKeyOf, scoreDocs } from "./eval.js";
import { guard } from "./guard.js";
import { createAuthorLinter, formatMessages } from "./lint.js";
import { authorDir } from "./paths.js";
import { docRates, featuresOfMarkdown } from "./profile.js";
import { NEEDS_YES } from "./pipeline.js";
import { analyzeProse, proseParagraphs, stripTitle } from "./prose.js";

export const CONDITIONS = ["B", "C", "BC"];
const REVISED = { C: "A", BC: "B" };
export const EXAMPLE_COUNT = 3;
export const EXAMPLE_MAX_CHARS = 3000;
export const DELTA_SIZES = [50, 150, 300];
export const MAIN_SIZE = 150;
const BOOTSTRAP_SAMPLES = 10000;

export const abcDir = (root, author) => path.join(authorDir(root, author), "experiments", "abc");

const byNewest = (a, b) => (b.meta.date ?? "").localeCompare(a.meta.date ?? "") || a.slug.localeCompare(b.slug);

export const pickExamples = (posts, category) =>
  [...posts].filter((post) => category === undefined || post.meta.category === category).sort(byNewest).slice(0, EXAMPLE_COUNT);

export const excerpt = (paragraphs, maxChars = EXAMPLE_MAX_CHARS) => {
  const kept = [];
  let chars = 0;
  for (const paragraph of paragraphs) {
    const length = [...paragraph].length;
    if (kept.length === 0 && length > maxChars) {
      kept.push([...paragraph].slice(0, maxChars).join(""));
      break;
    }
    if (chars + length > maxChars) {
      break;
    }
    kept.push(paragraph);
    chars += length;
  }
  return kept.join("\n\n");
};

export const stylePrompt = (basePrompt, examples) =>
  [
    basePrompt,
    "",
    "この筆者の文体で書いてください。言葉の選び方・表記・文の長さ・語り口を、次の例（同じ筆者の別の記事の本文の抜粋）に寄せます。例の話題や内容は使わないでください。",
    "",
    ...examples.flatMap((example, index) => [`--- 例 ${index + 1}: ${example.title} ---`, example.text, ""]),
    "--- 例ここまで ---",
  ].join("\n");

export const revisePrompt = (draft, findings) =>
  [
    "次の Markdown の下書きに、筆者の書き癖から外れた箇所の指摘が付いています。指摘に沿って下書きを直してください。",
    "",
    "- 指摘された箇所だけを直す。直すかどうかは文脈で決める。指摘のない文は変えない。",
    "- 「K 回減らす」「K 個減らす」のように数を減らす指摘は、指摘された箇所のうち文脈で選んだ K 箇所だけを直し、ほかの箇所と指摘のない文はそのままにする。",
    "- 直すのは 1 回だけにする。直したあとで見直して、別の箇所を直さない。",
    "- 直した稿の全文だけを Markdown で出力する。説明や、直さなかった理由は書かない。",
    "",
    "指摘（行:列 ルール メッセージ ｜ その行）:",
    ...findings,
    "",
    "--- 下書きここから ---",
    draft.replace(/\n$/u, ""),
    "--- 下書きここまで ---",
  ].join("\n");

export const lintFindings = async (lintText, text) => {
  const lines = text.split("\n");
  const messages = [...(await lintText(text, "onajimi-draft.md"))].sort((a, b) => a.line - b.line || a.column - b.column);
  return messages.map((message) => `${formatMessages([message])[0]} ｜ ${around((lines[message.line - 1] ?? "").trim(), message.column)}`);
};

const options = (corpus) => ({ skipParagraphs: corpus.config.skipParagraphs });

const runnerOf = (corpus, name) => {
  const runners = corpus.config.control.runners;
  const picked = name ?? Object.keys(runners)[0];
  if (!runners[picked]) {
    throw new Error(`corpus.yml の control.runners に ${picked ?? "runner"} がない`);
  }
  return { name: picked, runner: runners[picked] };
};

const statusOf = (target, metaFile, prompt) =>
  !fs.existsSync(target) ? "new" : readMeta(metaFile)?.prompt_sha256 === sha256(prompt) ? "cached" : "stale";

const reviseItem = async ({ post, condition, draft, target, metaFile, lintText }) => {
  const findings = await lintFindings(lintText, draft);
  const item = { post, condition, draft, findings, target, metaFile };
  if (findings.length === 0) {
    const meta = readMeta(metaFile);
    return { ...item, prompt: null, status: fs.existsSync(target) && meta?.called === false && meta.draft_sha256 === sha256(draft) ? "cached" : "copy" };
  }
  const prompt = revisePrompt(draft, findings);
  return { ...item, prompt, status: statusOf(target, metaFile, prompt) };
};

export const planAbc = async ({ root, author, corpus, runner: name, set = "test", only, exampleCategory, lintText }) => {
  const { name: runner } = runnerOf(corpus, name);
  const posts = pickPosts(corpus, set, only);
  const missing = posts.filter((post) => !fs.existsSync(controlFile(root, author, runner, post.slug))).map((post) => post.slug);
  if (missing.length > 0) {
    throw new Error(`A（${runner} の対照）がない: ${missing.join(", ")}。先に onajimi control --runner ${runner} --set ${set} を実行する。`);
  }
  const picked = pickExamples(corpus.profile, exampleCategory);
  if (picked.length === 0) {
    throw new Error(`例にできるプロファイル用の記事がない（category: ${exampleCategory}）。`);
  }
  const examples = picked.map((post) => ({
    slug: post.slug,
    title: post.meta.title ?? post.slug,
    text: excerpt(proseParagraphs(post.text, options(corpus))),
  }));
  const dir = abcDir(root, author);
  const items = [];
  for (const post of posts) {
    const basePrompt = renderPrompt(corpus.config.control.prompt, buildBrief(post, options(corpus)));
    const file = (condition, ext) => path.join(dir, condition, `${post.slug}.${ext}`);
    const bPrompt = stylePrompt(basePrompt, examples);
    const b = { post, condition: "B", prompt: bPrompt, target: file("B", "md"), metaFile: file("B", "json"), status: statusOf(file("B", "md"), file("B", "json"), bPrompt) };
    items.push(b);
    const revise = async (condition, draft) => reviseItem({ post, condition, draft, target: file(condition, "md"), metaFile: file(condition, "json"), lintText });
    items.push(await revise("C", fs.readFileSync(controlFile(root, author, runner, post.slug), "utf8")));
    items.push(b.status === "cached" ? await revise("BC", fs.readFileSync(b.target, "utf8")) : { post, condition: "BC", prompt: null, status: "pending", target: file("BC", "md"), metaFile: file("BC", "json") });
  }
  return { runner, examples, items };
};

const mean = (values) => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length);

const callMetas = (items) => items.filter((item) => item.status === "cached").map((item) => readMeta(item.metaFile)).filter((meta) => meta && meta.called !== false);

export const estimateAbc = ({ root, author, plan, delaySeconds }) => {
  const aMetas = [...new Set(plan.items.map((item) => item.post.slug))].map((slug) => readMeta(controlFile(root, author, plan.runner, slug).replace(/\.md$/u, ".json"))).filter(Boolean);
  return CONDITIONS.map((condition) => {
    const items = plan.items.filter((item) => item.condition === condition);
    const todo = items.filter((item) => item.status === "new" || item.status === "stale");
    const own = callMetas(items);
    const revised = condition === "BC" ? callMetas(plan.items.filter((item) => item.condition === "C")) : [];
    const source =
      own.length > 0
        ? { metas: own, label: `${condition} の過去 ${own.length} 本の平均から` }
        : revised.length > 0
          ? { metas: revised, label: `C の ${revised.length} 本の平均から` }
          : { metas: aMetas, label: `A の ${aMetas.length} 本の平均から` };
    const seconds = mean(source.metas.map((meta) => meta.duration_ms).filter((ms) => typeof ms === "number"));
    const cost = mean(source.metas.map((meta) => meta.total_cost_usd).filter((usd) => typeof usd === "number"));
    return {
      condition,
      calls: todo.length,
      fresh: todo.filter((item) => item.status === "new").length,
      stale: todo.filter((item) => item.status === "stale").length,
      copy: items.filter((item) => item.status === "copy").length,
      pending: items.filter((item) => item.status === "pending").length,
      cached: items.filter((item) => item.status === "cached").length,
      seconds: seconds === null ? null : (todo.length * seconds) / 1000 + Math.max(0, todo.length - 1) * delaySeconds,
      costUsd: cost === null ? null : todo.length * cost,
      basis: source.label,
    };
  });
};

export const renderAbcEstimate = (e) => {
  const copy = REVISED[e.condition] ? `、指摘なしで ${REVISED[e.condition]} のまま ${e.copy} 本` : "";
  const pending = e.pending > 0 ? `、B を作ってから決める ${e.pending} 本（最大 ${e.pending} 本の呼び出し）` : "";
  const time = e.calls === 0 ? "" : e.seconds === null ? "、時間は不明" : `、約 ${minutes(e.seconds)}`;
  const cost = e.calls === 0 ? "" : e.costUsd === null ? "、費用は不明" : `、約 $${e.costUsd.toFixed(2)}`;
  const basis = e.calls === 0 ? "" : `（${e.basis}）`;
  return `${e.condition}: 呼び出し ${e.calls} 本（新規 ${e.fresh}・作り直し ${e.stale}）${copy}、既存 ${e.cached} 本${pending}${time}${cost}${basis}`;
};

const writeOutput = (item, text, meta) => {
  fs.mkdirSync(path.dirname(item.target), { recursive: true });
  fs.writeFileSync(`${item.target}.tmp`, text);
  fs.renameSync(`${item.target}.tmp`, item.target);
  fs.writeFileSync(item.metaFile, `${JSON.stringify(meta, null, 2)}\n`);
};

const revisedMeta = (item, revised) => {
  const problems = guard(item.draft, revised);
  return { findings: item.findings.length, draft_sha256: sha256(item.draft), guard: { pass: problems.length === 0, problems } };
};

export const runAbc = async ({ corpus, plan, limit, delaySeconds, log = () => {} }) => {
  const { runner } = runnerOf(corpus, plan.runner);
  const { timeoutSeconds, retryDelaysSeconds } = corpus.config.control;
  const summary = { called: [], copied: [], skipped: [], pending: [], failed: [], guardFailed: [], rateLimited: null, unavailable: null };
  let first = true;
  for (const item of plan.items) {
    const label = `${item.condition} ${item.post.slug}`;
    if (item.status === "cached") {
      summary.skipped.push(label);
      continue;
    }
    if (item.status === "pending") {
      summary.pending.push(label);
      continue;
    }
    if (item.status === "copy") {
      writeOutput(item, item.draft, { condition: item.condition, runner: plan.runner, called: false, findings: 0, draft_sha256: sha256(item.draft), date: new Date().toISOString() });
      summary.copied.push(label);
      continue;
    }
    if (limit !== undefined && summary.called.length + summary.failed.length >= limit) {
      break;
    }
    if (!first && delaySeconds > 0) {
      await sleep(delaySeconds * 1000);
    }
    first = false;
    log(`${label} を生成中`);
    try {
      const output = await generateWithRetry(runner, item.prompt, { timeoutSeconds, retryDelaysSeconds, log });
      const meta = {
        condition: item.condition,
        runner: plan.runner,
        model: runner.model ?? null,
        called: true,
        prompt_sha256: sha256(item.prompt),
        date: new Date().toISOString(),
        duration_ms: output.durationMs,
        attempts: output.attempts,
        unwrapped: output.unwrapped,
        ...(item.condition === "B" ? { examples: plan.examples.map((example) => example.slug) } : {}),
        ...(REVISED[item.condition] ? revisedMeta(item, output.text) : {}),
        ...output.extra,
      };
      writeOutput(item, output.text, meta);
      summary.called.push({ label, durationMs: output.durationMs, costUsd: output.extra.total_cost_usd });
      if (meta.guard?.pass === false) {
        summary.guardFailed.push(label);
      }
      log(`${label} ${(output.durationMs / 1000).toFixed(1)} 秒${meta.guard ? `、guard ${meta.guard.pass ? "通過" : "失敗"}` : ""}`);
    } catch (error) {
      if (error instanceof RateLimitError) {
        summary.rateLimited = { label, error: error.message };
        break;
      }
      if (error instanceof UnavailableError) {
        summary.unavailable = { label, error: error.message };
        break;
      }
      summary.failed.push({ label, error: error.message });
      log(`${label} 失敗: ${error.message}`);
    }
  }
  return summary;
};

export const editRatio = (before, after) => {
  const a = [...before];
  const b = [...after];
  if (a.length + b.length === 0) {
    return 0;
  }
  let previous = new Int32Array(b.length + 1);
  let current = new Int32Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = a[i - 1] === b[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
    }
    [previous, current] = [current, previous];
  }
  return 1 - (2 * previous[b.length]) / (a.length + b.length);
};

const choose = (n, k) => {
  let value = 1;
  for (let i = 1; i <= k; i += 1) {
    value = (value * (n - k + i)) / i;
  }
  return value;
};

export const signTest = (wins, losses) => {
  const n = wins + losses;
  if (n === 0) {
    return 1;
  }
  let tail = 0;
  for (let k = 0; k <= Math.min(wins, losses); k += 1) {
    tail += choose(n, k);
  }
  return Math.min(1, (2 * tail) / 2 ** n);
};

const mulberry32 = (seed) => () => {
  let t = (seed += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export const bootstrapMeanCi = (values, { samples = BOOTSTRAP_SAMPLES, seed = 1 } = {}) => {
  const random = mulberry32(seed);
  const means = [];
  for (let s = 0; s < samples; s += 1) {
    let sum = 0;
    for (let i = 0; i < values.length; i += 1) {
      sum += values[Math.floor(random() * values.length)];
    }
    means.push(sum / values.length);
  }
  means.sort((x, y) => x - y);
  return [means[Math.floor(samples * 0.025)], means[Math.ceil(samples * 0.975) - 1]];
};

export const median = (values) => {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export const comparePaired = (xs, ys) => {
  const diffs = xs.map((x, i) => x - ys[i]);
  const wins = diffs.filter((d) => d < 0).length;
  const losses = diffs.filter((d) => d > 0).length;
  return { wins, losses, ties: diffs.length - wins - losses, meanDiff: mean(diffs), ci: bootstrapMeanCi(diffs), p: signTest(wins, losses) };
};

const REPORT_CONDITIONS = ["A", "B", "C", "C戻し", "BC", "BC戻し"];
const COMPARISONS = [["B", "A"], ["C", "A"], ["C", "B"], ["C戻し", "A"], ["BC", "B"], ["BC", "A"], ["BC戻し", "B"]];
const CARICATURE_CONDITIONS = ["筆者", "A", "B", "BC"];

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const formRegExp = (pattern) => {
  const literal = /^\/(.+)\/([gimsuy]*)$/su.exec(pattern);
  return literal ? new RegExp(literal[1], [...new Set([...literal[2], "g", "u"])].join("")) : new RegExp(escapeRegExp(pattern), "gu");
};

const lookahead = (pattern) => /\(\?=[^)]*\)\/[a-z]*$/u.exec(pattern)?.[0].replace(/\/[a-z]*$/u, "") ?? "";

export const orthographyCounts = (entry, strs) => {
  const patterns = entry.patterns ?? [entry.pattern];
  const author = new RegExp(`${escapeRegExp(entry.expected)}${lookahead(patterns[0])}`, "gu");
  const count = (regExp) => strs.reduce((sum, text) => sum + [...text.matchAll(regExp)].length, 0);
  return { author: count(author), model: patterns.reduce((sum, pattern) => sum + count(formRegExp(pattern)), 0) };
};

const caricatureOf = async (profile, docsByCondition, opts) => {
  const features = {};
  for (const [condition, docs] of Object.entries(docsByCondition)) {
    features[condition] = [];
    for (const doc of docs) {
      features[condition].push(await featuresOfMarkdown(doc, opts));
    }
  }
  const orthography = profile.orthography.map((entry) => ({
    label: `${entry.expected} / ${entry.patterns ?? entry.pattern}`,
    values: Object.fromEntries(
      Object.entries(features).map(([condition, docs]) => {
        const counts = docs.map((doc) => orthographyCounts(entry, doc.strTokens.map((str) => str.text)));
        const author = counts.reduce((sum, c) => sum + c.author, 0);
        const total = author + counts.reduce((sum, c) => sum + c.model, 0);
        return [condition, { author, total, share: total === 0 ? null : author / total }];
      }),
    ),
  }));
  const density = profile.density.map((entry) => ({
    label: entry.tokens.map((token) => token.basic_form ?? token.surface_form).join("+"),
    max: entry.max_per_1000,
    values: Object.fromEntries(
      Object.entries(features).map(([condition, docs]) => {
        const rates = docRates(docs, entry.tokens, 0);
        return [condition, { mean: mean(rates), over: rates.filter((rate) => rate > entry.max_per_1000).length }];
      }),
    ),
  }));
  return { orthography, density };
};

const readControlDocs = (root, author, runner, posts) =>
  posts
    .map((post) => ({ post, file: controlFile(root, author, runner, post.slug) }))
    .filter(({ file }) => fs.existsSync(file))
    .map(({ post, file }) => stripTitle(fs.readFileSync(file, "utf8"), post.meta));

const countAll = async (texts, opts) => {
  const docs = [];
  for (const text of texts) {
    docs.push(await tokenCounts(text, opts));
  }
  return docs;
};

export const computeAbcReport = async ({ root, author, preset, corpus = loadCorpus(root, author), runner: name, set = "test" }) => {
  const { name: runner } = runnerOf(corpus, name);
  const dir = abcDir(root, author);
  const opts = options(corpus);
  const posts = corpus[set].filter((post) => CONDITIONS.every((condition) => fs.existsSync(path.join(dir, condition, `${post.slug}.md`))) && fs.existsSync(controlFile(root, author, runner, post.slug)));
  if (posts.length === 0) {
    throw new Error(`${set} に B・C・BC がそろった記事がない。先に onajimi abc --yes を実行する。`);
  }
  const rows = posts.map((post) => {
    const aFile = controlFile(root, author, runner, post.slug);
    const raw = { A: fs.readFileSync(aFile, "utf8") };
    const meta = { A: readMeta(aFile.replace(/\.md$/u, ".json")) ?? {} };
    for (const condition of CONDITIONS) {
      raw[condition] = fs.readFileSync(path.join(dir, condition, `${post.slug}.md`), "utf8");
      meta[condition] = readMeta(path.join(dir, condition, `${post.slug}.json`)) ?? {};
    }
    const revision = Object.fromEntries(
      Object.entries(REVISED).map(([condition, before]) => {
        const m = meta[condition];
        const called = m.called !== false;
        return [condition, { called, findings: m.findings ?? 0, guardPass: !called || m.guard?.pass === true, problems: m.guard?.problems ?? [], editRatio: editRatio(raw[before], raw[condition]) }];
      }),
    );
    raw["C戻し"] = revision.C.guardPass ? raw.C : raw.A;
    raw["BC戻し"] = revision.BC.guardPass ? raw.BC : raw.B;
    const docs = Object.fromEntries(REPORT_CONDITIONS.map((condition) => [condition, stripTitle(raw[condition], post.meta)]));
    const target = buildBrief(post, opts).chars;
    return {
      slug: post.slug,
      author: stripTitle(post.text, post.meta),
      docs,
      meta,
      revision,
      lengthRatio: Object.fromEntries(REPORT_CONDITIONS.map((condition) => [condition, analyzeProse(docs[condition], opts).chars / target])),
    };
  });

  const runners = Object.keys(corpus.config.control.runners);
  const authorProfile = await countAll(corpus.profile.map((post) => stripTitle(post.text, post.meta)), opts);
  const controlProfile = await countAll(runners.flatMap((r) => readControlDocs(root, author, r, corpus.profile)), opts);
  const reference = [...authorProfile, ...controlProfile];
  const authorTest = await countAll(rows.map((row) => row.author), opts);
  const outputs = Object.fromEntries(await Promise.all(REPORT_CONDITIONS.map(async (condition) => [condition, await countAll(rows.map((row) => row.docs[condition]), opts)])));
  const profile = parseProfile(fs.readFileSync(path.join(authorDir(root, author), "profile.yml"), "utf8"));
  const isDictionary = dictionaryTokens(profile);
  const variants = [
    { label: "全トークン", exclude: () => false },
    { label: "辞書の語を除く", exclude: isDictionary },
  ];
  const deltas = [];
  for (const size of DELTA_SIZES) {
    for (const variant of variants) {
      const features = fitScaler(reference, mostFrequent(reference, size, variant.exclude));
      const center = centroid(authorProfile.map((doc) => zVector(features, doc)));
      const own = authorTest.map((doc) => zVector(features, doc));
      const pair = {};
      const toCenter = { 筆者: own.map((z) => delta(z, center)) };
      for (const condition of REPORT_CONDITIONS) {
        const zs = outputs[condition].map((doc) => zVector(features, doc));
        pair[condition] = zs.map((z, i) => delta(z, own[i]));
        toCenter[condition] = zs.map((z) => delta(z, center));
      }
      deltas.push({
        size,
        variant: variant.label,
        features: features.length,
        pair,
        toCenter,
        comparisons: COMPARISONS.map(([x, y]) => ({ x, y, ...comparePaired(pair[x], pair[y]) })),
        centerComparisons: COMPARISONS.map(([x, y]) => ({ x, y, ...comparePaired(toCenter[x], toCenter[y]) })),
      });
    }
  }

  const { lintText, rules } = await createAuthorLinter(root, author, preset);
  const documentKey = documentKeyOf(rules, preset);
  const findings = {};
  for (const condition of REPORT_CONDITIONS) {
    findings[condition] = await scoreDocs(lintText, rows.map((row) => ({ slug: row.slug, text: row.docs[condition] })), opts, documentKey);
  }

  const cost = Object.fromEntries(
    ["A", ...CONDITIONS].map((condition) => {
      const metas = rows.map((row) => row.meta[condition]).filter((meta) => meta.called !== false);
      const usd = metas.map((meta) => meta.total_cost_usd).filter((value) => typeof value === "number");
      const ms = metas.map((meta) => meta.duration_ms).filter((value) => typeof value === "number");
      return [condition, { calls: metas.length, totalUsd: usd.reduce((s, v) => s + v, 0), meanUsd: mean(usd), meanSeconds: ms.length === 0 ? null : mean(ms) / 1000, totalSeconds: ms.reduce((s, v) => s + v, 0) / 1000 }];
    }),
  );
  const caricature = await caricatureOf(profile, Object.fromEntries(CARICATURE_CONDITIONS.map((condition) => [condition, rows.map((row) => (condition === "筆者" ? row.author : row.docs[condition]))])), opts);
  return { set, runner, rows, deltas, findings, cost, caricature, referenceDocs: { author: authorProfile.length, controls: controlProfile.length } };
};

const f3 = (value) => (value === null || value === undefined || Number.isNaN(value) ? "-" : value.toFixed(3));
const f2 = (value) => (value === null || value === undefined || Number.isNaN(value) ? "-" : value.toFixed(2));

const deltaTable = (entry, key) => {
  const header = `| 条件 | 平均 | 中央値 |`;
  const lines = Object.entries(entry[key]).map(([condition, values]) => `| ${condition} | ${f3(mean(values))} | ${f3(median(values))} |`);
  return [header, "|---|---|---|", ...lines];
};

const comparisonTable = (comparisons) => [
  "| 比較 | 勝ち | 負け | 引き分け | 差の平均 | 95% CI（bootstrap） | 符号検定 p |",
  "|---|---|---|---|---|---|---|",
  ...comparisons.map((c) => `| ${c.x} vs ${c.y} | ${c.wins} | ${c.losses} | ${c.ties} | ${f3(c.meanDiff)} | [${f3(c.ci[0])}, ${f3(c.ci[1])}] | ${f3(c.p)} |`),
];

const pct = (value) => (value === null ? "-" : `${Math.round(value * 100)}%`);

const caricatureTable = ({ orthography, density }) => [
  `| 項目 | 目安 | ${CARICATURE_CONDITIONS.join(" | ")} |`,
  `|---|---|${CARICATURE_CONDITIONS.map(() => "---").join("|")}|`,
  ...orthography.map((row) => `| 表記 ${row.label} | - | ${CARICATURE_CONDITIONS.map((condition) => {
    const v = row.values[condition];
    return `${pct(v.share)}（${v.author}/${v.total}）`;
  }).join(" | ")} |`),
  ...density.map((row) => `| 密度 ${row.label} | ${row.max} | ${CARICATURE_CONDITIONS.map((condition) => {
    const v = row.values[condition];
    return `${f2(v.mean)}（超え ${v.over}）`;
  }).join(" | ")} |`),
];

const revisionLines = (rows, condition) => {
  const before = REVISED[condition];
  const called = rows.filter((row) => row.revision[condition].called);
  return [
    `- ${condition} で呼び出した ${called.length} 本のうち guard 通過 ${called.filter((row) => row.revision[condition].guardPass).length} 本。指摘なしで ${before} のままの記事 ${rows.length - called.length} 本`,
    `- ${condition} と ${before} の文字単位の編集率（1 − 2·LCS/(|${before}|+|${condition}|)）: 平均 ${f3(mean(rows.map((row) => row.revision[condition].editRatio)))}、中央値 ${f3(median(rows.map((row) => row.revision[condition].editRatio)))}`,
  ];
};

const revisionCells = (revision) => [revision.findings, revision.called ? (revision.guardPass ? "通過" : "失敗") : "しない", f3(revision.editRatio)];

export const renderAbcReport = (report) => {
  const { rows, deltas, findings, cost, caricature } = report;
  const main = deltas.filter((entry) => entry.size === MAIN_SIZE);
  const winPairs = [["B", "A"], ["C", "A"], ["C", "B"], ["BC", "A"], ["BC", "B"]];
  const out = [
    `# A/B/C（${report.set} ${rows.length} 本、runner ${report.runner}）`,
    "",
    "A は対照の素の出力、B は文体の指示と筆者の例 3 本を足した出力、C は A に lint の指摘を 1 回だけ直させた出力、BC は B に C と同じ手順で lint の指摘を 1 回だけ直させた出力。C戻し・BC戻し は guard に落ちた C・BC を A・B に戻したもの（スキルの手順どおりの最悪の場合）。",
    `Delta の語彙と z の平均・標準偏差は、筆者のプロファイル用 ${report.referenceDocs.author} 本と、その対照 ${report.referenceDocs.controls} 本から決めた（test は使っていない）。勝ちは Delta が小さいほう。差は前者 − 後者で、負なら前者が筆者に近い。`,
    report.set === "test" ? "注: 辞書づくりのあいだに test を見たことがあるなら、C と BC に有利な向きの偏りがある。" : "",
    "",
    `## 1. Burrows の Delta（同じ slug の筆者の記事との距離、N=${MAIN_SIZE}）`,
  ];
  for (const entry of main) {
    out.push("", `### ${entry.variant}（特徴 ${entry.features} 語）`, "", ...deltaTable(entry, "pair"), "", ...comparisonTable(entry.comparisons));
  }
  out.push("", `## 2. プロファイル用の筆者の重心との Delta（N=${MAIN_SIZE}）`);
  for (const entry of main) {
    out.push("", `### ${entry.variant}`, "", ...deltaTable(entry, "toCenter"), "", ...comparisonTable(entry.centerComparisons));
  }
  out.push(
    "",
    "## 3. N を変えたとき（同じ slug との Delta の平均）",
    "",
    `| N | 語彙 | 特徴 | ${REPORT_CONDITIONS.join(" | ")} | ${winPairs.map(([x, y]) => `${x} 勝ち/${y}`).join(" | ")} |`,
    `|---|---|---|${[...REPORT_CONDITIONS, ...winPairs].map(() => "---").join("|")}|`,
  );
  for (const entry of deltas) {
    const wins = (x, y) => {
      const c = entry.comparisons.find((item) => item.x === x && item.y === y);
      return `${c.wins}/${c.wins + c.losses + c.ties}`;
    };
    out.push(`| ${entry.size} | ${entry.variant} | ${entry.features} | ${REPORT_CONDITIONS.map((condition) => f3(mean(entry.pair[condition]))).join(" | ")} | ${winPairs.map(([x, y]) => wins(x, y)).join(" | ")} |`);
  }
  out.push(
    "",
    "## 4. lint の指摘（C と BC には循環。指摘を減らすように作っている）",
    "",
    "| 条件 | 記事 | 字数 | 指摘 | 文書単位 | 1000字あたり |",
    "|---|---|---|---|---|---|",
    ...REPORT_CONDITIONS.map((condition) => {
      const row = findings[condition];
      return `| ${condition} | ${row.docs} | ${row.chars} | ${row.findings} | ${row.documentLevel} | ${f2(row.per1000)} |`;
    }),
    "",
    "## 5. 壊していないか",
    "",
    ...revisionLines(rows, "C"),
    ...revisionLines(rows, "BC"),
    `- 指示した字数に対する地の文の字数の比: ${REPORT_CONDITIONS.map((condition) => `${condition} ${f2(mean(rows.map((row) => row.lengthRatio[condition])))}`).join("、")}`,
    "",
    "## 6. 費用と時間",
    "",
    "| 条件 | 呼び出し | 合計 USD | 1 本あたり USD | 合計時間 | 1 本あたり秒 |",
    "|---|---|---|---|---|---|",
    ...["A", ...CONDITIONS].map((condition) => {
      const c = cost[condition];
      return `| ${condition} | ${c.calls} | ${f2(c.totalUsd)} | ${f3(c.meanUsd)} | ${minutes(c.totalSeconds)} | ${c.meanSeconds === null ? "-" : c.meanSeconds.toFixed(0)} |`;
    }),
    "",
    "## 7. 記事ごと",
    "",
    `| slug | A の指摘 | C guard | 編集率 C/A | B の指摘 | BC guard | 編集率 BC/B | ${REPORT_CONDITIONS.map((condition) => `Delta ${condition}`).join(" | ")} | 字数比 A | 字数比 B | 字数比 BC |`,
    `|---|${[...Array(9 + REPORT_CONDITIONS.length)].map(() => "---").join("|")}|`,
    ...rows.map((row, i) => {
      const pair = main[0].pair;
      return `| ${row.slug} | ${[...revisionCells(row.revision.C), ...revisionCells(row.revision.BC)].join(" | ")} | ${REPORT_CONDITIONS.map((condition) => f3(pair[condition][i])).join(" | ")} | ${f2(row.lengthRatio.A)} | ${f2(row.lengthRatio.B)} | ${f2(row.lengthRatio.BC)} |`;
    }),
    "",
    "## 8. 筆者の癖を誇張していないか（辞書の語の出方）",
    "",
    `表記は筆者側の形の割合（筆者側/両方の回数）、密度は記事ごとの 1000 字あたりの平均（目安を超えた記事の数）。筆者は同じ slug の test の記事 ${rows.length} 本。`,
    "",
    ...caricatureTable(caricature),
  );
  const failed = rows.flatMap((row) => Object.keys(REVISED).flatMap((condition) => row.revision[condition].problems.map((problem) => `- ${condition} ${row.slug}: ${problem}`)));
  if (failed.length > 0) {
    out.push("", "guard の指摘:", ...failed);
  }
  return `${out.filter((line, i, all) => !(line === "" && all[i - 1] === "")).join("\n")}\n`;
};

export const abcCommand = async ({ root, author, preset, runner, set = "test", only, exampleCategory, limit, delaySeconds, estimate = false, yes = false, dryRun = false, report = false, say = () => {}, log = () => {} }) => {
  const corpus = loadCorpus(root, author);
  if (report) {
    const result = await computeAbcReport({ root, author, preset, corpus, runner, set });
    const text = renderAbcReport(result);
    const file = path.join(abcDir(root, author), "report.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    say(text);
    say(`${file} に書いた。`);
    return 0;
  }
  const { lintText } = await createAuthorLinter(root, author, preset);
  const plan = await planAbc({ root, author, corpus, runner, set, only, exampleCategory, lintText });
  const delay = delaySeconds ?? corpus.config.control.delaySeconds;
  if (dryRun) {
    for (const item of plan.items.filter((entry) => entry.prompt !== null)) {
      log(`--- ${item.condition} ${item.post.slug}\n${item.prompt}`);
    }
    return 0;
  }
  const estimates = estimateAbc({ root, author, plan, delaySeconds: delay });
  const calls = estimates.reduce((sum, e) => sum + e.calls, 0);
  if (estimate || (calls > 0 && !yes)) {
    say(`runner ${plan.runner}、${set} ${new Set(plan.items.map((item) => item.post.slug)).size} 本、例: ${plan.examples.map((example) => example.slug).join(", ")}`);
    for (const e of estimates) {
      say(renderAbcEstimate(e));
    }
    if (estimate) {
      return 0;
    }
    say("生成するには、見積もりを人に見せて同意を得てから --yes を付けて同じコマンドを実行する。");
    return NEEDS_YES;
  }
  const summary = await runAbc({ corpus, plan, limit, delaySeconds: delay, log });
  if (summary.pending.length > 0 && !summary.rateLimited && !summary.unavailable) {
    const next = await planAbc({ root, author, corpus, runner, set, only, exampleCategory, lintText });
    const used = summary.called.length + summary.failed.length;
    const rest = await runAbc({ corpus, plan: { ...next, items: next.items.filter((item) => item.condition === "BC") }, limit: limit === undefined ? undefined : Math.max(0, limit - used), delaySeconds: delay, log });
    for (const key of ["called", "copied", "failed", "guardFailed"]) {
      summary[key].push(...rest[key]);
    }
    summary.skipped.push(...rest.skipped.filter((label) => summary.pending.includes(label)));
    Object.assign(summary, { pending: rest.pending, rateLimited: rest.rateLimited, unavailable: rest.unavailable });
  }
  const pending = summary.pending.length > 0 ? `、B 待ち ${summary.pending.length}` : "";
  say(`呼び出し ${summary.called.length}、写し ${summary.copied.length}、既存 ${summary.skipped.length}${pending}、失敗 ${summary.failed.length}、guard 失敗 ${summary.guardFailed.length}`);
  for (const call of summary.called) {
    say(`${call.label}: ${(call.durationMs / 1000).toFixed(1)} 秒${typeof call.costUsd === "number" ? `、$${call.costUsd.toFixed(3)}` : ""}`);
  }
  if (summary.rateLimited) {
    say(`${summary.rateLimited.label} で回数制限に当たって止めた。時間をおいて同じコマンドで再開する。`);
    return 3;
  }
  if (summary.unavailable) {
    say(`${summary.unavailable.label} で混雑が続いたので止めた。時間をおいて同じコマンドで再開する。`);
    return 4;
  }
  return summary.failed.length > 0 ? 1 : 0;
};
