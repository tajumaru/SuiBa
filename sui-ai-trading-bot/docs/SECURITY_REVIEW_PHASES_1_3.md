# セキュリティレビュー — Phase 1〜3

実装者によるソースレビューとモックによる回帰検証。外部監査やMainnet実動作検証ではありません。

## 確認・修正した点

| 観点                                     | 対応                                                                                                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| PAPERから鍵を読んでしまう                | 通常WorkerからLIVEをimportせず、初期化/secret loaderともPAPERで即return。型だけで実行方式を共通化                                              |
| 外部ルートが悪意あるPackage/Moveへ誘導   | 単一Cetus経路に限定。Package/型/プール/オブジェクトをserver manifestと照合し、最終BCSの全体を独立テンプレートと完全比較                        |
| 追加送金・保護関数削除・引数変更         | Move/Transfer/Splitの正確な順序・データ依存・pure値・入力参照を含め照合。受取先はsenderだけ                                                    |
| 低い価格をRiskEngineへ渡して注文額を回避 | quote reference priceとrisk priceの一致、atomic数量からの5 USDC上限、引用出力との価格乖離を追加で検証                                          |
| SDKの見積もりをsimulation成功だけで信頼  | simulation前後でBCS/quote/wallet/stateを再確認。simulationが返したtransactionも一致確認し、残高delta/ガス/保有比率を別途検証                   |
| 模擬ガスによる資金不足の見逃し           | 実gas paymentを固定、doGasSelection=false、gasPaymentMocked=trueは拒否。ガス用留保とSUI売却分を別に計算                                        |
| key rotation / wallet change             | 初期化と各操作で許可addressを確認。secret sourceを再読込。wallet変更停止がSQLite rollbackで消えないよう修正                                    |
| 重複・同時プレビュー・不明状態           | SQLiteトランザクションで予約、executorの排他、未知のactiveOrderを保存して新規作業を拒否                                                        |
| 復帰時の自動稼働                         | 起動ごとにRESTART_STOP。プレビューarmはメモリ内のみ。emergencyとactiveOrderは保持                                                              |
| secret / RPCエラーの漏えい               | rawエラーを永続化・ログ出力しない。鍵はpublic address照合にのみ使用し、返却値・DB・UIに保持しない                                              |
| 不要な署名送信capability                 | WalletSignerの具体実装とsubmitは必ずthrow。production sourceの署名/送信呼出しを静的回帰検証。Cetus wrapperは見積もり/構築の2メソッドだけを公開 |
| SDK二重バージョン                        | 2.37.0に統一し、実SDKによるオフラインBUY/SELL構築と独立BCS検証でチェック                                                                       |

## 残る制約・Phase 4前の必須確認

- 実資金・実キー・実スワップ・Mainnetシミュレーションは実行していません。実ウォレット/実オブジェクトの許可マニフェストは未設定。
- RPC/SDKとserver側のレビュー済みmanifestは信頼境界です。チェックポイント証明の独自検証、Moveコントラクトの形式検証、KMS実接続は未実装。
- full genesis digestをBase58 decodeし、Mainnetの標準識別子（先頭4bytes：35834a8a）を検証。通信先はHTTPSを要求し、fresh service infoを利用。
- JavaScriptの文字列・SDK内部メモリに対する完全な秘密消去は保証できません。鍵を保持し続ける実装はありませんが、実署名段階ではsecret store/KMSと運用権限の設計を再レビューする必要があります。
- 最低受取保護は公式SDKの固定されたMove呼出し形に依存します。実Packageのバイトコードと現在のデプロイ先・共有オブジェクトをレビューし、承認済みの読み取り/シミュレーションで確認してから署名実装へ進む必要があります。
- Phase 4で署名する前に、最新quote・最新の実残高/日次台帳・同一bytesの検証/シミュレーション・承認内容のhash照合を再実施する必要があります。本Phaseのプレビュー成功を署名許可として再利用しないでください。
- 実現/未実現損益・Digest・再送/結果不明照合はPhase 5。現在のreconcilerは停止するだけの拡張点です。
- 承認UI、LIVE自動化、実行用サーバーAPIは存在しません。設定変更だけでこれらを有効にできません。

検証結果：型チェック・Vite本番ビルド成功。92件成功（既存PAPER 33件、LIVEモック58件、静的検証1件）。ブラウザbundleへの鍵処理混入と新規ファイルの秘密情報パターンも確認済み。
