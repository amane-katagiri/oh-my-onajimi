# oh-my-onajimi

まともな日本語を書けるモデルの一発書きを、特定の筆者の好みに少しだけ近づけるための道具。文章の質そのものを上げる道具ではない。モデルには本文を普段どおり書かせ、`onajimi lint` で引っかかった箇所だけを直させ、`onajimi guard` で数値と否定が変わっていないかを確かめる。

設計は [notes/plan.md](notes/plan.md)、先行実装の調査は [notes/prior-art.md](notes/prior-art.md)。

## 構成

```
packages/textlint-rule-preset-onajimi/  textlint のルール集（model-leaning / author-leaning / decoration-density）
packages/onajimi/                        CLI（build / lint / guard）
authors/<name>/profile.yml               人が編集する唯一の元データ
authors/<name>/corpus.yml                コーパスの選び方・除外・対照の生成コマンド・プロファイラの設定
authors/<name>/split.yml                 プロファイル用とテスト用の記事（onajimi split で一度だけ作る）
authors/<name>/profile/                  profile の出力（candidates.tsv・proposal.yml・thresholds.yml）
authors/<name>/generated/                build の出力（手で編集しない）
authors/<name>/corpus/                   筆者の記事と対照（_control/<runner>/）。gitignore
skill/SKILL.md                           薄いスキル
```

## 使い方

Node 26 以降。

```sh
npm install
npm test

npx onajimi build --author amane           # profile.yml から generated/ を作る
npx onajimi build --author amane --check   # generated/ が古ければ 1 で終わる
npx onajimi lint --author amane draft.md   # 指摘を「行:列 ルール名 メッセージ」で 1 行ずつ出す。0 件なら何も出さない
npx onajimi guard draft.md out.md          # 数値と否定の数が変わっていれば 1 で終わる

npx onajimi split --author amane           # corpus.yml の条件で記事を選び、新しい 25% をテスト用にして split.yml に書く
npx onajimi corpus --author amane          # プロファイル用・テスト用の本数と字数
npx onajimi control --author amane --runner opus --dry-run          # 対照のプロンプトを見るだけ
npx onajimi control --author amane --runner opus [--set test] [--only a,b] [--limit n]
npx onajimi profile --author amane [--paired]   # profile/ に候補・提案・しきい値を書く
npx onajimi eval --author amane            # テスト用の記事での誤検出と、対照での検出（1000 字あたり）
```

`control` は出力を `corpus/_control/<runner>/<slug>.md` に、モデル名・プロンプトのハッシュ・所要時間・試行回数を同名の `.json` に置く。出力済みでプロンプトのハッシュが今と同じ記事は飛ばし、ハッシュが違う（または `.json` がない）記事は作り直す。止まっても同じコマンドで続きから再開できる。混雑（gemini の 503、runner の `unavailable` に一致した失敗）は `retry_delays_seconds` の間隔で再試行し、それでも駄目なら止まって 4 で終わる。回数制限（429、`rate_limit` に一致した失敗）はすぐ止まって 3 で終わる。runner は `command`（stdin にプロンプトを渡す。引数に `{prompt}` があればそこに入れる）か、`api: gemini`（`key_file` から API キーを読み、ヘッダーで送る）で書く。

`profile` は Monroe ほか (2008) の情報事前分布つき対数オッズ比で、筆者のプロファイル用記事と各 runner の対照を比べる。z が負ほどモデル寄り。対照の先頭にあるタイトルと同じ見出しと、その直後の太字だけの副題（またはサブタイトルと同じ見出し）は、profile と eval の前に外す。ASCII だけのトークン（`x`・`U`・`Web` など）はユニグラムに入れず、両側が ASCII だけのバイグラムも作らない。`candidates.tsv` には、どれかの runner で |z| ≥ 2 の行だけを書く。全行は `profile/_full/candidates.tsv`（gitignore）に書く。`proposal.yml` は profile.yml に写す前の下書きで、自動では profile.yml を書き換えない。

`lint` は、先頭の `key: value` だけが並ぶブロック（区切りのない frontmatter）を読み飛ばす。`---` で囲んだ frontmatter は textlint の Markdown パーサーが外す。

## profile.yml

| キー | 中身 |
|---|---|
| `note` | メモ。生成物には入らない |
| `model_leaning` | `tokens`（kuromoji の形態素条件の並び）、`message`、任意の `evidence`。error |
| `author_leaning` | `tokens`、`author`（筆者側の言い方）、任意の `message` と `evidence`。warning |
| `orthography` | textlint-rule-prh のエントリ（`expected` と `pattern`/`patterns`）。warning |
| `thresholds` | `sentence_length`、`max_ten`、`bold_per_1000`、`list_ratio`。書かなかった項目の検査は止まる |
| `allow` | 一致した範囲がこの文字列（`/正規表現/` も可）を含むとき、leaning の指摘を出さない |

`evidence` は人が見直すためだけに残し、指摘のメッセージには入れない。

## ライセンス

`packages/onajimi/src/guard.js` の一部は yomiyasu（MIT）からの移植。[NOTICE](NOTICE) を参照。
