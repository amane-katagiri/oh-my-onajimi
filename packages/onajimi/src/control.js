import { buildBrief, renderPrompt } from "./brief.js";
import { loadCorpus, pickPosts } from "./corpus.js";
import { controlFile, metaFileOf } from "./docs.js";
import { RateLimitError, UnavailableError, configuredRunner, generateWithRetry, minutes, readMeta, sha256, sleep, statusByPromptHash, writeOutput } from "./runner.js";

const planControl = ({ root, author, corpus, runner: name, set = "profile", only }) => {
  configuredRunner(corpus, name);
  return pickPosts(corpus, set, only).map((post) => {
    const brief = buildBrief(post, { skipParagraphs: corpus.config.skipParagraphs });
    const prompt = renderPrompt(corpus.config.control.prompt, brief);
    const target = controlFile(root, author, name, post.slug);
    const metaFile = metaFileOf(target);
    return { post, prompt, chars: brief.chars, target, metaFile, status: statusByPromptHash(target, metaFile, prompt) };
  });
};

const outputTokensOf = (meta) => {
  const usage = meta.usage ?? {};
  if (typeof usage.output_tokens === "number") {
    return usage.output_tokens;
  }
  if (typeof usage.candidatesTokenCount === "number") {
    return usage.candidatesTokenCount + (usage.thoughtsTokenCount ?? 0);
  }
  return null;
};

// 過去の出力がない runner の目安。日本語の本文は 1 字あたり 1〜2 トークンで、思考の分を足して多めに見る。
const DEFAULT_TOKENS_PER_CHAR = 2.5;

const history = (plan) => {
  const durations = [];
  let tokens = 0;
  let chars = 0;
  for (const item of plan.filter((entry) => entry.status !== "new")) {
    const meta = readMeta(item.metaFile);
    if (typeof meta?.duration_ms === "number") {
      durations.push(meta.duration_ms);
    }
    const used = meta ? outputTokensOf(meta) : null;
    if (used !== null) {
      tokens += used;
      chars += item.chars;
    }
  }
  return {
    secondsPerOutput: durations.length === 0 ? null : durations.reduce((sum, ms) => sum + ms, 0) / durations.length / 1000,
    tokensPerChar: chars === 0 ? null : tokens / chars,
  };
};

export const estimateControl = ({ root, author, corpus, runner: name, set = "profile", only, delaySeconds }) => {
  const runner = configuredRunner(corpus, name);
  const plan = planControl({ root, author, corpus, runner: name, set, only });
  const todo = plan.filter((item) => item.status !== "cached");
  const chars = todo.reduce((sum, item) => sum + item.chars, 0);
  const past = history(plan);
  const delay = delaySeconds ?? corpus.config.control.delaySeconds;
  const tokensPerChar = past.tokensPerChar ?? DEFAULT_TOKENS_PER_CHAR;
  const tokens = Math.round(chars * tokensPerChar);
  return {
    runner: name,
    generate: todo.length,
    fresh: todo.filter((item) => item.status === "new").length,
    stale: todo.filter((item) => item.status === "stale").length,
    cached: plan.length - todo.length,
    chars,
    seconds: past.secondsPerOutput === null ? null : todo.length * past.secondsPerOutput + Math.max(0, todo.length - 1) * delay,
    tokens,
    tokensFromHistory: past.tokensPerChar !== null,
    costUsd: runner.price === undefined ? null : (tokens / 1e6) * runner.price,
  };
};

export const renderEstimate = (estimate) => {
  const e = estimate;
  const time = e.generate === 0 ? "" : e.seconds === null ? "、時間は不明（過去の出力がない）" : `、約 ${minutes(e.seconds)}`;
  const tokens = e.generate === 0 ? "" : `、出力 約 ${e.tokens} トークン（${e.tokensFromHistory ? "過去の出力から" : "仮の換算"}）`;
  const cost = e.generate === 0 ? "" : e.costUsd === null ? "、費用は price がないので出さない" : `、約 $${e.costUsd.toFixed(2)}`;
  return `${e.runner}: 生成 ${e.generate} 本（新規 ${e.fresh}・作り直し ${e.stale}）、既存 ${e.cached} 本、目標 ${e.chars} 字${time}${tokens}${cost}`;
};

export const runControl = async ({ root, author, corpus = loadCorpus(root, author), runner: name, set = "profile", only, limit, delaySeconds, dryRun = false, log = () => {} }) => {
  const runner = configuredRunner(corpus, name);
  const plan = planControl({ root, author, corpus, runner: name, set, only });
  const { timeoutSeconds, retryDelaysSeconds } = corpus.config.control;
  const delay = (delaySeconds ?? corpus.config.control.delaySeconds) * 1000;
  const summary = { generated: [], skipped: [], stale: [], failed: [], rateLimited: null, unavailable: null };
  let first = true;
  for (const { post, prompt, target, metaFile, status } of plan) {
    if (dryRun) {
      log(`--- ${post.slug}\n${prompt}`);
      continue;
    }
    if (status === "cached") {
      summary.skipped.push(post.slug);
      continue;
    }
    if (status === "stale") {
      summary.stale.push(post.slug);
      log(`${name} ${post.slug} はプロンプトが変わったので作り直す`);
    }
    if (limit !== undefined && summary.generated.length + summary.failed.length >= limit) {
      break;
    }
    if (!first && delay > 0) {
      await sleep(delay);
    }
    first = false;
    log(`${name} ${post.slug} を生成中`);
    try {
      const output = await generateWithRetry(runner, prompt, { timeoutSeconds, retryDelaysSeconds, log });
      const meta = {
        runner: name,
        model: runner.model ?? null,
        prompt_sha256: sha256(prompt),
        date: new Date().toISOString(),
        duration_ms: output.durationMs,
        attempts: output.attempts,
        unwrapped: output.unwrapped,
        ...output.extra,
      };
      writeOutput({ target, metaFile }, output.text, meta);
      summary.generated.push({ slug: post.slug, durationMs: output.durationMs });
      log(`${name} ${post.slug} ${(output.durationMs / 1000).toFixed(1)} 秒`);
    } catch (error) {
      if (error instanceof RateLimitError) {
        summary.rateLimited = { slug: post.slug, error: error.message };
        log(`${name} ${post.slug} で回数制限に当たったので止める: ${error.message}`);
        break;
      }
      if (error instanceof UnavailableError) {
        summary.unavailable = { slug: post.slug, error: error.message };
        log(`${name} ${post.slug} は再試行しても混雑していたので止める: ${error.message}`);
        break;
      }
      summary.failed.push({ slug: post.slug, error: error.message });
      log(`${name} ${post.slug} 失敗: ${error.message}`);
    }
  }
  return summary;
};
