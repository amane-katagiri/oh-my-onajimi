# リファレンス

README で省いた細かい話をまとめたページです。仕組みの全体と最初の使い方は [README](../README.md) を先に読んでください。

## ディレクトリの構成

```
.claude-plugin/plugin.json               Claude Code プラグインのマニフェスト
.claude-plugin/marketplace.json          ローカルで試すためのマーケットプレイス（このディレクトリ自体を載せる）
bin/onajimi                              リポジトリとプラグインから使う CLI の入口
packages/textlint-rule-preset-onajimi/  textlint のルール集
packages/onajimi/                        CLI
skills/onajimi/                          記事を筆者に寄せるスキル
skills/onajimi-profile/                  プロファイルを作るスキル
authors/amane/                           例として置いている作者のプロファイル（下の構成と同じ）
```

筆者のデータは、root（次の節）の下に次の形で置きます。

```
<root>/authors/<name>/profile.yml        辞書としきい値（人が書く）
<root>/authors/<name>/corpus.yml         記事の選び方・除外・比較用の記事の生成方法・プロファイラの設定（人が書く）
<root>/authors/<name>/split.yml          記事の分け方（onajimi split が作り、そのあとは固定）
<root>/authors/<name>/profile/           profile と review の出力
<root>/authors/<name>/generated/         build の出力（手で編集しない）
<root>/authors/<name>/corpus/            筆者の記事と、比較用に書かせた記事（_control/<runner>/）
<root>/authors/<name>/experiments/abc/   onajimi abc の B・C・BC の出力と report.md
```

このリポジトリの `authors/` で git が追跡するのは、人が書く `profile.yml`・`corpus.yml`・`split.yml` だけです。`profile/`・`generated/`・`corpus/`・`experiments/` は作り直せる出力か、リポジトリに入れたくないデータなので無視しています。

## データの置き場所（root）

CLI は `<root>/authors/<name>/` を読み書きします。root は次の順に決まります。

1. `--root <dir>`
2. 環境変数 `ONAJIMI_ROOT`
3. `${XDG_DATA_HOME:-~/.local/share}/onajimi`（`XDG_DATA_HOME` が絶対パスでなければ `~/.local/share` を使います）

リポジトリの `bin/onajimi`、npm で入れた `onajimi`、プラグインのスキルのどれも同じ順で決まります。スキルは `--root` を渡さないので、場所を変えるには `ONAJIMI_ROOT` を `~/.bashrc` か Claude Code の settings.json の `env` で設定します（Claude Code の Bash ツールはシェルの設定を読み込みます）。`onajimi root` は、使う root と、それがどれで決まったかを出します。

Claude Code のプラグイン用データディレクトリ（`${CLAUDE_PLUGIN_DATA}`）は使いません。プラグインを外すと既定で消えますが、筆者のデータには生成にお金と時間のかかる比較用の記事と、人が選んで作った辞書が入っているからです。

`init` と `import` 以外のコマンドは、筆者のディレクトリがないとエラーで止まります。

このリポジトリの例のプロファイルと root のあいだでは、`import` で写します。

```sh
bin/onajimi import --from . --author amane                                          # リポジトリ → root
bin/onajimi import --root . --from ~/.local/share/onajimi --author amane --force    # root → リポジトリ（書き戻し）
```

## プロファイルを手で作る流れ

`onajimi-profile` スキルを使わずに進めるときの流れです。

```sh
bin/onajimi init --author alice --posts ~/blog/content/post   # corpus.yml のひな形と空の profile.yml
# corpus.yml の posts・select・control.runners を書く
bin/onajimi pipeline --author alice --estimate   # 生成する本数・字数・時間・費用の目安だけを出す
bin/onajimi pipeline --author alice --yes        # split → 比較用の記事の生成 → profile → build → review
# <root>/authors/alice/profile/review.md を読み、採用する番号を決める
bin/onajimi accept --author alice O1 O2 'D5=「〜の中」を減らす。' T
bin/onajimi eval --author alice --set dev --details   # 筆者の確認用の記事での誤検出を 1 件ずつ見る
bin/onajimi eval --author alice                       # 最後に 1 回だけ、テスト用で評価する
```

## コマンド

全てのコマンドに `--root <dir>` を付けられます。引数なしで `bin/onajimi` を実行すると、使い方が出ます。

| コマンド | 何をするか |
|---|---|
| `root` | 使う root と、それが `--root`・`ONAJIMI_ROOT`・既定値のどれで決まったかを出す |
| `init --author <name> [--posts <dir>]` | corpus.yml のひな形と空の profile.yml を作る |
| `import --author <name> --from <dir> [--force]` | 別の root から profile.yml・corpus.yml・split.yml・profile/ を写し、build する。corpus/ と profile/_full/ は写さない。写し先にもうあれば止まる。`--force` を付けると上書きする（写し先の profile/ は _full/ を残して入れ替え、corpus/ には触らない） |
| `build --author <name> [--check]` | profile.yml から generated/ を作る。`--check` は generated/ が古ければ 1 で終わる |
| `lint --author <name> <file>` | ファイルをそのまま検査する |
| `guard <before> <after>` | 数値、否定の数、問いの文と推量の文の数が変わっていないかを見る。問いは「か。」「か？」「？」「?」で終わる文と「〜ではないかと思う」の形、推量は「だろう」「でしょう」「かもしれない」「らしい」「ようだ」で終わる文（どちらもインラインコードの中は見ない） |
| `split --author <name>` | 記事を選んで分け、split.yml に書く |
| `corpus --author <name>` | 分けた記事の本数と字数を出す |
| `control --author <name> --runner <name> [...]` | 比較用の記事を書かせる |
| `profile --author <name> [--paired] [--out <dir>]` | 候補・提案・しきい値を profile/ に書く |
| `review --author <name>` | profile/review.md を書く |
| `pipeline --author <name> [...]` | split → control（全 runner）→ profile → build → review を通す |
| `accept --author <name> <番号...>` | review.md の番号の候補を profile.yml に足し、build する |
| `eval --author <name> [--set ...] [--details]` | 筆者の記事での誤検出と、比較用の記事での検出を 1000 字あたりで出す |
| `abc --author <name> [--runner <name>] [--set test] [--only a,b] [--example-category <category>] [--limit n] [--estimate] [--yes] [--report]` | A（比較用の記事）・B（文体の指示と筆者の例）・C（A に lint の指摘を 1 回だけ直させる）・BC（B に同じことをする）を作り、比べる |

### 終了コード

| コード | 意味 |
|---|---|
| 0 | 成功。lint は指摘なし |
| 1 | lint に指摘がある、guard で変化があった、build --check で古い、生成に失敗した記事がある |
| 2 | 使い方や設定の誤り（split.yml が足りない、accept の重複など） |
| 3 | 回数制限（429 など）で生成を止めた。時間をおいて同じコマンドで再開する |
| 4 | 混雑（503 など）が再試行しても続いた。同じコマンドで再開する |
| 5 | 生成するものがあるのに `--yes` がない。見積もりだけを出して止めた |

### lint

- 先頭に `key: value` だけが並ぶブロック（区切りのない frontmatter）は読み飛ばします。`---` で囲んだ frontmatter は textlint が外します。
- 渡したファイルをそのまま見るので、corpus.yml の `exclude_sections` や、引用・表の除外は当たりません。コーパスの記事の指摘を見るときは `eval --set dev --details` を使います。

### control と pipeline

- 比較用の記事は `corpus/_control/<runner>/<slug>.md` に、モデル名・プロンプトのハッシュ・所要時間・試行回数は同じ名前の `.json` に保存します。
- 既にあってプロンプトのハッシュも同じ記事は飛ばします。ハッシュが違う記事と `.json` がない記事は作り直します。止まっても同じコマンドで続きから再開できます。
- 生成するものが 1 本でもあるのに `--yes` がなければ、見積もりを出して何も生成せずに 5 で終わります。`--estimate` と `--dry-run`（プロンプトを見るだけ）は `--yes` なしで動きます。
- 見積もりの時間と出力トークン数は、その runner の過去の出力の平均から出します。過去の出力がなければ、時間は不明、トークンは 1 字 2.5 トークンとして数えます。費用は runner に `price` を書いたときだけ出し、入力の費用は含めません。
- 混雑（Gemini の 503 や、runner の `unavailable` に一致した失敗）は `retry_delays_seconds` の間隔で再試行し、それでも駄目なら 4 で終わります。回数制限（429 や `rate_limit` に一致した失敗）はすぐ 3 で終わります。
- `--limit n` は 1 回で新しく作る本数、`--delay` は記事どうしの間隔（秒）です。
- `pipeline` は、どれかの runner が止まると profile に進みません。

### split

- split.yml がなければ、記事を選んで分けます。`holdout_after` より後の記事を holdout に、残りの新しい順に `test_ratio` をテスト用、その前の `dev_ratio` を確認用、残りをプロファイル用にします。
- split.yml があれば、もう分けた記事は動かさず、まだどこにも入っていない記事（新しく公開した記事など）だけを holdout に足します。
- split.yml に profile・dev・test・holdout のどれかが欠けていると、split も、split.yml を読むほかのコマンドもエラーで止まります。

### review と accept

- review.md の候補には番号が付きます。`M` は model_leaning、`O` は orthography、`R` は要確認の orthography、`D` は density、`T.<項目>` はしきい値です。番号は proposal.yml の `id` と同じで、profile をやり直すと変わることがあります。
- model_leaning と density の行には、筆者の確認用の記事での回数（density は 1000 字あたりの最大と、目安を超えた記事の数）も出ます。テスト用と holdout は数えません。
- `accept` は番号の候補を profile.yml の該当する節の末尾に足し、build します。ほかの項目と並びは変えません。
  - `M3=メッセージ` でメッセージを差し替えます。
  - `T.<項目>=値` で提案と違う値にします。
  - `T` だけなら、提案のしきい値をまとめて足します（検査が止まる値は除きます）。
  - 同じ候補やしきい値がもうあれば、何も書かずに 2 で終わります。

### abc

- A は `corpus/_control/<runner>/` にある比較用の記事をそのまま使う（呼び出さない）。runner は `--runner`、省略すると corpus.yml の最初の runner。
- B は、control と同じ指示に「この筆者の文体で書いてください」と、プロファイル用のいちばん新しい 3 本の本文（地の文の段落だけ。frontmatter・見出し・引用・コード・表を外し、1 本 3000 字までで段落の切れ目で切る）を足して、記事ごとに 1 回呼び出す。
- C は、A に lint をかけ、指摘がなければ A をそのまま写す（呼び出さない）。指摘があれば、onajimi スキルの手順 3 と 5（指摘された箇所だけを直す、「K 回減らす」は K 箇所だけ、指摘のない文は変えない、直すのは 1 回）を書いた指示と指摘（その行の抜粋つき）と下書きを渡して 1 回呼び出し、guard の結果を記録する。スキルと違い、guard に落ちても元に戻さず、そのまま残して印を付ける。指標では、落ちたものを A に戻した「C戻し」も出す。
- BC は、C と同じ手順を A ではなく B の出力にかける。指摘がなければ B をそのまま写す。落ちたものを B に戻した「BC戻し」も出す。B がまだないか作り直しになる記事の BC は、同じ実行の中で B を作ったあとに決める（見積もりでは「B を作ってから決める」と出す）。
- 出力は `<root>/authors/<name>/experiments/abc/{B,C,BC}/<slug>.md` と、同じ名前の `.json`（runner・モデル・プロンプトのハッシュ・所要時間・費用・C と BC は指摘の数と guard の結果）。プロンプトのハッシュが同じものは飛ばすので、止まっても同じコマンドで再開できる。辞書を変えると C と BC のプロンプトが変わり、B を作り直すと BC のプロンプトが変わり、作り直しになる。
- 呼び出すものがあるのに `--yes` がなければ、見積もりを出して 5 で終わる。見積もりの時間と費用は、その条件の過去の出力の平均（なければ BC は C の平均、それもなければ A の平均）から出す。`--dry-run` はプロンプトを出すだけ。
- `--report` は生成せずに、B・C・BC がそろった記事で指標を出し、`experiments/abc/report.md` にも書く。
  - Burrows の Delta: 地の文を kuromoji で切り（空白・数・ASCII だけのトークンは外す）、基本形（なければ表層形）で数える。語彙は、プロファイル用の筆者の記事とその比較用の記事（全 runner）で多い順に N 語（50・150・300）、z の平均と標準偏差も同じ記事から文書単位で出す。同じ slug の筆者の記事との Delta と、プロファイル用の筆者の記事の重心との Delta を出す。辞書（表記の両方の形、密度と leaning のトークン）に当たる語を外した版も出す。
  - 対の比較は、記事ごとの勝ち負け（Delta が小さいほうが勝ち）、差の平均とその 95% 区間（10000 回の bootstrap、乱数の種は固定）、両側の符号検定。
  - そのほか、eval と同じ数え方の指摘の数（C と BC には循環）、guard の通過率、A と C・B と BC の文字単位の編集率（1 − 2·LCS/(|元|+|直した稿|)）、指示した字数に対する字数の比、条件ごとの費用と時間。
  - 筆者の癖の誇張: 同じ slug の筆者の記事・A・B・BC で、辞書の表記ごとの筆者側の形の割合（pattern と同じ先読みを expected に付けて数える）と、密度の項目ごとの記事ごとの 1000 字あたりの平均と目安を超えた記事の数を並べる。
- test を辞書づくりのあいだに見たことがあれば、結果は C と BC に有利な向きに偏る。

### eval

- 既定はテスト用です。`--set dev|profile|test|holdout` で変えられます。
- 「指摘」は箇所の数です。「文書単位」は、密度の指摘（phrase-density と太字の密度）を記事と項目の組ごとに 1 件と数えた数です。内訳のかっこ内も同じ数え方です。1000 字あたりは箇所の数から出します。
  - phrase-density の項目は、生成した `.textlintrc.json` の `entries` のどれのメッセージで始まるかで決めます（いくつも当てはまるときは長いほう）。太字の密度は記事ごとに 1 項目です。
  - ほかのルールの指摘は、メッセージが「K 回減らす。」で終わっていても箇所ごとに数えます。
- `--details` は、指摘を `slug:行 ルール メッセージ ｜ その行の文（60 字まで）` の形で 1 件ずつ（密度の指摘は箇所ごとに）出します。eval と同じ除外（`exclude_sections`、引用・表・HTML・コード）を当てます。テスト用と holdout には使えません。

## profile.yml

| キー | 中身 |
|---|---|
| `note` | メモ。生成物には入らない |
| `model_leaning` | `tokens`（kuromoji のトークン条件の並び）と `message`。重大度は error |
| `author_leaning` | `tokens`、`author`（筆者側の言い方）、任意の `message`。重大度は warning |
| `orthography` | textlint-rule-prh のエントリ（`expected` と `pattern` または `patterns`）。重大度は warning |
| `density` | `tokens`、`max_per_1000`、`message`、任意の `min_chars` と `typical_per_1000`。地の文 1000 字あたりの出現数が `max_per_1000` を超えた文書では、出現した箇所全てに「この文書では N 回（目安 M 回まで）。K 回減らす。」を添えて出す。M は `max_per_1000` × 地の文の字数 ÷ 1000 の切り捨て、K は N − M。`min_chars` 字未満の文書には出さない。`typical_per_1000` は見直し用の記録で、生成物には入らない。`message` はほかの項目と同じにできない（build が止まる）。重大度は warning |
| `thresholds` | 下の表。書かなかった項目の検査は動かない |
| `allow` | 一致した範囲がこの文字列（`/正規表現/` も可）を含むとき、model_leaning・author_leaning の指摘を出さない |

どの項目にも `evidence`（根拠の数値）と `note` を書けます。どちらも人が見直すためのもので、指摘のメッセージには入りません。

| しきい値 | 中身 |
|---|---|
| `sentence_length` | 1 文の長さの上限（字） |
| `max_ten` | 1 文の読点の上限 |
| `bold_per_1000` | 地の文 1000 字あたりの太字の上限。超えた文書では、太字の 1 個ずつに「この文書の太字は N 個（目安 M 個まで）。K 個減らす。」を出す |
| `decoration_min_chars` | 地の文がこの字数未満の文書では、太字の密度を見ない |
| `list_ratio` | 地の文に占める箇条書きの割合の上限 |
| `bold_label_items` | 頭を太字にした箇条書きの数の上限。項目の最初が太字で、同じ段落に続きの文があるものを数える（「- **ラベル**: 説明」も「1. **比べる。** 説明」も。全部が太字の項目や、途中の太字は数えない）。0 なら 1 個目から指摘する |
| `emphasis_share_min` | 強調（太字と斜体）のうち、斜体が占める割合の下限 |
| `emphasis_min_marks` | 強調がこの数以上ある文書だけで、斜体の割合を見る |
| `emphasis_share_typical` | 筆者のふだんの斜体の割合。メッセージに入る |
| `density_min_chars` | density の `min_chars` の既定値 |

## corpus.yml

| キー | 中身 |
|---|---|
| `posts` | 記事の Markdown を置いたディレクトリ（corpus.yml からの相対パス、`~/` も使える）。既定は `corpus/post`。frontmatter は `key: value` の並びか、`---` で囲んだ YAML |
| `select` | 使う記事の条件。`author`・`categories`・`since`（YYYY-MM-DD）。書かなかった条件では絞らない。`categories` を書くと、それ以外のカテゴリーの同じ筆者の記事を「他ジャンル」として数える |
| `test_ratio`・`dev_ratio` | テスト用・確認用にする割合（holdout を除いた全体に対して）。既定は 0.25 と 0.1 |
| `holdout_after` | この日付（YYYY-MM-DD）より後の記事を、最初の split で holdout にする |
| `exclude_sections` | 解析から外す節（記事と見出しの組）。筆者が書いていない節（寄稿、引用した AI の出力など）に使う |
| `skip_paragraphs` | 解析から外す段落のパターン（`[TOC]` など） |
| `control` | 比較用の記事を書かせるプロンプトのひな形と、runner の設定 |
| `profile` | プロファイラの細かい設定（下の表） |

runner は次のどちらかで書きます。

- `command`：コマンドを実行し、標準入力にプロンプトを渡します。引数に `{prompt}` があれば、そこに入れます。
- `api: gemini`：Gemini の API を呼びます。`model` と `key_file`（API キーを書いたファイル）を指定します。キーはヘッダーで送り、ログには出しません。

どちらにも、任意で `price`（出力 100 万トークンあたりの USD。見積もりに使う）、`retry_delays_seconds`、`rate_limit`・`unavailable`（失敗のメッセージに一致させる正規表現）を書けます。

`profile` の設定:

| キー | 中身 |
|---|---|
| `alpha0` | 対数オッズ比の事前分布の強さ |
| `min_docs`・`min_count` | 候補にする最低の記事数と出現数 |
| `proposal_z`・`proposal_max_author_docs` | model_leaning を提案する z の上限と、筆者が使ってよい記事数の上限 |
| `rate_z` | density を提案する z の上限 |
| `proposal_limit` | 提案の件数の上限 |
| `min_chars` | density としきい値を決めるときに使う記事の最低字数 |
| `emphasis_min_marks` | 斜体の割合を数える記事の最低の強調数 |
| `orthography_min_count`・`orthography_min_share`・`orthography_z`・`orthography_limit` | 表記の組の条件 |
| `hint_z`・`hint_limit` | 筆者寄りの語の一覧の条件 |

## プロファイラの計算

### 対数オッズ比

筆者のプロファイル用の記事と、runner ごとの比較用の記事を、Monroe ほか (2008) の情報事前分布つき対数オッズ比で比べます。z が負ほどモデル寄り、正ほど筆者寄りです。

- 特徴は、内容語（名詞・動詞・形容詞・副詞）の基本形と、隣り合う 2 語の組です。トークン化は、lint の照合と同じ kuromoji で行います。
- 比較用の記事の先頭にある「タイトルと同じ見出し」と、その直後の太字だけの副題は、数える前に外します。モデルが自分で足すことが多いからです。
- ASCII だけのトークン（`x`・`Web` など）は数えません。カタカナ語がトークナイザーで割られたかけら（「トークン」の「クン」など）も、表記の組には使いません。
- `candidates.tsv` には、どれかの runner で |z| ≥ 2 の行だけを書きます。全部の行は `profile/_full/candidates.tsv` にあります。
- `proposal.yml` は提案の下書きです。profile.yml を自動で書き換えることはありません。

### 提案の種類

- `model_leaning` は、筆者がほぼ使わず（`proposal_max_author_docs` 本以下）、どの runner も多く使う語です。
- `density` は、筆者も使うが、頻度がモデルより低い語です。筆者のプロファイル用の記事（`min_chars` 字以上）が 1 本も超えない値を、目安の上限として出します。
- `orthography` は、読みと品詞が同じで、表記（かな・漢字・送り仮名）だけが違う組です。筆者が一方をほぼ必ず選び、どの runner も他方を多く選ぶ組を、prh のエントリにします。活用する語は、語幹と先読みの正規表現にします。
  - 漢字が食い違う組（機械／機会）は出しません。
  - 1 字の漢字の語、品詞の細分類が違う組、ほかの語の一部にも当たる表記は、要確認（`R`）に分けます。
- しきい値は、記事ごとの値から、筆者のどの記事も超えない値を提案します（「厳しめ」として 90 パーセンタイルも出します）。

### 提案に付く情報

- 後ろに続く語として、候補の直後に来る語の上位 3 つを出します。意味の違い（場所の「どこか」と、ぼかしの「どこか」など）を見分けるのに使います。
- 指示への混入（`in_brief_docs`）は、比較用の記事を書かせたときの指示に、その語が入っていた記事の数です。指示から写っただけの語は癖ではないので、1 以上の候補は model_leaning から外します（`excluded_in_brief`）。内容語を含む特徴だけで数え、助詞・記号だけの特徴は数えません。
- 他ジャンルとして、選んでいないカテゴリーの、同じ筆者の記事での頻度を出します。ジャンルによって使い方が変わる語を見つけるのに使います。

## npm パッケージ

`packages/` の 2 つは npm に出せる形にしてありますが、まだ公開していません（`"private": true`）。

- CLI の本体は `packages/onajimi/src/main.js` の `main({ argv, preset })` です。npm の入口（`packages/onajimi/bin/onajimi.js`）はルール集をパッケージ名で読み込み、リポジトリの `bin/onajimi` は相対パスで読み込んで渡します。root の決め方はどちらも同じです。そのため、リポジトリの中では `packages/onajimi/bin/onajimi.js` を直接実行できません。
- ルートの package.json はプラグイン用の依存で、レジストリにある版を固定したものだけを書きます。CLI とルール集の依存を変えたら、ルートにも同じ版を足します（食い違うとテストが落ちます）。
- 公開した状態を試すには、両方を `npm pack` し、同じディレクトリに 2 つの tgz を `npm install` します。
- ルートの NOTICE は、2 つのパッケージの NOTICE をつないだものです（食い違うとテストが落ちます）。

## 開発

```sh
npm ci
npm test
claude plugin validate .
```
