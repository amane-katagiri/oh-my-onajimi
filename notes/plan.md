# oh-my-onajimi 実装方針

## 目的と前提

まともな日本語を書けるモデルの一発書きを、特定の筆者の好みに少しだけ近づける。文章の質そのものを上げる道具ではない。

この設計は次の前提に立つ。
- スキルの指示では、モデルの日本語力を超えられない。だから本文は普段どおり書かせる。
- 禁止事項を並べても、文脈が膨らむだけになる。モデルに渡すのは、本文で実際に引っかかった箇所だけにする。
- ルールどうしが矛盾すると、モデルは「何もしない」を選びやすい。だから指摘は出すが、直すかどうかはモデルが文脈で決める。
- 凝ったスキルが、短い指示に勝てるとは限らない。勝てるかどうかは評価で確かめる（A/B/C 比較）。

先行実装から引き継ぐ教訓は次のとおり（[prior-art.md](prior-art.md)）。
- 文脈ごとの例外を正規表現で積み上げない（yomiyasu の「効く」）。語の向き不向きは筆者コーパスとの比較で決める。
- 点数を 1 つにまとめない。指摘は規則ごとの件数で返す。
- しきい値は設定ファイル 1 か所だけに置く。スキルの本文には数値を書かない。
- 指摘は行単位で返す。文書全体を対象にする指摘は、件数を 1 件だけ返す。
- 評価には最初から本物の筆者の文を使う。合成の文で自分を測らない。

## 全体の形

```
oh-my-onajimi/                              # Claude Code プラグインのルート（npm の単一パッケージ。workspaces は使わない）
├─ .claude-plugin/plugin.json / marketplace.json
├─ bin/onajimi                 # packages/onajimi/bin/onajimi.js を呼ぶだけの入口
├─ packages/textlint-rule-preset-onajimi/   # textlint のルール集（CJS）。単体で配れる形
│   ├─ index.js                # model-leaning / author-leaning / decoration-density / phrase-density
│   ├─ rules/matcher.js        # kuromojin + morpheme-match-textlint の照合（leaning と density で共有）
│   ├─ rules/token-leaning.js  # 辞書の語を拾う（model-leaning と author-leaning の中身）
│   ├─ rules/decoration-density.js / phrase-density.js
│   └─ test/                   # 規則ごとの fires/clean fixture
├─ packages/onajimi/                        # CLI（ESM）。ルール集は相対パスで読む
│   ├─ bin/onajimi.js          # lint / guard / control / profile / build / eval / import
│   ├─ src/lint.js             # .textlintrc.json を読み、ルールの実体を直接渡して textlint の kernel を動かす
│   ├─ src/prose.js            # Markdown → 地の文（位置を元に戻せる）
│   ├─ src/profile.js          # 対数オッズ比と文統計
│   ├─ src/build.js            # profile.yml → 辞書としきい値の生成物
│   └─ src/guard.js            # 数値・否定（v2 で助詞）
├─ authors/<name>/             # 開発用の root。プラグインでは ${CLAUDE_PLUGIN_DATA}/authors/<name>/
│   ├─ profile.yml             # 人が編集する唯一の元データ
│   └─ generated/              # build の出力（--check で元データとの差を検査する）
│       ├─ model-leaning.json  # {entries: [{message, tokens}]}
│       ├─ author-leaning.json # 同上
│       ├─ orthography.yml     # prh 形式（表記ゆれだけを扱う）
│       └─ .textlintrc.json    # 人が読むための設定。lint はモジュール解決に頼らずこれを読む
├─ skills/onajimi/SKILL.md / skills/onajimi-profile/SKILL.md
└─ notes/
```

root は `--root`、`ONAJIMI_ROOT`、リポジトリの順に決める。プラグインは版ごとのキャッシュに写されるので、筆者のデータはそこに置かない。

## 1. textlint のルール集

### 確認済みの事実（textlint 15.8.0, ai-words-ja 1.2.1）
- textlint-rule-preset-ai-words-ja の `no-ai-words` を、自前の preset の中に別名で 2 つ登録できる。登録すると、それぞれに別の辞書と severity を渡せる。出力上のルール名は `onajimi/hard`・`onajimi/soft` のようになる。これで重大度の 2 段を作れる。
- `--rulesdir` で読ませたルールには、`.textlintrc` のオプションが渡らない（`--print-config` で rule が空になった）。計画の初版は `--rulesdir` 前提だったので変える。ルールは preset のパッケージとして読ませる。
- 辞書の項目は、複数トークンの連なりで書ける。`{surface_form:"静か"},{surface_form:"に"},{basic_form:"壊れる"}` で「静かに壊れ」を拾えた。`{basic_form:"確認"},{basic_form:"する"}` で「確認した」も拾えた。
- 内部の rule は `require("textlint-rule-preset-ai-words-ja").default.rules["no-ai-words"]` で取れる。公開 API ではないので、バージョンを固定する。
- その後、ai-words-ja への依存はやめ、同じ照合（kuromojin + morpheme-match-textlint）を rules/token-leaning.js に持った。辞書の形式と allows の意味（一致した範囲だけを見る）は同じ。組み込み辞書がないので dictionaryMode はなくした。

### ルール
| ルール | 中身 | 既定の severity |
|---|---|---|
| `model-leaning` | モデルは多用するが、筆者はほとんど使わない語・連語。メッセージには筆者側の候補を併記する | error |
| `author-leaning` | モデルが選んだ語に対して、筆者の言い方を示す（例:「確認する」→ 筆者は「確かめる」寄り） | warning |
| `orthography` | 表記ゆれ（できる/出来る など）。textlint-rule-prh をそのまま使う | warning |
| `decoration-density` | 1000 字あたりの太字の数、箇条書きの比率、見出しの密度。`Syntax.Strong` などの AST ノードで数え、文書単位で 1 件だけ返す | warning |
| 文長・読点 | ja-technical-writing の sentence-length / max-ten を使い、しきい値は筆者の分布から入れる | warning |

- 計画の初版にあった `no-ai-phrase`（文字列の indexOf）は作らない。形態素の照合のほうが活用に強く、「お握り」型の誤検出も起きにくい。
- メッセージはモデルに読ませる前提で、短く書く。「〜の可能性があります」のような丁寧な定型文は使わない。
- すべての規則に、引っかかる例と引っかからない例の fixture を付ける（Vale voices の方式）。yomiyasu の edge_cases（MIT）は、誤検出の回帰テストとして取り込む。

## 2. 筆者ごとの設定

- 人が編集するのは `authors/<name>/profile.yml` だけ。`onajimi build` で `generated/` を生成し、`--check` で元データとの食い違いを検出する（aitext-check の方式）。
- profile.yml の中身:
  - `model_leaning`: 語（またはトークン列）、メッセージ、根拠（z 値と出現数）
  - `author_leaning`: モデル側の語、筆者側の語、根拠
  - `orthography`: prh のエントリ
  - `thresholds`: 文長の上限、読点の上限、装飾の密度（プロファイラが提案し、人が確定する）
  - `allow`: 引っかけたくない語
- 根拠の数値は生成物のメッセージには入れない。人が見直すときのためだけに残す。

## 3. 対照コーパスとプロファイラ

### 対照コーパスを作る（`onajimi control`）
- 筆者の記事から見出しの構成と、記事ごとのおおよその字数を取り出す。それを使うモデルに渡して、記事を素で書かせる。
- 生成に使うコマンドは設定で差し替えられるようにする（例: `claude -p`）。スキルと同じモデル・同じ素のプロンプトで作らないと、比べる意味がない。
- プロンプトは「この見出しで、この字数の記事を書いて」程度にとどめ、文体の指示は入れない。
- モデルは 2 系統にする。
  - 主: Opus（`claude -p`）。スキルを実際に使うモデルと揃える。
  - 副: Gemini Flash 系（API の無料枠）。
- 2 つの対照の結果を、次のように分けて扱う。
  - 両方のモデルでずれる語: LLM 共通の癖。model-leaning に入れる候補として、優先度を高くする。
  - Opus だけでずれる語: Opus 特有の癖として別枠に記録する。
- 生成物はプロンプトのハッシュで管理し、プロンプトを変えたら同じコマンドで作り直す。503 は間隔を延ばして再試行し、429 はすぐ止める。
- 対照の先頭のタイトル見出しと副題は、比べる前に外す（筆者の記事にはないので）。
- Gemini の無料枠には回数の制限がある（Flash は 1 日 20 回程度、Flash-Lite は 1 日 500 回程度という報告がある。正式な数字は AI Studio で確認する）。生成は再開できるようにし、出力はキャッシュする。
- API キーは corpus.yml の `key_file` で指したファイルから実行時に読み、ヘッダーで送る。リポジトリやログには書かない。

### プロファイル（`onajimi profile`）
- 地の文の取り出しは、lint と同じ経路で行う（@textlint/markdown-to-ast と textlint-util-to-string）。コード、表、URL、引用は除く（doc-style-skill の prose_segments の考え方）。
- トークン化は kuromojin で行う。照合側と同じトークナイザにして、取り出した語と照合される語がずれないようにする。
- 特徴:
  - v1: 内容語の basic_form のユニグラム
  - v1.1: 隣接 2 語の連なり（機能語を含める。slop-forensics のようにストップワードを除いてから n-gram を作ると、離れた語同士がつながるので、そうはしない）
  - 文末表現、読点直前の語: doc-style-skill の 35 チャネルから、行単位で指摘できるものだけを候補にする
- 統計: Monroe ほか (2008) の情報事前分布つき対数オッズ比。事前分布には両コーパスの合計を使う。
- 頑健性フィルタ: 2 本以上の記事（見出し）に出た語だけを候補にする（slop-forensics の WORD_MIN_PROMPT_IDS）。最小出現数も設ける。
- 出力は候補の TSV（語、z、筆者側の数、モデル側の数、例文）。筆者側とモデル側の語の対応付けは自動でやらない。人が選んで profile.yml に書く。
- しきい値の提案: 筆者の記事ごとの分布から決める。プロファイル用の記事が 1 本も引っかからないように、外側に丸めた順序統計量を使う（doc-style-skill の calibration の考え方）。

## 4. ガード（`onajimi guard before.md after.md`）

- v0 は文書単位で、数値と否定を比べる。
  - 数値: NFKC で正規化し、漢数字も直してから多重集合として比べる。
  - 否定: 義務・推量・慣用の言い方（なければならない、かもしれない、とは限らない、少ない、危ない…）を先に伏せてから数える。
- v2 で、文の対応付けを入れて段落・文単位にする。同一の文を先に組にし、残りは 4 文の窓の中で類似度 0.45 以上のものを組にする。そのうえで、否定の入れ替わり（否定以外の変化が 2 字以内）と助詞の入れ替えを検出する。
- 伏せる語の一覧と判定の核は yomiyasu の diff（MIT）から小さく移植する。ライセンス表記を残す。全体の 1 万行は持ち込まない。

## 5. 薄いスキル

```markdown
---
name: onajimi
description: 日本語の記事を書き終えたあと、指定した筆者の書き癖に寄せる軽い仕上げをする
---
1. 本文はふだんどおり書く。このスキルを理由に書き方を変えない。
2. 書き終えたら draft.md に保存し、`onajimi lint --author <name> draft.md` を実行する。
3. 指摘された箇所だけを直す。直すかどうかは文脈で決め、直さない指摘には理由を一言添える。指摘のない文は変えない。
4. 直した稿を out.md に保存し、`onajimi guard draft.md out.md` を実行する。失敗したら、該当する箇所を元に戻す。
5. lint は再実行しない。残った指摘は一覧にして書き手に返す。
```

- `onajimi lint` は textlint を呼び、指摘を `行:列 ルール メッセージ` の 1 行ずつに詰めて出す。指摘が 0 件なら何も出さない（Vale agent-tools の方式）。
- スキルの本文には、数値も語の一覧も書かない。
- hook での自動実行は v2 以降。入れる場合は 1 ターンに 1 回だけ走るよう制御する。

## 6. 評価

- 筆者の記事は時系列で、プロファイル用とテスト用に分ける。テスト用の記事は、辞書としきい値の調整に一度も使わない。
- 指標:
  1. 誤検出: テスト用の筆者記事 1000 字あたりの指摘数。目標はほぼ 0。
  2. 検出: プロファイルに使っていない見出しでモデルに書かせた文の、1000 字あたりの指摘数。
  3. 近づき具合: スキルを通す前と後で、テスト用コーパスとの対数オッズの距離（上位語の z の重み付き和など）が縮むか。
  4. 壊していないか: ガードの検出数と、人が抜き取りで確認した内容の変化。
- A/B/C 比較（slop-skill-audit と同じ形）:
  - A: 素のモデル
  - B: 「この筆者の文体に寄せて」という一行の指示と、筆者の記事数本を例として渡す
  - C: このスキル
  - 費用・時間も記録する。C が B に勝てなければ、そう書く。
- 最後に人が、どれが筆者の文かを伏せた状態で読み比べる（少数でよい）。

## 7. 進め方

### v0: 動く最小限
- リポジトリの骨組み。textlint 15.8.0 と ai-words-ja 1.2.1 を固定する。
- preset（model-leaning と author-leaning は手書きの小さい辞書で動かす。decoration-density も入れる）と fixture テスト
- `onajimi lint` と `onajimi guard`（文書単位）
- SKILL.md
- 動作確認: 筆者の記事 3 本と、モデル出力 3 本に lint をかけて目で見る

### v1: プロファイラ
- `control`・`profile`・`build --check`
- しきい値の提案
- `eval` の 1〜3 と A/B/C の準備

### v2: 精度
- ガードを文単位にし、助詞の入れ替えも見る
- 2 語の連なりと文末表現の特徴を入れる
- hook（任意）

## 筆者コーパス（ama.ne.jp、2026-11-01 時点）
- `https://ama.ne.jp/index.md` から、全記事の Markdown（`post/*.md`）を取れる。全 253 本で、本文はおよそ 133 万字（コードブロックを除く）。
- frontmatter: title, author, summary, date, category, license (CC BY 4.0), rating。212 本には `ai_summary` と `ai_keywords` も付いている。frontmatter は解析の対象から外す。
- category 別の本数と字数:

  | category | 本数 | 字数 | 中身 |
  |---|---|---|---|
  | ugoki | 78 | 39 万字 | 日々の話題 |
  | lily | 70 | 59 万字 | 小説 |
  | tech | 56 | 25 万字 | 技術 |
  | report | 38 | 6 万字 | 定期レポート |
  | shuzai / drawing / doll | 11 | 4 万字 | その他 |

- author が `stewpot` の記事が 7 本ある。名義が違うので、別の筆者として扱う。
- 記事は 2015 年から 2026 年までにわたる。文体は年によって変わっている可能性がある。プロファイル用とテスト用は時系列で分け、古い記事は重みを下げるか除く。
- 小説と記事では書きぶりがまったく違う。category（register）ごとに別のプロファイルを作る。
- AI が書いた文の除外。ogpai-2025 に、「AI による出力例と分かる部分」と「ほかの名義の部分」は AI が生成していることがある、と明記されている。
  - 「色がきれいなよもぎもち」名義の節は除く。my-2025 の見出し「あまねけ！2025 by 色がきれいなよもぎもち（おまけ）」から記事の末尾まで。
  - 記事の中で示している AI の出力例は除く。引用ブロックとコードブロックは丸ごと解析しない。それ以外の書き方の出力例は、取得したあとで抜き取って確認し、除外リスト（記事と見出しの組）に足す。
- 最初に作るのは、tech と ugoki を合わせた「記事」のプロファイル。lily（小説）は見出しがなく対照の作り方が違うので、あとで別に作る。
- コーパスはリポジトリに入れない。取得スクリプトで `authors/<name>/corpus/` に落とし、gitignore する。

## 初版の辞書づくりでわかったこと（2026-11-01）
- 辞書（model_leaning）に入れられるのは、筆者がほぼ使わない語だけ。筆者も使っていて頻度だけが違う語（「た。」「を、」など）は、語ごとに lint すると筆者の文にも指摘が出る。こうした語は文書単位の密度ルールにする（未実装）。そのために、記事ごとの頻度の分布から、しきい値を決める処理が要る。
- v0 で手書きした「AI っぽい語」（静かに壊れる、鍵を握る、時間を溶かす）は、opus・gemini の 172 本にほぼ出なかった。思い込みで選んだ語は根拠にならない。
- いちばん強く出たのは表記の差（全て/すべて、気付く/気づく、分かる/わかる、様々/さまざま）。
- 同じ語でも、ジャンル（register）で使い方が変わる。ふと・思わず は記事ではほぼ使わないが、小説では多い。
- 1 語の一致だけでは、意味の違いを分けられない。「どこか」の場所の意味と婉曲の意味、「大切にする」と「大切だ」の違いなど。そのため、メッセージで判断を書き手に委ねている。
- 対照の指示に ai_summary を渡すと、要約の語が対照側に写り込む恐れがある。今回は「試み」が要約 3 本に出ていたので外した。ツール側の対策（未実装）:
  - candidates に「指示に含まれていた文書数」の列を足す。
  - 指示に含まれていた語は proposal から外すか、印を付ける。

## 手作業をツールにした（2026-11-01）
- 記事は profile / dev / test の 3 つに分ける。辞書の誤検出は dev で見て、test は最後の評価にだけ使う。amane の test 22 本は前の分け方と同じ。
- 表記の組、後ろに続く語、指示への混入（`in_brief_docs` と `excluded_in_brief`）、他ジャンルでの頻度、密度ルール（`phrase-density`）と短い文書の除外（`min_chars`）を profile と preset に入れた。太字ラベルの箇条書きと斜体の割合も decoration-density で見る。
- `onajimi review` が、人や AI が一度で読める review.md にまとめる。`onajimi pipeline` が split から review までを通し、`onajimi init` がひな形を書く。
- わかったこと: 様々/さまざま は gemini が筆者と同じく「様々」を選ぶので、「どの runner も」の条件では出ない。斜体の割合は筆者自身の記事でも 0 から 1 まで散らばっていて、文書単位のしきい値では筆者とモデルを分けられない。

## test の汚染（2026-11-01）
- amane の test 22 本は、初版の辞書を作るときに誤検出を見ている（大切・どこか・ふと）。第 2 版でこの 3 語を外した根拠は、指示への混入と dev での誤検出だが、test で見た記憶が判断に入った可能性は否定できない。3 語を残していれば、test の誤検出は 0.12 ではなく 0.17 前後だったはず。
- そのため、この 22 本は「一度見た test」として扱う。A/B/C 比較には使うが、結果には注記を付ける（C に少し有利な向き）。
- 2026-10-28 以降に公開する tech/ugoki の記事は test2 として取っておく。辞書の調整にも dev の確認にも使わない。数本たまったら、test2 で A/B/C を回し直す。
- test と test2 は、lint の結果も含めて最後の評価まで見ない。
- test2 は corpus.yml の `holdout_after: 2026-10-27` と split.yml の `holdout` にした（下の節）。

## スキルだけで辞書を作らせてみた（2026-11-01）
- 別のエージェントに skills/onajimi-profile だけを渡して辞書を作らせた。表記としきい値は人が作ったものと同じになり、語（model_leaning・density）はまったく食い違った。報告された問題と手当て:
  - 費用の確認がない: `pipeline` と `control` は生成するものがあれば見積もりを出して 5 で止まり、`--yes` でだけ生成する。`--estimate` で見積もりだけを出せる。
  - 新しい記事の置き場所がない: `holdout_after` と split.yml の `holdout`。split は分けた記事を動かさず、新しい記事を holdout に足す。amane の profile/dev/test は前と同じ。
  - 提案を写す手間と写し間違い: review.md の番号（M・O・R・D・T）と `onajimi accept`。
  - dev の指摘の場所が分からず、生の記事に lint をかけてゲストの節の指摘を拾った: `eval --set dev --details` が eval と同じ除外で行ごとに出す。test と holdout には使えない。lint はファイルをそのまま見ると README に書いた。
  - 「指示」の列が を+、 などの機能語にも数字を出し、外す理由になっていた: 内容語を含む特徴だけで数える。
  - dev での使用が review.md から分からなかった: model_leaning と density の行に dev の回数を出す。
- コーパスの混入（筆者でない段落）を見つける簡単な決まりは見つからなかった。二人称（あなた）は amane の記事で 40 段落以上あり、筆者の書き方そのものだった。署名つきの見出し（by 〜）は my-2025 しかなく、もう除外している。そのため、混入はスキルの手順（dev の指摘が筆者の文でなさそうなら exclude_sections に足すよう人に伝える）に任せた。

## 決まったこと
- 最初の筆者コーパス: ama.ne.jp のブログ記事（Markdown 原稿）
- 対照に使うモデル: Opus（主）と Gemini Flash 系（副）
- 配布: ローカルだけ。リポジトリは private にする。npm には公開しない。

## 実装の約束
- 言語は JavaScript。textlint 側は CJS、CLI は ESM。ビルドはなし。テストは node:test。
- コメントは原則書かない。
- 外部の実装を移植するときは、出典とライセンスを記録する。
