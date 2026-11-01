import fs from "node:fs";
import path from "node:path";
import { build } from "./build.js";
import { corpusPaths, loadCorpus, writeSplit } from "./corpus.js";
import { runControl } from "./control.js";
import { runProfile } from "./profile.js";
import { writeReview } from "./review.js";

export const runPipeline = async ({ root, author, limit, delaySeconds, log = () => {}, say = () => {} }) => {
  if (!fs.existsSync(corpusPaths(root, author).split)) {
    const split = writeSplit({ root, author });
    say(`split: profile ${split.profile.length} 本、dev ${split.dev.length} 本、test ${split.test.length} 本`);
  }
  const corpus = loadCorpus(root, author);
  let stopped = 0;
  for (const runner of Object.keys(corpus.config.control.runners)) {
    const summary = await runControl({ root, author, runner, set: "all", limit, delaySeconds, log });
    say(`control ${runner}: 生成 ${summary.generated.length}（うち作り直し ${summary.stale.length}）、既存 ${summary.skipped.length}、失敗 ${summary.failed.length}`);
    if (summary.rateLimited) {
      say(`control ${runner}: ${summary.rateLimited.slug} で回数制限に当たって止めた。時間をおいて同じコマンドで再開する。`);
      stopped = stopped || 3;
    } else if (summary.unavailable) {
      say(`control ${runner}: ${summary.unavailable.slug} で混雑が続いたので止めた。時間をおいて同じコマンドで再開する。`);
      stopped = stopped || 4;
    } else if (summary.failed.length > 0) {
      stopped = stopped || 1;
    }
  }
  if (stopped !== 0) {
    say("対照がそろっていないので、profile と review は実行していない。");
    return stopped;
  }
  const profile = await runProfile({ root, author });
  say(`profile: ${Object.entries(profile.sides).map(([name, side]) => `${name} ${side.docs} 本`).join("、")}、候補 ${profile.strong.length} 件`);
  build({ root, author });
  const review = await writeReview({ root, author });
  say(`review: ${path.relative(process.cwd(), review.file)}（${review.lines} 行）`);
  return 0;
};
