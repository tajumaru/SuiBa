# 実況のサーバー側生成（端末間統一）設計

作成日：2026-11-16
状態：設計のみ（未実装）

## 1. 目的と前提

現在の実況は、各ブラウザが worker のスナップショットを材料に `advanceNarration` を実行し、ペア別の `localStorage`（`suiba.narration.v1`、WAL は接尾辞付き）へ保存する。同じ事実を見ても、画面を開いた時刻、開いていた時間、端末内の既読状態によって生成結果が変わる。

本設計の目的は、**運用事実から作る実況エピソードの正本を worker の SQLite に置き、どの端末も同じ順序・同じ本文を読む**ことにある。2026-11-15 の見送りは、オーナーが 2026-11-16 に再開を決めたため、本書では再検討済みとして扱う。

前提は次のとおり。

- PAPER の取引ロジック、売買条件、安全停止条件、DeepBook／Sui の通信経路を変えない。
- UI の見た目、キャラクターの口調、現在の表示上限（通常 30 件＋会話 12 件）を変えない。変更するのは実況の供給元だけである。
- worker とダッシュボードは既存方針どおり単一イメージのままとする。
- 数値や理由は保存済みの事実だけから作り、材料不足時は黙る現在の fail-closed を維持する。
- 本書は実装を含まない。テーブル名、API 名、保持値は実装前に未決事項を確定してから固定する。

## 2. 現状の棚卸し

### 2.1 現行経路

worker は `/api/dashboard/summary`、`/api/dashboard/records`、`/api/operations` などで判断、イベント、約定、予測、板、BTC、チェーン情報を返す。ブラウザはスナップショット更新時に段階処理を走らせ、重複排除、クールダウン、ウォッチ、連チャン、月次集計などの状態と本文を端末内に保存する。このため、ブラウザを閉じている間の実況は生成されず、初回表示では進行中の話を静かに採用する処理も端末ごとに起きる。

以下の kind は `apps/dashboard/src/narrationStorage.ts` の zod enum を正とした全 34 件である。「頻度」は上限または契機であり、実データ次第で発生しない。

### 2.2 kind 別の材料・頻度・移行可否

| kind | 現在の材料 | 現在の生成頻度／契機 | サーバー移行 | 理由・扱い |
|---|---|---|---|---|
| `cycle` | worker の decision telemetry、直前 trail | 新しい判断ごと。既定周期は 60 秒 | 可 | サイクル内の確定済み判断から決定論的に生成できる |
| `trade` | candidate audit、paper fill | 約定ごと | 可 | 約定コミット後の永続事実がある |
| `rejection` | candidate audit の拒否結果 | シグナルがゲートで拒否された時 | 可 | candidate の終端状態を契機にできる |
| `stop` | operation event、runtime／vital state | 手動・安全停止ごと。端末初期化時にも補完 | 可（補完は禁止） | operation event の一度だけの生成に統一し、端末初期化由来は廃止する |
| `start` | `MANUAL_START` control event | 開始ごと | 可 | operation event を正本にできる |
| `warning` | API／ANOMALY／ERROR event、connectivity | 新しい異常または遷移ごと | 可 | worker に原イベントと一時停止状態がある |
| `recovery` | recovery event、connectivity 遷移 | 回復ごと | 可 | worker の回復確定点で一度だけ生成できる |
| `nearMiss` | decision telemetry、watch 状態 | watch が接近後に外れた時 | 可 | watch 状態機械を worker 側へ移せば同一になる |
| `watchHit` | decision telemetry、watch 状態 | watch 条件成立時 | 可 | 同上。連チャンもサーバー状態で一意にする |
| `reach` | 3 条件中 2 条件成立、reach 状態 | 同じ不足条件の区間で 1 回 | 可 | decision と保存済みエピソード状態で判定できる |
| `superReach` | watch 距離、reach 状態 | reach 区間で最大 1 回 | 可 | 同上 |
| `priceLine` | decision の `rsiLinePrice` | ライン出現ごと | 可 | worker telemetry に材料がある |
| `priceLineReached` | decision price、保存済み price line | ライン接触ごと | 可 | worker 側状態で一度だけ判定できる |
| `sellLine` | position、entry、TP／SL 設定 | ポジションごと 1 回 | 可 | worker が保有状態と設定を持つ |
| `sellLineCrossing` | worker 予測記録、TP／SL | 再武装 15 分、同側 30 分 cooldown | 可 | 予測正本は既に worker。交差状態だけ移す |
| `review` | watch の declared／hit／miss | 精算 3 件、または BUY 時に未レビュー 2 件以上 | 可 | 集計状態を worker に保存すれば決定論的 |
| `alert` | decision price／volume の履歴 | ±1% または volume +200%、発火後 5 cycle 抑制 | 可 | worker の連続サイクルで欠落なく評価できる |
| `sleepTalk` | 端末の sleeping 時間、端末内実況履歴 | 停止中 15 分ごと | 条件付き可 | 内容材料はサーバーに移せるが「画面を見ている間だけ」の性質を失う。推奨はサーバー生成から除外し端末演出として残す |
| `chatUser` | 端末で入力した自由文 | ユーザー送信ごと | 不可（端末ローカル） | 全端末共有は会話内容の意図しない同期になる。運用実況ではない |
| `chatReply` | 端末入力、端末会話履歴、worker スナップショット | 応答ごと | 不可（端末ローカル） | 質問した端末の会話体験に属する |
| `chatPrompt` | 端末で観測した milestone | milestone ごと、通常 10 分 cooldown（BUY は例外） | 不可（端末ローカル） | 質問チップは端末 UI の誘導であり正本実況にしない |
| `epoch` | worker の chain sample、端末の last epoch | epoch 変化ごと | 可 | chain sample はサーバーにある。端末の初見判定を廃止する |
| `monthlyReport` | 端末の月次 counters、worker fill 最大 200 件 | 終了月ごと 1 回 | 条件付き可 | counters を worker に移せば可。ただし fill 200 件窓の欠落表示を維持する |
| `btc` | worker の BTC sample | 1h 変化 ±1%以上、同方向 2 時間 cooldown | 可 | sampler は worker に既存 |
| `forecastCall` | worker の forecast record、decision | 新しい非 flat 予測。最大 1 回／時、10 分以内 | 可 | 予測正本は既に worker |
| `forecastHit` | worker の forecast と candles | horizon 完了時、2 時間以内 | 可 | worker が採点・履歴を既に永続化している |
| `forecastMiss` | 同上 | 同上 | 可 | 同上 |
| `forecastTouch` | forecast touch state、candles | touch ごと、2 時間以内 | 可 | worker の予測と足から判定可能 |
| `forecastTouchNear` | 同上 | horizon 終了時、near 条件を満たす時 | 可 | 同上 |
| `bookWall` | worker の top-of-book sampler | 出現等は最短 5 分、同壁 30 分 cooldown | 可 | sampler は worker にある。検出状態をペア DB に移す |
| `forecastCalib` | worker の calibration event | 校正変更ごと。旧経路は 30 分以内のみ発話 | 可 | calibration event は worker に永続化済み |
| `memory` | worker の situation memory、任意の MemWal recall | 同一 statistic は 6 時間 cooldown | 可 | 統計・recall は worker に既存。生成結果を保存して全端末で共有する |
| `greeting` | 端末で選んだ character と直前 character | キャラクター切替ごと | 不可（端末ローカル） | 端末設定による UI 体験であり、別端末へ波及させない |
| `status` | vital state、初回表示、接続遷移 | 初回表示や状態遷移ごと | 原則不可 | 初回表示・再接続は端末固有。共有すべき BOOT／RESET は event 由来の別エピソードとして生成する |

結論として、正本フィードは 28 kind をサーバー候補とし、`sleepTalk`、`chatUser`、`chatReply`、`chatPrompt`、`greeting`、`status` の 6 kind は端末体験としてローカルに残す。enum は互換性のため直ちに分割せず、エントリに `scope: "server" | "device"` 相当を導入して供給元を明示する。`monthlyReport` は材料の月次 counter を移した段階で有効化する。

## 3. 目標アーキテクチャ

### 3.1 生成点

worker に `NarrationGenerator`（仮称）を置き、現在の純粋関数・文面テンプレートを shared または worker 配下へ移す。生成は HTTP の読み取り時ではなく、材料が確定したトランザクションの後に行う。

1. サイクルの判断、candidate、fill、operation event、forecast calibration を各既存テーブルへ保存する。
2. 同じ単一 `MarketScheduler` の tick 内で、永続化済みの最新事実と `narration_state` を読み、段階順を変えずに候補を作る。
3. `narration_entries` と次の `narration_state` を 1 SQLite transaction で保存する。
4. commit 後に MemWal outbox を同じ source id で冪等に enqueue する。MemWal の失敗は生成・取引へ影響させない。

非サイクル材料は次の確定点を契機とする。

- operation／control／fill：その記録の commit 直後
- forecast answer／calibration：forecast 更新 transaction の直後
- BTC、chain、book：sampler の新しい有効 sample を採用した直後。ただしペア固有の book 以外は二重発話を防ぐ生成キーを持つ
- situation memory：`refreshSituationMemory` が新しい `key:evaluatedAt` を保存した直後

worker 起動時は、カーソル以降の未処理材料だけを順に再生する。現在のブラウザ初期化のように、古いスナップショットから `status` や進行中の話を新規生成しない。クラッシュが「材料 commit 後、実況 commit 前」に起きても再生で埋まり、「実況 commit 後」に再試行しても安定 id の一意制約で重複しない。

### 3.2 SQLite 案

ペア別 `bot.sqlite` に以下を追加する。

```sql
CREATE TABLE narration_entries (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  id         TEXT NOT NULL UNIQUE,
  pair       TEXT NOT NULL,
  source_key TEXT NOT NULL,
  kind       TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  json       TEXT NOT NULL,
  UNIQUE(pair, source_key, kind)
);
CREATE INDEX narration_entries_pair_order
  ON narration_entries(pair, occurred_at, seq);

CREATE TABLE narration_state (
  pair       TEXT PRIMARY KEY,
  version    INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  json       TEXT NOT NULL
);
```

`json` は現行表示に必要な `text`、`side`、`forecastOrigin`、`sellLineSide` 等だけを厳密 schema で保存する。自由な元スナップショットは複製しない。`narration_state` は watch、reach、cooldown、monthly counters、処理済み材料カーソル等の生成状態であり、既読や封印の開封状態は入れない。

#### id と source_key

- `id` は表示用の安定識別子で、`narration:v1:<pair>:<kind>:<source-key>:<ordinal>` の各要素を canonical JSON 化して SHA-256 にした値とする。文面変更で id が変わらないよう、本文は入力に含めない。
- `source_key` は材料の不変 id（operation event id、candidate id、fill id、forecast origin、calibration id、decision `evaluatedAt`＋cycle id 等）と、状態遷移名から作る。
- 1 材料から複数行出る `review` は `ordinal` を 0 始まりで固定する。
- ランダム UUID と `Date.now()` 単独を id に使わない。再起動時の再生で同じ id になることをテストする。

#### 並び順

正規順は `(occurred_at ASC, seq ASC)` とする。`occurred_at` は元事実の時刻、`seq` は同時刻の段階順を確定する DB 採番である。API cursor には `seq` だけを使い、時刻の同値や時計の後退で欠落しないようにする。画面も API 順をそのまま表示し、端末側で再ソートしない。

### 3.3 読み取り API

既存認証境界に次を加える。

```text
GET /api/narration?pair=SUI_USDC&since=<seq>&limit=100
200 {
  "schema": 1,
  "pair": "SUI_USDC",
  "entries": [...],
  "nextSince": 12345,
  "hasMore": false,
  "oldestAvailable": 12000,
  "generatedAt": 1794787200000
}
```

- `since` は排他的な整数 cursor（`seq > since`）。未指定時は最新 30 件を昇順で返す。
- `limit` は既定 100、最大 200。`hasMore=true` の間は同じ cursor でページングする。
- cursor が保持窓より古い場合は、欠落を隠さず `410 NARRATION_CURSOR_EXPIRED` と `oldestAvailable` を返す。画面は最新窓を再取得する。
- `pair` は allowlist（`SUI_USDC`／`WAL_USDC`）で検証する。現行の `x-suiba-pair` と pair switch の 409 契約を維持するか、選択 DB を安全に読み分ける専用 service にするかは未決事項 #2 とする。
- ETag または `nextSince` の長時間 polling を使えるが、WebSocket／SSE は導入しない。既存 dashboard polling に同居させる。
- `/api/*` と同じ session／管理 Bearer／readonly Bearer を受理する。readonly Bearer は GET のみという現行規則をそのまま適用し、新しい書き込み権限を作らない。

### 3.4 ダッシュボード

ダッシュボードの運用実況は表示専用にする。

- `advanceNarration` による正本エピソード生成、運用状態の `persistNarration`／`restoreNarration` を停止する。
- API の entry を既存 `AgentNarrationFeed` に渡し、現行 kind ごとの見た目、音声、ポーズ、スクロール挙動を維持する。
- `chatUser`／`chatReply`／`chatPrompt`／`greeting`／`status`／推奨上の `sleepTalk` は、`scope=device` の別レイヤーとして端末内に保持する。サーバー entry の間へ挿入する場合もサーバー順は変えない。
- 端末が閉じていた期間も、再接続時に cursor 以降を取得する。画面上限を超える分は現在どおり表示時に trim するが、サーバー記録は失わない。
- 音声読み上げは「この端末で新着として受け取った entry」だけを対象にし、初回ロードや cursor expired 後の再同期で過去分を一斉に読まない。

## 4. 端末ローカルに残す状態

原則は、**事実とその共通実況はサーバー、閲覧者ごとの体験は端末**である。次はサーバーに上げない。

- memory の封印シールを開けた id（`openedMemorySealIds`）と封印導入時刻
- 既読 cursor、未読件数、末尾追随／「最新へ」ボタン、スクロール位置
- 音声の再生済み、ミュート、読み上げ中状態
- 選択キャラクターと切替挨拶
- チャット入力、会話履歴、質問チップの表示済み
- 端末接続・再接続に由来する `status`、推奨上の `sleepTalk`

これらを API cursor や `narration_state` と混ぜない。既読同期や会話同期は本設計の目的ではない。

## 5. SUI_USDC／WAL_USDC

現行は localStorage key を分け、フィード、スコア、チャット memory をペア間で混ぜない。worker DB も SUI の root DB と WAL の sibling DB に分かれる。したがって正本も**ペア別フィードを推奨**する。

- `narration_entries`／`narration_state` は各ペア DB に置き、API は選択中のペアだけを返す。
- 画面のペア切替では該当ペアの cursor と端末既読を読み直す。
- BTC／chain／起動停止のような共通材料も、生成時点で各ペアへ複製するなら id に pair を含める。片方だけに記録して API で合成する方式は、順序と保持境界が複雑になるため採らない。
- 将来「全ペア統合フィード」が必要なら、ペア別正本を `occurred_at, pair, seq` で読み取り時に合成する。初期実装では行わない。

## 6. MemWal ミラー

現行はブラウザが `watchHit`／`nearMiss`／`review` を `/api/memwal/narration` へ POST し、worker が `memwal_outbox` に入れる。サーバー生成後はこの POST を撤去し、`NarrationGenerator` がエピソード保存と同じ source id を使って outbox に enqueue する。

- enqueue 対象 kind と curated text は現行 3 種を維持する。
- `UNIQUE(kind, source_id)` と安定 source id により、クラッシュ再生でも二重登録しない。
- ブラウザからの旧 POST は移行期間だけ受理してもよいが、サーバー生成 entry の id と同じ source id へ正規化し、重複を no-op にする。表示切替後に endpoint と呼び出しを削除する。
- shadow／daily review の mirror 経路は変更しない。実況の生本文、自由チャット、封印状態は MemWal に送らない。

## 7. 保持と容量

### 7.1 日量の試算

既定 60 秒周期で `cycle` が最大 1,440 件／日となる。各 cycle に alert、watch、reach、line 等が重なる最悪寄りの係数 1.5 と、event／forecast／book 等 100 件／日を足すと、設計上の上側は約 2,260 件／日である。平常時は `cycle` 中心の約 1,500 件／日を想定する。

1 entry を index 込み平均 1 KiB と保守的に置くと、約 1.5〜2.3 MiB／日、30 日で約 45〜69 MiB／ペア、2 ペアで約 90〜138 MiB。文面だけなら実際はこれより小さいが、容量判断は上側を使う。

### 7.2 推奨保持

- SQLite の全文 entry は **30 日または 50,000 件／ペアの早い方**を推奨する。50,000 件は平常約 33 日、上側約 22 日に相当する。
- 削除はサイクル間に最大 200 行ずつ行い、取引サイクルを長時間塞がない。未送信の MemWal outbox を narration entry の削除に連動して消さない。
- 現行の `RETENTION_FULL_EVIDENCE_DAYS=30` は古い decision／cycle audit の payload を compact するもので、実況は元証拠の代替ではない。実況を 30 日で削除しても証拠テーブルの方針を変えない。
- forecast の append-only archive、fill、operation event 等の既存保持も変えない。実況 json に元証拠を複製しないことで増加を限定する。
- cold backup／公開 export の既存アーカイブ上限を広げない。初期実装では実況テーブルを公開 export の対象外とし、DB backup には通常の SQLite テーブルとして含める。公開 export が必要になった場合は、別途 allowlist、件数上限、自由文非包含を設計する。

## 8. 移行計画とロールバック

| 段階 | 内容 | 判定 | ロールバック |
|---|---|---|---|
| 0. スキーマのみ | 空テーブル、state schema、read API を追加。画面は現行のまま | DB migration、空 API、readonly 認証 | 画面影響なし。旧 worker へ戻しても追加テーブルは無害 |
| 1. 影生成 | worker が server entry を生成するが画面は端末生成を表示 | 同じ材料範囲で kind、本文、順序、件数を突き合わせる。端末固有 6 kind は比較外 | feature flag で生成停止。端末表示は無影響 |
| 2. 読み取り影運用 | 画面が API も取得し、開発診断だけで差分記録 | 複数端末で server id／cursor が一致、再起動で重複なし | API 取得を止め、従来表示を継続 |
| 3. 表示切替 | server entry を表示正本にし、端末生成は fallback として残す | 端末間一致、音声の過去一括再生なし、pair 分離 | feature flag で端末生成へ戻す。server table は保持 |
| 4. 端末生成撤去 | 運用 kind の `advanceNarration` と旧 MemWal POST を撤去 | 一定観察期間で欠落・重複・cursor expired 復帰を確認 | 直前版へコード rollback。DB は前方互換で残す |

既存端末の過去フィードは**サーバーへ取り込まない**ことを推奨する。理由は、同じ事実から複数端末が異なる本文・id・時刻を持ち、どれを正本にするか証明できず、重複や順序逆転を避けられないためである。切替時は localStorage を即削除せず、端末内の「切替前の履歴」として短い互換期間だけ閲覧可能にするか、単に新 server feed へ置き換えてロールバック用に残す。サーバー API へ upload する経路は作らない。

リリースは既存の単一イメージ経路を使う。worker／UI の変更を含むため停止窓と通常の配置・再開手順が必要だが、broker の特権コードや監視経路は変更しない。

## 9. 整合性・障害時の原則

- 生成失敗は取引・安全系を止めない。失敗を診断イベントとして記録し、次 tick で同じ cursor から再試行する。
- malformed な元材料は実況を生成しない。推測本文で穴埋めしない。
- API 停止中は最後の取得内容を表示し、既存の「再起動中の可能性」表示とバックオフ復帰に従う。データ鮮度と Bot の安全状態を混同しない。
- state schema は version を持ち、未知 version は生成を止めて診断可能にする。空 state へ黙って戻して watch を二重宣言しない。
- テストは 34 kind の enum 一致、同一入力の冪等性、クラッシュ境界、同時刻順、pair 分離、保持境界、readonly GET、MemWal 一重化を固定する。

## 10. やらないこと

- 取引ロジック、売買条件、戦略パラメータ、ProfitGuard、安全停止条件、回復上限を変更しない。
- UI の見た目、表示件数、キャラクターの口調を変更しない。
- WebSocket／SSE、別ダッシュボードサービス、Service Worker／PWA を導入しない。
- 端末の既読、封印シール、チャットをアカウント同期しない。
- 過去 localStorage を server 正本へ import しない。
- MemWal の対象 kind を増やさない。

## 11. 未決事項（オーナーの決定が必要）

### 11-1. `sleepTalk` を共有フィードに含めるか

- A：サーバーが停止中 15 分ごとに生成し、全端末で共有する。
- B：端末が開いている時だけのローカル演出として残す。
- **推奨：B。** Bot の事実ではなく閲覧中のキャラクター演出で、24 時間生成すると履歴の多くを占めるため。

### 11-2. 非選択ペアの API 読み取り方式

- A：現行どおり worker の選択中ペアだけを返し、切替後に読む。
- B：API が両方のペア DB を read-only で開き、`pair` query で直接読む。
- **推奨：A。** 初期実装の DB ライフサイクルと pair switch の契約を変えずに済む。端末間統一には十分である。

### 11-3. 保持上限

- A：30 日または 50,000 件／ペアの早い方。
- B：90 日または 150,000 件／ペアの早い方。
- **推奨：A。** 現行の完全証拠 30 日方針と揃い、2 ペアの上側見積もりを約 138 MiB に抑えられる。

### 11-4. 影生成の合格条件

- A：7 日間、server 対象 kind の差分ゼロを要求する。
- B：48 時間かつ主要経路（cycle、watch、trade、stop／recovery、forecast）を各 1 回以上確認する。
- **推奨：B。** 稀な月次・約定を待って移行を止めず、各 kind の fixture／再生テストで不足分を補う。

### 11-5. 切替前 localStorage の表示

- A：切替後は server feed だけを表示し、localStorage はロールバック用に読み込まず残す。
- B：「切替前の履歴」として端末内だけの別区画を一定期間表示する。
- **推奨：A。** UI を変えないという範囲を守り、端末ごとに違う過去を共通フィードへ混ぜない。

### 11-6. 端末ローカル entry と server entry の見せ方

- A：現在と同じ一つの時系列に合成し、内部 `scope` だけ分ける。
- B：チャット等を別フィードへ分ける。
- **推奨：A。** 見た目を変えず、server entry の順序は `seq` で維持できる。合成の同時刻 tie-break は server entry を先に固定する。

## 12. 実装規模の自己評価

**L**。文面関数の移設だけでなく、34 kind の分類、生成状態の永続化、クラッシュ再生、API cursor、ペア DB、MemWal の入力変更、段階移行、ダッシュボードの表示専用化が跨るためである。安全に分割するなら、スキーマ／影生成、API／影取得、表示切替、旧経路撤去の 4 PR 以上を想定する。
