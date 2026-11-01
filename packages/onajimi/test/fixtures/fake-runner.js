import fs from "node:fs";

const [log, mode, failures] = process.argv.slice(2);
const prompt = fs.readFileSync(0, "utf8");
const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0;
fs.appendFileSync(log, `${prompt.split("\n")[0]}\n`);
if (mode === "limited" && calls >= 1) {
  process.stderr.write("API Error: 429 rate limit exceeded\n");
  process.exit(1);
}
if (mode === "flaky" && calls < Number(failures)) {
  process.stderr.write("API Error: 503 UNAVAILABLE\n");
  process.exit(1);
}
const title = /タイトル: (.*)/u.exec(prompt)?.[1] ?? "";
process.stdout.write(JSON.stringify({ is_error: false, total_cost_usd: 0.01, result: `\`\`\`markdown\n# ${title}\n\n本文を確認した。\n\`\`\`\n` }));
