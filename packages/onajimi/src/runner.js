import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { expandHome } from "./paths.js";

export class RateLimitError extends Error {}
export class UnavailableError extends Error {}

const FENCE = /^\s*```(?:markdown|md)?[ \t]*\n([\s\S]*?)\n```\s*$/u;

export const unwrapFence = (text) => {
  const match = FENCE.exec(text);
  return match ? { text: `${match[1]}\n`, unwrapped: true } : { text, unwrapped: false };
};

const execute = (command, { stdin, timeoutMs }) =>
  new Promise((resolve, reject) => {
    // 生成させるだけなので、作業ディレクトリは空にしてリポジトリの中身を見せない。
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "onajimi-control-"));
    const child = spawn(command[0], command.slice(1), { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      fs.rmSync(cwd, { recursive: true, force: true });
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      fs.rmSync(cwd, { recursive: true, force: true });
      resolve({ code, signal, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin ?? "");
  });

const tail = (text, size = 300) => text.trim().slice(-size).replace(/\s+/gu, " ");

const generateByCommand = async (runner, prompt, { timeoutSeconds }) => {
  const usesArg = runner.command.some((arg) => arg.includes("{prompt}"));
  const command = runner.command.map((arg) => arg.replaceAll("{prompt}", prompt));
  const started = Date.now();
  const result = await execute(command, { stdin: usesArg ? "" : prompt, timeoutMs: timeoutSeconds * 1000 });
  const durationMs = Date.now() - started;
  const rateLimit = runner.rate_limit ? new RegExp(runner.rate_limit, "iu") : null;
  const unavailable = runner.unavailable ? new RegExp(runner.unavailable, "iu") : null;
  const failWith = (reason) => {
    const message = `${reason}: ${tail(result.stderr) || tail(result.stdout)}`;
    const seen = `${result.stdout}\n${result.stderr}`;
    if (rateLimit && rateLimit.test(seen)) {
      throw new RateLimitError(message);
    }
    if (unavailable && unavailable.test(seen)) {
      throw new UnavailableError(message);
    }
    throw new Error(message);
  };
  if (result.signal) {
    failWith(`${result.signal} で止まった（${timeoutSeconds} 秒で打ち切り）`);
  }
  if (result.code !== 0) {
    failWith(`終了コード ${result.code}`);
  }
  let text = result.stdout;
  const extra = {};
  if (runner.output === "json") {
    let data;
    try {
      data = JSON.parse(result.stdout);
    } catch {
      failWith("JSON として読めない出力");
    }
    if (data.is_error === true) {
      failWith("エラーの応答");
    }
    text = data[runner.result_field ?? "result"];
    for (const field of runner.meta_fields ?? []) {
      if (data[field] !== undefined) {
        extra[field] = data[field];
      }
    }
  }
  if (typeof text !== "string" || text.trim() === "") {
    failWith("本文が空");
  }
  return { ...unwrapFence(text), durationMs, extra };
};

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const RATE_HEADERS = /^(retry-after|x-ratelimit-.*)$/iu;

const generateByGeminiApi = async (runner, prompt, { timeoutSeconds, fetchImpl = fetch }) => {
  if (typeof runner.model !== "string" || typeof runner.key_file !== "string") {
    throw new Error("api: gemini の runner には model と key_file が要る");
  }
  const key = fs.readFileSync(expandHome(runner.key_file), "utf8").trim();
  const started = Date.now();
  const response = await fetchImpl(`${GEMINI_ENDPOINT}/${encodeURIComponent(runner.model)}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }] }),
    signal: AbortSignal.timeout(timeoutSeconds * 1000),
  });
  const durationMs = Date.now() - started;
  const rateHeaders = Object.fromEntries([...response.headers].filter(([name]) => RATE_HEADERS.test(name)));
  const body = await response.text();
  const describe = () => {
    try {
      const error = JSON.parse(body).error ?? {};
      const details = (error.details ?? []).map((detail) => detail.retryDelay ?? detail.violations?.map((v) => v.quotaId ?? v.quotaMetric).join(",")).filter(Boolean);
      return [error.status, error.message, ...details].filter(Boolean).join(" / ").replaceAll(key, "＊＊＊");
    } catch {
      return tail(body).replaceAll(key, "＊＊＊");
    }
  };
  if (response.status === 429) {
    throw new RateLimitError(`HTTP 429: ${describe()} ${JSON.stringify(rateHeaders)}`);
  }
  if (response.status === 503) {
    throw new UnavailableError(`HTTP 503: ${describe()}`);
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${describe()}`);
  }
  const data = JSON.parse(body);
  const candidate = data.candidates?.[0];
  const text = (candidate?.content?.parts ?? []).filter((part) => !part.thought).map((part) => part.text ?? "").join("");
  if (text.trim() === "") {
    throw new Error(`本文が空: finishReason=${candidate?.finishReason ?? "なし"} ${JSON.stringify(data.promptFeedback ?? {})}`);
  }
  return {
    ...unwrapFence(text),
    durationMs,
    extra: { model_version: data.modelVersion, finish_reason: candidate.finishReason, usage: data.usageMetadata, rate_headers: rateHeaders },
  };
};

export const generateOne = (runner, prompt, options) =>
  runner.api === "gemini" ? generateByGeminiApi(runner, prompt, options) : generateByCommand(runner, prompt, options);

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

export const readMeta = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

export const generateWithRetry = async (runner, prompt, { timeoutSeconds, retryDelaysSeconds, log }) => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return { ...(await generateOne(runner, prompt, { timeoutSeconds })), attempts: attempt };
    } catch (error) {
      const wait = retryDelaysSeconds[attempt - 1];
      if (!(error instanceof UnavailableError) || wait === undefined) {
        throw error;
      }
      log(`混雑しているので ${wait} 秒待って再試行する（${attempt + 1} 回目）: ${error.message}`);
      await sleep(wait * 1000);
    }
  }
};

export const configuredRunner = (corpus, name) => {
  const runner = corpus.config.control.runners[name];
  if (!runner) {
    throw new Error(`corpus.yml の control.runners に ${name ?? "runner"} がない`);
  }
  return runner;
};

export const statusByPromptHash = (target, metaFile, prompt) =>
  !fs.existsSync(target) ? "new" : readMeta(metaFile)?.prompt_sha256 === sha256(prompt) ? "cached" : "stale";

export const writeOutput = ({ target, metaFile }, text, meta) => {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(`${target}.tmp`, text);
  fs.renameSync(`${target}.tmp`, target);
  fs.writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`);
};

export const minutes = (seconds) => (seconds < 90 ? `${Math.ceil(seconds)} 秒` : `${Math.ceil(seconds / 60)} 分`);
