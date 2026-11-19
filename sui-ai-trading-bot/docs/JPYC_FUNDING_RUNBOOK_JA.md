# JPYC → Potario 資金投入（半自動）手順書

作成：2026-11-19。目的：日本円から Potario（Sui / DeepBook）の BalanceManager まで、
人の手が要る所だけ人がやり、残りを道具で半自動化する。

## 全体像（4つの区間）

```
円 ──(1)── JPYC(Polygon) ──(2)── USDC(Polygon) ──(3)── USDC(Sui) ──(4)── BalanceManager
     JPYC EX            DEXで交換          Sui Bridge(CCTP)      DeepBook入金
```

- JPYC は公式に Sui 未対応（対応チェーン：Ethereum／Polygon／Avalanche／Kaia）。
  だから「JPYC そのもの」ではなく「円の価値を USDC に替えて Sui へ運ぶ」形になる。
- 区間3は Circle の CCTP（公式の焼却→発行方式）。Sui に着くのは
  Potario が使う Native USDC そのもので、ラップ品にならない。手数料はガス代のみ。

## 自動化の切り分け

| 区間 | 人がやること | 道具がやること（半自動） |
|---|---|---|
| (1) 円→JPYC | JPYC EX で発行予約＋銀行振込（本人確認済み口座の操作なので自動化しない） | 着金チェック：Polygon の JPYC 残高を定期確認し、届いたら知らせる |
| (2) JPYC→USDC | ウォレットで署名1回 | 交換レートと見込み額の提示、交換の実行補助、結果の確認 |
| (3) USDC を Sui へ | Sui Bridge で送信の承認（署名） | 着金の見張り：Sui 側の USDC 残高を確認し、届いたら知らせる |
| (4) BM へ入金 | 署名1回（オーナー操作） | 入金額の計算補助、入金後の BM 残高の照合・記録 |

原則：鍵に触る操作（署名）は本人が押す。残高の確認・見張り・照合・記録は道具がやる。

## 必要なもの

- JPYC EX 口座（開設済み ✓）。受け取りチェーンは **Polygon**、登録ウォレット宛て
- Polygon のガス代 **POL**（少額。JPYC の交換・送信で使う。JPYC 自体では払えない）
- Sui メインネットの自分のアドレス（Slush）
- メインネットの BalanceManager（**まだ無い**。REAL 本番移行時に作成する。
  それまでは区間4は「Sui ウォレットに USDC が届いた所まで」が終点）

## 手順

### 区間1：円 → JPYC（Polygon）
1. JPYC EX で発行予約：チェーン＝Polygon、登録ウォレット、金額（最低 3,000円／1回上限 100万円）
2. 指定口座へ銀行振込
3. 反映まで目安 15〜25分（Polygon の承認回数 256回）
4. 確認：Polygon の JPYC 残高が増えていること（道具が確認できる）

### 区間2：JPYC → USDC（Polygon 上）
1. QuickSwap 等で JPYC → USDC を交換（手数料 約0.3%＋相場のブレ）
2. 注意：JPYC の交換プールはドル系ほど厚くない。大きな額はブレが増えるので分割が無難
3. 確認：Polygon の USDC 残高

### 区間3：USDC（Polygon）→ USDC（Sui）
1. Sui Bridge（bridge.sui.io）で Polygon → Sui、資産＝USDC、宛先＝自分の Sui アドレス
2. CCTP 経由。手数料は両チェーンのガス代のみ。目安 十数分
3. 確認：Sui の Native USDC 残高が増えていること（道具が確認できる）

### 区間4：Sui ウォレット → BalanceManager
1. DeepBook の BalanceManager へ USDC を入金（オーナー署名）
2. 確認：BM の残高を読み取り、入金額と一致すること
3. ※ メインネット BM ができるまでは省略（区間3の着金で完了とする）

### 出金（逆向き）
Sui USDC →（CCTP）→ Polygon USDC → JPYC へ交換 → JPYC EX で償還 → 円（償還は無料）。

## 半自動ツールの設計（作るならこの形）

- **残高チェッカー**：Polygon（JPYC／USDC／POL）と Sui（USDC／SUI）の残高を
  1コマンドで一覧表示。区間ごとの「届いたか」の判定に使う
- **着金ウォッチャー**：区間1と3の待ち時間に、残高が増えたら通知する
  （手動ポーリングではなく、確認は道具側で完結させる）
- **BM 入金ヘルパー**：入金額を指定 → 署名は本人 → 入金後に BM 残高を照合して記録
- 署名が要る操作は、道具が「ここまで準備できた。署名して」と止まる形にする

## リハーサル案（お金を動かす前に）

- 区間2〜3はテストネットで練習できる（CCTP テストネット：Polygon Amoy ↔ Sui testnet、
  テスト USDC は Circle の faucet から）
- 本番の初回は最低額 3,000円分で通し確認し、着金と残高の一致を見てから額を上げる

## 注意

- 区間2で円建てからドル建てに変わる。以後 Potario の運用は USDC 建て
  （為替の影響を受けるのは投入・出金の瞬間）
- JPYC EX の発行・償還は営業時間や混雑で遅れることがある（2026-09 には
  Upbit 上場日に Ethereum／Polygon の発行予約が一時停止した実績あり）
- 税務の扱いは本書の範囲外（必要な時に別途確認する）
