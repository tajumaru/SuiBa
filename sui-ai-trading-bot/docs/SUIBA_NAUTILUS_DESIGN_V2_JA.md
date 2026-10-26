# SuiBa × Nautilus 調査・設計 第2版

調査日：2026-10-26。対象：tajumaru/SuiBa、前回取得したmain `ce09e38ace33a7623539275d0da67677f88cd36b`。本版ではリモートmainを再取得していない。今回はソース読取と公開一次資料調査、設計文書作成のみ。アプリ改修、起動、デプロイ、注文、Gitのmain変更・push・マージは実施していない。

## 1. 結論と前提

未運用でアプリ改修可能という条件を反映し、「既存Worker全体の移植」より「共通ドメイン処理と環境依存処理の分離」を推奨する。Windows 11／通常Dockerの起動機能は維持する。実行モードはPAPER限定とし、TEE対応を理由にLIVE経路や取引用秘密鍵を追加しない。

第一段階はOyster CVM＋Node.js 24.22.1で注文なしの単発判断を検証する。Bunを前提とするnautilus-tsは初期採用しない。自前Nitro＋Node＋小さなRust証明コンポーネントを代替案とし、証明・通信互換性に問題があれば比較する。公式RustテンプレートをそのままNodeで動く製品とは扱わない。

第二段階で、外部の権威ある保存先と単一実行制御を追加する。TEE内SQLiteやOysterのDocker volumeを履歴の唯一の保存先にしない。SQLiteはDocker版の正本、TEE版の再構築可能なローカル投影として利用できるが、両者の保証は同じではない。

本文の分類：**確認済み**＝ソースまたは一次資料で確認。**設計案**＝今後の実装案。**未検証**＝対象環境で実行していない事項。文書での提供機能は稼働保証・SLAの実測とは区別する。

## 2. 追加調査で確定した事項

| 事項 | 確認内容 | 設計への影響 |
|---|---|---|
| OysterのNode構成 | Sui向け手順にNode.js／Rust／Pythonの構成がある [S1,S2] | Node維持の根拠になる。ただし24.22.1とnode:sqliteは別途実機検証 |
| Sui経由の投入 | Sui用ガイドに`--deployment sui`がある [S1] | 一般QuickstartのArbitrum経路と区別する。支払用mainnet資産とTestnet検証は別 |
| アプリの測定 | blue構成ではPCR0/1/2に加えてPCR16/imageIdでアプリを識別する [S2,S3] | 基盤PCRだけの一致ではSuiBaコードを証明できない |
| mutable tag | Composeのタグ名が同じならイメージ更新後もPCR16が同じになり得るとの記載 [S1] | アプリ・補助サービスすべてdigest固定。起動後にコードを取得しない |
| 永続化 | 公開資料は別Instanceへの状態移送に未実装の制約を記載 [S4] | 障害時の状態自動引継ぎを設計前提にしない。現行サービスの提供状況は要照会 |
| Seal | 公式Seal-Nautilus例は自前TEEのみ試験済み、Oyster未試験 [S5] | Oysterでそのまま使えると約束しない |
| OysterのNautilus KMS | 再起動後の鍵導出を目的とする [S6] | Sui Nautilusと同名だが別の仕組み。鍵復旧とDB復旧を混同しない |
| ネットワーク | proxy方式で切断・timeout挙動が変わり得る。TLSはTEE内終端が必要 [S7,S8] | 採用base imageの実装を固定して通信試験する |

## 3. 現行コードで追加確認した分離上の問題

1. `BotEngine`は具象`BotDatabase`、`OperationMonitor`、グローバル`apiAccess`、Cetus見積り、PAPER計算を一つのtickで扱う。単なるDBクラス差し替えでは非同期の外部確定保存に対応できない。
2. `packages/shared/src/index.ts`は型だけでなく`apiFetch`もimportする。共通ロジックの依存を小さくするには、型・スキーマ・数値処理と通信を分離する必要がある。
3. `api-timing.ts`と`read-budget-node.ts`はNodeのAsyncLocalStorageに依存する。ブラウザやドメイン処理の入口に混在させない。
4. 指標計算は60本以上、現在足と前回足の両方を計算する経路では61本以上が必要。現行足検証も最低61本。1件の価格取得では現行戦略を評価できない。
5. Cetus quoteは15秒で失効する。外部保存後に古いquoteで処理しない。外部通信中にDBトランザクションやロックを保持しない。
6. ChartHistoryClientはworker_threadsを使い、別のchart-history SQLiteを持つ。図表履歴・バックテストの処理をTEE判断の必須構成から外せる。ただし検証に使う市場足は共通化する。
7. 現行mainは起動時停止・世代番号・単一tick・DB内の重複抑止・原子的fillを持つが、複数DBや複数TEEを跨ぐ排他ではない。

前回確認時、PR #16／#17はともにDraft・未マージ。本版でマージ状態を再取得していない。#17の注文／trade／check照合強化は新設計の必須要件へ反映するが、レビュー・取り込みは今回行わない。#16の新しい分析・confidence等を移行の必須依存にはしない。

## 4. 提案する論理構成

以下は新設または再編する責務であり、実装済みのパッケージ名ではない。

| 層 | 責務 | 禁止する依存 |
|---|---|---|
| domain-types | Candle、設定、Portfolio、判断、イベントの型・スキーマ | fs、HTTP、DB、環境変数 |
| analysis-core | 指標・戦略・ProfitGuard・リスク・PAPER遷移・独立台帳検査 | DB、署名鍵、ネットワーク、直接の現在時刻取得 |
| cycle-service | 取得→品質検査→判断→安全確認→保存の順序制御 | UI、具象SQLiteへの直接アクセス |
| safety-machine | 停止・通信一時停止・復旧・再起動・世代管理 | UIの状態だけに依存した認可 |
| infrastructure | DeepBook、Sui、quote、保存、時計、ID生成、署名 | ドメイン判断の再実装 |
| docker-runtime | 既存Node、SQLite volume、管理API、Scheduler | TEE証明成功の偽装 |
| tee-runtime | 証明・署名・許可通信・外部保存・起動検証 | LIVE executor、任意メッセージ署名API |
| dashboard | DockerまたはWalrusの静的React画面 | 取引用秘密鍵、公開ADMIN_TOKEN |

ローカル通常Dockerは外部Sui・Walrus・TEE・KMSなしでも、オフライン入力による検証と起動ができる状態を維持する。実市場データ利用時は当然その接続が必要。TEE実行だけが必要とする鍵・証明のために、通常Docker起動を壊さない。

## 5. 境界となる契約

設計用の契約であり、実コードではない。

- MarketReader：期限とsignalを受け取り、足・板・取得先・取得時刻・品質証拠を返す。
- SuiReader：現行の読み取り専用API。発注・取引送信メソッドを持たせない。
- QuoteReader：Cetus見積り取得・鮮度検査。単発判断PoCでは依存させない。
- AnalysisInput：検証済み足、設定、PAPERポートフォリオ、明示された評価時刻、入力・状態version。
- AnalysisResult：BUY/SELL/WAITと根拠。`executionEligible`とは別。BUYは注文許可ではない。
- StateStore：load、atomic commit、request ID照会、epoch制御、停止命令。ネットワーク保存に対応するため非同期契約とする。
- Clock：wall timeと単調時計を分離。ドメインの再現評価では評価時刻を固定する。
- EvidenceSigner：定義した判断・確定結果だけを署名。任意のbytesを外部APIから受け取って署名しない。

市場取得失敗は正常なWAITに変換しない。`UNAVAILABLE`／`INVALID_INPUT`として返し、戦略を実行していないことを記録する。正常なWAITとの混同を防ぐ。

## 6. 保存方式の選択

| 方式 | 利点 | 制約 | 判断 |
|---|---|---|---|
| TEE内SQLiteのみ | 簡単 | 再起動・移送時の消失 | 単発PoC限定 |
| SQLiteの定期snapshotのみ | 既存DBを流用 | 最終snapshot以降の損失、巻き戻し | 確定履歴の正本にしない |
| 外部の信頼するDB | 原子的保存、排他、履歴照会を実装しやすい | DB管理者・サービスを信頼する | 初期の常時PAPERで推奨 |
| 暗号化イベント＋Sui上の最新状態commitment | 未信頼ストレージの改ざん・巻き戻し検知を強化 | オンチェーン遅延・費用・複雑さ、データ可用性は別 | 強い脅威モデルが必要になった段階 |
| WalrusへDBファイルを毎周期保存 | 保存されたblobを参照できる | SQLiteのtransaction／leaseを代替しない | 主DBとして採用しない |

初期の常時PAPERでは、自分が管理し信頼する外部PostgreSQL等を正本とする案を推奨。TEE内のSQLiteはキャッシュ・再構築可能な投影にする。通常DockerはSQLiteの単一ファイル・ローカルvolumeを正本としてよい。同じStateStore契約試験を両方に適用する。

この案は「計算と鍵はTEEで守るが、履歴の最新性・排他についてDBを信頼する」モデルである。DBまで悪意を持つ前提の完全な保証と宣伝しない。暗号化・署名・hash chainだけでは、DBが提示する整合した過去状態を検出できない。

## 7. 常時PAPERの確定プロトコル案

1. 起動のたびに新boot ID。状態取得・検証中は注文ゲート閉鎖。
2. 信頼するStateStoreの単一writer制御で新epochを取得。lease期限はStore側で判定し、各commitでepochを照合する。単なるTTLだけに依存しない。
3. 市場取得・見積り・計算はDBロック外で実行。開始時のstateVersion、settingsVersion、stopGenerationを記録する。
4. commitはひとつのtransactionで、writer epoch／lease、開始許可、停止世代、状態version、注文ID未登録、quoteと市場の期限を再確認する。
5. 注文、trade、check、portfolio、処理済み足、監査、状態version更新を一括保存する。どれか失敗なら全体をrollbackする。
6. 正本からcommit成功を確認して初めて確定結果として返す。結果署名には確定seqとstate hashを含める。判断署名と約定確定署名の用途を区別する。
7. 保存成功の返答が失われたときは同じrequest IDを照会。別IDで再注文しない。確定不能のまま次周期の注文へ進まない。

Writer epochが変わっても経済的な同一注文IDは変えない。`account＋source＋timeframe＋candle timestamp＋side`等を基に一意化し、epochは独立の排他用列とする。epochを注文IDへ含めて再起動時に別注文にしてしまわない。

SQLiteとPostgreSQLを跨ぐtransactionは作らない。TEE内の投影更新が失敗しても外部正本から復元できる設計にする。外部正本へ確定後、応答前にTEEが停止しても同じ結果を問い合わせられる。

PAPER fillは純粋な状態計算なので、正本での原子的commitと一意制約で二重適用を抑止できる。現物注文に必要な外部取引所とのexactly-once保証を実現したとは主張しない。

## 8. 停止・再開の状態機械

| 状態 | 注文 | 遷移条件 |
|---|---|---|
| BOOTING | 不可 | 証明・設定・状態・履歴を検査 |
| STOPPED | 不可 | 正常起動後の既定状態。明示STARTを待つ |
| RUNNING_PAPER | PAPERのみ | 認証済みSTART、writer保持、全ゲート正常 |
| PAUSED_NETWORK | 不可 | 対象となる一時通信障害。復旧証拠を収集 |
| RECONCILIATION_REQUIRED | 不可 | 注文・台帳・状態versionに疑義 |
| EMERGENCY_STOPPED | 不可 | 明示停止、重大異常。自動復旧しない |

現行の通信一時停止からのPAPER限定復旧は保持する。PR #17相当の連続正常周期、注文／trade／checkの照合、停止世代再確認を要求する。新boot ID、writer交代、DB復元、未知のcommit結果からは自動売買再開しない。プロセスの自動再起動と、売買の自動再開を分ける。

停止命令は正本のstopGenerationを増やす。commitが先に確定したか、停止が先に確定したかをStoreで直列化する。停止確定後のfillは拒否する。通信断で停止を永続化できない場合も、TEEのローカルゲートは直ちに閉じる。別のwriterが勝手に再開しないよう、writer交代は常にSTOPPEDで始める。

ネットワーク越しの停止には伝達遅延がある。UIで停止ボタンを押した瞬間から全系統の停止を保証するのではなく、ローカル閉鎖と正本停止の確認状態を分けて表示する。

## 9. 証明・署名・設定の設計

PoCの署名鍵は起動ごとの一時鍵。永続署名鍵を導入しない。暗号スイートはOysterのSui連携例に合わせたsecp256k1を第一候補にし、Moveの検証形式・hash・署名encodingまで固定する。公式Rust例のEd25519と無条件に互換だとは扱わない。

署名Envelope案：schemaVersion、purpose=`SUIBA_ANALYSIS_V1`、executionMode=`ANALYSIS_ONLY`、sourceNetwork、verificationNetwork、pair、requestId、challenge、bootId、code/config/input/state hash、取得時刻、評価時刻、期限、判断、根拠hash。金額はatomic整数文字列、時刻は整数、列挙値は固定。BCS等で実際の署名対象bytesを定義し、表示JSONと分ける。

データ取得のmainnetと検証先のTestnetを明示的に分離する。Testnet契約が受理しても「Testnet市場から取得した」ことにはならない。

Oyster blueでは期待するbase PCRとPCR16/imageIdを両方検証する。信頼するコード・設定の値はレビュー済みビルドから計算し、稼働中サーバーが返した値をそのまま信頼リストへ追加しない。debug測定を受け入れない。

起動時注入する設定はPCRに入らない場合があるため、code hashだけで戦略設定まで証明したとしない。設定hashを署名へ含め、管理者署名や認可された設定versionと比較する。外部URL、対象銘柄、PAPER制約、許可する設定範囲を検証する。

再現可能buildはNode・pnpm・lockfile・アーキテクチャ・全イメージdigest・ビルド手順を固定し、独立した2回のビルドで比較する。既存Dockerfileのdigest固定だけで成立したとは扱わない。PoCはまずamd64で差分要因を減らす。arm64最適化は後段。

## 10. Walrus Sites・API・認証

共通のReact静的buildをDocker配信とWalrus配信に使う。API base URLを明示設定し、HTTPSと許可originを検証する。CORSは認証の代わりにならない。公開read APIと管理APIを別scopeにする。

提案API：GET capabilities、GET attestation情報、POST analysis-once、GET analysis結果、GET PAPER状態。START／STOP／設定変更は別の認証済み管理API。PoCはSTART・fill APIを公開しない。

通常Dockerでは既存ADMIN_TOKEN認証を維持できる。TEE管理ではウォレット署名等でmethod、path、body hash、account、network、nonce、期限を結び付け、TEE側でも認証する。署名者アドレスと許可リストを照合する。署名nonceを再利用させない。秘密の本文は別途暗号化が必要で、署名だけでは隠せない。

PoCの公開データは通常HTTPS入口で中継してよいが、中継を機密性の信頼境界とするかを明記する。ホストからも秘密を隠す本格構成では、TEE内でWeb PKI TLS終端するか、証明に結び付いた暗号化チャネルを設計する。Scallopは通常ブラウザfetchでそのまま使えるとは扱わない。[S8]

フロントは「署名未検証」「登録済み鍵の署名検証済み」「Testnet契約検証済み」を分ける。鍵を応答から受け取って署名だけ検証した状態を、TEE検証済みと表示しない。信頼するregistry・測定値・鍵の結び付きも検証する。古い結果は時刻と期限切れを表示する。

Nautilusとしての証明連携を検証する段階では、PCRと鍵のオンチェーン登録を含める。各判断結果のオンチェーン検証は別段階にできる。[S9] Walrus Testnet表示用portalは公開mainnet portalと分けて準備する。

## 11. 最小PoCの境界と手順

### PoC-0：Dockerで共通判断の再現性

将来の実装作業：現行判断の入力と結果を固定fixtureとして保存し、同じNodeで切り出し前後を比較する。売買判断、理由、数値、ProfitGuard・リスクの境界条件を保つ。戦略改善を同時に混ぜない。

### PoC-1：Oysterで単発取得・判断・署名

1. Node 24.22.1の最小imageを起動。バージョンguardを維持。
2. 1回の取得バッチで既存戦略に必要な足を取得。既存Engine同等の品質検証を対象にするなら5分・15分・1時間足と板・Indexer状態も取得する。1 HTTP要求限定とはしない。
3. 固定のPAPERポートフォリオ・設定で1回判断。設定・初期状態はhashを明示し、利用者口座と誤認させない。
4. quote／fill／Scheduler／注文DBを呼ばず、構造化した結果を署名。
5. ローカルで同じ保存入力を評価し比較。所定の測定値・鍵との結び付きを検証。
6. 証明登録をTestnetで検証。続いて任意の結果をTestnetアプリ契約で検証する。
7. Walrus Sitesの読取画面から取得し、署名・期限・ネットワークを表示。

再起動時は未完了の単発要求を自動再実行しない。永続性を持たないPoCでは同じrequestIdの重複実行を再起動を跨いで完全には抑止しない。bootIdで区別し、出力に注文権限を持たせず、Testnet側ではchallengeの消費を一度に制限する。これは常時PAPERの冪等性保証とは別。

### PoC-2：耐久保存とPAPER復旧

外部正本、単一writer、epoch、原子的PAPER commit、照会による不明結果の確定を追加する。DockerとTEE両方で同一の保存契約試験を実施。ウォレットの実注文は導入しない。

### PoC-3：連続運転と切替

24時間、次に72時間で通信・DB・TEE再起動を試す。別accountのDockerを比較用に動かしてよい。同じaccountを切り替えるときは停止確定→正本照合→writer更新→停止状態起動→手動START。共有実行環境のfailoverをローカルDBコピーだけで行わない。

## 12. 合格条件と障害試験

| 試験 | 合格条件 |
|---|---|
| 共通判断の互換性 | 同じ入力・設定・時刻に同じaction／reason／数値。PAPER遷移・独立台帳検査が一致 |
| パッケージ境界 | analysis-coreにfs、DB、HTTP、process.env、秘密鍵が入らない |
| PAPER限定 | 通常Docker・TEEともLIVE設定を拒否。PoC配布物にexecutor／fill APIを含めない |
| HTTP/2 | ALPN、接続再利用、GOAWAY、RST、部分body、cancel後の遅延成功を確認 |
| 期限 | 既存の安全期限を緩和せず、期限切れは拒否。対象base imageで孤立通信を残さない |
| 証明 | 間違うPCR16、base、鍵、debug、改ざん署名、異なる用途を拒否 |
| 再送 | 同じ確定requestIdは同じ結果。別payloadとのID衝突を拒否 |
| commit前強制終了 | 未確定fillがportfolioへ反映されない |
| commit後・応答前強制終了 | 再照会で既存結果を返し、fillを増やさない |
| 2 TEE | 古いepochのcommit拒否。障害中のwriter交代でも明示STARTが必要 |
| 停止競合 | 停止確定後のfill拒否。遅れて届く正常応答で再開しない |
| 保存異常 | 接続断、COMMIT不明、容量不足、整合性不明で注文ゲート閉鎖 |
| 履歴照合 | 孤立・重複・方向不一致・不正日時・JSON ID不一致等で停止 |
| 復元 | 完全な正本から再構築。古いsnapshot単独では再開許可を出さない |
| 設定更新競合 | 判断開始後の設定更新を検知し、古いversionのcommitを拒否 |

初期の単発通信計測は30回以上でcold/warmのp50/p95/max・失敗数を記録する設計案。小標本なのでSLAとはしない。連続運転では通信・計算・保存・署名を分けて測定し、既存の8秒取得／quote15秒等の期限内で成立するか評価する。閾値超過を理由に鮮度判定を安易に緩めない。

## 13. 工数・費用の更新

前回のPoC 5～10人日は単発経路に限定した見積り。本版の共通化・管理認証・外部正本を全部含む数字ではない。

計画用推定：共通化と互換性検証3～6人日、単発TEEと署名・画面5～10人日、耐久保存・復旧・排他10～20人日、連続運転・運用手順3～5人日＋24～72時間の観測。単純合算21～41人日程度だが、再現可能build、TLS、registry互換性の難度で増える。コード改修前の確約ではない。

前回の自前Nitro月160～200ドルの概算は単一ホストの参考枠で、外部正本の新設費まで含まない。新設計の月額は「TEE実行契約＋永続DB＋バックアップ＋監視＋HTTPS／ドメイン＋Suiガス＋Walrus保存」。Oysterの確定単価、DB規模、保存量が未確定なので総額を確定しない。小規模の外部DB・バックアップに月20～80ドル程度を予算枠として仮置きできるが、これは公式料金ではなく設計上の予備費である。

## 14. 設計判断の現状

- 採用案：Node 24維持、共通ロジックの分離、DockerとTEEの別起動、PAPER限定、Oyster単発PoC。
- 採用案：初期の常時PAPERは信頼する外部正本。DBを含む完全なtrustless構成は初期目標にしない。
- 保留：Oysterの具体的なbase／CLI版／registry、署名encoding、TLS鍵配布、DB事業者、料金、SealかOyster KMSかの選択。
- 別途必要：最新main／PR状況を実装着手時に再確認。PR強化内容と再編コードの安全要件を照合する。
- 完了していないこと：Node24のTEE実行、SQLiteのTEE挙動、Sui実通信、再現可能build、Move検証、永続化、障害試験。

結論は「改修可能なら両環境対応の設計は現実的。まず単発判断と証明を確認し、保存と排他を別の合格段階にする」。この調査だけで完全移行の安全性や性能を保証しない。

## 15. 一次資料

- [S1: Oyster Sui向けBuild・Deploy・Register](https://docs.marlin.org/oyster/build-cvm/guides/sui-oyster/step-3-build-deploy-register-enclave)
- [S2: Oyster Sui向けArchitecture](https://docs.marlin.org/oyster/build-cvm/guides/sui-oyster/step-2-architecture-overview)
- [S3: Oyster Sui向けVerify](https://docs.marlin.org/oyster/build-cvm/guides/sui-oyster/step-5-verify-enclave-integrity)
- [S4: Oyster Security Guarantees](https://docs.marlin.org/oyster/protocol/cvm/guarantees)
- [S5: Sui Seal-Nautilus](https://docs.sui.io/sui-stack/nautilus/seal)
- [S6: Oyster Nautilus KMS](https://docs.marlin.org/oyster/nautilus/)
- [S7: Oyster Basic Networking](https://docs.marlin.org/oyster/core-concepts/networking)
- [S8: Oyster Secure Networking](https://docs.marlin.org/oyster/core-concepts/secure-networking)
- [S9: Sui Using Nautilus](https://docs.sui.io/sui-stack/nautilus/using-nautilus)
- [Nautilus公式リポジトリ](https://github.com/MystenLabs/nautilus)
- [Sui掲載のコミュニティツール](https://docs.sui.io/sui-stack/nautilus/community-dev-tools)
- [Walrus Sites](https://docs.wal.app/sites)

### コード根拠（固定commit）

- [BotEngine](https://github.com/tajumaru/SuiBa/blob/ce09e38/sui-ai-trading-bot/apps/worker/src/engine.ts)
- [OperationMonitor](https://github.com/tajumaru/SuiBa/blob/ce09e38/sui-ai-trading-bot/apps/worker/src/operations.ts)
- [Database](https://github.com/tajumaru/SuiBa/blob/ce09e38/sui-ai-trading-bot/packages/database/src/index.ts)
- [Shared](https://github.com/tajumaru/SuiBa/blob/ce09e38/sui-ai-trading-bot/packages/shared/src/index.ts)
- [Indicators](https://github.com/tajumaru/SuiBa/blob/ce09e38/sui-ai-trading-bot/packages/indicators/src/index.ts)
- [CetusRouter](https://github.com/tajumaru/SuiBa/blob/ce09e38/sui-ai-trading-bot/packages/dex-router/src/index.ts)
- [DeepBook transport](https://github.com/tajumaru/SuiBa/blob/ce09e38/sui-ai-trading-bot/packages/market-data/src/deepbook-transport.ts)
- [ChartHistoryClient](https://github.com/tajumaru/SuiBa/blob/ce09e38/sui-ai-trading-bot/apps/worker/src/chart-history-client.ts)

