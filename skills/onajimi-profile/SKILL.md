---
name: onajimi-profile
description: 筆者のコーパスと対照からプロファイルの提案を作り、人と相談して profile.yml を決める
---
1. `onajimi pipeline --author <name>` を実行する。回数制限や混雑で止まったら、時間をおいて同じコマンドで再開する。
2. `authors/<name>/profile/review.md` を最初から最後まで読む。ほかの出力は、確かめたいことがあるときだけ開く。
3. profile.yml の変更案を作り、人に見せる。選び方:
   - model_leaning には、筆者がほぼ使わない語だけを入れる。
   - 話題の語（記事の中身で決まる名詞）は外す。
   - 指示に入っていた語（excluded_in_brief や「指示」が 1 以上の行）は外す。
   - 他ジャンルで筆者がよく使う語は外すか、注をメッセージに書く。
   - 表記の組で拾える語は、語より orthography を優先する。要確認の組は例文で確かめる。
   - 頻度だけが違う語は density に、装飾はしきい値にする。
   - 根拠は evidence に写し、メッセージには数値を書かない。
4. 人が同意した変更だけを profile.yml に書く。
5. `onajimi build --author <name>` と `onajimi eval --author <name> --set dev` を実行し、表と dev での指摘を人に見せる。
6. 誤検出があれば 3 に戻る。
7. test の記事と test の評価は、人が最終評価を頼むまで見ない。頼まれたら `onajimi eval --author <name>` を一度だけ実行する。
