import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { RateLimitError, UnavailableError, generateOne, sha256, unwrapFence } from "../src/control.js";
import { run } from "./helpers.js";
import { makeCorpusRoot, post } from "./corpus-helpers.js";

const prepare = () => {
  const posts = {};
  for (let i = 0; i < 4; i += 1) {
    posts[`p${i}`] = post({ title: `題${i}`, date: `2021-01-0${i + 1}`, body: `# 見出し${i}\n\n本文です。\n` });
  }
  const made = makeCorpusRoot(posts);
  run(["split", "--root", made.root, "--author", "demo"]);
  return made;
};

const calls = (log) => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0);

test("control caches outputs with meta and skips them on the next run", () => {
  const { root, log } = prepare();
  const first = run(["control", "--root", root, "--author", "demo", "--runner", "fake"]);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.stdout, "生成 3（うち作り直し 0）、既存 0、失敗 0\n");
  assert.equal(calls(log), 3);
  const dir = path.join(root, "authors/demo/corpus/_control/fake");
  assert.equal(fs.readFileSync(path.join(dir, "p0.md"), "utf8"), "# 題0\n\n本文を確認した。\n");
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "p0.json"), "utf8"));
  assert.equal(meta.prompt_sha256, sha256("約100字で書いてください。\nタイトル: 題0\n# 見出し0\n要点: 要点。"));
  assert.equal(meta.unwrapped, true);
  assert.equal(meta.total_cost_usd, 0.01);
  assert.equal(typeof meta.duration_ms, "number");
  const second = run(["control", "--root", root, "--author", "demo", "--runner", "fake"]);
  assert.equal(second.stdout, "生成 0（うち作り直し 0）、既存 3、失敗 0\n");
  assert.equal(calls(log), 3);
  const test = run(["control", "--root", root, "--author", "demo", "--runner", "fake", "--set", "test"]);
  assert.equal(test.stdout, "生成 1（うち作り直し 0）、既存 0、失敗 0\n");
});

test("control stops cleanly on a rate limit and resumes later", () => {
  const { root, log } = prepare();
  const result = run(["control", "--root", root, "--author", "demo", "--runner", "limited"]);
  assert.equal(result.code, 3);
  assert.match(result.stdout, /p1 で回数制限に当たって止めた/);
  assert.equal(calls(log), 2);
  const dir = path.join(root, "authors/demo/corpus/_control/limited");
  assert.deepEqual(fs.readdirSync(dir).sort(), ["p0.json", "p0.md"]);
});

test("control --only picks posts and --dry-run prints prompts without running", () => {
  const { root, log } = prepare();
  const dry = run(["control", "--root", root, "--author", "demo", "--runner", "fake", "--only", "p2", "--dry-run"]);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stderr, /--- p2\n約100字で書いてください。\nタイトル: 題2/u);
  assert.equal(calls(log), 0);
  assert.equal(run(["control", "--root", root, "--author", "demo", "--runner", "fake", "--only", "p3"]).code, 2);
});

test("a code fence around the whole output is removed", () => {
  assert.deepEqual(unwrapFence("```markdown\n# A\n\n本文\n```\n"), { text: "# A\n\n本文\n", unwrapped: true });
  assert.deepEqual(unwrapFence("# A\n\n```js\nx\n```\n"), { text: "# A\n\n```js\nx\n```\n", unwrapped: false });
});

const geminiRunner = (root) => {
  const keyFile = path.join(root, "key");
  fs.writeFileSync(keyFile, "secret-key\n");
  return { api: "gemini", model: "gemini-test", key_file: keyFile };
};

test("the gemini runner sends the key in a header and reads the text parts", async () => {
  const { root } = prepare();
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return new Response(
      JSON.stringify({ modelVersion: "gemini-test-001", candidates: [{ finishReason: "STOP", content: { parts: [{ text: "考え", thought: true }, { text: "# 本文\n" }] } }], usageMetadata: { totalTokenCount: 9 } }),
      { status: 200, headers: { "x-ratelimit-remaining": "19" } },
    );
  };
  const output = await generateOne(geminiRunner(root), "書いて", { timeoutSeconds: 5, fetchImpl });
  assert.equal(seen.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent");
  assert.equal(seen.init.headers["x-goog-api-key"], "secret-key");
  assert.doesNotMatch(seen.url, /secret/);
  assert.equal(output.text, "# 本文\n");
  assert.equal(output.extra.model_version, "gemini-test-001");
  assert.deepEqual(output.extra.rate_headers, { "x-ratelimit-remaining": "19" });
});

test("the gemini runner turns 429 into a rate limit without leaking the key", async () => {
  const { root } = prepare();
  const fetchImpl = async () =>
    new Response(JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "quota for secret-key", details: [{ retryDelay: "30s" }] } }), { status: 429 });
  await assert.rejects(generateOne(geminiRunner(root), "書いて", { timeoutSeconds: 5, fetchImpl }), (error) => {
    assert.ok(error instanceof RateLimitError);
    assert.match(error.message, /RESOURCE_EXHAUSTED.*30s/u);
    assert.doesNotMatch(error.message, /secret-key/);
    return true;
  });
});

test("control regenerates outputs whose prompt hash no longer matches", () => {
  const { root, log } = prepare();
  run(["control", "--root", root, "--author", "demo", "--runner", "fake"]);
  const config = path.join(root, "authors/demo/corpus.yml");
  const parsed = YAML.parse(fs.readFileSync(config, "utf8"));
  parsed.control.prompt = `本文は約{chars}字です。\n${parsed.control.prompt}`;
  fs.writeFileSync(config, YAML.stringify(parsed));
  fs.rmSync(path.join(root, "authors/demo/corpus/_control/fake/p1.json"));
  const result = run(["control", "--root", root, "--author", "demo", "--runner", "fake"]);
  assert.equal(result.stdout, "生成 3（うち作り直し 3）、既存 0、失敗 0\n");
  assert.equal(calls(log), 6);
  const meta = JSON.parse(fs.readFileSync(path.join(root, "authors/demo/corpus/_control/fake/p0.json"), "utf8"));
  assert.equal(meta.prompt_sha256, sha256("本文は約100字です。\n約100字で書いてください。\nタイトル: 題0\n# 見出し0\n要点: 要点。"));
  assert.equal(run(["control", "--root", root, "--author", "demo", "--runner", "fake"]).stdout, "生成 0（うち作り直し 0）、既存 3、失敗 0\n");
});

test("control retries an unavailable runner with backoff and stops cleanly when it stays down", () => {
  const flaky = prepare();
  const ok = run(["control", "--root", flaky.root, "--author", "demo", "--runner", "flaky", "--limit", "1"]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(calls(flaky.log), 3);
  assert.match(ok.stderr, /0 秒待って再試行する（3 回目）/u);
  const meta = JSON.parse(fs.readFileSync(path.join(flaky.root, "authors/demo/corpus/_control/flaky/p0.json"), "utf8"));
  assert.equal(meta.attempts, 3);

  const down = prepare();
  const stopped = run(["control", "--root", down.root, "--author", "demo", "--runner", "down"]);
  assert.equal(stopped.code, 4);
  assert.match(stopped.stdout, /p0 で混雑が続いたので止めた/u);
  assert.equal(calls(down.log), 4);
  assert.equal(fs.existsSync(path.join(down.root, "authors/demo/corpus/_control/down")), false);
});

test("the gemini runner treats 503 as unavailable", async () => {
  const { root } = prepare();
  const fetchImpl = async () => new Response(JSON.stringify({ error: { status: "UNAVAILABLE", message: "high demand" } }), { status: 503 });
  await assert.rejects(generateOne(geminiRunner(root), "書いて", { timeoutSeconds: 5, fetchImpl }), UnavailableError);
});
