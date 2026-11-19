# TradeCap REAL 層 Gemini クロスチェック（2026-11-20）

やり方：Gemini（無料枠）に PC Bot の実コード（7f87bf4）の REAL 層を読ませて「怪しい所だけ」を出させ、全件をシロがコード実物と固定版 SDK（@mysten/deepbook-v3 2.8.0）のソースで検証した。Gemini の指摘をそのまま信じない前提の二重チェック。

## 結論

**新しい欠陥はゼロ。** Gemini の指摘は全19件中、確定した問題は0件。内訳は、読み違い・設計どおりの挙動の誤認が大半で、残りは「事実だが実害なし」2件と「設計書でも未決事項として明記済みの既知の限界」1件。今朝のシロの総点検の結論（残り手順は実行可能、主発見は残高差分の台帳経路が未実装の1件）は覆らなかった。なお、その主発見は Gemini は見つけていない（履歴ソースの周辺は見ていたが、増減データの不在には辿り着かなかった）。

## 確定したもの（問題ではないが事実）

1. **スナップショットの同時点性**（read-only.ts）：残高・ロック・未請求などを別々の読み取りで集めるため、厳密には同一チェックポイントの状態ではない。ただしこれは設計書 §11.9.2-5 が「未決の検証事項」として明記済みの既知の限界で、ズレは再開ゲート側で差分として現れてフェイルクローズする。Phase 2 の宿題として既存分に合流。
2. **indexer 注文イベントの checkpoint が "0" 固定**（history-source.ts）：事実。ただしページのチェックポイントは GraphQL 側の実値で進み、ゲートや照合はそちらで効くため実害なし。見た目の粗さのみ。

## 理論上の縁（実害なし）

- GraphQL が hasNextPage=true で endCursor=null を返すと照合が早期完了扱いになる経路。Sui GraphQL の仕様上その組み合わせは返らない。硬化するなら1行の防御で足りるが、Phase 1 では不要と判断。

## 棄却した指摘（検証の要点だけ）

- 送信キューが UNKNOWN で止まらない（execution.ts）：止めるのはキューではなく、各送信の冒頭で台帳を読む `hasNonTerminalSubmission` チェック。設計どおり。
- digest の衝突（execution.ts）：digest は tx バイト列そのもののハッシュ。衝突するなら同一 tx でしかあり得ず、主キー制約でもフェイルクローズする。
- markSent と送信の間に停止が割り込む（execution.ts）：単一スレッドのため、最終チェックから markSent までの同期的区間には割り込めない。送信後の停止は「送信済みは進み得る」という設計の前提内。
- 台帳の SELECT→UPDATE 競合／途中エラーでチェックポイント不整合（database.ts）：全体が BEGIN IMMEDIATE のトランザクションで、エラー時は ROLLBACK される。読み違い。
- ガスの帰属判定が digest だけ（database.ts）：実際のクエリは identity_key と digest の両方で絞っている。読み違い。
- identity 不一致イベントが混ざる（database.ts）：不一致イベントはラッチ記録のうえ `continue` で台帳に入らない。隔離は効いている。
- 照合ループの無限ループ（reconciler.ts）：カーソル停滞は専用エラーで投げる。クラッシュ時は保存済みカーソルから再開。
- 2系統の履歴で一意キーが衝突（history-source.ts）：indexer 側は `indexer-order:` 前缀の別空間で、複合主キー上衝突しない。
- gasSummary だけではガスが漏れる（history-source.ts）：Sui のガス精算は gasSummary（計算＋保管−返金）が全量。それ以外のガス成分はない。
- 取得前にチェックポイント検証がない（reconciler.ts）：検証は「適用前」に行われており、不一致データは台帳に入らない。取得自体は公開チェーンへの読み取りで漏洩もない。
- submissionStatus の null が永久ブロック（history-source.ts）：「見つからない＝失敗とみなさない」は §6.5 の設計そのもの。照合のたびに再照会され、確定すれば解ける。
- checkManagerBalance は数値を直接返す（read-only.ts）：固定版 SDK 2.8.0 の実ソースで確認。返るのは `{ coinType, balance }` オブジェクトで、`unwrapManagerBalance` の期待と一致。Gemini の別版知識による誤認。
- botGasSuiMist の単位混在（read-only.ts）：ガスは MIST のまま専用項目で扱われ、BM 残高（コイン単位）と混ぜて計算する箇所はない。
- 口座がないと EMPTY_ACCOUNT で誤魔化す（read-only.ts）：DeepBook の口座は初回発注で作られる遅延生成で、「ない」は正常状態。通信エラー時は例外で落ちてフェイルクローズする。

## 実施メモ

- 対象ファイル：execution.ts／database.ts／reconciler.ts／history-source.ts／cap-valid.ts／read-only.ts（cap-valid は指摘ゼロ）。
- Gemini は既定モデル（gemini-3.8-flash）が無料枠の混雑で2回タイムアウトし、gemini-3.1-flash-lite に切り替えて全パス完了（各数秒）。軽いモデルの方がこの用途では速くて十分だった。
- 生の指摘文はローカル（シロの作業領域）に保存。
