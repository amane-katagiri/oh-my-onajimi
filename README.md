# oh-my-onajimi

まともな日本語を書けるモデルの一発書きを、特定の筆者の好みに少しだけ近づけるための道具。文章の質そのものを上げる道具ではない。モデルには本文を普段どおり書かせ、`onajimi lint` で引っかかった箇所だけを直させ、`onajimi guard` で数値と否定が変わっていないかを確かめる。

設計は [notes/plan.md](notes/plan.md)、先行実装の調査は [notes/prior-art.md](notes/prior-art.md)。

## 構成

```
packages/textlint-rule-preset-onajimi/  textlint のルール集（model-leaning / author-leaning / decoration-density / phrase-density）
packages/onajimi/                        CLI（build / lint / guard）
authors/<name>/profile.yml               人が編集する唯一の元データ
authors/<name>/corpus.yml                コーパスの選び方・除外・対照の生成コマンド・プロファイラの設定
authors/<name>/split.yml                 プロファイル用・dev 用・テスト用の記事（onajimi split で一度だけ作る）
authors/<name>/profile/                  profile と review の出力（candidates.tsv・proposal.yml・thresholds.yml・review.md）
authors/<name>/generated/                build の出力（手で編集しない）
authors/<name>/corpus/                   筆者の記事と対照（_control/<runner>/）。gitignore
skills/onajimi/SKILL.md                   薄いスキル（書いた記事を筆者に寄せる）
skills/onajimi-profile/SKILL.md           プロファイルを人と決めるためのスキル
```

## 新しい筆者のプロファイルを作る

```sh
npx onajimi init --author alice --posts ~/blog/content/post   # corpus.yml のひな形と空の profile.yml
# corpus.yml の posts・select・control.runners を直す
npx onajimi pipeline --author alice   # split → control（全 runner、再開できる）→ profile → build → review
```

`pipeline` は split.yml がなければ作り、全 runner の対照を全記事ぶん作る（`--limit n` は 1 回で新しく作る数、`--delay` は間隔）。どれかの runner が止まったら profile に進まず、3（回数制限）か 4（混雑）で終わるので、同じコマンドで再開する。最後に `authors/<name>/profile/review.md` を書く。これを読んで profile.yml を決め、`build` と `eval --set dev` で確かめる（skills/onajimi-profile）。test は最後に一度だけ使う。

## 使い方

Node 26 以降。

```sh
npm install
npm test

npx onajimi build --author amane           # profile.yml から generated/ を作る
npx onajimi build --author amane --check   # generated/ が古ければ 1 で終わる
npx onajimi lint --author amane draft.md   # 指摘を「行:列 ルール名 メッセージ」で 1 行ずつ出す。0 件なら何も出さない
npx onajimi guard draft.md out.md          # 数値と否定の数が変わっていれば 1 で終わる

npx onajimi split --author amane           # 記事を選び、新しい test_ratio をテスト用、その前の dev_ratio を dev 用にして split.yml に書く
npx onajimi corpus --author amane          # プロファイル用・dev 用・テスト用の本数と字数
npx onajimi control --author amane --runner opus --dry-run          # 対照のプロンプトを見るだけ
npx onajimi control --author amane --runner opus [--set profile|dev|test|all] [--only a,b] [--limit n]
npx onajimi profile --author amane [--paired]   # profile/ に候補・提案・しきい値を書く
npx onajimi review --author amane          # profile/review.md（提案のまとめと、今の profile.yml での dev の指摘）
npx onajimi eval --author amane [--set dev]   # 誤検出と対照での検出（1000 字あたり）。既定は test
```

`control` は出力を `corpus/_control/<runner>/<slug>.md` に、モデル名・プロンプトのハッシュ・所要時間・試行回数を同名の `.json` に置く。出力済みでプロンプトのハッシュが今と同じ記事は飛ばし、ハッシュが違う（または `.json` がない）記事は作り直す。止まっても同じコマンドで続きから再開できる。混雑（gemini の 503、runner の `unavailable` に一致した失敗）は `retry_delays_seconds` の間隔で再試行し、それでも駄目なら止まって 4 で終わる。回数制限（429、`rate_limit` に一致した失敗）はすぐ止まって 3 で終わる。runner は `command`（stdin にプロンプトを渡す。引数に `{prompt}` があればそこに入れる）か、`api: gemini`（`key_file` から API キーを読み、ヘッダーで送る）で書く。

`profile` は Monroe ほか (2008) の情報事前分布つき対数オッズ比で、筆者のプロファイル用記事と各 runner の対照を比べる。z が負ほどモデル寄り。対照の先頭にあるタイトルと同じ見出しと、その直後の太字だけの副題（またはサブタイトルと同じ見出し）は、profile と eval の前に外す。ASCII だけのトークン（`x`・`U`・`Web` など）はユニグラムに入れず、両側が ASCII だけのバイグラムも作らない。`candidates.tsv` には、どれかの runner で |z| ≥ 2 の行だけを書く。全行は `profile/_full/candidates.tsv`（gitignore）に書く。`proposal.yml` は profile.yml に写す前の下書きで、自動では profile.yml を書き換えない。

`profile` はほかに次を出す。
- 表記の組（`orthography`）: kuromoji の基本形の読みと品詞が同じで、表記（かな・漢字・送り仮名）だけが違う語の組。筆者が一方をほぼ必ず選び、どの runner も他方を多く選ぶ組を、prh のエントリ（`expected` が筆者の表記）として出す。活用する語は語幹と先読みの正規表現にする。漢字が食い違う組（機械/機会）は出さない。1 字の漢字の語や、品詞の細分類が違う組は、別の語のことがあるので `orthography_review` に分ける。
- 後ろに続く語: candidates の `author_next`・`control_next` と evidence に、直後の語（基本形/品詞）の上位 3 つ。
- 指示への混入: 対照の指示（brief から作り直したプロンプト）に、候補のモデル側の表記が入っていた記事の数（`in_brief_docs`）。漢字・カタカナの語の一部に当たっただけのもの（ブログの「ログ」）は数えない。1 以上の候補は `model_leaning` から `excluded_in_brief` に移す。
- 他ジャンル: 選んでいないカテゴリーの同じ筆者の記事での 1000 字あたりの頻度（`author_other_per_1000`）。対照の頻度以上なら提案に `note` を付ける。
- 密度（`density`）: `rate_differences` の語ごとに、`min_chars` 字以上のプロファイル用記事の 1000 字あたりの頻度から、どの記事も超えない値を出す。対照の記事で何本が引っかかるかも出す。
- しきい値: 太字の密度は `min_chars` 字以上の記事だけで決める。太字のラベルと「:」で始まる箇条書きの数、斜体の割合（強調 `emphasis_min_marks` 個以上の記事だけ）も出す。thresholds.yml の `controls` に対照の記事ごとの値がある。

`lint` は、先頭の `key: value` だけが並ぶブロック（区切りのない frontmatter）を読み飛ばす。`---` で囲んだ frontmatter は textlint の Markdown パーサーが外す。

## profile.yml

| キー | 中身 |
|---|---|
| `note` | メモ。生成物には入らない |
| `model_leaning` | `tokens`（kuromoji の形態素条件の並び）、`message`、任意の `evidence`。error |
| `author_leaning` | `tokens`、`author`（筆者側の言い方）、任意の `message` と `evidence`。warning |
| `orthography` | textlint-rule-prh のエントリ（`expected` と `pattern`/`patterns`）。warning |
| `density` | `tokens`、`max_per_1000`、`message`、任意の `min_chars`（なければ `thresholds.density_min_chars`）・`typical_per_1000`・`note`・`evidence`。地の文 1000 字あたりの出現数が `max_per_1000` を超えた文書に 1 件だけ出す。`min_chars` 字未満の文書には出さない。warning |
| `thresholds` | 下の表。書かなかった項目の検査は止まる |
| `allow` | 一致した範囲がこの文字列（`/正規表現/` も可）を含むとき、leaning の指摘を出さない |

| しきい値 | 中身 |
|---|---|
| `sentence_length`・`max_ten` | 文の長さと 1 文の読点の上限 |
| `bold_per_1000`・`decoration_min_chars` | 1000 字あたりの太字の上限。`decoration_min_chars` 字未満の文書では見ない |
| `list_ratio` | 地の文に占める箇条書きの比率の上限 |
| `bold_label_items` | 「- **ラベル**: 説明」型の箇条書きの数の上限（0 なら 1 個目から）。超えた文書では 1 個ずつ指摘する |
| `emphasis_share_min`・`emphasis_min_marks`・`emphasis_share_typical` | 強調（太字と斜体）が `emphasis_min_marks` 個以上の文書で、斜体の割合がこれを下回ったら 1 件出す。`emphasis_share_typical` は筆者のふだんの値としてメッセージに入る |
| `density_min_chars` | `density` の `min_chars` の既定値 |

`evidence` と `note` は人が見直すためだけに残し、指摘のメッセージには入れない。

## corpus.yml

| キー | 中身 |
|---|---|
| `posts` | 記事の Markdown を置いたディレクトリ（corpus.yml からの相対、`~/` 可）。既定は `corpus/post`。frontmatter は `key: value` の並びか `---` で囲んだ YAML |
| `select` | `author`・`categories`・`since`（YYYY-MM-DD）。書かなかった条件では絞らない。`categories` を書くと、それ以外のカテゴリーの同じ筆者の記事を「他ジャンル」として数える |
| `test_ratio`・`dev_ratio` | 新しい順にテスト用・dev 用にする割合（全体に対する割合。既定 0.25・0.1） |
| `exclude_sections`・`skip_paragraphs` | 解析から外す節と段落 |
| `control` | 対照のプロンプトのひな形と runner |
| `profile` | `alpha0`・`min_docs`・`min_count`・`proposal_z`・`proposal_max_author_docs`・`rate_z`・`proposal_limit`・`min_chars`・`emphasis_min_marks`・`orthography_min_count`・`orthography_min_share`・`orthography_z`・`orthography_limit`・`hint_z`・`hint_limit` |

## ライセンス

`packages/onajimi/src/guard.js` の一部は yomiyasu（MIT）からの移植。[NOTICE](NOTICE) を参照。
