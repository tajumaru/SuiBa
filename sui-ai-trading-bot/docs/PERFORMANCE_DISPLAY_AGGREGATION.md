# 表示用集計高速化 第1弾

比較基準：`6ff13aea54d2ed4375505557d36e3e6162722ec5`。
作業開始時に `git fetch origin main` で取得し、HEAD・origin/mainが一致することを確認した。
監査資料の過去の固定SHAや3101の実行版とは比較しない。

実装の固定SHA：`9259fdfcdfbc55ec2e875c373b55928cf3b2523c`。ブランチ：`perf/display-aggregation`。

| 分割コミット | 内容 |
|---|---|
| `91415e58b2e6cd2cf37235eea9eb5f11fab4edce` | API計測、表示用DB更新検出の基盤 |
| `3d82e5ce288af171d6a6b30571d75b439255a796` | operationCounts共有、台帳Map化 |
| `9259fdfcdfbc55ec2e875c373b55928cf3b2523c` | 表示入力・イベント由来集計の再利用 |

回帰テスト・再現スクリプト・結果は作業ツリーに作成済み。最終コミットは未作成。自動承認レビューの利用上限により最終確認を完了できていない。push・デプロイは行っていない。

変更ファイル一覧：

```text
apps/worker/src/index.ts
apps/worker/src/operations.ts
apps/worker/src/validation.ts
apps/worker/src/dashboard-feed.ts
packages/database/src/index.ts
packages/shared/src/api-timing.ts
tests/display-performance.test.ts
tests/settings-api.test.ts
scripts/benchmark-display.ts
scripts/regress-display.ts
scripts/prepare-display-baseline.ps1
docs/PERFORMANCE_DISPLAY_AGGREGATION.md
docs/PERFORMANCE_DISPLAY_RESULTS.json
```

## 実装と安全境界

- `operations.ts`：24h/168h reportのoperationCountsを期間ごとに1回にする。snapshot全体では5回→3回、対象SQLは10回→6回。
- 台帳：成功checksの最初のstrict-equality一致をMapに保持する。重複、未照合約定、不正数値、理由配列の順序、全件のgas加算・件数照合を維持する。NaNはMapのSameValueZeroとstrict equalityが異なるため登録しない。台帳結果はキャッシュしない。
- `validation.ts`：既存10秒TTLは維持する。DB更新時はTTL内でも失効させる。fresh出力でも入力versionが不変なら、検証イベントの読込・JSON解析とAPI・ローソク足・板のイベント由来集計を再利用する。経過時間・maxGap・停止記録・照合・合否条件は従来どおり評価する。
- イベントのSQL timestampとJSON内atを別に扱う。未来行は元のSQL範囲に入るまで解析しない。時刻の巻戻し、targetAt、targetAt+maxGapMsでも元の対象範囲を保つ。
- `dashboard-feed.ts`：表示用frameのcanonical化・hash、records読込・hashのみをDB更新versionで再利用する。summaryのruntime・安全状態は毎回engine.snapshotから取得する。
- DB versionは `total_changes()`、`pragma_data_version`、自接続transaction完了世代の組。ローカル更新、別接続commit、修復、rollback、再起動で失効する。キャッシュ取得エラー時に古い値へフォールバックしない。
- ordersAllowed・安全監視・停止・復旧条件に表示キャッシュを接続していない。DeepBook通信・売買戦略・Docker設定・DDL/indexを変更していない。3101へのアクセス・設定変更・再起動は実施していない。

## 計測方法

隔離した合成SQLiteとloopbackの空きポートによるroute harness。
実際のBotDatabase / OperationMonitor / ValidationRecorder / DashboardServiceを呼び出す。
スケジューラ・取引・外部通信は起動しない。認証・本番HTTPルーティング・Worker競合を含む本番性能ではない。

前後とも同じNode 24.22.1 Windows x64、既存node_modules、同じlockfile、同一fixture・固定時刻・gzip・直列要求。
CPUはIntel Core i5-10400（6 cores / 12 threads）。Vitest 3.2.7、TypeScript 5.9.3、Vite 7.3.7。
Nodeは測定用dataディレクトリにのみ展開し、公式SHASUMS256と照合した。
ZIP SHA256：`d2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5`。
lockfile SHA256：`f96da72b5afa94e0325a186c7bd07ec97c26f1a7ab26be5be55084399304bb90`。
依存の再インストールは行っていない。

fixture：paper_checks / paper_trades / paper_orders / operation_candidates 各10,000件、validation_events 25,000件、3足×1,000本。
HTTP warmup 10回を除外し、warmを各1,000標本採取する。時刻を固定するため10秒TTLの失効を混ぜない。
`/api/validation`は毎回fresh=trueであり、warmでもレポート全体のTTLヒットではない。
coldはレコーダー・DashboardServiceを要求ごとに再生成する別測定。
分位点はnearest-rank。HTTP時間は要求開始からgzip本文の全受信までで、クライアントJSON.parseは含まない。
同一PCの単一runであり、CPU固定、p99信頼区間、複数runの再現性は未評価。

SQL時間はStatementSync get/all/runの実行と行返却を含み、prepareとJSON.parseを含まない。
集計時間は対象の同期処理からSQL時間を引いた値で、prepare・JSON.parse・hashを含む。
JSON生成はJSON.stringify、圧縮はgzip完了までのwall time（キュー待ちを含む）。
本体APIにも同じ内訳をServer-Timingで付ける。圧縮しないレスポンスのcompressionは0。
SQL文・パラメーター・認証情報をメトリクスに記録しない。
基準版のarchiveには同一のSQL計測probeだけを加える。集計処理の変更は混ぜない。

## 結果

測定結果・回帰結果は同ディレクトリのJSON成果物と以下の表に記録する。

### warm（各n=1,000、ms）

| API | p50 前→後 | p95 前→後 | p99 前→後 |
|---|---:|---:|---:|
| /api/operations | 461.09 → 246.44 | 571.18 → 290.98 | 741.95 → 365.26 |
| /api/validation | 122.68 → 58.57 | 151.43 → 96.89 | 181.35 → 151.63 |
| /api/dashboard/summary | 54.18 → 38.06 | 65.56 → 51.43 | 79.55 → 74.62 |

### warm処理内訳（p50、ms）

| API | SQL回数 前→後 | SQL 前→後 | 集計 前→後 | JSON 前→後 | gzip 前→後 |
|---|---:|---:|---:|---:|---:|
| /api/operations | 45 → 42 | 124.77 → 99.26 | 336.06 → 145.33 | 0.08 → 0.08 | 0.51 → 0.52 |
| /api/validation | 7 → 7 | 51.53 → 26.35 | 69.13 → 31.17 | 0.03 → 0.03 | 0.37 → 0.36 |
| /api/dashboard/summary | 24 → 19 | 19.78 → 8.08 | 33.58 → 29.09 | 0.03 → 0.03 | 0.31 → 0.31 |

### cold（各n=30、ms）

| API | p50 前→後 | p95 前→後 | p99 前→後 | SQL回数 前→後 |
|---|---:|---:|---:|---:|
| /api/operations | 643.73 → 386.60 | 896.75 → 733.72 | 909.12 → 742.42 | 52 → 49 |
| /api/validation | 127.74 → 126.41 | 184.59 → 143.90 | 186.97 → 163.43 | 7 → 8 |
| /api/dashboard/summary | 55.69 → 67.60 | 63.30 → 126.31 | 70.85 → 145.07 | 24 → 25 |

coldのsummaryはp50・p95・p99が悪化した。更新確認SQLが1回増え、再利用できない条件ではキャッシュ構築コストも生じる。n=30の単一runだけでは悪化量の原因を断定できない。反復測定・GC/負荷分離による調査が未解決。coldのp99は最大標本であり安定したtail推定ではない。

warmのoperations p95も初期目標200msには届かない。全期間読込と会計計算の残コストがある。

3 APIのJSON本文SHA256はwarm/cold双方で前後一致。固定mainとの差分回帰22ケースも全てdeep equalityで一致。詳細な全分位点は [PERFORMANCE_DISPLAY_RESULTS.json](PERFORMANCE_DISPLAY_RESULTS.json) に保存した。

### テスト結果と未完了確認

- 対応版Nodeで型検査・productionビルド成功。
- 全体テストは425件中424件成功。追加テストの通信失敗fixtureが信頼host条件と不一致だった1件を修正し、その後の対象6件は6件成功。実装の安全条件は変更していない。
- 最終の全件再実行と再現用baseline準備スクリプトの動作確認は、自動承認レビューが利用上限で完了できず、コマンド自体が未実行。425件全件成功とは報告しない。
- 最後に追加したSQL例外時の計測assertionも未再実行。
- 別接続更新、rollback、DB再open、recorder再生成、通信失敗時の実行禁止・表示失効、未来の不正JSON、時刻巻戻しを対象テスト・差分回帰で検証。
- 実3101へはアクセス・変更していない。


## 再現

リポジトリのsui-ai-trading-botをcwdとし、対応版NodeをPATHに設定する。

```powershell
./scripts/prepare-display-baseline.ps1
$env:SOURCE_ROOT = "$PWD/data/performance/baseline/source/sui-ai-trading-bot"
$env:BENCH_OUT = 'data/performance/reproduce-before'
node --import tsx scripts/benchmark-display.ts
$env:SOURCE_ROOT = "$PWD"
$env:BENCH_OUT = 'data/performance/reproduce-after'
node --import tsx scripts/benchmark-display.ts
# coldは前後それぞれ別BENCH_OUTで実行する
$env:BENCH_SCENARIO = 'cold'
$env:SAMPLES = '30'
node --import tsx scripts/benchmark-display.ts
# differentialは空の合成DBだけを生成する
$env:BASELINE_ROOT = "$PWD/data/performance/baseline/source/sui-ai-trading-bot"
node --import tsx scripts/regress-display.ts
node node_modules/vitest/vitest.mjs run
node node_modules/typescript/bin/tsc --noEmit
```

既存のDBは使わず、新規のPID付きfixtureファイルを生成する。既存のbaseline出力先も上書きしない。

## 未解決の性能問題・制約

- 同期SQLiteと全期間台帳読込、表示reportの範囲集計、operationCountsのJSON集計は残る。台帳Map化は照合の探索コストを減らす改善で、照合自体を省略しない。
- engine.snapshot({ light: true })も当日件数・metrics用に最大1万件の取引履歴を読む。summaryのframe/recordsキャッシュ後もこのコストは残る。
- DB全体の更新versionなので、関係のないruntime等の更新でも表示キャッシュが失効する。頻繁な更新下の効果はwarm値より小さくなる。
- 検証イベントの入力キャッシュはセッション分の行文字列と解析済みオブジェクトを保持する。増分集計やメモリ上限の設計は今後の対象。
- fresh検証では停止・注文・checks等の読込と安全評価を繰り返す。表示用の合否を注文許可に流用しない。
- Worker競合時、100,000件以上、同時5/20接続、長時間のGC/RSS、ブラウザE2Eと実3101の性能は今回の比較に含まない。
- DeepBook/Suiの通信遅延、復旧・鮮度期限、フロントエンドbundle、静的圧縮、Docker最適化は対象外。

## main統合前の再確認（2026-10-23）

Node v24.22.1で型検査、production build、全32ファイル425テストが成功。上記の全件再実行・追加assertion未確認事項を解消した。baseline準備スクリプトの再実行と実環境への反映は未実施。
