import fs from "node:fs";
import path from "node:path";
import { computeAbcReport, renderAbcReport } from "./abc-report.js";
import { mean } from "./abc-metrics.js";
import { buildBrief, renderPrompt } from "./brief.js";
import { loadCorpus, pickPosts } from "./corpus.js";
import { controlFile, metaFileOf } from "./docs.js";
import { around } from "./eval.js";
import { EXIT, needsYesMessage, stopOf } from "./exit.js";
import { guard } from "./guard.js";
import { byPosition, createAuthorLinter, formatMessage } from "./lint.js";
import { authorDir } from "./paths.js";
import { proseParagraphs } from "./prose.js";
import { RateLimitError, UnavailableError, configuredRunner, generateWithRetry, minutes, readMeta, sha256, sleep, statusByPromptHash, writeOutput } from "./runner.js";
import { mapSeries } from "./util.js";

export const CONDITIONS = ["B", "C", "BC"];
export const REVISED = { C: "A", BC: "B" };
const EXAMPLE_COUNT = 3;
const EXAMPLE_MAX_CHARS = 3000;

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

const lintFindings = async (lintText, text) => {
  const lines = text.split("\n");
  const messages = [...(await lintText(text, "onajimi-draft.md"))].sort(byPosition);
  return messages.map((message) => `${formatMessage(message)} ｜ ${around((lines[message.line - 1] ?? "").trim(), message.column)}`);
};

const options = (corpus) => ({ skipParagraphs: corpus.config.skipParagraphs });

export const abcRunner = (corpus, name) => {
  const picked = name ?? Object.keys(corpus.config.control.runners)[0];
  return { name: picked, runner: configuredRunner(corpus, picked) };
};

const outputFiles = (dir, condition, slug) => ({ target: path.join(dir, condition, `${slug}.md`), metaFile: path.join(dir, condition, `${slug}.json`) });

const reviseItem = async ({ post, condition, draft, target, metaFile, lintText }) => {
  const findings = await lintFindings(lintText, draft);
  const item = { post, condition, draft, findings, target, metaFile };
  if (findings.length === 0) {
    const meta = readMeta(metaFile);
    return { ...item, prompt: null, status: fs.existsSync(target) && meta?.called === false && meta.draft_sha256 === sha256(draft) ? "cached" : "copy" };
  }
  const prompt = revisePrompt(draft, findings);
  return { ...item, prompt, status: statusByPromptHash(target, metaFile, prompt) };
};

const bcItem = (post, b, dir, lintText) =>
  b.status === "cached"
    ? reviseItem({ post, condition: "BC", draft: fs.readFileSync(b.target, "utf8"), ...outputFiles(dir, "BC", post.slug), lintText })
    : { post, condition: "BC", prompt: null, status: "pending", ...outputFiles(dir, "BC", post.slug) };

export const planAbc = async ({ root, author, corpus, runner: name, set = "test", only, exampleCategory, lintText }) => {
  const { name: runner } = abcRunner(corpus, name);
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
    const bPrompt = stylePrompt(basePrompt, examples);
    const bFiles = outputFiles(dir, "B", post.slug);
    const b = { post, condition: "B", prompt: bPrompt, ...bFiles, status: statusByPromptHash(bFiles.target, bFiles.metaFile, bPrompt) };
    items.push(b);
    items.push(await reviseItem({ post, condition: "C", draft: fs.readFileSync(controlFile(root, author, runner, post.slug), "utf8"), ...outputFiles(dir, "C", post.slug), lintText }));
    items.push(await bcItem(post, b, dir, lintText));
  }
  return { runner, dir, examples, items };
};

const resolvePending = async (plan, lintText) => {
  const bBySlug = new Map(plan.items.filter((item) => item.condition === "B").map((item) => [item.post.slug, item]));
  const items = await mapSeries(
    plan.items.filter((item) => item.status === "pending"),
    (item) => {
      const b = bBySlug.get(item.post.slug);
      return bcItem(item.post, { ...b, status: statusByPromptHash(b.target, b.metaFile, b.prompt) }, plan.dir, lintText);
    },
  );
  return { ...plan, items };
};

const callMetas = (items) => items.filter((item) => item.status === "cached").map((item) => readMeta(item.metaFile)).filter((meta) => meta && meta.called !== false);

const estimateAbc = ({ root, author, plan, delaySeconds }) => {
  const aMetas = [...new Set(plan.items.map((item) => item.post.slug))].map((slug) => readMeta(metaFileOf(controlFile(root, author, plan.runner, slug)))).filter(Boolean);
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

const renderAbcEstimate = (e) => {
  const copy = REVISED[e.condition] ? `、指摘なしで ${REVISED[e.condition]} のまま ${e.copy} 本` : "";
  const pending = e.pending > 0 ? `、B を作ってから決める ${e.pending} 本（最大 ${e.pending} 本の呼び出し）` : "";
  const time = e.calls === 0 ? "" : e.seconds === null ? "、時間は不明" : `、約 ${minutes(e.seconds)}`;
  const cost = e.calls === 0 ? "" : e.costUsd === null ? "、費用は不明" : `、約 $${e.costUsd.toFixed(2)}`;
  const basis = e.calls === 0 ? "" : `（${e.basis}）`;
  return `${e.condition}: 呼び出し ${e.calls} 本（新規 ${e.fresh}・作り直し ${e.stale}）${copy}、既存 ${e.cached} 本${pending}${time}${cost}${basis}`;
};

const revisedMeta = (item, revised) => {
  const problems = guard(item.draft, revised);
  return { findings: item.findings.length, draft_sha256: sha256(item.draft), guard: { pass: problems.length === 0, problems } };
};

const runAbc = async ({ corpus, plan, limit, delaySeconds, log = () => {} }) => {
  const { runner } = abcRunner(corpus, plan.runner);
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
    say(needsYesMessage());
    return EXIT.NEEDS_YES;
  }
  const summary = await runAbc({ corpus, plan, limit, delaySeconds: delay, log });
  if (summary.pending.length > 0 && !summary.rateLimited && !summary.unavailable) {
    const used = summary.called.length + summary.failed.length;
    const rest = await runAbc({ corpus, plan: await resolvePending(plan, lintText), limit: limit === undefined ? undefined : Math.max(0, limit - used), delaySeconds: delay, log });
    for (const key of ["called", "copied", "skipped", "failed", "guardFailed"]) {
      summary[key].push(...rest[key]);
    }
    Object.assign(summary, { pending: rest.pending, rateLimited: rest.rateLimited, unavailable: rest.unavailable });
  }
  const pending = summary.pending.length > 0 ? `、B 待ち ${summary.pending.length}` : "";
  say(`呼び出し ${summary.called.length}、写し ${summary.copied.length}、既存 ${summary.skipped.length}${pending}、失敗 ${summary.failed.length}、guard 失敗 ${summary.guardFailed.length}`);
  for (const call of summary.called) {
    say(`${call.label}: ${(call.durationMs / 1000).toFixed(1)} 秒${typeof call.costUsd === "number" ? `、$${call.costUsd.toFixed(3)}` : ""}`);
  }
  const stop = stopOf(summary, "label");
  if (stop) {
    say(stop.message);
    return stop.code;
  }
  return summary.failed.length > 0 ? EXIT.FAILED : 0;
};
