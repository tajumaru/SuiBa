# PR #25 最終レビュー

対象：tajumaru/SuiBa PR #25。基準main：e12548aff07bd83a1de769364ebf0afbf97fc726。レビュー開始時head：180af54e1bd813ea1211a0b5d2b10671a3ea3514。レビュー修正は同じfeat/wal-usdc-paperブランチに追加する。mainへのマージ・実資金取引は行わない。

## 判定と指摘

| 優先度 | 指摘 | 状態・マージへの影響 |
|---|---|---|
| P0 | 該当なし | LIVE拒否・署名送信機能なしを維持 |
| P1 | 停止中なら保有中の基軸数量・原価を残したままペア切替でき、非選択ペアを監視しなくなる | 修正済み。切替元・先の全台帳で数量・原価・未完了注文／候補を確認し409拒否。自動決済・取消・残高削除なし |
| P2 | SPREAD_TOO_WIDE時に検査したbid/askが残らず、後の正常スナップショットで誤って原因分析できてしまう | 修正済み。同じ応答のbid/ask・板時刻・取得時刻・計算比率・閾値を診断に保存。価格や安全判定は変更しない |
| P2 | 認証fixtureのE2E失敗 | main e12548aとPRで同一環境の同じ6件を再実行し、同じ5失敗・1成功。今回のWAL変更由来ではない。別途fixture更新が必要 |
| P2 | 既存coreのtick境界テストが全体実行で一度quote回数1期待に対し2を観測 | 単独36件と全体1,077件の再実行では成功。再現条件未確定。重複約定が発生したという実測ではない。テスト安定性の追跡事項 |
| P2 | WALのスプレッド・板厚が短時間で変動、30分／2時間PAPER連続試験は未実施 | 安全閾値を維持。PAPER実運用開始の判断は別途検証。Indexer内部とオンチェーン状態の独立照合までは行っていない |

**マージ判定：P1修正後のCI成功を条件に、PAPER限定のコード統合は可。WALの長時間安定稼働の承認・LIVE有効化を意味しない。** 最終CI結果はPR checksおよびレビュー回答で確認する。今回はマージを実行しない。

## スプレッドの実測

測定は固定の公式Indexerに対する読み取りのみ。設定はmaxOrder=5 USDC、maxSlippage=0.003（0.3%）のまま。3回ずつ交互に測定し、都合のよい成功だけを抽出していない。

時刻はUTC。JSTは+9時間。各行のbid/askと判定は同じ取得応答に対応する。

| ペア | Indexer板時刻 UTC | 取得完了 UTC | bid（USDC/基軸） | ask（USDC/基軸） | spread | 結果 |
|---|---|---|---:|---:|---:|---|
| WAL_USDC | 2026-10-28 21:29:59.099 | 2026-10-28 21:29:59.306 | 0.033881 | 0.033920 | 0.11504% | 通過 |
| SUI_USDC | 2026-10-28 21:30:01.076 | 2026-10-28 21:30:01.145 | 0.945610 | 0.945980 | 0.03912% | 通過 |
| WAL_USDC | 2026-10-28 21:30:03.187 | 2026-10-28 21:30:03.337 | 0.033881 | 0.033920 | 0.11504% | 通過 |
| SUI_USDC | 2026-10-28 21:30:04.956 | 2026-10-28 21:30:05.044 | 0.945610 | 0.945980 | 0.03912% | 通過 |
| WAL_USDC | 2026-10-28 21:30:11.920 | 2026-10-28 21:30:12.100 | 0.033861 | 0.034043 | 0.53605% | SPREAD_TOO_WIDE |
| SUI_USDC | 2026-10-28 21:30:14.403 | 2026-10-28 21:30:14.488 | 0.944450 | 0.944810 | 0.03811% | 通過 |

WALの拒否サンプルはmid=(0.033861+0.034043)/2=0.033952、差額=0.000182 USDC/WAL、spread=0.000182/0.033952=0.00536050895（0.536050895%）。設定0.003（0.3%）を超える。板時刻と取得完了の差は180msで、既存の10秒鮮度上限にも収まる。SPREAD_TOO_WIDEは正しい拒否であり、STALE_ORDERBOOKとの取り違えではない。

約13秒前のWALはbid=0.033881、ask=0.033920、spread=0.11504%。両側の許容範囲内板厚は約6.03 USDCで、5 USDC注文に対する余裕は小さい。同期間のSUIは0.03811〜0.03912%、板厚は数千〜数万USDC。WALは最良気配の変動で閾値をまたいだと説明できる。広がった応答の板厚は、spread段階で拒否するため不明のまま扱う。

公式Indexerのorderbook価格はUSDC建ての表示単位として数値化され、book検証にWAL 9桁／USDC 6桁のatomic換算は介在しない。同じ両価格に共通倍率を掛けてもspread比率は変わらないことをテストした。今回の超過を単位換算の不具合とする根拠はなく、Indexer応答上の市場気配の拡大が観測結果である。Indexer内部の整合性とオンチェーンの同時刻状態を独立確認した結果ではないため、その範囲まで断定しない。

前回証跡のSPREAD_TOO_WIDEは拒否時のbook=nullで、正確なbid/askを後から復元できない。別ファイルの約2分後の正常板を、その失敗時の板として扱ってはいけない。追加のbookObservationにより今後は同一応答で検証できる。

証跡：[6サンプルのJSON](evidence/pr25-spread-review-20261029.json)。再現：`node --import tsx scripts/review-wal-spread.ts`。APIタイムアウト30秒/標本の読み取り予算があり、署名・注文・売買開始は行わない。

## 安全停止

spread=(ask-bid)/mid、閾値0.003、板10秒、Indexer遅延60秒、両側maxOrderの板厚確認は変更しない。広い板を使うfixtureで、MarketSelectionがhealthy=falseになり、assertReadyがMARKET_UNAVAILABLEを返し、BotEngineがrunning=false / SPREAD_TOO_WIDEとなり、見積もりも約定も発生しないことを確認した。正常な板に変わっても自動で売買再開しない既存ルールを維持する。

## ペア隔離と切替

SUIは既存DATABASE_PATH、WALは同パス+.WAL_USDC.sqlite。選択DB・チャートキャッシュも分離。保存されたbaseCoinとエンジンpairを照合する。PAPER会計、原価配賦、実現損益、履歴、リスク設定はペアDBで分離し、異ペアquoteはRiskEngineとPAPER executorで拒否する。

pairSwitchBlockerは数量（legacy suiとquantityAtomic）、原価（costBasisとcostBasisUsdc）を全てゼロ確認し、負数・不正値を拒否する。全期間のpaper_ordersとoperation_candidatesをSQLで確認し、未知状態も安全側に拒否する。history(200)のような表示上限は使わない。切替元のrunning・取得処理・別API・バックテスト・レート制限ガードも維持する。切替先はbootより前に検査し、bootのinterruptPendingで未完了候補が消えたように見えることを防ぐ。

409コードはPAIR_POSITION_OPEN / PAIR_PENDING_WORK / PAIR_INVALID_LEDGER。UIは決済・会計確認が必要であることを説明する。拒否時に残高・原価・損益・注文を変更しない。許可された切替後は停止状態で、新たな取得検証後に手動開始が必要。

認証付き実APIで、切替元の保有数量、未処理注文、切替先の保有数量、PENDING候補をそれぞれ注入した隔離fixtureで拒否を確認した。候補がPENDINGのまま残ることも確認。全て精算・終端済みにしたfixtureでSUI→WAL→再起動→SUIの設定・履歴復元を確認した。ユーザーの運用DBを自動決済・改変する試験ではない。

## 認証E2E比較

Windows、Node v24.22.1、同じnode_modulesへの参照、同じPlaywright Chromium、375×900、同じ6テスト、同じ設定、同じローカルポートを順番に使用。mainは正確なe12548aをgit archiveした無変更コピーであり、以前の4918a69のコピーは今回の比較に使用していない。

両方ともchart-sync、dashboard-feed、deepbook-validationの2件、localizationの1件の計5件が失敗し、認証エラー表示1件が成功。session POSTを売買変更に数える、sessionに404を返す、未知リクエストとして拒否するfixtureが原因。実APIの管理認証が破壊されているという結果ではない。今回の修正でこれらの期待値や認証制約を緩和していない。

証跡：[比較要約JSON](evidence/pr25-auth-fixture-comparison-20261029.json)。生ログ内のローカルパス・fixtureソースを大量にコミットせず、同じテスト名と結果・原因を要約した。

## テストとCI

- Node v24.22.1、typecheck / build成功。
- 修正後の全Vitest 75ファイル、1,077件成功。Node組込み45件成功。
- WAL専用23件成功。切替拒否に関する残数量・残原価・全期間PENDING確認・不正台帳・拒否板診断・安全停止を追加。
- 認証付き実API切替テスト成功。WAL UIの4幅テストも成功。
- offline CIと同じローカル検証：73ファイル、1,047件成功・既存ネットワーク条件による8件skip、Node組込み45件成功。
- 修正前head 180af54のGitHub Actions [run #183](https://github.com/tajumaru/SuiBa/actions/runs/40770914984)はcompleted / successを確認。修正後headのCIもpush後に確認する。
- PAPER限定を維持し、LIVEを拒否する既存テストも成功。実資金取引・mainへのマージなし。

## 今回の変更ファイル

- apps/worker/src/index.ts：切替元・先の台帳確認を追加。
- packages/database/src/index.ts：表示上限のない切替拒否判定を追加。
- packages/market-data/src/deepbook.ts / provider.ts：拒否した板の数値・時刻・閾値を診断に追加。
- apps/dashboard/src/main.tsx：切替拒否理由の説明を追加。
- tests/wal-pair.test.ts / settings-api.test.ts：安全停止と切替拒否・隔離の回帰テスト。
- scripts/review-wal-spread.ts：署名・注文を行わない固定公開APIの6標本probe。
- README.md、WAL_USDC_IMPLEMENTATION_JA.md、本書とevidence：仕様・レビュー・証跡。
