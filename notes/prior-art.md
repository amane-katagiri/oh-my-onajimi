# 先行実装の調査メモ（2026-11-01）

各リポジトリの既定ブランチの最新を shallow clone して、コードを読んだだけ。どれも実行していない。ファイルの位置は各リポジトリのルートからの相対パスで書いた。ただし yomiyasu は `skills/yomiyasu/`、doc-style-skill は `skills/author-style-builder/` から数えている。

| リポジトリ | commit | commit 日 |
|---|---|---|
| nanaism/yomiyasu | 29d67ccb05e3 | 2026-10-30 |
| jomatsu/doc-style-skill | 4237c85048e9 | 2026-09-03 |
| p1ass/textlint-rule-preset-ai-words-ja | deb67606b384 | 2026-09-25 |
| textlint-ja/textlint-rule-preset-ai-writing | 45bb6485062b | 2026-05-14 |
| zero-platform-lab/aitext-check | b50853a8d451 | 2026-10-31 |
| jdkato/voices | 5409079d0abc | 2026-09-28 |
| vale-cli/agent-tools | 5e8704f5c07a | 2026-09-02 |
| sam-paech/slop-forensics | c313f042620f | 2025-11-01 |

## 結論

計画と同じ組み合わせは見つからなかった。組み合わせは次のとおり。
- 筆者コーパスと、同じ見出しでモデルに書かせた文章を Monroe の対数オッズ比で比べる
- 筆者ごとの辞書としきい値を作る
- 決定的な lint をかけて、指摘行だけを 1 回直す
- 数値・否定のガードをかける

## yomiyasu 2.5.0（nanaism/yomiyasu）
- SKILL.md は 46k 字。毎回読む references も含めると、文脈に約 85〜100k 字が入る。禁止系の行は 80 行。
- lint は 6,149 行で、正規表現だけ・31 規則。たとえば「効く」の例外は、文字どおりの意味の語を数十語並べ、そこに lookbehind を足している。lookbehind は全体で 58 個。
- 点数は人の文と AI の文をほぼ区別できていない（人 98.7 / AI 95.6、AUC 0.53〜0.56）。作者も点数を合否に使うのをやめた。
- 箇条書きのしきい値はスクリプトが 25%、文書は 15%。今も食い違っている。
- 英字まわりのスペースを減点する件は、現行版では直っている（test_spacing_policy.py）。
- 評価用の人の文は、作者の記事 1 本を 8 つに分けたものだけ。lint と同じ型で自分を測る、循環した評価になっている。
- 借りるもの:
  - diff の否定検出（diff:5093-5260）。義務・推量の表現を伏せてから比べ、否定以外の変化が 2 字以内なら risk にする。
  - 数値の正規化（diff:4085-4585）
  - 助詞の入れ替え検出（受け身は除外する）
  - 文の対応づけ。同一文を先に組にし、残りは 4 文の窓の中で ratio 0.45 以上を組にする。
  - lists/*.txt
  - edge_cases 54 本（誤検出の回帰テストに使える）

## doc-style-skill（jomatsu/doc-style-skill）
- Sudachi で 35 チャネルを測る。単位は記事。分布の差は JSD で測る。
- 安定性の判定は、中央値をハードコードした定数と比べているだけ。トピックをまたぐ検定は not_run で、実際には走っていない。
- 生成される SKILL.md には「漢字比 x%」のような、モデルが意識して制御できない数値ルールが最大 60 個入る。
- G1〜G4 の指摘範囲は文書全体なので、行単位では直せない。
- G5（戯画化）は手で marker を入れないと skipped。G6（コピー）もふつうの使い方では skipped。
- 改稿は 2〜3 パスで、毎回 lint し直す前提。LLM の出力を実際に評価したデータはない。
- 借りるもの:
  - blocks.py の prose_segments。コード・表・URL を除いても、元の位置に戻せる。
  - 35 チャネルの定義。プロファイラの特徴の候補にする。
  - 較正。順序統計量を外側に丸めて記事単位の FWER を抑えるので、較正に使った記事自身は fail しない。
  - 短い入力は warn に格下げする処理
  - G6 の判定。26 字の完全一致と MinHash を使う。
  - 「形態素の指標は SKILL.md に書かず、検査専用にする」という分け方

## 小物
- textlint-rule-preset-ai-words-ja（p1ass）
  - 辞書は `{entries:[{message, tokens}]}`。kuromojin の形態素条件で照合するので、連なりも活用も扱える。
  - `dictionaryPath` と `append`/`override` で差し替えられる。
  - allows は一致した範囲だけを外す。
  - 項目ごとの重大度はない。
  - **プロファイラの出力先の第一候補。**
- textlint-rule-preset-ai-writing
  - textlint 15 用で、API の書き方の手本になる。
  - StringSource と originalIndexFromIndex で、コードを除いた位置を元の位置に戻せる。
  - allows がノード全体を黙らせるのは悪い例。
  - 太字の密度を見るルールはないので、Strong ノードを数える自作ルールが要る。
- aitext-check
  - 元の表 1 つから prh の yml を生成する。`--check` で生成物との食い違いを見る。
  - 重大度ごとに辞書ファイルを分ける。
  - maskQuotes は「」の中を伏せ字にして、行番号を保ったまま引用部分を検査から外す。
  - 止める語は絞る方針。「足す」を外した経緯が書いてある（4 割の返答が止まった）。
  - hook の実装は同梱されていない。
- Vale voices / agent-tools
  - PostToolUse で動く hook。指摘がないときは何も出さず、既定では error だけを返す（warning を出すと linter を切られるから）。
  - 返し方は `additionalContext`。
  - ルールごとに fires/clean のテストを対で持つ。
  - Brief.md（ルールの事前説明）を書く前に読ませる。
  - Edit のたびに走るので、1 ターン 1 回の制御は自前で作る必要がある。
- slop-forensics
  - 指標は平滑化なしの頻度比で、Monroe の方式より劣る。日本語は扱えない。
  - README に書いてある一般語フィルタは、実際には呼ばれていない。
  - 「2 プロンプト以上に出た語に限る」という頑健性フィルタだけは借りる価値がある（見出しを 1 プロンプトとみなす）。

## 未確認
- textlint でルールインスタンスを別名で 2 つ設定できるか（重大度を 2 層にするため）
