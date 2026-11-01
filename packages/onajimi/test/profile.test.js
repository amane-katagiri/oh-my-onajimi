import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { aggregate, compare, containsWord, docFeatures, docRates, featuresOfMarkdown, isContentWord, logOddsZ, proposeDensity, proposeModelLeaning, proposeRateDifferences, snippet } from "../src/profile.js";
import { aggregateVariants, docVariants, isScriptVariant, prhEntry, proposeOrthography } from "../src/orthography.js";
import { measureArticle, proposeThresholds } from "../src/stats.js";
import { run } from "./helpers.js";
import { makeCorpusRoot, post } from "./corpus-helpers.js";

test("log-odds with an informative Dirichlet prior matches a hand computation", () => {
  // α_w = 10 × 12/200 = 0.6, δ = ln(10.6/99.4) − ln(2.6/107.4) = 1.48275, σ² = 1/10.6 + 1/2.6
  assert.ok(Math.abs(logOddsZ(10, 2, 100, 100, 10) - 2.1425) < 1e-4);
  assert.ok(Math.abs(logOddsZ(2, 10, 100, 100, 10) + 2.1425) < 1e-4);
  assert.equal(logOddsZ(5, 5, 100, 100, 10), 0);
});

test("features are content-word unigrams and adjacent bigrams by basic form", async () => {
  const { features } = await featuresOfMarkdown("動作を確認した。2024年に確認する。\n");
  assert.equal(features.get("確認/名詞").count, 2);
  assert.equal(features.get("確認+する").count, 2);
  assert.deepEqual(features.get("確認+する").tokens, [{ basic_form: "確認" }, { basic_form: "する" }]);
  assert.deepEqual([...features.get("確認+する").surfaces], [["確認し", 1], ["確認する", 1]]);
  assert.equal(features.get("2/名詞"), undefined);
  assert.equal([...features.keys()].some((key) => key.startsWith("4+")), false);
  assert.equal(isContentWord({ pos: "名詞", pos_detail_1: "非自立", surface_form: "こと" }), false);
  const ascii = (await featuresOfMarkdown("UTF-8の0x85とU+0000はWebの話。\n")).features;
  for (const key of ["x/名詞", "U/名詞", "Web/名詞"]) {
    assert.equal(ascii.get(key), undefined, key);
  }
  assert.equal([...ascii.keys()].some((key) => /^[\x21-\x7e]+\+[\x21-\x7e]+$/u.test(key)), false);
  assert.ok(ascii.get("Web+の"));
});

test("snippets stay within 40 characters", () => {
  const text = `${"あ".repeat(50)}確認${"い".repeat(50)}。次の文。`;
  const short = snippet(text, 50, 52);
  assert.ok([...short].length <= 40);
  assert.match(short, /確認/);
  assert.equal(snippet("前の文。短い確認の文。後の文。", 6, 8), "短い確認の文。");
});

test("compare keeps model-leaning features seen in enough control documents", () => {
  const doc = (id, words) => ({ id, features: docFeatures([{ text: words.join(""), tokens: words.map((w, i) => ({ surface_form: w, basic_form: w, pos: "名詞", pos_detail_1: "一般", word_position: i + 1 })) }]) });
  const author = aggregate([doc("a1", ["猫", "犬", "猫"]), doc("a2", ["猫", "犬"])]);
  const control = aggregate([doc("c1", ["鍵", "鍵", "犬"]), doc("c2", ["鍵", "猫"])]);
  const other = aggregate([doc("o1", ["象"]), doc("o2", ["象"])]);
  const rows = compare(author, { m: control, o: other }, { alpha0: 10, min_docs: 2, min_count: 2 });
  assert.equal(rows.find((row) => row.feature === "象/名詞").z.m, undefined);
  assert.ok(rows.every((row) => Number.isFinite(row.score)));
  const unigrams = rows.filter((row) => row.kind === "unigram" && row.feature !== "象/名詞");
  assert.equal(unigrams[0].feature, "鍵/名詞");
  assert.equal(unigrams[0].modelLeaning.m, true);
  assert.ok(unigrams[0].z.m < 0);
  assert.equal(unigrams.at(-1).feature, "猫/名詞");
  assert.equal(unigrams.at(-1).authorLeaning, true);
});

test("the dictionary proposal takes only words the author almost never uses; frequency gaps go to rate differences", () => {
  const row = (feature, authorDocs, z) => ({
    feature,
    tokens: [{ basic_form: feature }],
    author: { count: authorDocs * 3, docs: authorDocs },
    z: { m: z },
    modelLeaning: { m: true },
    control: { m: { count: 30, docs: 10, surfaces: new Map([[feature, 30]]) } },
  });
  const rows = [row("た+。", 60, -14), row("すべて", 0, -3.3), row("わかる", 1, -2.5), row("それ", 41, -5.9), row("ふと", 1, -1.5)];
  const config = { proposal_z: -2, proposal_max_author_docs: 1, rate_z: -4, proposal_limit: 10 };
  rows[1].inBriefDocs = 2;
  const proposal = proposeModelLeaning(rows, ["m"], config);
  assert.deepEqual(proposal.model_leaning.map((entry) => entry.evidence.feature), ["わかる"]);
  assert.deepEqual(proposal.excluded_in_brief.map((entry) => [entry.evidence.feature, entry.evidence.in_brief_docs]), [["すべて", 2]]);
  const rates = proposeRateDifferences(rows, ["m"], { author: { chars: 1000 }, m: { chars: 1000 } }, config);
  assert.deepEqual(rates.map((entry) => entry.feature), ["た+。", "それ"]);
  assert.deepEqual(rates[0].per_1000_chars, { author: 180, m: 30 });
});

test("article measures follow sentence-length, max-ten and decoration-density", async () => {
  const markdown = ["東京、大阪、名古屋に行き、食べ、寝た。短い。", "", "**太字**の文。", "", "- 項目", "", "> 引用、引用、引用、引用、引用。", ""].join("\n");
  const measure = await measureArticle(markdown);
  assert.equal(measure.sentence_length, 19);
  assert.equal(measure.max_ten, 2);
  assert.equal(measure.bold_per_1000, Number(((1 / measure.proseChars) * 1000).toFixed(1)));
  assert.equal(measure.list_ratio, Number((2 / measure.proseChars).toFixed(2)));
});

test("proposed thresholds are not exceeded by any article; stricter ones are the 90th percentile", () => {
  const articles = Array.from({ length: 10 }, (_, i) => ({ sentence_length: 50 + i, max_ten: i % 4, bold_per_1000: i * 0.33, list_ratio: i * 0.031, proseChars: 2000, bold_label_items: 0, marks: 0, emphasis_share: null, lengths: [], tens: [] }));
  const result = proposeThresholds(articles);
  assert.equal(result.sentence_length.proposed, 59);
  assert.equal(result.sentence_length.stricter, 58);
  assert.equal(result.sentence_length.stricter_exceeds, 1);
  assert.equal(result.bold_per_1000.proposed, 3);
  assert.equal(result.list_ratio.proposed, 0.28);
  assert.equal(result.max_ten.proposed, 3);
});

test("profile writes candidates, a proposal and thresholds from cached controls", () => {
  const body = (extra) => `# 見出し\n\n今日は動作を${extra}。結果を書いた。\n`;
  const { root } = makeCorpusRoot({
    lily1: post({ title: "L", date: "2021-02-01", category: "lily", body: "動作を確認した。確認した。確認した。確認した。\n" }),
    a: post({ title: "A", date: "2021-01-01", aiSummary: "徹底的に調べた。", body: body("確かめた") }),
    b: post({ title: "B", date: "2021-01-02", body: body("確かめた") }),
    c: post({ title: "C", date: "2021-01-03", body: body("確かめた") }),
    d: post({ title: "D", date: "2021-01-04", body: body("確かめた") }),
  });
  assert.equal(run(["split", "--root", root, "--author", "demo"]).code, 0);
  const dir = path.join(root, "authors/demo/corpus/_control/fake");
  fs.mkdirSync(dir, { recursive: true });
  for (const slug of ["a", "b"]) {
    fs.writeFileSync(path.join(dir, `${slug}.md`), "# 見出し\n\n今日は動作を確認した。徹底的に確認した。\n");
  }
  const result = run(["profile", "--root", root, "--author", "demo"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /author 3 本 \d+ 字、author_other 1 本 \d+ 字、fake 2 本/u);
  const out = path.join(root, "authors/demo/profile");
  const [header, ...rows] = fs.readFileSync(path.join(out, "candidates.tsv"), "utf8").trimEnd().split("\n");
  const columns = header.split("\t");
  assert.deepEqual(columns.slice(0, 8), ["feature", "kind", "z_fake", "z_limited", "z_flaky", "z_down", "author_count", "author_docs"]);
  const field = (cells, name) => cells[columns.indexOf(name)];
  const full = fs.readFileSync(path.join(out, "_full/candidates.tsv"), "utf8").trimEnd().split("\n");
  const kakunin = full.map((row) => row.split("\t")).find((cells) => cells[0] === "確認+する");
  assert.ok(Number(field(kakunin, "z_fake")) < 0);
  assert.equal(field(kakunin, "z_limited"), "");
  assert.equal(field(kakunin, "surfaces"), "確認し");
  const proposal = YAML.parse(fs.readFileSync(path.join(out, "proposal.yml"), "utf8"));
  assert.ok(proposal.model_leaning.some((entry) => entry.evidence.feature === "確認+する"));
  assert.deepEqual(Object.keys(proposal.thresholds), [
    "sentence_length",
    "max_ten",
    "bold_per_1000",
    "list_ratio",
    "decoration_min_chars",
    "bold_label_items",
    "emphasis_share_min",
    "emphasis_min_marks",
    "density_min_chars",
    "emphasis_share_typical",
  ]);
  assert.match(result.stdout, /author_other 1 本/u);
  assert.equal(field(kakunin, "in_brief_docs"), "0");
  assert.ok(Number(field(kakunin, "author_other_per_1000")) > 0);
  assert.equal(field(kakunin, "author_next"), "");
  assert.match(field(kakunin, "control_next"), /^た\/助動詞 4$/u);
  const kakuninEntry = proposal.model_leaning.find((entry) => entry.evidence.feature === "確認+する");
  assert.match(kakuninEntry.note, /他のカテゴリー/u);
  assert.equal(kakuninEntry.evidence.control_next, "た/助動詞 4");
  assert.ok(proposal.excluded_in_brief.some((entry) => entry.evidence.feature === "徹底的/名詞" && entry.evidence.in_brief_docs === 1));
  assert.equal(proposal.model_leaning.some((entry) => entry.evidence.feature === "徹底的/名詞"), false);
  assert.ok(fs.existsSync(path.join(out, "thresholds.yml")));
  assert.ok(full.length > rows.length + 1);
  for (const row of rows) {
    const z = row.split("\t").slice(2, 6).filter(Boolean).map(Number);
    assert.ok(z.some((value) => Math.abs(value) >= 2), row);
  }
});

test("bold thresholds count only articles with enough prose; bold labels and emphasis share are measured", async () => {
  const articles = [
    { sentence_length: 1, max_ten: 1, bold_per_1000: 30, list_ratio: 0, proseChars: 29, bold_label_items: 0, marks: 4, emphasis_share: 0.25, lengths: [], tens: [] },
    { sentence_length: 1, max_ten: 1, bold_per_1000: 1.2, list_ratio: 0, proseChars: 3000, bold_label_items: 0, marks: 10, emphasis_share: 0.6, lengths: [], tens: [] },
    { sentence_length: 1, max_ten: 1, bold_per_1000: 0.5, list_ratio: 0, proseChars: 2000, bold_label_items: 0, marks: 2, emphasis_share: 0, lengths: [], tens: [] },
  ];
  const control = [{ sentence_length: 1, max_ten: 1, bold_per_1000: 9, list_ratio: 0, proseChars: 2000, bold_label_items: 3, marks: 6, emphasis_share: 0, lengths: [], tens: [] }];
  const result = proposeThresholds(articles, { minChars: 1500, minMarks: 3, controls: { m: control } });
  assert.equal(result.bold_per_1000.proposed, 1.2);
  assert.equal(result.bold_label_items.proposed, 0);
  assert.equal(result.emphasis_share_min.proposed, 0.25);
  assert.equal(result.emphasis_share_min.p50, 0.25);
  assert.equal(result.decoration_min_chars.proposed, 1500);
  assert.deepEqual(result.controls.m.bold_label_items, { articles: 1, p50: 3, max: 3, fires: 1, fires_stricter: 1 });
  assert.equal(result.controls.m.emphasis_share_min.fires, 1);

  const measure = await measureArticle(["- **速さ**: 速い", "- **軽さ：** 軽い", "- **太字**だけ", "- ふつう: 説明", "", "*斜体*と**太字**。", "", "> - **引用**: 数えない", ""].join("\n"));
  assert.equal(measure.bold_label_items, 2);
  assert.deepEqual(measure.boldLabels.map((at) => at.line), [1, 2]);
  assert.equal(measure.marks, 5);
  assert.equal(measure.emphasis_share, 0.2);
});

test("orthography groups script variants by reading and part of speech and writes prh entries", async () => {
  const side = async (texts) => {
    const docs = [];
    for (const [i, text] of texts.entries()) {
      const { strTokens } = await featuresOfMarkdown(text);
      docs.push(docVariants(`d${i}`, strTokens));
    }
    return aggregateVariants(docs);
  };
  const author = await side(["話が分かった。意味が分からない。全て読んだ。", "やっと分かる。全て終わった。その方がいい。その方が早い。機会がある。", "全てを見た。分かりやすい。その方が楽だ。機会を待つ。機会が来た。"]);
  const model = await side(["話がわかった。意味がわからない。すべて読んだ。そのほうがいい。", "やっとわかる。すべて終わった。そのほうが早い。機械がある。", "すべてを見た。わかりやすい。すべてだ。そのほうが楽だ。機械を待つ。機械が来た。"]);
  const params = { orthography_min_count: 3, orthography_min_share: 0.8, orthography_z: 1, orthography_limit: 10 };
  const result = await proposeOrthography(author, { m: model }, params);
  const pairs = result.orthography.map((entry) => [entry.expected, entry.pattern]);
  assert.deepEqual(pairs.sort(), [["全て", "すべて"], ["分か", "/わか(?=[っらりる])/"]]);
  const wakaru = result.orthography.find((entry) => entry.expected === "分か");
  assert.equal(wakaru.evidence.author["分かる"], 4);
  assert.equal(wakaru.evidence.control.m["わかる"], 4);
  assert.ok(wakaru.evidence.author_example.length > 0);
  assert.deepEqual(result.orthography_review.map((entry) => [entry.expected, entry.pattern]), [["方", "ほう"]]);
  assert.match(result.orthography_review[0].check.join(), /1 字の漢字/u);
  assert.equal([...result.orthography, ...result.orthography_review].some((entry) => /機/u.test(entry.expected)), false);
  assert.equal(isScriptVariant("気付く", "気づく"), true);
  assert.equal(isScriptVariant("機会", "機械"), false);
  assert.deepEqual(prhEntry("様々", "さまざま", ["さまざま"]), { expected: "様々", pattern: "さまざま" });
  assert.deepEqual(prhEntry("気付く", "気づく", ["気づい", "気づか"]), { expected: "気付", pattern: "/気づ(?=[いかく])/" });
});

test("katakana words split by the tokenizer do not form orthography pairs", async () => {
  const side = async (texts) => {
    const docs = [];
    for (const [i, text] of texts.entries()) {
      const { strTokens } = await featuresOfMarkdown(text);
      docs.push(docVariants(`d${i}`, strTokens));
    }
    return aggregateVariants(docs);
  };
  const author = await side(["オタクくんが来た。オタクくんは寝た。", "オタクくんと話した。オタクくんの本。", "オタクくんも笑った。"]);
  const model = await side(["トークンを発行する。トークンが漏れた。", "トークンを消す。トークンの一覧。", "トークンだけを見る。"]);
  assert.equal(model.get("クン/名詞"), undefined);
  const params = { orthography_min_count: 3, orthography_min_share: 0.8, orthography_z: 1, orthography_limit: 10 };
  const result = await proposeOrthography(author, { m: model }, params);
  assert.equal([...result.orthography, ...result.orthography_review].some((entry) => entry.expected === "くん"), false);
});

test("a variant that also matches inside other words goes to review", async () => {
  const side = async (texts) => aggregateVariants(await Promise.all(texts.map(async (text, i) => docVariants(`d${i}`, (await featuresOfMarkdown(text)).strTokens))));
  const author = await side(["全て見た。全て食べた。", "全てを読む。全て終わる。", "全てだ。"]);
  const model = await side(["すべて見た。すべて食べた。すべてを。", "すべてだ。すべて終わる。", "すべての本。"]);
  const params = { orthography_min_count: 3, orthography_min_share: 0.8, orthography_z: 1, orthography_limit: 10 };
  const result = await proposeOrthography(author, { m: model }, params);
  const entry = [...result.orthography, ...result.orthography_review].find((e) => e.expected === "全て");
  assert.ok(entry);
  assert.equal(result.orthography.includes(entry), true);
  const leaky = await side(["クン付けで呼ぶ。クンと呼ぶ。", "クンが来た。", "クンは寝た。"]);
  const leakyAuthor = await side(["くん付けで呼ぶ。くんと呼ぶ。", "くんが来た。くんは寝た。", "くんの本。"]);
  for (const entry of leaky.values()) {
    entry.raw += 10;
  }
  const flagged = await proposeOrthography(leakyAuthor, { m: leaky }, params);
  assert.equal(flagged.orthography.some((e) => e.expected === "くん"), false);
  assert.match(flagged.orthography_review.find((e) => e.expected === "くん")?.check.join() ?? "", /ほかの語の一部/u);
});

test("density proposals take a threshold no long-enough profile article exceeds", async () => {
  const docOf = async (id, text) => ({ id, ...(await featuresOfMarkdown(text)) });
  const filler = "今日は晴れていたので散歩に出かけて公園を一周してから家に帰ってきた";
  const authorDocs = [await docOf("a1", `${filler}と思う。${filler}。`), await docOf("a2", `${filler}。${filler}。`), await docOf("short", "思う。思う。思う。")];
  const controlDocs = { m: [await docOf("c1", `${filler}と思う。${filler}と思う。と思う。`), await docOf("c2", `${filler}。${filler}。`)] };
  const rate = { feature: "思う/動詞", tokens: [{ pos: "動詞", basic_form: "思う" }], evidence: { in_brief_docs: 0 } };
  const [entry] = proposeDensity([rate], authorDocs, controlDocs, { min_chars: 40 });
  const authorRates = docRates(authorDocs, rate.tokens, 40);
  assert.equal(authorRates.length, 2);
  assert.ok(authorRates.every((value) => value <= entry.max_per_1000));
  assert.equal(entry.min_chars, 40);
  assert.equal(entry.evidence.control.m.fires, 1);
  assert.equal(entry.evidence.author_articles, 2);
  assert.match(entry.message, /「思う」が多い/u);
});

test("brief matching ignores a surface that is only part of a longer kanji or katakana word", () => {
  assert.equal(containsWord("ブログ記事を書いて", "ログ"), false);
  assert.equal(containsWord("本文だけを出力", "本"), false);
  assert.equal(containsWord("新しい方式を試みた。", "試み"), true);
  assert.equal(containsWord("ログを見る", "ログ"), true);
  assert.equal(containsWord("この本は", "本"), true);
});
