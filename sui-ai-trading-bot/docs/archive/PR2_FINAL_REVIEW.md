# PR #2 最終レビュー・検証記録

実施日: 2026-10-24（日本時間）
対象: https://github.com/tajumaru/SuiBa/pull/2
開始時head: `0290cdace28aa2c2ef870cd767a5d581c8eb7396`
確認した最新main: `4d24126285c35471397e968734a8a53fcd375808`

## ブランチ・既存指摘

- 開始時はmainが13コミット、PRが5コミット先行。元のPR変更はBotVitalSigns.tsx、botVital.ts、OperationOverview.tsx、style.css、bot-vital.test.tsの5ファイル。
- 既存コメントの停止優先、心拍・受信鮮度、取得経過の経年、停止予定超過の指摘は修正済み。ただし下記の追加問題を発見した。
- GitHubのレビュー提出・インラインレビュースレッドはともに0件。会話コメント2件の対応内容をソースと照合した。
- mainの追加変更はSui通信診断、証拠保存失敗・DB異常時の注文禁止、Node実行環境とオフライン検証など。表示に使用する既存snapshotフィールドとの互換性を確認した。
- 修正コミット後にmainを一時的に未コミットでマージし、競合なし、型チェック・ビルド成功、関連111テスト成功を確認。その後 `git merge --abort` で元に戻した。mainへの変更、rebase、force push、PRマージは行っていない。

## レビュー結果・修正

P0: 0件。今回の変更はダッシュボード表示・テスト・記録に限定。取引判断、損益計算、PAPER処理、LIVE禁止、安全停止条件、通信経路、API、管理トークン認証、DB保存形式は変更していない。

P1: 5件、修正済み。

1. **心拍・受信日時の欠落、不正値、未来値**: nullやNaN等が鮮度比較をすり抜け、正常な雫を出せた。有限かつ正の時刻、現在以前という条件を追加。不正な経過・予定時刻も表示しない。
2. **市場データの経年**: dataStatusとtransportRecentはsnapshot生成時点の値で、受信後に閾値を超えても正常を維持できた。lastTransportSuccessAtとlastMarketClosedAtを画面の現在時刻で再評価。Worker既存の180秒・360秒を使用し、欠落時も正常としない。
3. **取得期限超過**: 45秒を超えても取得中の文言だけ消え、正常な雫が残った。取得中かつ有効経過が45秒超なら雫を止め、サマリーも状態不明にする。完了・新しい証拠の到着で復帰する。45秒ちょうどの既存境界は維持。
4. **不完全・矛盾した稼働状態**: 未知のbotStateやMANUAL_STOPでサマリーと雫が不一致になり得た。既知の稼働・通信状態を要求し、unknownの雫ではヒーローも状態不明に揃える。安全停止・停止の優先順位は維持。
5. **ページ復帰**: バックグラウンドで止まったタイマーの次回実行まで古い表示を維持できた。visibilitychangeとpageshowで即時再評価。タイマーと両イベントをcleanupで解除。新snapshot受信時は現在時刻も更新。

P2: 2件。

- **模式表示注記の可読性（修正済み）**: style.cssの注記を11pxから12px、文字色を明るく変更。固定パターンの装飾であり価格・分析頻度ではない旨の既存注記を維持。BotVitalSigns.tsxは整形のみ。
- **既存のテストランナー混在（残存）**: 標準Vitestがnode:test用tools/sui-transport-bench/bench.test.mjsを拾い「No test suite found」で失敗する。mainにもある既存問題で、今回はランナー設定を変更していない。下記のとおり本来のランナーで6件成功を確認。

## 回帰テスト

- tests/bot-vital.test.ts: 24件から44件へ。正常→異常→正常、正常→停止→再起動、欠落・不正・未来日時、取得期限超過と復旧、市場更新停止、複数異常、安全停止優先、再マウント時の古い証拠、未知botStateを追加。
- tests/e2e/operations.pw.ts: 2シナリオ追加。実Chromiumで動作中・通信異常・復旧・停止・再起動・取得期限超過・復旧、reduced-motion、ページ復帰、APIタイムアウトを確認。APIを置き換え、注文等の書き込みがないことも検証。
- テスト応答の心拍・市場日時はブラウザの仮想時計と同期させた。古いローソク足のままでは復旧と判定されないことも、テスト準備の過程で確認した。

## 実行環境

既定PATHのNodeはv24.14.0だったため使用しなかった。既存のNode 24.22.1 MSIを作業専用フォルダーへ管理展開し、以下の実行ログを確認した。システムインストールや永続PATH変更は行っていない。

```text
v24.22.1
D:\Source\SuiBa\.worktrees\pr2-final-review\.runtime\msi\PFiles64\nodejs\node.exe
```

main組み合わせ検証時のランタイム検証ログも `NODE_VERSION_VERIFIED`, `required: >=24.22.1 <25`, `version: v24.22.1` を確認した。
既存node_modulesを参照しており、クリーンな依存再インストールは未検証。

## 検証結果

- lint: lintコマンド・ESLint設定なし。変更対象6ソース/テストのPrettier --check成功。git diff --check成功。
- 型チェック: Node 24.22.1でTypeScript `--noEmit` 成功。
- ビルド: Vite成功（192 modules）。依存zodのPURE注釈警告あり。生成失敗ではない。
- PR単独Vitest: `vitest run --exclude '**/tools/**' --maxWorkers 2`、36ファイル、508成功・0失敗。作業専用TEMP/TMPで実行。
- ベンチ単体: `node --test tools/sui-transport-bench/bench.test.mjs`、6成功・0失敗。
- 標準全体実行: 初回505成功・1失敗（settings-api起動待ち）に加え既存node:testファイルのsuite失敗。settings-apiは個別および並列数を抑えた全体実行で成功した。途中の再実行では一時ファイル消失により31 runner errorsが発生したため、専用TEMP/TMPで全件再実行して上記508成功を確認。途中失敗を成功件数へ加算していない。
- main組み合わせ: 型チェック・ビルドと6ファイル111成功・0失敗（bot-vital、operation-overview、sui-health、sui-observations、paper-recovery-engine、sqlite-lock）。mainを含む全テストは未実施。
- 実ブラウザ: Playwright Chromium、375/390/430/1280px、運用画面40成功・0失敗。reduced-motion時のanimation-name:none、停止時の雫なし、横あふれなしを検証。375pxのヒーロー画像も目視確認。

## 未検証・制限

- 実iPhone/Safari、横向き、最大文字サイズ、長時間のCPU・メモリ計測、実ネットワーク切断からの復旧は未検証。
- 実DeepBook/Suiへの接続、実データでの長時間PAPER運転は今回実施していない。
- LIVE注文は一切実行していない。LIVE拒否テストのみ実行。
- CI結果・push後の最終head・マージ可否はGitHubで別途確認し、最終報告に記載する。
