# oh-my-onajimi

まともな日本語を書けるモデルの一発書きを、特定の筆者の好みに少しだけ近づけるための道具。文章の質そのものを上げる道具ではない。モデルには本文を普段どおり書かせ、`onajimi lint` で引っかかった箇所だけを直させ、`onajimi guard` で数値と否定が変わっていないかを確かめる。

設計は [notes/plan.md](notes/plan.md)、先行実装の調査は [notes/prior-art.md](notes/prior-art.md)。

## 構成

```
packages/textlint-rule-preset-onajimi/  textlint のルール集（model-leaning / author-leaning / decoration-density）
packages/onajimi/                        CLI（build / lint / guard）
authors/<name>/profile.yml               人が編集する唯一の元データ
authors/<name>/generated/                build の出力（手で編集しない）
authors/<name>/corpus/                   筆者の記事（gitignore）
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
```

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
