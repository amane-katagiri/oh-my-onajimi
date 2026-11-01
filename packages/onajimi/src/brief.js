import { analyzeProse } from "./prose.js";

const roundChars = (chars) => Math.max(100, Math.round(chars / 100) * 100);

export const buildBrief = (post, { skipParagraphs = [] } = {}) => {
  const { headings, chars } = analyzeProse(post.text, { skipParagraphs });
  return {
    slug: post.slug,
    title: post.meta.title ?? "",
    summary: post.meta.summary ?? "",
    outline: headings.filter((heading) => heading.depth <= 2),
    chars: roundChars(chars),
    points: post.meta.ai_summary ?? "",
  };
};

export const renderPrompt = (template, brief) => {
  const values = {
    title: brief.title,
    summary: brief.summary || "（なし）",
    chars: String(brief.chars),
    outline: brief.outline.length > 0 ? brief.outline.map(({ depth, text }) => `${"#".repeat(depth)} ${text}`).join("\n") : "（見出しなし）",
    points: brief.points || "（なし）",
  };
  return template.replace(/\{(\w+)\}/gu, (match, key) => {
    if (!(key in values)) {
      throw new Error(`プロンプトのひな形に知らない差し込み {${key}} がある`);
    }
    return values[key];
  });
};
