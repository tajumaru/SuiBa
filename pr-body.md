## 結論（1行）
CI（suiba-no-worker）の docker-run 3脚のシナリオ配分を均等化し、全体の待ち時間を縮める実験。

## 変わること
- `.github/workflows/suiba-no-worker.yml` の docker-run マトリクスだけを変更：
  - persistence-group： persistence,normal-cutoff
  - abort-group： worker-abort,signal-survive,normal,crash,timer
  - helper-group： helper,signal-failure
- 実行するシナリオの集合（9件）は同一。配分だけが変わる。

## 変わらないこと
- 検証の中身・合否基準・他のジョブ（verify、docker-broker、docker-offline、docker-systemd、docker-suites）は無変更。
- Bot 本体・売買ロジック・本番には無関係。

## 確認したこと
- 実測（直近6ラン中央値）：全体 238秒。脚の検証時間は crash-group 170秒／abort-group 約75秒／helper-group 163秒で、全体は最長脚で決まっていた。均等化後の見込みは最長脚 約140秒、全体 約3分20秒。
- この PR 自体の CI で新しい配分の実測を取り、効果がなければ戻す。

## 本番への影響
なし（CI の配分のみ）。

## 画面の変更
なし。
