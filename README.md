# oh-my-onajimi

まともな日本語を書けるモデルの一発書きを、特定の筆者の好みに少しだけ近づけるための道具。文章の質そのものを上げる道具ではない。モデルには本文を普段どおり書かせ、`onajimi lint` で引っかかった箇所だけを直させ、`onajimi guard` で数値と否定が変わっていないかを確かめる。

設計は [notes/plan.md](notes/plan.md)、先行実装の調査は [notes/prior-art.md](notes/prior-art.md)。

## 構成

```
.claude-plugin/plugin.json               Claude Code プラグインのマニフェスト
.claude-plugin/marketplace.json          ローカルで試すためのマーケットプレイス（このディレクトリ自体をプラグインとして載せる）
bin/onajimi                              CLI の入口（プラグインが有効なあいだ Bash の PATH に入る）
packages/textlint-rule-preset-onajimi/  textlint のルール集（model-leaning / author-leaning / decoration-density / phrase-density）。単体でも配れる形
packages/onajimi/                        CLI（build / lint / guard など）。ルール集は相対パスで読む
authors/<name>/profile.yml               人が編集する唯一の元データ
authors/<name>/corpus.yml                コーパスの選び方・除外・対照の生成コマンド・プロファイラの設定
authors/<name>/split.yml                 プロファイル用・dev 用・テスト用・holdout の記事（onajimi split が作り、2 回目からは新しい記事を holdout に足すだけ）
authors/<name>/profile/                  profile と review の出力（candidates.tsv・proposal.yml・thresholds.yml・review.md）
authors/<name>/generated/                build の出力（手で編集しない）
authors/<name>/corpus/                   筆者の記事と対照（_control/<runner>/）。gitignore
skills/onajimi/SKILL.md                   薄いスキル（書いた記事を筆者に寄せる）
skills/onajimi-profile/SKILL.md           プロファイルを人と決めるためのスキル
```

## Claude Code プラグインとして入れる

```sh
npm ci                                                  # ローカルのパスから入れるときは依存が自動では入らない
claude plugin marketplace add ./                        # このリポジトリのルートで
claude plugin install onajimi@oh-my-onajimi
```

Git のリポジトリから入れたとき（`/plugin marketplace add <owner>/<repo>` のあと `/plugin install onajimi@oh-my-onajimi`）は、package-lock.json に沿って依存が自動で入る。

筆者のデータは、プラグインのデータディレクトリ `${CLAUDE_PLUGIN_DATA}`（`~/.claude/plugins/data/<プラグインの ID>/`、更新しても残る）の `authors/<name>/` に置く。スキルは CLI に `--root ${CLAUDE_PLUGIN_DATA}` を渡す。このリポジトリにある筆者のプロファイルは、次のように写す。

```sh
bin/onajimi import --root ~/.claude/plugins/data/onajimi-oh-my-onajimi --from . --author amane
```

`import` は `--from` の root から profile.yml・corpus.yml・split.yml・profile/（`_full/` を除く）を写し、写した先で build する。corpus/（記事と対照）は写さない。写した先にもうあれば止まる。新しい筆者は `init --root <データディレクトリ>` から作る。

CLI の root（`authors/` のあるディレクトリ）は、`--root`、環境変数 `ONAJIMI_ROOT`、このリポジトリの順に決まる。

## 新しい筆者のプロファイルを作る

```sh
bin/onajimi init --author alice --posts ~/blog/content/post   # corpus.yml のひな形と空の profile.yml
# corpus.yml の posts・select・control.runners を直す
bin/onajimi pipeline --author alice --estimate   # 生成する数・目標字数・時間・費用の見積もりだけを出す
bin/onajimi pipeline --author alice --yes        # split → control（全 runner、再開できる）→ profile → build → review
bin/onajimi accept --author alice M3 O2 'D5=「〜の中」を減らす。' T   # review.md の番号を profile.yml に足して build
bin/onajimi eval --author alice --set dev --details
```

`pipeline` は split を更新し（分けた記事は動かさない）、全 runner の対照を全記事ぶん作る（`--limit n` は 1 回で新しく作る数、`--delay` は間隔）。生成するものが 1 本でもあるのに `--yes` がなければ、見積もりを出して何も書かずに 5 で終わる。`--estimate` は見積もりだけを出して 0 で終わる（split.yml も書かない）。どれかの runner が止まったら profile に進まず、3（回数制限）か 4（混雑）で終わるので、同じコマンドで再開する。最後に `authors/<name>/profile/review.md` を書く。これを読んで profile.yml を決め、`accept` で足し、`eval --set dev --details` で確かめる（skills/onajimi-profile）。test は最後に一度だけ、holdout は人が頼んだときだけ使う。

見積もりの時間と出力トークンは、その runner の過去の出力（`.json` の `duration_ms` と出力トークン数）の平均から出す。過去の出力がなければ時間は不明とし、トークンは 1 字 2.5 トークンの仮の換算にする。費用は runner に `price`（出力 100 万トークンあたりの USD）を書いたときだけ出し、入力の費用は数えない。

## 使い方

Node 26 以降。

```sh
npm ci
npm test

bin/onajimi build --author amane           # profile.yml から generated/ を作る
bin/onajimi build --author amane --check   # generated/ が古ければ 1 で終わる
bin/onajimi lint --author amane draft.md   # 指摘を「行:列 ルール名 メッセージ」で 1 行ずつ出す。0 件なら何も出さない（corpus.yml の除外は当てない）
bin/onajimi guard draft.md out.md          # 数値と否定の数が変わっていれば 1 で終わる

bin/onajimi split --author amane           # 記事を選び、holdout_after より新しい記事を holdout、残りの新しい test_ratio をテスト用、その前の dev_ratio を dev 用にして split.yml に書く
bin/onajimi corpus --author amane          # プロファイル用・dev 用・テスト用・holdout の本数と字数
bin/onajimi control --author amane --runner opus --dry-run          # 対照のプロンプトを見るだけ
bin/onajimi control --author amane --runner opus [--set profile|dev|test|holdout|all] [--only a,b] [--limit n] [--estimate] [--yes]   # --yes なしで生成するものがあれば、見積もりを出して 5 で終わる
bin/onajimi profile --author amane [--paired]   # profile/ に候補・提案・しきい値を書く
bin/onajimi review --author amane          # profile/review.md（番号つきの提案と、今の profile.yml での dev の指摘）
bin/onajimi accept --author amane <番号...>  # 提案を profile.yml に足して build する
bin/onajimi eval --author amane [--set dev|profile|test|holdout] [--details]   # 誤検出と対照での検出（1000 字あたり）。既定は test
```

`control` も `pipeline` と同じく、生成するもの（新規か作り直し）があるのに `--yes` がなければ見積もりを出して何も生成せずに 5 で終わる（`--estimate` と `--dry-run` は `--yes` なしで動く）。`control` は出力を `corpus/_control/<runner>/<slug>.md` に、モデル名・プロンプトのハッシュ・所要時間・試行回数を同名の `.json` に置く。出力済みでプロンプトのハッシュが今と同じ記事は飛ばし、ハッシュが違う（または `.json` がない）記事は作り直す。止まっても同じコマンドで続きから再開できる。混雑（gemini の 503、runner の `unavailable` に一致した失敗）は `retry_delays_seconds` の間隔で再試行し、それでも駄目なら止まって 4 で終わる。回数制限（429、`rate_limit` に一致した失敗）はすぐ止まって 3 で終わる。runner は `command`（stdin にプロンプトを渡す。引数に `{prompt}` があればそこに入れる）か、`api: gemini`（`key_file` から API キーを読み、ヘッダーで送る）で書く。

`profile` は Monroe ほか (2008) の情報事前分布つき対数オッズ比で、筆者のプロファイル用記事と各 runner の対照を比べる。z が負ほどモデル寄り。対照の先頭にあるタイトルと同じ見出しと、その直後の太字だけの副題（またはサブタイトルと同じ見出し）は、profile と eval の前に外す。ASCII だけのトークン（`x`・`U`・`Web` など）はユニグラムに入れず、両側が ASCII だけのバイグラムも作らない。`candidates.tsv` には、どれかの runner で |z| ≥ 2 の行だけを書く。全行は `profile/_full/candidates.tsv` に書く。`profile/` と `generated/` は作り直せる出力なので git では追跡しない（追跡するのは人が書く profile.yml・corpus.yml・split.yml だけ）。`proposal.yml` は profile.yml に写す前の下書きで、自動では profile.yml を書き換えない。

`profile` はほかに次を出す。
- 表記の組（`orthography`）: kuromoji の基本形の読みと品詞が同じで、表記（かな・漢字・送り仮名）だけが違う語の組。筆者が一方をほぼ必ず選び、どの runner も他方を多く選ぶ組を、prh のエントリ（`expected` が筆者の表記）として出す。活用する語は語幹と先読みの正規表現にする。漢字が食い違う組（機械/機会）は出さない。1 字の漢字の語や、品詞の細分類が違う組は、別の語のことがあるので `orthography_review` に分ける。
- 後ろに続く語: candidates の `author_next`・`control_next` と evidence に、直後の語（基本形/品詞）の上位 3 つ。
- 指示への混入: 対照の指示（brief から作り直したプロンプト）に、候補のモデル側の表記が入っていた記事の数（`in_brief_docs`）。内容語を含む特徴だけで数え、助詞・記号だけの特徴は数えない（- と出し、外さない）。漢字・カタカナの語の一部に当たっただけのもの（ブログの「ログ」）は数えない。1 以上の候補は `model_leaning` から `excluded_in_brief` に移す。
- 他ジャンル: 選んでいないカテゴリーの同じ筆者の記事での 1000 字あたりの頻度（`author_other_per_1000`）。対照の頻度以上なら提案に `note` を付ける。
- 密度（`density`）: `rate_differences` の語ごとに、`min_chars` 字以上のプロファイル用記事の 1000 字あたりの頻度から、どの記事も超えない値を出す。対照の記事で何本が引っかかるかも出す。
- しきい値: 太字の密度は `min_chars` 字以上の記事だけで決める。太字のラベルと「:」で始まる箇条書きの数、斜体の割合（強調 `emphasis_min_marks` 個以上の記事だけ）も出す。thresholds.yml の `controls` に対照の記事ごとの値がある。

`lint` は、先頭の `key: value` だけが並ぶブロック（区切りのない frontmatter）を読み飛ばす。`---` で囲んだ frontmatter は textlint の Markdown パーサーが外す。`lint` は渡されたファイルをそのまま見るので、コーパスの記事に直接かけると `exclude_sections` や引用・表の除外が当たらない。コーパスの記事の指摘は `eval --set dev --details` で見る。これは eval と同じ除外（`exclude_sections`、引用・表・HTML・コードの行）を当て、指摘を `slug:行 ルール メッセージ ｜ 行の文（60 字まで）` で 1 行ずつ出す。test と holdout には `--details` を使えない。

`split` は、split.yml がなければ記事を分けて書く。split.yml に profile・dev・test・holdout のどれかがなければ、split も読む側のコマンドもエラーで止まる（古い split.yml は直さない）。あれば、もう分けた記事は動かさず、まだどこにもない記事（新しく公開した記事など）だけを holdout に足す。holdout は test と同じく review.md に出さず、辞書の調整にも使わない。

`review` は、提案に番号を振る。M は model_leaning、O は orthography、R は orthography_review、D は density、T.<項目> はしきい値。model_leaning と density の行には、筆者の dev の記事での回数（density は 1000 字あたりの最大と、目安を超える記事の数）を出す。「指示」の列は、内容語（名詞・動詞・形容詞・副詞。非自立・接尾・数を除く）を含む特徴だけで数え、助詞や記号だけの特徴（を+、、た+。など）は - にして指示を理由に外さない。

`accept` は番号の項目を profile.yml の該当する節の末尾に足し（tokens・message・note・evidence などを写す。YAML のアンカーは使わない）、build する。ほかの項目と並びは変えない。`M3=メッセージ` で message を差し替え、`T.<項目>=値` で提案と違う値にする。`T` だけなら、検査が止まる値（値がない項目と、斜体の割合が 0 のときの emphasis_*）を除いた提案のしきい値をまとめて足す。同じ tokens（orthography は同じ expected と pattern）やもう書いたしきい値があれば、何も書かずに 2 で終わる。番号は proposal.yml の `id` なので、profile をやり直したら review.md を読み直す。

## profile.yml

| キー | 中身 |
|---|---|
| `note` | メモ。生成物には入らない |
| `model_leaning` | `tokens`（kuromoji の形態素条件の並び）、`message`、任意の `evidence`。error |
| `author_leaning` | `tokens`、`author`（筆者側の言い方）、任意の `message` と `evidence`。warning |
| `orthography` | textlint-rule-prh のエントリ（`expected` と `pattern`/`patterns`）、任意の `note` と `evidence`。warning |
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
| `test_ratio`・`dev_ratio` | 新しい順にテスト用・dev 用にする割合（holdout を除いた全体に対する割合。既定 0.25・0.1） |
| `holdout_after` | この日付（YYYY-MM-DD）より後の記事を、最初の split で holdout にする。2 回目からの split は日付によらず新しい記事を holdout に足す |
| `exclude_sections`・`skip_paragraphs` | 解析から外す節と段落 |
| `control` | 対照のプロンプトのひな形と runner。runner には任意で `price`（出力 100 万トークンあたりの USD。見積もりに使う） |
| `profile` | `alpha0`・`min_docs`・`min_count`・`proposal_z`・`proposal_max_author_docs`・`rate_z`・`proposal_limit`・`min_chars`・`emphasis_min_marks`・`orthography_min_count`・`orthography_min_share`・`orthography_z`・`orthography_limit`・`hint_z`・`hint_limit` |

## ライセンス

MIT（[LICENSE](LICENSE)）。`packages/onajimi/src/guard.js` の一部は yomiyasu（MIT）、`packages/textlint-rule-preset-onajimi/rules/token-leaning.js` の一部は textlint-rule-preset-ai-words-ja（MIT）からの移植。[NOTICE](NOTICE) を参照。
