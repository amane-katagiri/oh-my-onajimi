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
const reply = (result) => process.stdout.write(JSON.stringify({ is_error: false, total_cost_usd: 0.01, duration_ms: 5, result }));
if (mode === "abc") {
  const draft = /--- 下書きここから ---\n([\s\S]*)\n--- 下書きここまで ---/u.exec(prompt)?.[1];
  if (draft !== undefined) {
    reply(`${draft.replaceAll("出来る", "できる").replace("3 回", "何回か")}\n`);
  } else {
    const style = prompt.includes("--- 例 1:") ? "例を読んだ。" : "";
    const tried = title.includes("数") ? "3 回試した。" : "";
    const word = title.includes("素") ? "できる" : "出来る";
    reply(`# ${title}\n\n${style}${tried}本文を読んだ。これなら${word}。\n`);
  }
} else {
  reply(`\`\`\`markdown\n# ${title}\n\n本文を確認した。\n\`\`\`\n`);
}
