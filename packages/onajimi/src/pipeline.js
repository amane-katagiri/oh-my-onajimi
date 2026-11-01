import path from "node:path";
import { build } from "./build.js";
import { computeSplit, loadCorpus, saveSplit, splitText } from "./corpus.js";
import { estimateControl, renderEstimate, runControl } from "./control.js";
import { EXIT, needsYesMessage, stopOf } from "./exit.js";
import { runProfile } from "./profile.js";
import { writeReview } from "./review.js";

export const runPipeline = async ({ root, author, preset, limit, delaySeconds, estimate = false, yes = false, log = () => {}, say = () => {} }) => {
  const planned = computeSplit({ root, author });
  const corpus = loadCorpus(root, author, { split: planned.split });
  const runners = Object.keys(corpus.config.control.runners);
  const estimates = runners.map((runner) => estimateControl({ root, author, corpus, runner, set: "all", delaySeconds }));
  const pending = estimates.reduce((sum, e) => sum + e.generate, 0);
  if (estimate || (pending > 0 && !yes)) {
    if (planned.changed) {
      say(`split（まだ書いていない）: ${splitText(planned.split)}${planned.added.length > 0 ? `。holdout に入る記事 ${planned.added.length} 本` : ""}`);
    }
    for (const e of estimates) {
      say(`estimate ${renderEstimate(e)}`);
    }
    if (estimate) {
      return 0;
    }
    say(needsYesMessage("対照を"));
    return EXIT.NEEDS_YES;
  }
  if (planned.changed) {
    saveSplit({ root, author }, planned);
    say(`split: ${splitText(planned.split)}${planned.added.length > 0 ? `（holdout に足した記事 ${planned.added.length} 本）` : ""}`);
  }
  let stopped = 0;
  for (const runner of runners) {
    const summary = await runControl({ root, author, corpus, runner, set: "all", limit, delaySeconds, log });
    say(`control ${runner}: 生成 ${summary.generated.length}（うち作り直し ${summary.stale.length}）、既存 ${summary.skipped.length}、失敗 ${summary.failed.length}`);
    const stop = stopOf(summary, "slug");
    if (stop) {
      say(`control ${runner}: ${stop.message}`);
    }
    stopped ||= stop?.code ?? (summary.failed.length > 0 ? EXIT.FAILED : 0);
  }
  if (stopped !== 0) {
    say("対照がそろっていないので、profile と review は実行していない。");
    return stopped;
  }
  const profile = await runProfile({ root, author });
  say(`profile: ${Object.entries(profile.sides).map(([name, side]) => `${name} ${side.docs} 本`).join("、")}、候補 ${profile.strong.length} 件`);
  build({ root, author });
  const review = await writeReview({ root, author, preset });
  say(`review: ${path.relative(process.cwd(), review.file)}（${review.lines} 行）`);
  return 0;
};
