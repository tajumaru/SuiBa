export function operationReason(code: string): string {
  const labels: Record<string, string> = {
    REQUEST_FAILED: "リクエストを完了できませんでした",
    UNAUTHORIZED:
      "管理トークンを確認できません。ログアウトして正しいトークンで接続してください",
    HTTP_401: "認証が必要です。管理トークンを確認してください",
    HTTP_403: "この操作は許可されていません",
    REQUEST_REJECTED: "入力値または運用状態を確認してください",
    UPSTREAM_TIMEOUT: "外部APIの応答が時間内に届きませんでした",
    UPSTREAM_HTTP_500: "外部APIでサーバーエラーが発生しています",
    UPSTREAM_HTTP_502: "外部APIの中継先に接続できません",
    UPSTREAM_HTTP_503: "外部APIが一時的に利用できません",
    NATIVE_USDC_POOL_NOT_FOUND: "ネイティブUSDCの取引プールが見つかりません",
    INSUFFICIENT_CANDLES: "判定に必要な確定足が不足しています",
    INVALID_CANDLE: "市場データに不正な価格または出来高があります",
    CANDLE_GAP: "市場データに欠損または重複があります",
    PRICE_OUTLIER: "市場データに異常な価格変化があります",
    UNKNOWN_PRICE_IMPACT: "取引による価格への影響を確認できません",
    NO_LIQUID_ROUTE_OR_UNMODELED_FEE:
      "利用可能な取引経路がないか、手数料を計算できません",
    COIN_DIRECTION: "取引する通貨の方向が一致しません",
    COIN_NOT_ALLOWED: "対象外の通貨が含まれています",
    INVALID_NUMBERS: "数量または価格の計算値が不正です",
    NO_LIQUIDITY: "取引に必要な流動性がありません",
    CONCURRENT_ORDER: "処理中の注文があるため見送りました",
    INVALID_QUOTE: "価格見積もりの内容が不正です",
    UPSTREAM_HTTP_429: "APIの利用制限に達したため安全停止しています",
    API_BACKOFF: "APIの再試行待機中です。PAPERは停止しています",
    API_RETRIES_EXHAUSTED:
      "APIの再試行上限に到達しました。時刻を確認し手動解除してください",
    API_CANCELLED: "終了処理のためAPI取得を中断しました",
    PROCESS_RESTART_STOPPED: "再起動のため停止。開始は手動です",
    PROCESS_SHUTDOWN: "プロセス終了による停止",
    PROCESS_RESTART_INTERRUPTED: "処理中に再起動したため約定せず停止",
    MANUAL_START: "手動でPAPER運用を開始",
    MANUAL_STOP: "手動で停止",
    MANUAL_RESET: "停止状態を手動で解除",
    EMERGENCY_STOP: "緊急停止",
    MARKET_DATA_STALLED: "市場データの更新が停止しています",
    STALE_CANDLES: "市場データが古いため停止",
    QUOTE_EXPIRED: "価格見積もりの期限が切れています",
    QUOTE_UNAVAILABLE: "価格見積もりを取得できません",
    QUOTE_INVALID: "価格見積もりの安全性を確認できません",
    UNKNOWN_COSTS: "ガス代または手数料が不明です",
    INVALID_POSITION: "保有数量または取得原価が不正です",
    INSUFFICIENT_POSITION: "売却数量が保有数量を超えています",
    NO_POSITION: "売却できる保有数量がありません",
    INVALID_PROFIT_CONFIG: "利益保護の設定が不正です",
    PROFIT_DATA_UNKNOWN: "利益計算に必要な情報が不足しています",
    MINIMUM_NET_PROFIT_NOT_MET: "手数料込みの利益が基準に届かないため見送り",
    PROJECTED_NET_INSUFFICIENT:
      "想定純利益が往復費用または最低基準に届かないため見送り",
    MINIMUM_NET_PROFIT_MET: "最低純利益の条件を満たしました",
    PROJECTED_NET_EXCEEDS_ROUND_TRIP_COST:
      "想定純利益が往復費用と最低基準を満たしました",
    PROTECTIVE_EXIT_PROFIT_BYPASS: "損切り・リスク削減のため利益条件のみ免除",
    PROTECTIVE_EXIT_PROFIT_DATA_UNAVAILABLE:
      "保護的売却の利益条件のみ免除。安全性の確認は必須",
    PROFIT_GUARD_DISABLED: "利益条件は無効。見積もり検証・リスク制限は継続",
    DAILY_LOSS_LIMIT: "日次損失制限に到達。新規購入を制限します",
    DAILY_BUY_LIMIT: "1日の購入上限に到達",
    MAX_ORDER: "1回の取引上限を超えています",
    MAX_HOLDING: "最大保有比率を超えています",
    INSUFFICIENT_BALANCE: "残高が不足しています",
    INVALID_BALANCE: "残高の計算値が不正です",
    DUPLICATE_ORDER: "重複注文・約定を防止しました",
    PAPER_RECONCILIATION_FAILED:
      "残高または損益の照合で不整合を検出したため停止",
    CONSECUTIVE_API_ERRORS: "APIの連続エラーを検出しました",
    SUI_READ_FAILED: "Suiの読み取りAPIに接続できません",
    BOT_STOPPED: "ボットが停止しているため見送り",
    SLIPPAGE_OR_IMPACT: "価格ずれ・価格影響が上限を超えています",
    STALE_MARKET: "市場データが古いため見送り",
    STRATEGY_WAIT: "戦略の条件を満たしていないため見送り",
    GAS_LEDGER_MISMATCH: "累計ガス代の記録が一致しません",
    FILL_LEDGER_COUNT_MISMATCH: "約定と照合記録の件数が一致しません",
    UNKNOWN_COST_BASIS: "取得原価を確認できません",
    DATA_OR_EXECUTION_FAILURE:
      "データ取得またはPAPER処理でエラーが発生しました",
  };
  if (labels[code]) return labels[code];
  if (code.startsWith("QUOTE_"))
    return "価格見積もりの取得・検証に失敗しました";
  if (code.startsWith("MARKET_")) return "市場データの取得・検証に失敗しました";
  if (code.startsWith("HEALTH_"))
    return "Sui読み取りAPIの接続確認に失敗しました";
  if (code.startsWith("MISMATCH_") || code.startsWith("LEDGER_"))
    return "記録された残高・損益と独立した計算結果が一致しません";
  return "安全条件またはデータの整合性を確認できません";
}
