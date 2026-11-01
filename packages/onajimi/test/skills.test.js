import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "./helpers.js";

test("skills leave the data root to onajimi root instead of the plugin data directory", () => {
  const dir = path.join(repoRoot, "skills");
  for (const name of fs.readdirSync(dir)) {
    const text = fs.readFileSync(path.join(dir, name, "SKILL.md"), "utf8");
    assert.ok(!text.includes("CLAUDE_PLUGIN_DATA"), name);
    assert.ok(!text.includes("--root"), name);
    assert.ok(text.includes("onajimi root"), name);
  }
});
