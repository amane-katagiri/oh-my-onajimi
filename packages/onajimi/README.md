# onajimi

筆者の記事から、その人の書き癖を辞書にして、下書きを検査する CLI です。

筆者の記事と、モデルに書かせた対照の記事を比べて、筆者のプロファイル（辞書としきい値）を作ります。そのプロファイルに沿って、下書きを textlint で検査します。モデルが書いた日本語の記事を、特定の筆者の好みに少しだけ近づける仕上げに使います。ルールの実体は textlint-rule-preset-onajimi です。

## インストール

```sh
npm install --global onajimi
```

Node 22 以降が必要です。

## 使い方

次の流れで、プロファイルを作って下書きを検査します。

```sh
onajimi init --author alice --posts ~/blog/content/post   # corpus.yml のひな形と空の profile.yml を作る
# profile.yml に辞書としきい値を書くか、pipeline で提案を作って accept で足す
onajimi build --author alice                              # profile.yml から generated/ を作る
onajimi lint --author alice draft.md                      # 指摘を「行:列 ルール名 メッセージ」で 1 行ずつ出す。0 件なら何も出さない
onajimi guard draft.md out.md                             # 直す前と後で数値・否定・問い・推量の数が変わっていれば 1 で終わる
```

`lint` は、指摘を 1 行に 1 件ずつ出します。指摘がなければ何も出しません。`guard` は、直した稿で数値、否定の数、問いの文と推量の文の数が変わっていたら 1 で終わります。

## コマンド

| コマンド | 中身 |
|---|---|
| `root` | 使う root と、その決まり方を出す |
| `init` / `import` | 筆者のひな形を作る / 別の root から profile.yml などを取り込んで build する（`--force` で上書き） |
| `build [--check]` | profile.yml から辞書と `.textlintrc.json` を作る。`--check` は古ければ 1 で終わる |
| `lint <file>` | 下書きを検査する |
| `guard <before> <after>` | 直した稿で数値、否定、問いと推量の文の数が変わっていないかを見る |
| `split` / `corpus` | 記事を profile・dev・test・holdout に分ける / 本数と字数を出す |
| `control` | モデルに対照の記事を書かせる（費用がかかるので `--yes` がなければ見積もりだけ出す） |
| `profile` / `review` / `accept` | 候補としきい値を出す / review.md にまとめる / 番号で profile.yml に足す |
| `pipeline` | split から review までを通す |
| `eval` | 筆者の記事での誤検出と、対照での検出を 1000 字あたりで出す |

引数なしで実行すると、全てのオプションが出ます。プロファイルの作り方（対照の生成、候補の選び方、dev と test の使い分け）は、リポジトリ oh-my-onajimi の README と docs/reference.md にあります。

## データの置き場所

筆者のデータは `<root>/authors/<name>/` に置きます。root は次の順に決まります。

1. `--root <dir>`
2. 環境変数 `ONAJIMI_ROOT`
3. `${XDG_DATA_HOME:-~/.local/share}/onajimi`（`XDG_DATA_HOME` が絶対パスでなければ `~/.local/share` を使います）

`init` と `import` は、筆者のディレクトリがなければ作ります。ほかのコマンドは、筆者のディレクトリがなければエラーで止まります。

## ライセンス

MIT です。`src/guard.js` の一部は yomiyasu（MIT）から移植しています。[NOTICE](NOTICE) を参照してください。
