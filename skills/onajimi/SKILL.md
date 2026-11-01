---
name: onajimi
description: 日本語の記事を書き終えたあと、指定した筆者の書き癖に寄せる軽い仕上げをする
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/onajimi *)
---
筆者のデータは `${CLAUDE_PLUGIN_ROOT}/bin/onajimi root` が出す root の `authors/<name>/` にある（場所を変えるには環境変数 ONAJIMI_ROOT を設定する）。筆者がなければ止めて、root を示し、`onajimi import` か onajimi-profile スキルで作るよう人に伝える。

1. 本文はふだんどおり書く。このスキルを理由に書き方を変えない。
2. 書き終えたら作業ディレクトリに onajimi-draft.md として保存し、`${CLAUDE_PLUGIN_ROOT}/bin/onajimi lint --author <name> onajimi-draft.md` を実行する。
3. 指摘された箇所だけを直す。直すかどうかは文脈で決め、直さない指摘には理由を一言添える。指摘のない文は変えない。「K 回減らす」のように数を減らす指摘は、指摘された箇所のうち文脈で選んだ K 箇所だけを直し、ほかの箇所と指摘のない文はそのままにする。
4. 直した稿を onajimi-out.md に保存し、`${CLAUDE_PLUGIN_ROOT}/bin/onajimi guard onajimi-draft.md onajimi-out.md` を実行する。失敗したら、該当する箇所を元に戻す。
5. lint は再実行しない。残った指摘は一覧にして書き手に返す。
