---
name: onajimi-profile
description: 筆者のコーパスと対照からプロファイルの提案を作り、人と相談して profile.yml を決める
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/onajimi *)
---
以下の `onajimi` は `${CLAUDE_PLUGIN_ROOT}/bin/onajimi`、`onajimi root` 以外のコマンドには `--author <name>` を付ける。筆者のデータは `onajimi root` が出す root（以下 `<root>`）の `authors/<name>/` にあり、場所を変えるには環境変数 ONAJIMI_ROOT を設定する。始める前に `<root>` を人に伝える。別の root にある筆者を使うなら `onajimi import` を人に勧める。

0. corpus.yml がなければ、記事の置き場所・使う runner・API キーの渡し方（`key_file` か環境変数）を人に尋ね、`onajimi init --posts <記事のディレクトリ>` のあと corpus.yml を一緒に直す。キーそのものをチャットに貼ってもらわない。
1. `onajimi pipeline --estimate` を実行し、runner ごとの生成数・時間・費用の見積もりを人に見せる。人が同意してから `onajimi pipeline --yes` を実行する。回数制限や混雑で止まったら、時間をおいて同じコマンドで再開する。
2. `<root>/authors/<name>/profile/review.md` を最初から最後まで読む。ほかの出力は、確かめたいことがあるときだけ開く。
3. 次の順で選び、review.md の番号つきの一覧にして人に見せる。
   - orthography を先に選ぶ。表記の組で拾える語は、語としては足さない。要確認（R）の組は例文で確かめる。
   - model_leaning（M）は、筆者が使うプロファイル用の記事が 1 本以下で、dev が 0 回の語だけ。そうでなく頻度の差だけなら density（D）にする。
   - 話題の語（記事の中身で決まる名詞）、ジャンルで使い方が変わる語（注や他ジャンルの頻度で分かる）、指示に入っていた内容語は外す。
   - しきい値（T）は提案の値をそのまま使う。厳しくするのは人が頼んだときだけ。「検査が止まる」と書かれた項目は入れない。
   - author_leaning は、同じ意味の組（筆者側の z が高く、モデル側の z が低い）がはっきりあるときだけ人と書く。なければ空のままにする。
   - M と D の message は、代わりにどう書くかを短く書く。数値は書かない。
4. 人が同意した番号だけを `onajimi accept <番号...>` で足す（message は `'D5=〜を減らす。〜にする。'` の形で渡す）。accept が build まで行う。
5. `onajimi eval --set dev --details` を実行し、表と指摘を人に見せる。
6. 誤検出があれば 3 に戻って一度だけ直す。筆者が書いていないらしい文（ゲストの節、パロディ、引用した AI の出力など）での指摘は、エントリを外さずに、corpus.yml の exclude_sections に足すよう人に伝える。
7. test と holdout の記事は、人が最終評価を頼むまで開かず、lint も eval もかけない。頼まれたら `onajimi eval` を一度だけ実行する。holdout は人が頼んだときだけ `onajimi eval --set holdout` を実行する。
