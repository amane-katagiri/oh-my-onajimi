# textlint-rule-preset-onajimi

筆者の書きぶりから作った辞書としきい値で、日本語の文章を検査する [textlint](https://textlint.org/) のプリセットです。

次のようなものを指摘します。

- モデルが多用するのに、筆者はほとんど使わない語
- 筆者なら別の言い方をする語
- 太字や箇条書きの多さ
- 言い回しの密度

辞書としきい値は筆者ごとに違うので、プリセットには入っていません。ふつうは CLI の onajimi（npm の `onajimi`）が、筆者の記事とモデルの対照から作ります（`onajimi build` が `generated/` に辞書と `.textlintrc.json` を書きます）。手で書いてもかまいません。

## インストール

```sh
npm install --save-dev textlint textlint-rule-preset-onajimi
```

Node 20 以降、textlint 15 以降が必要です。

## 使い方

`.textlintrc.json` の例です。

```json
{
  "rules": {
    "preset-onajimi": {
      "model-leaning": { "dictionaryPath": "./model-leaning.json" },
      "author-leaning": { "severity": "warning", "dictionaryPath": "./author-leaning.json", "allows": ["確認事項"] },
      "decoration-density": { "severity": "warning", "maxBoldPer1000": 4, "maxListRatio": 0.4, "minChars": 1500 },
      "phrase-density": {
        "severity": "warning",
        "entries": [
          { "tokens": [{ "basic_form": "の" }, { "basic_form": "中" }], "max_per_1000": 1.2, "min_chars": 1500, "message": "「〜の中」を減らす。" }
        ]
      }
    }
  }
}
```

検査は次のように実行します。

```sh
npx textlint draft.md
```

## ルール

既定では `decoration-density` だけが有効です。それもしきい値を書いた検査しか動きません。ほかの 3 つは、設定を書いたときだけ動きます。

### model-leaning / author-leaning

辞書の語・連語を、地の文（`Str` ノード）ごとに形態素で照合して指摘します。中身は同じで、重大度を分けるために 2 つの名前で登録しています。モデル寄りの語は error、筆者の言い方を示すものは `"severity": "warning"` にする使い方を想定しています。太字・インラインコード・改行・段落をまたぐ一致は拾いません。

| オプション | 中身 |
|---|---|
| `dictionaryPath` | 辞書の JSON（必須）。`.textlintrc` のあるディレクトリからの相対 |
| `allows` | 一致した範囲がこの文字列（`/正規表現/flags` も可）を含むとき、指摘しない |

辞書の形式です。

```json
{
  "entries": [
    {
      "message": "「静かに壊れる」はモデルの言い方。何がどう壊れるかを書く。",
      "tokens": [{ "surface_form": "静か" }, { "surface_form": "に" }, { "basic_form": "壊れる" }]
    }
  ]
}
```

`tokens` は kuromoji のトークンの条件の並びです（[morpheme-match](https://github.com/azu/morpheme-match) の形式）。`surface_form`・`basic_form`・`pos`・`pos_detail_1` などを書きます。値を配列にすると、どれかに一致すれば対象になります。`message` は指摘の文です。

### decoration-density

文書全体の装飾を数えて、しきい値を超えたら指摘します。太字の密度は太字ごとに「この文書の太字は N 個（目安 M 個まで）。K 個減らす。」を出し、ラベル付きの箇条書きは項目ごとに出します。箇条書きの比率と斜体の割合は、文書に 1 件だけ出します。M は上限 × 地の文の字数 ÷ 1000 の切り捨て、K は N − M です。引用と表の中は数えません。書かなかったしきい値の検査は動きません。

| オプション | 中身 |
|---|---|
| `maxBoldPer1000` | 地の文 1000 字あたりの太字の上限 |
| `minChars` | 地の文がこの字数未満の文書では太字の密度を見ない（既定 0） |
| `maxListRatio` | 地の文に占める箇条書きの字数の比率の上限 |
| `maxBoldLabelItems` | 「- **ラベル**: 説明」型の箇条書きの数の上限。超えた文書では 1 個ずつ指摘する |
| `minEmphasisShare` | 強調（太字と斜体）に占める斜体の割合の下限 |
| `minEmphasisMarks` | 強調がこの数以上の文書だけで斜体の割合を見る（既定 3） |
| `typicalEmphasisShare` | 筆者のふだんの斜体の割合。メッセージに入る |

### phrase-density

語・連語の地の文 1000 字あたりの出現数が上限を超えた文書では、その項目が出現した箇所すべてに、`message` のあとへ「この文書では N 回（目安 M 回まで）。K 回減らす。」を付けて出します。M は `max_per_1000` × 地の文の字数 ÷ 1000 の切り捨て、K は N − M です。直す側は、指摘された箇所のうち K 箇所だけを選んで直せば目安に収まります。見出し・引用・表・コード・HTML は数えません。

| オプション | 中身 |
|---|---|
| `entries` | 項目の配列。`tokens`（上と同じ形式）、`max_per_1000`、`message`、任意の `min_chars`（この字数未満の文書では見ない） |

## ライセンス

MIT です。`rules/token-leaning.js` の一部は textlint-rule-preset-ai-words-ja（MIT）から移植しています。[NOTICE](NOTICE) を参照してください。
