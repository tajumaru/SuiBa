# PR #9 マージ前確認・追加修正

対象ブランチ：`codex/fix-preflight-quality-gates`。確認した修正前HEAD：`2950c64299b0b884310076b2c04b22f106a9be94`。
mainとPR #8は変更せず、追加コミットはPR #9だけへ反映する。既存コンテナ・DB・volume、取引開始・注文・約定には触れていない。

## Actions失敗の切り分け

GitHub Actionsの実ログで照合した。mainのpush起動runはPR起動run一覧に出ないため、公開APIのhead_sha指定でも確認した。認証情報の抽出は行っていない。

| 対象 | Run | Ubuntu | Windows |
| --- | --- | --- | --- |
| main `8270beffbdf296800bc737e34ae2d55bd78d3709` | [40154291877](https://github.com/tajumaru/SuiBa/actions/runs/40154291877) | 成功 | test:offlineで2件失敗 |
| PR #9 HEAD `2950c64`、合成merge `54f4c6a` | [40154706268](https://github.com/tajumaru/SuiBa/actions/runs/40154706268) | 成功 | test:offlineで同じ2件失敗 |

Windowsの失敗jobはmainが [121052218333](https://github.com/tajumaru/SuiBa/actions/runs/40154291877/job/121052218333)、PRが [121053482269](https://github.com/tajumaru/SuiBa/actions/runs/40154706268/job/121053482269)。両方ともtypecheck/build成功、Vitestは711 passed / 7 skipped / 2 failed。PR追加分のNodeテスト17件はWindowsでもすべて成功した。

失敗は `tests/agent-narration-fx.test.tsx` の以下2件。

- `switches the visible group by pose in the stylesheet`
- `animates only when reduced motion is not requested`

期待値はLF固定だが、WindowsのCSS読取り結果はCRLFだった。両jobのAssertionErrorにも `expected ':root {\r\n ...' to contain '...\n ...'` が記録されている。mainと修正前PRの該当テスト・CSSはGit blob自体も同一で、PR #9による新規障害ではない。

| 同一blob | SHA-256 |
| --- | --- |
| agent-narration-fx.test.tsx | `e67331bf132a2e236d9e5ea7b42707b9a2d57b1b00efb4beee00b6ff95110dcf` |
| style.css | `3036cb989688718fa83332d488d154d6881ad4b801044af760654bb492de0e14` |

追加修正ではテストのCSS読取り結果だけをCRLF→LFへ正規化した。CSS本体・UI挙動・各assertionの内容は変更していない。

## 終了時の板と監査時刻

`preflight-audit.cjs` は正常完了時の板GETをawaitした後、read-only DB監査の開始時刻を `audit.at` に保存する。その後のoperations読取り・レポート生成・コンテナ停止時刻とは区別する。鮮度の評価時点はこの監査スナップショット時刻であり、後のレポート出力時刻まで板の正常性を保証するものではない。

修正前は `startedAt <= completedAt <= audit.at` だけを確認していた。そのため、例えば開始=監査500ms前、完了=監査100ms前、上流timestamp=監査50ms前という証拠が通り得た。上流時刻は監査以前でも、取得完了より未来なので採用できない。

また、AbortSignalを渡すだけでは、遅れて返った応答や本文が期限内の証拠かを集計時に再確認できなかった。

追加修正では収集・集計の共通関数 `endBookTiming` で以下を検証する。

```text
観測開始 <= 取得開始 startedAt <= 取得完了 completedAt <= 監査 audit.at
0 <= 単調時計で測った durationMs <= 8,000ms
completedAt - startedAt <= 8,000ms
上流 timestamp <= completedAt
0 <= audit.at - 上流 timestamp <= 10,000ms
```

上流timestampが取得開始より前であること自体は異常ではない。取得中に更新され、開始より後・完了以前となる場合も有効である。上流時刻をローカル時刻で書き換えることはしない。

- 収集はwall clockと独立した `performance.now()` の所要時間を保存する。時計調整で8秒超の取得を短く見せない。
- ヘッダー取得後と本文取得後にabortを再確認する。本文の取得・parseまでを所要時間に含める。
- 逆転、期限超過、観測窓外、取得完了より未来の上流時刻は既知の違反としてFAIL/NO-GO。
- 時刻・単調所要時間・上流timestamp・source等の必要証拠欠落、HTTP/通信/本文取得失敗はMISSING/INCONCLUSIVE。保持していた古いWorker板へfallbackしない。
- 監査時刻が最初の観測より前へ逆転した場合も例外を出さずNO-GOにする。
- `criteria.endBookTiming` に開始・完了・単調所要時間・上流時刻・監査時刻と判定理由を保存する。

既存の取得期限8秒、板鮮度10秒、実HTTP試行各100件、安全停止条件は維持する。今回追加する `durationMs` を持たない旧形式はMISSINGとし、wall時間から推測補完しない。

## 回帰テスト

Nodeの品質ゲートテストは17件から26件へ増加。追加9件は表形式の複数ケースを含む。

1. 上流時刻が開始以前・取得中・完了と同時・完了より未来の場合。
2. wall clock逆転、単調時計逆転をクランプせず拒否。
3. wall/単調時計の片方または両方で8秒超になった遅い成功応答。
4. 本文取得だけが遅い場合。
5. 取得8,000/8,001ms、鮮度10,000/10,001msの境界。100試行基準も維持。
6. 観測窓外、完了以前への監査時刻逆転、観測開始以前への監査時刻逆転。
7. 取得後から監査までの待ちで板が古くなる場合。
8. transport/HTTP503/本文/schema失敗。Workerの保持板が新しく見えても代用禁止。
9. 開始・完了・duration・上流timestamp・source・error・audit時刻の欠落、null/NaN/Infinity。

追加修正後、Node v24.22.1の一時コンテナ・network=noneで、品質ゲート **26 passed**、既存offline **713 passed / 7 skipped（45ファイル成功）**、typecheck/build成功を確認した。全体試験はローカルI/O影響を避けるtmpfsと1 workerを使用し、試験の制限時間は延長していない。

実通信の2時間再検証は行っていない。すべての外部板取得テストはmockであり、既存取引環境を起動していない。更新後のGitHub Actions結果はPR #9で確認する。
