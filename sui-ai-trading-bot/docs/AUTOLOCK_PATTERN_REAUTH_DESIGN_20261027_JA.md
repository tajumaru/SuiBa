# SuiBa 自動ロック・パターン再認証：現状調査・詳細設計

調査日：2026-10-27（JST）。区分：**調査・設計のみ。実装承認を意味しない。**

公開時注記：ユーザーの追加指示「mainにpush」に基づき、この設計書のみをmainへ追加する。追加作業の基点は `a6db35752202260d687d6a5876f27dcb8e82c018`。本文の「最新main」、行番号、現状評価、および「commit/pushを行っていない」という記述は、調査終了時点の `e90840d916166c58cc040d48e72f2aa606bd557f` に関する記録であり、公開時点の再調査結果ではない。アプリケーション実装・設定変更・Bot操作は本公開にも含めない。

レビュー反映版：2026-10-27。レビュー基点は `367eb6fb525cad2e38f75854b9881daee81f16e3`、本更新の公開作業基点は `99fb9715d83762a126f3c06e19a82b818d89c403`。A章は初回調査の履歴として残し、最新差分・追加実測はG章に記載する。B〜F章はレビューを反映した推奨設計。今回の「設計書push」は文書更新・commit・pushだけの承認であり、実装・運用適用の承認ではない。

## 結論と適用条件

推奨は **BをAのHttpOnly Cookieで実現する「サーバー側の親セッション＋短命なタブ別管理操作許可＋パターン再認証」**。単一workerを前提に、人間の親セッションと操作許可はメモリ、パターン検証情報・失敗制限・自動化run許可は**認証専用SQLite**に保存する。外部DBサービスや追加パッケージは導入せず、既存の取引DBとは別ファイル・別接続にする。人間のブラウザと自動検証の資格情報・認可経路を分離する。WebAuthnは将来の強化候補とし、今回の必須依存にしない。

安全に導入できるが、現在の7日署名Cookieへパターン画面を足すだけでは不十分。失効可能なサーバー側状態、CSRF・認可の統一、競合防止、自動検証権限を先に整備する。既存バックテストPOSTの認証不整合も先に修正する必要がある。

**保証の境界**：ブラウザがイベントを実行せず、通信も届かない瞬間のバックグラウンド移行をサーバーが検知することはできない。正常時は即時通知でロック、通知不能時は**事前発行した単回チケットの固定期限**により既存の操作許可を最大15秒に制限する（B3/G2）。受信時刻から15秒延長する方式は採用しない。復帰時は残存時間にかかわらずパターンまたは管理トークンを要求する。この上限は正規クライアントの更新が停止する場合のもので、同一originの悪意あるコードが更新を継続する場合の可視性を証明するものではない。この15秒も許容できない場合、通常のWebアプリでは「完全なサーバー即時検知」を満たせないため要件調整が必要。

## A. 現状調査レポート

### A1. 対象と確認範囲

| 項目 | 確認結果 |
|---|---|
| リモート最新main | `e90840d916166c58cc040d48e72f2aa606bd557f`。`git ls-remote origin refs/heads/main`で確認 |
| コミット | `fix(auth): preserve browser login with persistent signed sessions`、2026-10-27 12:53:22 +09:00 |
| 読み取ったHEAD | 上記SHAと一致。現在のブランチ名は `fix/e2e-auth-fixtures-and-narration` |
| ローカルmain参照 | `be8b202a006bd5a59236f5685155af47264bcfa6`。古いため調査基準にしない |
| 作業ツリー | 追跡ファイルの差分なし。既存の未追跡Nodeインストールログ2件は触れていない |
| 稼働コンテナ | `suiba-deepbook-24h-bot-1`、観測時Up約11時間、healthy。healthyは取引running=trueの証明ではない |
| コンテナのソース | 最新mainと一致しない。worker `index.ts` のSHA256が異なり、`browser-session.ts` は存在しない |
| コンテナのビルド識別 | OCI revisionラベルは `unknown`。完全な稼働ソースSHAは未確定 |
| 実施した操作 | Git・ソース・限定メタデータの読み取り、コンテナ内の別Nodeプロセスでversion/API存在/公開ソースhash確認、公式仕様参照 |
| 実施していない操作 | ログイン・ログアウト・認証API操作、Bot制御、再起動、テスト、ビルド、依存追加、設定変更、commit/push/PR/merge |

調査対象は[固定mainコミット](https://github.com/tajumaru/SuiBa/tree/e90840d916166c58cc040d48e72f2aa606bd557f/sui-ai-trading-bot)。以下のソース行番号はすべてこのSHA。稼働イメージへ最新認証が反映済みとは判断しない。秘密ファイル、`.env` の値、Cookie、Authorization実値、実セッションは取得・出力していない。

### A2. Node.js：設定と実ランタイム

| 層 | 設定／実測 |
|---|---|
| package.json:5–7 | `>=24.22.1 <25`。単に24.22.1以上というだけでなく、25以上も現在は非対応 |
| .nvmrc / .node-version:1 | ともに `24.22.1` |
| docker/Dockerfile:1 | `node:24.22.1-bookworm-slim`、digest固定 |
| scripts/verify-node-version.mjs:4–36 | 実行中のprocess.versionを検証。24系かつ24.22.1以上のみ許可 |
| scripts/run-project.mjs:72–81 | 子ツールもprocess.execPathで起動し、そのディレクトリをPATH先頭にする |
| worker index.ts:1 | 起動時のバージョン制約をimport |
| .github/workflows/suiba-offline.yml:13,20–29 | Windows/Ubuntu、Node 24.22.1、typecheck/build/test:offline |
| Windowsの今回のシェル | `node --version` → **v24.22.1** |
| 稼働コンテナ内のNode実行物 | `process.version` → **v24.22.1**、OpenSSL **3.5.9**、`typeof crypto.argon2` → **function** |

コンテナ内の値は同じコンテナの別プロセスでの実測であり、Botプロセス内に診断コードを注入した結果ではない。PID 1はdocker-init。今回は稼働Bot自身のprocess.versionログや実行ファイル差し替え履歴までは検証していない。設定値だけでバージョン対応済みと判断してはいない。

### A3. 現在の認証フローと関連ソース

以下のリンクはローカルで確認した対象ファイル。関数・範囲は右列に示す。

| 項目 | ファイル・関数・行番号と処理 |
|---|---|
| 管理トークン設定 | [worker/index.ts](D:/Source/SuiBa/sui-ai-trading-bot/apps/worker/src/index.ts:44) 44–49：ADMIN_TOKEN_FILE優先、readFileSync→trim。なければADMIN_TOKEN。32文字未満は起動拒否 |
| Bearer検証 | [browser-session.ts](D:/Source/SuiBa/sui-ai-trading-bot/apps/worker/src/browser-session.ts:39) `bearer` 39–40、`equal` 6–9：長さ一致後timingSafeEqual。全管理権限を持つ単一共有秘密 |
| Cookie生成 | 同ファイル `issue` 19–21：期限＋24byte乱数＋管理トークンを鍵とするHMAC-SHA256。トークン自体はCookieに含めない |
| Cookie検証 | 同 `valid` 23–37：署名・期限を検証。セッションレコード・失効表・ロック状態なし |
| Cookie属性 | 同 `setCookie` 42–49：`suiba.session; Path=/api; HttpOnly; SameSite=Strict; Max-Age=604800`。TLS socketまたはX-Forwarded-Proto=httpsならSecure |
| API認証ゲート | [worker/index.ts](D:/Source/SuiBa/sui-ai-trading-bot/apps/worker/src/index.ts:270) 270–279：全`/api/`にBearer **または**Cookie。非GETのCookie要求は追加ガード |
| CSRFガード | browser-session.ts `sessionMutationAllowed` 55–60：X-SuiBa-Request=1、Sec-Fetch-Siteはsame-originまたは欠如。CORS許可なし。Origin完全一致やCSRF nonceは未実装 |
| セッションAPI | worker/index.ts 280–290：GET確認、POST新Cookie、DELETE Cookie削除。POSTは既存Cookieだけでも可能 |
| ログインprobe | [verifyToken.ts](D:/Source/SuiBa/sui-ai-trading-bot/apps/dashboard/src/verifyToken.ts:43) `verifyToken` 43–107：Bearerでsummary、404のみstate fallback。8秒全体期限、JSON構造検査、redirect:error、401/TIMEOUT/NETWORK等の区別 |
| Cookieへの交換 | [browserSession.ts](D:/Source/SuiBa/sui-ai-trading-bot/apps/dashboard/src/browserSession.ts:5) `loginSession` 5–23：probe成功後POST auth/session。現状はresponse.okで成功とする |
| フロント状態 | [main.tsx](D:/Source/SuiBa/sui-ai-trading-bot/apps/dashboard/src/main.tsx:219) 219–241,459–462：React token状態へ実管理トークンではなくSESSIONというマーカーを設定 |
| 再読み込み復元 | main.tsx 220–239：GET auth/session、authenticated=trueで復元。8秒期限、AbortSignal.any/timeout使用 |
| ログアウト | main.tsx `logout` 267–280：DELETE成功または401後、token/data消去。通信失敗時は元画面を保持 |
| 共通API | main.tsx 319–345：SESSION時Bearerを付けずCookie、X-SuiBa-Requestを付与。401でtoken/data消去 |
| ログイン競合対策 | [LoginScreen.tsx](D:/Source/SuiBa/sui-ai-trading-bot/apps/dashboard/src/LoginScreen.tsx:64) 64–110、[loginAttempt.ts](D:/Source/SuiBa/sui-ai-trading-bot/apps/dashboard/src/loginAttempt.ts:6) 6–40：同期single-flight、世代番号、abort、unmount/cancel、成功通知1回 |
| トークンの一時保持 | LoginScreen.tsx 24,69–85：入力状態・非同期クロージャに一時保持し、送信時入力欄を消去。GCタイミングまで厳密なゼロ化は保証しない |
| localStorage | [patternLock.ts](D:/Source/SuiBa/sui-ai-trading-bot/apps/dashboard/src/patternLock.ts:15) `removeLegacyPatternLock` 15–40：旧3キーの削除だけ。復号・再保存なし。LoginScreen 32–42で実行 |
| sessionStorage | 対象アプリソースの検索で認証用途の使用なし |
| document.cookie | フロントで直接読み書きなし。HttpOnly Cookieをサーバーが発行 |
| 複数タブ | Cookieを共有するがReact状態は各タブ。BroadcastChannel/storageによる認証同期なし。別タブログアウト後は次回APIの401で追従 |
| ポーリング | main.tsx 383–393：10秒。 [OperationsPanel.tsx](D:/Source/SuiBa/sui-ai-trading-bot/apps/dashboard/src/OperationsPanel.tsx:669) `useOperationsFeed` 669–722：operations/stateを10秒周期、世代ガードあり |
| WebSocket / SSE | 対象dashboard/workerソースにWebSocket/EventSourceによる管理配信の実装は見つからない。現行はHTTPポーリング。将来導入時は接続・各送信・再接続で認可が必要 |
| バックグラウンドイベント | AgentNarration.tsx:375–381、OperationOverview.tsx:93–100に時刻表示更新用visibilitychange/pageshow。認証ロック処理ではない |
| 独自fetch | [BacktestComparison.tsx](D:/Source/SuiBa/sui-ai-trading-bot/apps/dashboard/src/BacktestComparison.tsx:165) 165–176：渡されたSESSIONマーカーもBearerとして送る。X-SuiBa-Requestなし |
| 応答保護 | worker/index.ts 190–195：no-store、nosniff、CSP script-src self / frame-ancestors none。535–536は汎用REQUEST_FAILEDへ抑制 |
| Bot分離の根拠 | worker/index.ts 128–141 watchdog、161–187 scheduler/engine.tick、543–547 scheduler.start。API controlは476–532。ブラウザ接続をBot周期の開始条件にしていない |

現行の絶対期限は発行から7日だが、CookieによるPOST auth/sessionで新しい7日Cookieを作れるため、強い再認証からの絶対上限にはなっていない。DELETEはそのブラウザのCookie削除のみで、コピー済みCookieをサーバー側で失効しない。同じ管理トークンを維持する限り署名Cookieはサーバー再起動後も有効。管理トークン変更時は署名が変わり全Cookieが失効するが、プロセスへの反映方法・停止影響は別の運用作業になる。

### A4. 既存セキュリティ指摘の状況

| 項目 | 判定と残る問題 |
|---|---|
| パターン由来鍵で管理トークンを暗号化しlocalStorageへ保存 | **最新mainでは撤去済み**。履歴a804f4cの方式をb5bc366で廃止。現行patternLock.tsは削除専用 |
| 旧保存データの処理 | 3キー削除、読取拒否でも削除試行、失敗表示あり。削除はLoginScreen mount時のため、Cookie復元だけで画面に入る場合は直ちに実行されない。コピー済みデータ・別タブ・別端末・バックアップは消せない |
| トークンの平文ブラウザ永続化 | 現行アプリでは新規保存なし。ただし過去に盗まれた暗号文の危険が消えた証明にはならない。心当たり時のローテーションが必要。今回は実行しない |
| UI多重ログイン・古い結果 | single-flight/世代ガードは実装済み。ただしabortしても届いたPOSTのSet-Cookieが無効になる保証はない。サーバーの認証状態とUIキャンセルの整合を追加設計する |
| 個別セッション失効・自動ロック | **未実装**。現行Cookieは署名だけのため、サーバーロックを表せない |
| スライド更新による期限延長 | 強認証時刻の保存なし。7日の再発行を禁止する設計が必要 |
| Cookie Secure | プロキシヘッダーを直接信頼し、HTTPではSecureを省略。信頼するプロキシ境界・本番HTTPS強制を明示する必要 |
| CSRF | カスタムヘッダー＋Fetch Metadata＋SameSiteで一定の対策済み。完全一致Origin/Host検証・専用nonce・セッションAPIまで統一した検証へ強化する |
| レート制限・監査 | 認証専用の失敗回数、ロックアウト、失効監査が当該認証経路にない |
| バックテスト回帰 | SESSION文字列は正規Bearerではない。CookieがあればGETは通るが、POSTは追加ヘッダー欠如により403となるコード経路。**ソースからの判定で、実環境で再現操作していない** |
| XSS | CSP等の防御あり。HttpOnlyでも同一originの悪意あるJSによる操作は防げない。パターンはXSS対策の代替ではない |

「既知指摘はすべて修正済み」とは断定しない。確認できたのは上記のソース・履歴と対応関係であり、全Issue/PRや外部監査の網羅照合は行っていない。稼働コンテナは別版なので、ここでの修正済み判定は最新mainに限る。

### A5. 自動検証・Docker・DB方針

| 経路 | 現状／影響 |
|---|---|
| CLI・unattended | docker/deepbook-24h.mjs:121–141はコンテナ内でADMIN_TOKEN_FILEを読み、Bearerでvalidation/startやvalidation/reportを呼ぶ。人間のブラウザCookieとは独立 |
| 30分 | compose.preflight-30m.yaml:2–18,32–57。専用project/image/SHA/secret/volume、read_only＋tmpfs。新しい検証を今回は起動していない |
| 2時間 | docs/PAPER_RUN2_PREFLIGHT_REPORT.md:1–7,144に既存記録。停止状態での通信観測という条件がある。認証設計を理由にstart/resetを自動実行しない |
| 24時間 | compose.deepbook-24h.yaml:12–25、deepbook-24h.mjs:124。起動済みの検証はそのまま維持する必要がある |
| Docker内API | localhost:3100へのBearer。ホスト公開は基本127.0.0.1。Docker内だから無認証でよいという実装ではない |
| APIテスト | tests/settings-api.test.ts:59,87、verify-runtime.ts:18,40等はテスト用トークンで隔離workerを操作 |
| Cookieテスト | tests/browser-session.test.ts:12–62、browser-session-login.test.ts。永続署名Cookieの再起動有効性は現行仕様としてテストに存在 |
| ブラウザテスト | playwright.auth.config.ts:5–24はChromium＋iPhone 13相当WebKit。tests/e2e/login.pw.ts:203以降にはAPIモック。モック成功は本物のCookie・サーバー認可の証明ではない |
| CI | .github/workflows/suiba-offline.yml:19–29はNode固定・offline検証。実運用の秘密を必要としない構成を維持 |
| トークンのサーバー保存 | 基本composeはenv_file、専用検証composeはDocker secretファイル。値は今回未読。環境変数方式は権限あるinspect等による露出面がある |
| DB不使用という条件 | **現コードはすでにSQLite使用**。packages/database/src/index.ts:2,182–184のnode:sqlite/DatabaseSync、worker:57のBotDatabaseが根拠。「新たな認証DB／外部DBを増やさない」と解釈して提案する |

## B. 推奨アーキテクチャ

### B1. 信頼境界とデータモデル

ブラウザ → 信頼済みHTTPS終端 → worker認証・認可ゲート → 管理API、という経路に統一する。Bot scheduler/engine/market transport/risk/profit/ledger/healthはブラウザ認証から独立させる。

| 要素 | 内容・保存先 |
|---|---|
| 親セッション | 256bit乱数SID。ブラウザにはHttpOnly Cookieのみ。サーバーはSIDのSHA256をキーとし、principal=admin、strongAuthenticatedAt、absoluteExpiresAt、patternEligibleUntil、authEpoch、csrf nonce、revokedをメモリ保持 |
| タブ別操作許可 | 256bit乱数grantをタブのメモリだけに保持し専用ヘッダーで送信。サーバー側にはhash、親SID、tabId、familyEpoch、idleDeadline、leaseExpiresAt、許可scope。Cookieだけでは機密APIへ入れない |
| ロック単位 | 同じ親Cookieを共有する全タブを1familyとし、どれかのロックで全タブのgrantを失効する。別端末の独立セッションまで毎回ロックしない。管理トークン／パターン変更時は全family失効 |
| パターン検証情報 | 現在の単一adminモデルでは**システムに1個**。version、policyVersion、salt、Argon2idパラメータ、hash、pepper key id、credentialVersionを認証専用SQLiteへ。将来複数admin化ではprincipal別へ拡張 |
| 失敗制限情報 | credentialVersionごとの失敗数、blockedUntil、strongRequired、試行予約を認証専用SQLiteでtransaction管理。セッションを替えても回数をリセットしない |
| 自動化run許可 | runId、対象instance/audience、scope、絶対期限、資格情報hash、失効状態を認証専用SQLiteに保存。短命access tokenはメモリ。再起動でaccess tokenは失効するが、有効なrun許可から再取得可能 |
| Pepper | 管理トークンとは独立した256bit秘密。Docker secretで読取専用供給。検証情報と同じvolume/バックアップへ入れない |
| 監査 | eventId、時刻、匿名化session参照、action、scope、結果、理由、credentialVersion、runId。token/pattern/hash/Cookie/生IPや本文をログに出さない |

人間のセッションはメモリだけにするため、worker/Docker再起動時は管理トークンでログインし直す。パターン自体は残すが、それだけで新しい親セッションを作れない。現行の「再起動後も7日Cookie復元」からの意図的な変更であり、受け入れ確認が必要。自動化run許可の永続性とは区別する。認証専用SQLiteを採用しても、人間のセッションを自動復元する仕様にはしない。

### B2. 推奨期限

| 期限 | 推奨値 | 根拠／更新条件 |
|---|---|---|
| 無操作ロック | 300秒 | 設定キーidleLockSeconds、初期300。将来60–900秒程度の範囲で設定可能。変更は管理トークンによるfresh再認証、延長しても既存のロックは解除しない |
| バックグラウンド | 検出時直ちにlocal lock＋サーバーlock送信 | 通信不能時のサーバー側残存許可は下記leaseで制限 |
| 管理操作lease | チケット発行から最大15秒、可視の前景で5秒ごとにpresence更新 | 固定上限であり、更新成功から丸15秒を保証しない。presenceは無操作期限を更新せず、遅延要求で上限を延ばさない |
| 親セッション絶対期限 | 強認証から12時間 | 8時間は厳格、24時間は便利だが盗難時の期間が長い。12時間を推奨。パターン・presenceでは延長しない |
| パターン許可期限 | 強認証から8時間、かつ最後のlockから30分以内 | 8時間経過、または30分超の離席は管理トークン。繰り返しunlockしても強認証時刻は更新しない |
| fresh強認証 | 5分以内 | pattern登録・置換・削除、機密な認証設定、自動化権限発行。入力tokenは確認後破棄 |
| 自動化access token | 10分 | 下記の期限付きrun許可から更新。人間のidle/visibilityルールは適用しない |
| 自動化run許可 | 最大26時間、runごとに明示設定 | 30分/2時間/24時間＋後処理の必要時間に限定。scope変更不可、任意延長不可 |

サーバーはactivityの受信時刻でidle期限を計算し、クライアント申告時刻で延長しない。leaseはサーバーのチケット発行時に定めた固定期限で拘束する。単調時計でプロセス内のidle/leaseを管理し、絶対期限の時計巻戻りでも元の許可時間を超えないよう発行時の単調時計上限を併用する。再起動で全親セッションを破棄する。永続lockout・run期限は時計異常・読取失敗時にfail closedとする。

### B3. フロー

**初回ログイン**

1. 起動・reload・pageshowでは機密ビューを描画せずRESTORINGへ。旧localStorageキーの削除専用migrationはログイン画面だけでなく起動時にも実行する設計とする。
2. 管理トークンをHTTPSのPOST loginへ送信し、サーバーが検証・レート制限する。現在の機密summaryをprobeとして読む必要はなくす。
3. 検証成功で旧SIDを失効し、新SIDを発行。ログイン応答は親セッション作成に限り、キャンセル後のSet-Cookieで自動的にUNLOCKEDにならないようにする。
4. 画面がまだ可視で、その認証試行がcurrentである場合のみ、一回限りの短命activation challengeを確認してタブgrantを取得。キャンセルやhide後の古いactivationは拒否。
5. パターン未登録なら任意登録へ案内。未登録でも管理トークンで通常利用可。登録しない利用者も5分lockは有効で、解除には管理トークンを使う。

**パターン登録**

1. UNLOCKEDかつfresh強認証で、期限2分のenrollment challengeを開始。既存pattern変更には再度tokenを求める。
2. 1回目と確認入力はメモリだけで保持。両方をTLS POSTで送り、サーバーでもcanonical化・一致・policyを検証。ログ／URLへ含めない。
3. 並列KDF数を制限してhash作成。完了後にsession/epoch/challenge期限を再検証し、commitを原子的に行う。ページ離脱で自動保存しない。明示commit前のdraftに有効性はない。
4. 登録成功後は両入力・線を消去。変更時はcredentialVersionを更新し、既存pattern由来grantと他familyを失効。現在のfresh強認証familyも新SIDへローテーションする。
5. cancelとcommitが競合した場合、サーバーが先にcommitを確定した事実はabortだけでは戻らない。状態照会で確定結果を表示し、必要ならfresh tokenで削除する。「キャンセルすれば保存済み変更まで必ず消える」とは約束しない。

**ユーザー操作・5分ロック**

- pointerdown、click、keydown、wheel、touch操作に由来するscrollを対象。Event.isTrusted、前景、UNLOCKEDを確認する。scrollはブラウザ生成のプログラムスクロールでもtrustedになり得るため、それ単独を根拠にせず、直近のtrusted wheel/touch/pointer/keyboard操作との関連を確認する。
- pointermove/mousemove単独は除外。パターン描画中のmoveは入力処理にだけ使用し、ロック中のidle更新には使わない。dispatchEvent等の合成イベントは除外。isTrustedはXSSやブラウザ自動操作に対するセキュリティ境界ではない。
- 最初の操作は即時activity通知、連続操作は最大1秒程度で集約。通知が間に合わず期限切れなら安全側にlock。API polling・presence・市場更新・SSE・WebSocket・Bot処理はactivityを呼べないAPI構造にする。
- サーバーはactivity専用POSTだけでidleDeadlineを更新。**期限経過後のactivityでは解除しない**。各管理API受信時にもidle/lease/epochを確認する。クライアントtimerは表示のための補助であり、API側判定の代替にしない。
- local deadlineまたはサーバーlockで機密ビューをunmount、全機密store/cache/チャート/ナレーションの蓄積を消去、APIをabort、generation増加、grantを破棄。Bot制御APIは呼ばない。

**固定期限付きpresence/activation**

- サーバー発行の単回更新チケットにSID・tab・epoch・連番・発行時刻から最大15秒の固定期限を束縛する。更新後のgrant期限はこの期限、idle期限、親絶対期限の最小値を超えない。
- 更新要求はsingle-flight、未使用チケットは1個に限定。重複・逆順・期限切れチケットは拒否し、期限切れgrantを更新で復活させない。次チケットを受け取っても、可視のcurrent試行でなければ消費しない。
- 例えば発行5秒後に消費すれば、そのチケットによるgrantの残りは約10秒。単純な「受信時刻＋15秒」は禁止。activityもleaseを延長しない。
- 初回ログイン・パターン成功も、結果受領後に可視状態を確認して単回activationを消費する二段階とする。activationのgrantも発行済みチケットの固定期限に拘束し、遅延したKDF完了だけでは発行しない。
- チケット・KDF結果のepochをcommit直前に再確認。ロックは常に優先。応答・要求が遅れても、事前期限を超える操作許可を作らない。

**バックグラウンド・復帰**

- visibilitychange(hidden)とpagehideは冪等なlocal lockを実行し、fetch keepaliveでlock通知。通常のカスタムCSRFヘッダーを使う。sendBeaconはカスタムヘッダーが使えないので単純な認証例外APIを追加しない。
- サーバーlockはfamilyEpochを増やし全grant失効。既にlock済みなら成功扱い。ネットワーク応答を待たず画面を消去する。
- visible、pageshow（persistedの真偽を問わず）、focusによる復帰、offline→onlineではまずRESUME_CHECK。通常データfetchを再開する前にサーバーへlock/barrierを送る。前のgrantがまだ有効でも再利用しない。
- 通信不能ならlocal LOCKEDのまま。再接続で保留lockを先に確定し、その後にpattern/tokenを受け付ける。lease更新を先に送って古い許可を延命しない。
- hidden通知が一切動かなかった場合も、presenceが止まれば15秒でサーバーlease失効。ブラウザが通知も停止も偽装する相手に可視状態を暗号学的に証明することはできない。

**パターン解除**

1. Cookieが有効でpatternEligibleUntil内、lockから30分以内、strongRequired=falseのときのみunlock challenge発行（60秒、一度限り、SID/familyEpoch/credentialVersionへ束縛）。
2. pattern POSTをサーバーでcanonical化し、レート制限を先に確認してKDF照合。不存在・不一致で過度な情報を返さない。
3. 成功時もKDF開始時と同じepochかを確認。古い結果は409 AUTH_STATE_CHANGED。照合成功は短命な単回activationチケットを返すだけで管理トークンは一切返さない。失敗数を適切に更新。
4. UIは現在の試行成功かつ可視の場合のみactivationを要求し、新grant取得後UNLOCKED。サーバーは可視状態自体を証明できないため、epoch・固定期限・単回消費を検証する。機密データを新規取得してから表示。ルート・選択タブ・timeframe等の非機密設定だけ保持し、window.location.reloadは不要。
5. 忘却時は管理トークン再認証。新SIDとfresh認証で回復し、希望時だけpattern再登録。パターンを表示・復元するAPIは作らない。

**失効・logout・再起動**

親期限、失効、再起動は401 SESSION_EXPIRED/REVOKED。LOCKEDは423 SESSION_LOCKED、レート制限は429＋Retry-After、CSRFは403、世代競合は409。logoutはサーバー失効＋Cookie削除。offline logoutでもlocal消去を即実行し、未完了のサーバー失効を表示する。通信失敗で機密画面を残す現在の挙動は改める。tokenの変更は全セッション／run許可／pattern credentialとの関係を認証epochで整理する。

**Bot継続稼働**

lock/unlock/logout/session-expireは認証ストアとUIだけを変更し、db.runtime、scheduler、engine、apiAccessの市場向けcircuit breakerへ書かない。DeepBook取得・売買判断・RiskEngine・Profit Guard・台帳・ログ・validationHeartbeat・healthzは同じ周期で続く。既存の通信異常／市場不正／リスク等の安全停止条件は一切緩和しない。現コードの判断経路はstrategy registryであり、外部LLMの利用を今回確認したわけではない。認証変更は判断方式に依存しない。

### B4. 状態遷移

```mermaid
stateDiagram-v2
    [*] --> RESTORING
    RESTORING --> ANONYMOUS: 親なし・期限切れ・再起動
    RESTORING --> LOCKED: 有効な親があってもgrantを復元しない
    ANONYMOUS --> AUTHENTICATING: 管理トークン
    AUTHENTICATING --> ANONYMOUS: 失敗・cancel
    AUTHENTICATING --> UNLOCKED: 現在の試行のactivation成功
    UNLOCKED --> ENROLLING: fresh強認証
    ENROLLING --> UNLOCKED: 明示commit成功・cancel
    ENROLLING --> LOCKED: hide・idle・失効
    UNLOCKED --> LOCKED: 5分idle・hide・手動lock・lease切れ
    LOCKED --> UNLOCKING: 有効な親＋期限内pattern
    UNLOCKING --> UNLOCKED: 照合成功＋可視＋同epochのactivation成功
    UNLOCKING --> LOCKED: 不一致・通信断・古い結果
    LOCKED --> TOKEN_REQUIRED: 期限超過・10連続失敗
    TOKEN_REQUIRED --> AUTHENTICATING: 管理トークン
    LOCKED --> RESUME_CHECK: 復帰・再接続
    RESUME_CHECK --> LOCKED: lock barrier確認
    RESUME_CHECK --> TOKEN_REQUIRED: 親失効
    UNLOCKED --> ANONYMOUS: logout・親絶対期限
```

どの非匿名状態もサーバー失効でANONYMOUSへ移る。UI状態とBot runtime.runningは別状態機械とする。

### B5. API認可マトリクス

記号：○許可、×拒否、scope＝限定自動化権限。すべてメソッドも検証。既存ルートの位置はworker/index.ts。

| API／処理 | 現行行 | 公開 | locked親 | unlocked親＋tab grant | 自動化 | 分類・追加条件 |
|---|---:|---:|---:|---:|---:|---|
| GET /、静的asset | 241–268 | ○ | ○ | ○ | ○ | 公開。機密を埋め込まない |
| GET /healthz | 232–239 | ○ | ○ | ○ | ○ | 公開。最小限ok/stale/PAPERのみ |
| POST /api/auth/login（新） | — | credential必須 | ○ | ○ | × | 管理トークン照合・login rate limit・Origin |
| GET /api/auth/session | 280–290 | × | ○ | ○ | × | 最小state/期限/CSRF情報だけ。Bot状態なし |
| DELETE /api/auth/session | 同上 | × | ○ | ○ | × | CSRF、サーバー失効。既失効は冪等処理 |
| POST /api/auth/lock（新） | — | × | ○ | ○ | × | CSRF。family全体lock |
| POST /api/auth/unlock/challenge, /unlock（新） | — | × | ○ | ○ | × | 親とpattern期限、単回challenge、レート制限 |
| POST /api/auth/activate（新） | — | × | ○ | ○ | × | 認証成功時の単回チケット・固定期限・同epoch・CSRF。照合成功だけではgrantなし |
| POST /api/auth/activity, /presence（新） | — | × | × | ○ | × | 現在のgrant必須。locked/expiredを復活させない |
| POST/DELETE /api/auth/pattern（新） | — | × | × | ○ | × | fresh管理トークン確認、登録challenge、CAS |
| GET /api/dashboard/summary | 315–320 | × | × | ○ | read:dashboard | 管理情報 |
| GET /api/dashboard/candles | 322–338 | × | × | ○ | read:market | 管理情報。市場データでも現行同様公開しない |
| GET /api/dashboard/records | 339–344 | × | × | ○ | read:records | 履歴・損益 |
| GET /api/chart/history | 292–314 | × | × | ○ | read:market | 上流コスト制限も維持 |
| GET /api/state | 346–352 | × | × | ○ | read:state | 設定・portfolioを含む |
| GET /api/operations | 353–365 | × | × | ○ | read:operations | 運用データ |
| GET /api/balances | 380–394 | × | × | ○ | read:balances | アドレス未設定時400を維持 |
| GET /api/backtest | 396–399 | × | × | ○ | read:backtest | 管理情報 |
| POST /api/backtest | 434–469 | × | × | ○ | execute:backtest | busy/入力検証維持 |
| POST /api/settings | 470–475 | × | × | ○ | write:settings | 自動化は明示発行時のみ。制約・監査必須 |
| POST /api/control {start} | 476–532 | × | × | ○ | control:start | scope＋PAPER audience＋全既存安全条件 |
| 同 {stop,emergency} | 同上 | × | × | ○ | control:stop / emergency | locked画面から無認証の停止ボタンは追加しない |
| 同 {reset} | 同上 | × | × | ○ | control:reset | 危険な再許可として明示scope。read token不可 |
| GET /api/validation, /report.md | 366–379 | × | × | ○ | read:validation | validation有効時だけ |
| POST /api/validation/start | 414–433 | × | × | ○ | validation:start | 既存STOP_BEFORE_VALIDATION等を維持 |
| POST /api/automation/runs（新） | — | × | × | fresh token | × | runId、対象instance、scope、期限を明示 |
| POST /api/automation/access（新） | — | × | × | × | run資格情報 | 固定scopeの10分token発行、期限上限あり |
| market tick / risk / profit / persistence / watchdog | 128–187等 | HTTPなし | — | — | — | Bot内部専用。ブラウザCookieや自動化token不要 |

自動検証用APIを公開APIにしない。分類は公開／locked最小API／unlocked管理API／Bot内部処理／scope付き自動化API。未登録ルート・メソッドはdefault deny。全機密GETもロック拒否の対象。将来のSSE/WSは接続時だけでなく各配信直前とepoch変更時にも遮断する。

## C. 技術選定と詳細規則

### C1. A/B/C比較

| 観点 | A：HttpOnlyサーバーセッション | B：短命管理許可＋再認証親（推奨） | C：WebAuthn併用 |
|---|---|---|---|
| セキュリティ | サーバー失効可能。単純なunlocked booleanだけでは通知不能期間を抑えにくい | Cookie単独で操作不可、期限・idle・lease・epochで制限。patternの弱さは残る | 公開鍵方式でpatternより強く、origin束縛。fallbackが弱いと全体の強度は下がる |
| 実装難易度 | 中。既存署名Cookieを状態付きへ置換 | 中〜高。タブgrant/競合/lease追加。ただし外部サービス不要 | 高。challenge/署名検証、RP管理、認証器・復旧運用が増える |
| Windows | 対応 | 対応 | 対応ブラウザ＋Windows Hello/セキュリティキー等。実機確認が必要 |
| iPhone Safari | Cookie/HTTPS前提で対応 | 同左。復帰barrierが重要 | 対応環境でpasskey利用可。サイトがFace IDそのものを直接検証するわけではない |
| Docker | 特別な追加基盤なし | 同左＋専用secret/小さなauth volume | サーバー検証はDocker可。利用者の認証器は端末側 |
| 再起動 | メモリなら再ログイン。永続ストアなら継続可能 | 人間の親/grantは失効。pattern・失敗制限・自動化run許可は保持 | メモリsessionは失効。公開鍵credentialは永続化が必要 |
| Codex検証 | Cookieフロー検証＋別CLI方式 | 人間E2Eとrun token検証を分けやすい | virtual authenticator等は実生体認証を証明しない。実機検証が必要 |
| 外部DBサービス追加なし | 単一プロセスなら可能 | メモリ＋Node標準の認証専用SQLite。DBファイルは追加 | 公開鍵・credential情報の永続化が必要 |
| LAN IP | 信頼済みHTTPSなら可 | 同左 | **直接IPのRP IDは不可**。安定したDNSホスト名が必要 |

A/B/Cは完全な排他案ではない。本案はBの権限モデルにAのtransportを使い、後からCを追加できる境界を用意する。WebAuthnのorigin/RP束縛とIP制約は[W3C仕様](https://www.w3.org/TR/webauthn-3/)を根拠とする。

### C2. パターン規則・保存・推測耐性

- 点番号は左上から0〜8、重複点なし、**最低6点、最大9点**。最大1個の有効pattern。変更時は置換し旧版を失効する。
- Androidに近い規則：直線上で未選択の中間点を通過する接続は自動挿入（例0→2は0,1,2）。既選択の中間点は再挿入しない。線の交差は許可するが交差座標だけで点を追加しない。サーバーも同一canonical規則を適用し、未知番号・重複・長さ超過を拒否する。
- 一直線、単純な連続外周、既知の頻出形状などのversion管理blocklistを登録時に拒否する。6点だから強いとは判断しない。偏り・肩越し観察・画面跡・録画の影響もある。
- 探索空間の安全側上限は、6〜9点の重複なし列で `9P6+9P7+9P8+9P9 = 967,680 < 2^20`。中間点制約とblocklistでさらに減り、実際の選択は非一様。これは設計上の計算で、全列挙テストを今回実行した結果ではない。
- 保存はArgon2id、ランダムsalt 16byte以上、tag 32byte。候補初期値m=64MiB、t=3、p=1。Windows/Linux隔離環境で遅延・メモリ・Bot周期への影響を測り、目標250〜500ms程度を参考に決定する。今回ベンチマーク未実施。
- pepper付きHMACでドメイン分離したcanonical patternを前処理し、その出力をArgon2idへ。pepperは管理トークンと独立。pepper/versionを失えばtokenでpattern再登録し、弱い方式へフォールバックしない。
- 認証DBの検証情報だけ漏れた場合の推測をpepperで抑える。ただしpepperも漏れた場合、小さな探索空間はhashだけでは守り切れない。攻撃機種に基づく総当たり時間は未測定なので「安全な年数」は示さない。
- Node 24.22.1はnode:crypto.argon2とargon2Syncを持つ（追加レビューでWindows/コンテナ実測）。独自PHC parserを広く実装せず、version付き固定スキーマでparamsをallowlistし、保存情報の改ざんで過大メモリを要求できないようにする。[Node公式](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptoargon2algorithm-parameters-callback)
- 依存追加の少なさから**Node標準の同期Argon2idをKDF専用Worker内で直列実行**する。同期APIを許可するのはそのWorker内だけであり、Bot/HTTPのメインスレッドでは禁止。外部node-argon2は高水準APIの利点がある一方、native binary・Windows/Linux互換と依存管理が増える。[OWASP推奨](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- 非同期KDFをWorkerに移すだけでは、全イベントループ間で共有されるlibuvスレッドプールの競合を解消できない。ストアWorkerとKDF Workerを分け、KDF同時1・待ち行列2・全体実行頻度上限を適用する。[libuv公式](https://docs.libuv.org/en/v1.x/threadpool.html)
- WorkerでもCPUとプロセスメモリは共有。resourceLimitsはネイティブメモリ全体の制限ではなくOOM防止を保証しない。Bot周期・event loop遅延・RSSを隔離環境で測定し、不合格なら別プロセス分離まで運用投入しない。[Node Worker制約](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html)

### C3. レート制限・DoS

| 対象 | 初期推奨 |
|---|---|
| pattern照合 | 親ごと5試行/5分、同時1件。credential全体でも集約し、セッション増殖で回避不可 |
| 失敗遅延 | 1–4回でも最大1試行/秒。5回失敗で60秒、6〜9回は段階的延長（上限15分）。10回でpattern経路を無効にし管理トークン必須 |
| 永続性 | 失敗予約をKDF前に永続化。成功時に確定更新。再起動・並行要求で失敗数を巻き戻さない。保存失敗はpattern照合拒否 |
| 初回token認証 | IP＋principal/global上限、例5失敗/分、30失敗/時で段階的遅延。認証済みブラウザやBotの内部通信には波及させない |
| KDF資源 | KDF専用Worker内の同期API、同時1、待ち行列最大2、全体実行頻度上限、超過429/503。入力上限、request期限、Worker異常時fail closed |
| 管理トークン回復 | patternロックアウトと独立して利用可能。ただしtoken自身のオンライン攻撃対策は維持。管理トークン照合でpatternロックアウト解除可 |

IPは補助キー。LAN/NAT共有・IPv6変更・X-Forwarded-For偽装を考慮し、信頼済みプロキシからのみ取得する。全体制限による管理者へのDoSは残るため、安易な永久アカウントロックはしない。監査・期限付き制限・token回復を用意する。認証の429を市場API障害としてapiAccess.onFailureへ流してBotを止めない。

### C4. 保存方式

| 候補 | 長所 | 短所／判断 |
|---|---|---|
| 全メモリ | 簡単・高速・Bot DBに干渉しない | pattern登録・失敗制限が再起動で消えるため単独採用しない |
| A：メモリsession＋専用ファイル | 外部DB不要、取引DBへ触れない。Docker volume/Windows ACLで運用可能 | 原子的更新・排他・破損復旧を独自実装。失敗予約・登録・run失効が増えるほど負担。初回推奨から変更 |
| B：メモリsession＋既存SQLite | transactionを流用可能、Windows/Dockerに既存基盤あり | 取引DBの書込競合・migration・破損の影響を共有しやすい。Bot優先のため不採用 |
| C：メモリsession＋認証専用SQLite | transactionで登録・失敗予約・run失効を原子的に管理。取引DBとは別の障害境界。**推奨** | 専用volume/スキーマ/バックアップが必要。CPU・ディスクの物理資源まで分離するものではない |

Node標準node:sqliteを使用し、取引bot.sqliteとは別ファイル・専用auth volumeへ保存。ストア専用Workerが接続を1つ所有して書込を直列化する。低頻度の認証処理なので、初期はrollback journal方式・synchronous=FULLを候補とし、WALを必須にしない。presenceや管理APIポーリングごとのDB書込は禁止。初期スキーマはpattern_credentials、auth_attempts/lockouts、automation_runs、必要な監査記録をversion管理する。

Linuxはnode所有・0600/0700、Windowsは所有者だけのACL。壊れたDBを自動初期化せず、認証を閉じて管理トークンによる明示回復を要求する。保存障害をBotDatabaseのfaultへ混入しない。read_onlyプロファイルでは専用書込volumeを明示し、pepperを同じvolume/バックアップへ入れない。バックアップ復元時はrun資格情報を無効化し、失敗制限の巻戻りも安全側に回復する。

再起動で人間の親session/grantと自動化access tokenは失効する。pattern・失敗制限・run許可は保持するため、有効なrun資格情報から短命access tokenを再取得できる。将来複数replicaへ拡張する際は共有の強整合ストアを設計し、DBファイルをネットワーク共有してそのまま多重writerにしない。

### C5. Cookie・CSRF・固定対策

- 本番はHTTPS必須。`__Host-suiba.session; Secure; HttpOnly; SameSite=Strict; Path=/`、Domainなし、Max-Ageは残り絶対期限以下。中身はSIDだけ。__HostはPath=/が条件で、現行Path=/apiのまま名前だけ変えない。
- logoutと移行時は旧suiba.sessionを旧Path=/apiで削除し、新旧を併用して迂回させない。旧署名Cookieの権限を引き継がず、導入時に管理トークン再認証を要求する。
- login/再強認証でSIDをrotationし旧SID失効。unlockごとはtab grantとCSRF関連challengeを更新する。SIDをURLやlocalStorageへ出さない。
- 全Cookie mutationにOrigin完全一致、Host/許可origin固定、CSRF nonce、X-SuiBa-Request、Fetch Metadataを適用。SameSiteは補助防御。GETへ副作用を置かない。loginにもCSRF/Originチェックを行う。
- 信頼するHTTPS終端を固定し、外部入力のX-Forwarded-Proto/Hostをそのまま採用しない。workerの直接ポートはloopbackまたは内部networkのみ。CORSは原則許可しない。
- HTTPの開発/E2Eは本番と混ぜず、隔離loopback instanceで明示的な開発設定と別Cookie名を使う。production insecure fallback、環境変数1個で本番認証を無効化する仕組みは設けない。[Cookie仕様参照](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)

### C6. 複数タブ・競合制御

BroadcastChannelでLOCK/LOGOUT/EPOCH_CHANGEDだけを通知し、token・pattern・grantは送信しない。未対応時はlocalStorageに非機密のlock epoch通知だけを書き、storageイベントで追従（認証情報保存には使わない）。通知を受けてもunlockは自動伝播させず、可視タブがサーバーで確認する。通知欠落時もAPIゲートとpresence応答が権威となる。

PCで別タブへ移ると旧タブhideにより同じfamilyがlockする。そのため「片方がhiddenでも別タブを開いたままにしたい」運用とは両立しない。今回は安全側のfamily全体lockを推奨。別端末まで巻き込まない。

| 競合／異常 | 必須対処 |
|---|---|
| login/register/unlock連打 | UI同期single-flight＋サーバー単回challenge/idempotency key。ボタンdisabledだけに依存しない |
| 古い認証結果 | client generationとserver epoch両方一致を要求。ロックは常に優先 |
| KDF中にlock/logout | KDF後、commit前にepoch再チェック。成功しても古いgrantを発行しない |
| 登録cancel・ページ離脱 | draft期限・abort・challenge取消、commit前の再確認。commit済み結果は状態照会で明示 |
| lock直前に始まったAPI | 入口認可に加え、非同期処理後の機密応答送信前・副作用commit直前に認可再確認 |
| lock後に届いた応答 | client generation不一致ならJSON結果をstoreへ反映せず破棄。旧feed/チャート/ナレーションcacheも破棄 |
| lock直前に確定したcontrol | 確定済みstart/stopをロックが取り消したと見せない。監査でcommit時刻・epochを保存。lock自体から追加controlは発行しない |
| gzip等の遅延送信 | worker/index.ts:206–222の非同期圧縮callback直前にもepoch確認。送信開始済みbyteの回収は不可能 |
| 復帰・再接続 | lock barrier→status→pattern/token→fresh fetchの順。自動unlock・古いaction再送禁止 |
| server/Docker再起動 | 人間の親/grant無効でtoken再認証。pattern/失敗制限/run許可は保存。自動化access tokenは再取得。Botは従来の再起動時安全挙動に従う |
| 認証ストア故障 | 認証操作をfail closedにする。取引DB faultとして扱わない。Botの従来障害判定は維持 |

サーバーのlockとmutation commitを同一の短い同期区間またはCASで直列化する。長時間ロックでengineを待たせない。ブラウザabortはサーバー取消の証明にはならない。

### C7. iPhone Safari・HTTPS・UI

Pointer Eventsを主経路とし、pointerdown/move/up/cancel、setPointerCapture、lostpointercaptureを扱う。primary pointer1本のみ。入力面だけtouch-action:none、user-select:none、スクロール抑止を適用し、ページ全体の拡大や通常スクロールは妨げない。pointercancel、回転・リサイズ、ページ離脱は未完成入力を破棄する。[Pointer Events仕様説明](https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events)

レイアウトは既存style.css:1–5の背景#0b111b・文字#dce8f0と既存テーマを維持。3×3面は幅min(画面内幅,320px)程度、正方形、点のhit areaは44CSS px以上、間隔を十分確保。小画面・横向き・safe-area・動的viewportを考慮する。番号のキーボード選択、取消、token入力への代替導線を設け、ドラッグだけを唯一の方法にしない。token貼り付けを許可し、password managerを妨げない設計とする。

入力中の線と選択点はその試行中だけ表示し、送信時・失敗時・cancel時に即消去。完成patternの再表示なし。色だけで成否を示さずrole=status/alertを使う。prefers-reduced-motionに従い、強い振動アニメーション等を避ける。

ロック画面案：

> **SuiBa**
>
> 画面はロックされています
>
> パターンを入力してロックを解除してください
>
> ［3×3入力面］
>
> 管理トークンで再認証
>
> 画面ロックはBotの稼働状態を変更しません。現在の稼働状態は解除後に確認できます。

lock中に履歴・損益・settings・アドレス・管理情報をDOM、canvas、aria、tooltipへ残さない。blur overlayだけは禁止。Bot実状態を未確認のまま「稼働中」と表示しない。ロック画面のための機密status公開APIも追加しない。

| Safari事象 | 設計と制約 |
|---|---|
| アプリ切替・ホーム・タブ切替 | visibilitychange hiddenを第一経路、pagehide補助。イベント未実行・通知失敗もあるためleaseと復帰barrier必須 |
| 端末sleep | timerの実行を当てにせず、server期限＋復帰時lock。時計差分でUIも検査 |
| reload・ページ破棄 | tab grantを永続保存しないので復元時はlock。Cookieだけで管理画面を復元しない |
| bfcache | pagehideで消去、pageshow persisted=trueも最初はlock。no-storeだけでbfcache不使用と断定しない |
| OSのアプリ切替snapshot | hide時の最速消去を試みるが、OSが消去前の画像を保存する可能性をWebアプリ側から完全には制御できない |
| offline | patternをローカル照合して解除しない。復旧までlockのまま |
| API互換 | 現行復元処理のAbortSignal.any/timeoutは対象iOS版により要検証。verifyTokenと同様にAbortController＋timerで統一する設計なら古いSafariへの依存を減らせる |
| 証明書 | IPアクセスならSANに正しいIP、期限・チェーン・信頼が必要。iPhoneへ手動CA追加だけではSSL信頼が自動で有効になるとは限らない |
| Cookie | 信頼済みHTTPS・同一origin fetchが前提。SecureをHTTPへ下げて解決しない。private mode/保存消去でCookie消失時はtokenログイン |
| IPとport | Cookieはportで分離されない。LAN IPで他のHTTPSサービスとCookie名が衝突し得るため、専用DNSホスト名への移行が望ましい |

`https://192.168.3.136:8443`について、mainのDockerはHTTP worker＋loopback公開であり、対象ツリーにLAN用HTTPS終端・証明書配置を特定できなかった。今回のポート読取でも確定情報を得ていない。**現在の証明書SAN・期限・チェーン、iPhoneでの信頼、実Cookie送受信は未確認**。実機が接続できているという利用例を証明書検証成功と同一視しない。設定を変えずに将来の実機確認で確定させる。

ページイベントの限界は[visibilitychange](https://developer.mozilla.org/en-US/docs/Web/API/Document/visibilitychange_event)、[pagehide](https://developer.mozilla.org/en-US/docs/Web/API/Window/pagehide_event)、[pageshow](https://developer.mozilla.org/en-US/docs/Web/API/Window/pageshow_event)を参照。CAの手動信頼手順は[Apple公式](https://support.apple.com/en-us/102390)を根拠とする。

### C8. Codex自動検証の認証設計

**人間のパターンを自動で入力する運用を管理APIスクリプトの必須条件にしない。** ただし人間向けE2Eではpattern/idle/visibilityを正規経路で検証する。

1. 自動化に対してrunId・対象instance/audience・期限・scopeを明示したrun許可を発行する。既定はread:validation/read:operationsなど最小read。start/stop/reset/settingsは必要なときだけ独立scopeで承認する。
2. run資格情報は新規高entropy値で、管理トークンの派生値にしない。安全なファイル／Docker secretから読み、サーバーはhashだけ保持。access tokenは10分、更新は固定されたrun権限内のみ。26時間上限で24時間観測に対応する。
3. unattended更新はブラウザ入力不要だが、run自体の期限を延長したり別scopeを得たりできない。run許可の資格情報hash・scope・対象・絶対期限・失効状態は認証専用SQLiteへ永続化。worker再起動時はaccess tokenだけ失効し、有効なrun資格情報から再取得可能。run失効・期限切れ・時計異常・ストア障害時は拒否する。Botは認証期限切れだけでは停止しない。
4. access/run tokenをURL、コマンド引数、Playwright trace、storageState、HAR、レポート、ログへ出さない。CLIは実値をstdoutへ表示しない。監査にはrunIdとscopeだけ記録。
5. 既存Bearer管理APIは互換期間に維持するが、**root ADMIN_TOKENによる直接管理操作はloopback/内部管理経路に限定**。LANのブラウザ向け経路はBearerをlogin/fresh再認証にだけ許可し、root tokenでUI lockを迂回する運用を作らない。経路判定は信頼済みlistener/proxy境界で行う。
6. 既存の30分・2時間・24時間用スクリプトはrun tokenを使うよう段階移行。現在の24時間観測中に資格情報や稼働環境を切り替えない。既存実行が終了し、明示承認した次の検証から適用する。
7. CIは一時worker・一時secret・一時auth storeのみ。本番volumeや管理トークンを持ち込まない。ブラウザAPIモックだけで合格にせず、別途本物のCookie/CSRF/grantを扱うローカル統合E2Eを設計する。scripts/test-loopback.mjsの環境変数除去へ新AUTH_DB_PATH等を追加し、新Workerが通信ガードpreloadを落とさないよう検証する。
8. run発行はfresh管理トークン再認証を条件に、権限制限ファイルへ資格情報を保存するクライアントで行う。発行値をstdoutやコマンド引数へ出さない。失効確定後は配下access tokenも拒否。Cookie認証と自動化Bearerの曖昧なフォールバックを避け、audience・scope・メソッドでdefault denyにする。

ブラウザを隠してCLI tokenを使うテストは人間の自動ロックの検証にはならない。Playwrightのマウス/タッチ/キーボードによる実入力と、合成dispatchEventを分ける。WebKitエミュレーションではiOSのアプリ切替・端末sleep・OSスナップショット・実証明書信頼を代替できない。

## D. 変更影響範囲（すべて将来の実装候補）

### D1. 既存ファイル

| ファイル | 予定変更と影響 |
|---|---|
| apps/worker/src/browser-session.ts | 署名のみの7日Cookieを、失効可能な親SID＋grantへ置換。旧Cookie無効化、CSRF、期限を統合 |
| apps/worker/src/index.ts | 認証/認可ゲート、auth endpoints、応答直前epoch確認。engine/control安全判定そのものは変えない |
| apps/dashboard/src/browserSession.ts | login/status/logout/challenge/CSRF/grantの共通clientへ。token probeによる機密fetchを廃止 |
| apps/dashboard/src/main.tsx | token文字列判定を状態機械へ。起動restore gate、lock時store消去、generation、認可付きfetchへ統一 |
| apps/dashboard/src/LoginScreen.tsx / loginAttempt.ts | 現行single-flightを維持・拡張。legacy削除・登録案内・回復導線。cancelとserver sessionを区別 |
| apps/dashboard/src/patternLock.ts | 削除専用migrationとして維持。旧暗号化機能を復活させない |
| apps/dashboard/src/BacktestComparison.tsx | 独自Bearer fetchを共通clientへ置換。既存Cookie POST回帰を先に修正 |
| OperationsPanel.tsx / dashboardClient.ts / AgentNarration.tsx等 | poll enabledをUNLOCKEDへ統一、lockでデータ・蓄積・遅延応答を破棄。正確なcache所有者は実装時に再点検 |
| apps/dashboard/src/style.css | 既存ダークテーマ、safe-area、pattern面、focus、reduced-motion |
| docker/Dockerfile / compose*.yaml | pepper secret、専用auth volume/パス、権限、信頼HTTPS設定。Node/pnpmの不要な更新はしない |
| docker/deepbook-24h.mjs / verify*.mjs / scripts/preflight-audit.cjs | run tokenとscopeへ移行。出力redaction維持、既存Botへの操作を暗黙追加しない |
| tests/browser-session*.test.ts / tests/e2e/login.pw.ts / playwright*.config.ts | 現行7日復元の期待を新仕様へ更新。Cookie実統合・grant/idle/競合検証を追加する計画 |
| .github/workflows/suiba-offline.yml | Windows/Linuxの新認証テストをofflineで実行可能にする。実iPhone検証をCI成功と混同しない |

`dashboardClient.ts`等の名称・cache境界は実装時に現ツリーで再確認する。今回は変更ファイル一覧の設計であり、変更を行った一覧ではない。

### D2. 新規ファイル候補

- worker：`auth/session-store.ts`、`auth/authorization.ts`、`auth/pattern-service.ts`、`auth/pattern-worker.ts`、`auth/credential-sqlite-store.ts`、`auth/store-worker.ts`、`auth/rate-limit.ts`、`auth/automation.ts`、`auth/audit.ts`。
- shared：`auth-contract.ts`（state/error/schema）、`pattern-policy.ts`（canonical規則・policyVersion。秘密は含めない）。
- dashboard：`AuthProvider.tsx`、`LockScreen.tsx`、`PatternInput.tsx`、`PatternEnrollment.tsx`、`useActivityLock.ts`、`authClient.ts`。
- tests：認可matrix、fake-clock session、pattern policy、認証DB障害/transaction、同時要求、実Cookie E2E、自動化scope、Bot分離回帰用の各fixture/テスト候補。

### D3. 運用への影響

導入時に旧Cookieから一度tokenログインし直す。12時間上限・8時間pattern許可・30分離席上限・reload時lockが現行より厳しくなる。APIのJSON成功データは維持し、認証エラーコードを追加。共通clientを通らないfetchを全検索して修正しないと一部画面だけ401/403になる。

Dockerではauth volumeとpepper管理が増える。現在のBotへvolume付替えやrecreateは本調査に含まれない。read_only検証profileにも専用volumeが必要。auth障害がhealthzのBot生存判定や市場circuit breakerへ混ざらないようにする。

Bot内部を変えずUI継続稼働は設計できるが、認証KDFによるCPU/メモリ枯渇や同一プロセスクラッシュまで「絶対に停止しない」とは保証できない。Workerの並行上限と資源測定、必要なら独立authプロセス分離が追加対策。今回は最小構成のWorker方式を推奨し、測定でBot周期へ影響が出るなら採用を止める。

## E. 段階的実装・テスト計画

### E1. 実装順序

| Phase | 作業 | 依存関係 | 主なリスク | 受け入れ条件 |
|---|---|---|---|---|
| 1 認証基盤・session | バックテスト共通fetch修正、SID/CSRF/失効/期限/認可matrix、認証専用SQLite/ストアWorker、root管理経路制限、永続run許可とスクリプト移行、旧Cookie移行 | 合意した期限・HTTPS境界・run scope。実装承認後のみ | Cookie回帰、CLI拒否、旧Cookie迂回、DB障害 | 全APIが認可matrix通り。コピーCookieのlogout後拒否。run scope拒否・再起動再取得。token永続化なし。Bot挙動差なし |
| 2 pattern登録・検証 | canonical規則、二重入力、同期Argon2idをKDF専用Workerで直列実行、pepper、SQLite transaction、失敗制限、token回復 | Phase 1、専用volume/secret | 小さい探索空間、DoS、cancel競合、CPU/RSS | plaintext/暗号化tokenなし、再起動後失敗制限維持、KDF中lockで解除不可、忘却回復可能、資源測定合格 |
| 3 idle/background lock | activity専用経路、300秒、固定チケット15秒上限/5秒更新、activation、family lock、epoch/barrier、cache消去 | Phase 1/2。pattern未登録のtoken解除も実装 | timer停止、通信欠落、遅延/逆順更新、古い応答復活 | 境界時刻・全API拒否・poll非延長・複数タブ・遅延応答で合格。lockからcontrolを呼ばない |
| 4 iPhone Safari | Pointer Events、safe-area、cancel/rotation、実HTTPS/Cookie、sleep/bfcache/復帰実機 | Phase 3、信頼証明書、対象iOS版確定 | OS snapshot・イベント未配送・CA未信頼 | 指定iPhone/PCで操作可能。復帰時に機密が再表示されない。未達のOS制約を明文化 |
| 5 security/regression | 攻撃系、fake clock、Windows/Linux、隔離PAPER 30分/2時間/24時間、回帰・監査 | Phase 1–4、個別の運用検証承認 | 上流障害とauth混同、試験中Bot停止 | 下記23項目を証拠付き評価。既存安全停止・台帳・Profit Guard等が維持。未確認項目があるまま運用へ反映しない |

フェーズ途中で運用へ半端なlock画面を公開しない。開発feature flagは権限を緩める用途にしない。rollback時も旧署名Cookieや旧暗号化patternへ戻して認証を迂回させず、全session破棄＋tokenログインとする。運用Docker更新・Bot再起動は別の明示承認を必要とする作業である。

### E2. 時計と試験環境

SessionService/RateLimiterへClock（wallNow/monotonicNow）を注入し、フロントもtimer wrapperと時計を注入できる設計にする。Vitest fake timersとPlaywright clockで299,999ms/300,000ms、lease境界、親期限、日付巻戻りを即時検証。**本番APIに任意時刻を指定するパラメータは作らない**。visibility等はDOMイベントの単体試験と実ブラウザ/実機を分ける。

隔離worker・隔離DB/volume・一時token・ローカル市場fixtureで先に検証。実PAPER観測は時間の短縮が目的のfake clockと分離し、実際の30分/2時間/24時間を測るときだけ通常時計を使う。今回はいずれも実行していない。

### E3. 23項目テスト計画

| # | テスト | 方法・合格条件 |
|---:|---|---|
| 1 | 管理トークン初回login | 正誤・32文字制約・single-flight・cancel・レスポンス不正・Cookie作成失敗。正しい現在の試行だけactivation可 |
| 2 | pattern登録 | fresh認証必須、6〜9点、単純形拒否、サーバーcanonical一致、登録数1、連打で1commit |
| 3 | 確認入力 | 不一致/中間点/交差/重複/複数pointer/cancelで保存しない。commit競合の確定結果も表示 |
| 4 | 5分lock | fake clockで境界直前許可・境界一致で拒否。client timerが停止してもserverで拒否 |
| 5 | 操作timer更新 | click/tap/keyboard/wheel/実scroll連動。単なるmousemove、dispatchEvent、programmatic scrollでは延長しない |
| 6 | API更新非延長 | polling/presence/marketイベントを大量に模擬しても300秒でlock。presenceだけの継続を検証 |
| 7 | background lock | hidden/pagehide/タブ切替の即時消去とepoch失効。通知drop・更新遅延/逆順/重複でも発行済みチケットの最大15秒上限。古いactivation拒否。復帰は必ずbarrier |
| 8 | 正しいpattern | eligible親＋challenge＋同epochのときだけ新grant。tokenは応答にもログにもない |
| 9 | 誤pattern | 解除せず汎用error。存在推測、異常列、巨大body、unknown policyを拒否 |
| 10 | 連続失敗 | 並列・別SID・別IP・再起動で回数回避不可。429/Retry-After/10回token必須。token回復可能 |
| 11 | locked API拒否 | matrix全行を実サーバーへ。Cookieのみ、旧grant、旧署名Cookieで機密GET/POSTすべて拒否 |
| 12 | session期限 | 12h親、8hpattern、30分lock、fresh5分の各境界。pattern/presenceでは絶対期限延長不可 |
| 13 | 複数タブ | tab A hideでfamily lock、Bの遅延応答破棄。BroadcastChannelなし/storage拒否でもAPIで拒否 |
| 14 | reload | Cookie有効でも機密描画前にlock。tab grantがstorageState/localStorage/sessionStorageへ保存されない |
| 15 | Safari復元 | 実iPhoneでapp切替/sleep/bfcache/OSページ破棄。復帰前の機密flash、古いcanvas/ariaを確認 |
| 16 | Docker再起動 | **専用試験instanceのみ**。人間の親/grantと自動化access失効、pattern/失敗制限/run許可保持。人間はtoken再login、自動化は有効runからaccess再取得。既存再起動安全処理を維持 |
| 17 | 通信断・復旧 | hide通知/lock/unlock応答をdrop、逆順配送。offline解除なし。復旧後lock先行、自動control再送なし |
| 18 | Codex自動検証 | CI/CLI/Docker/run token更新・期限/scope/audience/失効。UI E2Eは本物Cookie統合も実施。30m/2h/24hの期限予算を検証 |
| 19 | PAPER継続 | fixtureでlock前後のtick/decision/risk/profit/ledger/log/validation/healthを比較。lock/logoutでruntimeを書かないことを監視。実観測では約定ゼロもあり得るため約定増加を必須にしない |
| 20 | DeepBook異常安全停止 | 隔離fixtureでtimeout/古い市場/回復条件/台帳不正/リスク超過。locked中も既存停止・再開制約が同じであること |
| 21 | token漏えい | storage、DOM、network response、URL、logs、HAR/trace/report/image layer/認証ファイルを一時canaryで検査。実秘密は使用しない。旧3キー削除も確認 |
| 22 | XSS/CSRF/固定 | cross-origin/same-site別origin、欠如Origin、nonce欠如、不正proxy header、SID固定/旧SID/コピーCookie、grant replay、圧縮応答競合を検証。CSPがあるだけでXSS解決扱いしない |
| 23 | Node 24.22.1互換 | WindowsとDocker Linuxでversion gate/子process/同期Argon2id専用Worker/既知ベクトル/CPU・RSS/SQLite transaction。非対応版は起動拒否。新Workerのloopbackガード継承。依存lockを不用意に更新しない |

追加の完了基準：KDF最大負荷時でも既存Bot周期の安全予算を侵さないこと。auth volume満杯・破損・pepper欠如・Worker crashでも認証は閉じ、Botの既存記録やhealthを破壊しないこと。安全性と継続稼働の両方に未解決があれば運用導入しない。

## F. 最終評価

| 問い | 回答 |
|---|---|
| 1 安全に導入できるか | **条件付きで可能**。サーバーの失効・認可を先に作る。現在のCookie方式のままUIだけ追加する案は不可 |
| 2 実装前に直す問題 | バックテストのCookie POST不整合、個別失効不能、Cookieでの期限再発行、HTTPS/proxy信頼境界、認証専用rate limit。稼働版とmainの相違も解消計画が必要 |
| 3 token安全性 | patternから独立したまま保護可能。tokenを暗号化保存せず、hash/pepper/親SID/grantを別物として扱う。既に持ち出された旧暗号文の危険は今回の設計だけでは消えない |
| 4 Codex自動検証 | 維持可能。明示run scope/短命access tokenを使い、CLIへ人間のpatternを強制しない。本番の無条件bypassは作らない |
| 5 PAPER継続稼働 | lockによってBot状態を変更しない設計は可能。既存異常時停止は維持する。CPU枯渇・worker crash・Docker再起動まで含む絶対稼働保証ではない |
| 6 iPhone Safari | 通常の自動lock・pattern・復帰再認証は実現可能。通知不能瞬間のserver即時lockとOS snapshot完全制御には限界。証明書・対象iOS版の実機確認が必要 |
| 7 patternとFace ID | **WebAuthn/passkey＋user verificationの方が安全**。patternは小さな探索空間と観察攻撃に弱い。Face IDは端末側検証で、WebAuthnは公開鍵署名を検証する。端末passcodeへのfallbackもあり「常にFace IDのみ」とは保証しない |
| 8 最終推奨 | **HttpOnly親session＋固定期限チケット付き短命grant＋server pattern照合＋独立run認証**。人間はメモリsession、認証専用SQLite、独立pepper、Node標準同期Argon2idのKDF専用Worker。WebAuthnはDNS/HTTPS整備後に追加候補 |
| 9 ユーザーが決める事項 | 下記。今回の文書提出では実装に移らない |

実装承認前に決めるべき項目：

1. 通知不能時にサーバー許可が最大15秒残る境界を許容するか。完全即時という要件の例外を明文化する必要がある。
2. 親12時間・pattern8時間・離席30分・再起動後token必須という推奨期限でよいか。
3. 単一admin・pattern1個を端末間で共用する初期仕様か、端末別patternが必要か。後者はcredential管理・削除・上限の設計を追加する。
4. どれかのタブを離れると同一Cookie family全体lockする運用でよいか。
5. 自動検証へ付与するread/start/stop/reset/settingsのscope、run許可の発行主体・最大期限。
6. LAN IPを継続するか、将来passkey向けの専用DNS名と信頼証明書へ移るか。対象iPhone/iOS/Safariの最低版と確認担当。
7. 旧pattern保存を使った端末がある場合のtokenローテーション、および既存24時間観測終了後の適用時期。今回のBotには触れない。

8. 認証専用SQLiteの追加と、自動化run許可のみ再起動後も有効期限内で再取得可能にする方針。

**最終判断：条件付きで実装開始を推奨。運用適用は未承認。** 固定15秒上限、人間の期限・family lock、認証専用SQLite方針の合意後に認証基盤から着手できる。Safari実機・証明書信頼・資源測定・統合回帰は実装後かつ運用導入前の必須条件。文書公開の承認を実装承認と解釈しない。

**作業終了条件**：設計書の更新・公開で終了。アプリケーションコード・設定・依存・テストは変更せず、実装・テスト実行・Bot制御・PR/mergeは行わない。今回の追加指示により、この文書のみcommit/pushする。将来の実装はユーザーの明示承認後に別作業として開始する。

## G. 設計レビューと公開時点の差分

### G1. 調査基点と事実

| 時点 | 確認結果 |
|---|---|
| 初回調査 | e90840d。A章は当時の行番号・コンテナ観測を保存した履歴 |
| レビュー | リモートmain=367eb6fb525cad2e38f75854b9881daee81f16e3。初回からbrowser-session.ts/browserSession.ts/LoginScreen.tsx/BacktestComparison.tsx/worker/index.ts、認証テスト、Docker、CI/Playwright設定は変更なし |
| レビュー時main.tsx | 開始拒否の汎用バナー抑制を追加。認証方式は同じ。apiは327–354、ログイン成功478、BacktestComparison呼出752へ移動 |
| 追加検証基盤 | scripts/test-loopback.mjs、loopbackガード、停止証拠抽出、PAPER復旧/Sui観測テストを追加。既存Botへ接続せず一時worker/DB/認証値を使う設計 |
| レビュー時実測 | Windows/稼働コンテナ内の別Nodeプロセスともv24.22.1、SQLite 3.53.4、argon2Sync存在。コンテナ内のindex.tsとbrowser-session.tsのhashは対象main該当ファイルと一致。イメージ全体一致の証明ではない |
| 本公開基点 | 99fb9715d83762a126f3c06e19a82b818d89c403。レビュー後にmainが進んだため最新から文書だけ更新 |
| 公開前の追加差分確認 | browser-session.ts/browserSession.ts/BacktestComparison.tsx/worker/index.ts/Dockerは変更なし。LoginScreen.tsxは見出し・常設案内・末尾説明を削除し、旧pattern削除時の案内へ説明を統合。認証処理・旧データ削除自体は維持 |
| その他の公開前差分 | 買い走りライン、ticker/narration/indicator/strategy等と対応テストの更新あり。今回の公開では変更せず、前回レビューのPAPER全体評価を再実測したとは扱わない |

レビューではソース読取・限定メタデータ・公式仕様を確認した。認証API操作、Bot制御、再起動、テスト、ビルドは実施していない。公開作業では設計書だけを変更する。A章の過去のコンテナ不一致は、その後のレビュー時観測と区別する。

### G2. 背景ロックの比較と採用理由

| 評価 | A：15秒上限/5秒更新 | B：5秒上限/1秒更新 | C：操作ごとの短命許可 |
|---|---|---|---|
| セキュリティ | 通知欠落後の残存が長め。固定期限チケット必須 | 残存を短縮。固定期限チケット必須 | 無操作時の許可を閉じやすいが、機密GETにも設計が必要 |
| 負荷概算/前景1タブ | 約12要求/分 | 約60要求/分 | 操作頻度次第 |
| 通信断/遅延 | 相対的に余裕あり | 瞬断・timer遅延で誤ロック増 | 操作時の失敗・往復待機が増える |
| Safari安定性 | 相対的に有利、実機未確認 | timer抑制の影響を受けやすい | UI待機と再試行が複雑化 |
| Bot負荷 | 軽いメモリ照合中心、KDF/DB書込なし | Aの約5倍の更新通信 | 操作ごとの認可往復 |
| Codex | 人間E2Eで固定上限を検証 | タイミング条件が厳しい | UIシナリオが複雑。CLIは独立認証 |

**Aを採用候補として確定する。** 数値は設計上の概算で実測ではない。正規クライアントの更新停止から最大15秒という上限をユーザーと合意する。Safariがイベントを実行せず通信も届かない瞬間のサーバー即時失効、OSのアプリ切替snapshot完全制御、悪意ある同一originコードへの可視性証明は保証しない。WebSocketの切断検知でも即時性は保証できない。

[Page Visibility](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API)、[pagehide](https://developer.mozilla.org/en-US/docs/Web/API/Window/pagehide_event)を根拠とする。復帰は残存leaseにかかわらずbarrier→状態確認→pattern/token→activation→fresh fetchの順。

### G3. バックテスト認証の具体的修正設計

レビュー基点367eb6fではbrowserSession.ts:4のSESSIONはcookie-session。main.tsx:478で設定し、752でBacktestComparisonへ渡す。BacktestComparison.tsx:165–175のrequestは169でその文字列をBearer送信し、POSTにX-SuiBa-Requestがない。worker/index.ts:270–279ではCookieがあれば認証は通るが、非GET追加ガードで403になる。実運用APIへの再現POSTは未実施。

- 変更ファイル：BacktestComparison.tsx、main.tsx、認証基盤で共通authClient.tsを追加。
- 変更関数：BacktestComparisonのprops/内部request、main.tsxの共通api/呼出箇所。token文字列ではなく認証済みAPI関数を渡す。
- 互換性：/api/backtestのGET/POST・入力・成功JSON・busy/入力検証を維持。worker側のCSRFガードを緩めない。
- 共通clientがCookie、追加ヘッダー、CSRF nonce、tab grant、401/423、generation/abortを扱う。SESSIONを資格情報として送らない。
- 回帰：実CookieでGET/POST成功、Cookieなし401、追加ヘッダーなし403、locked423、古いgrant拒否、入力不正/履歴不足/busy、lock後の遅延応答破棄、CLIのscope付き認可。

### G4. レビュー指摘一覧

P0は新機能公開を阻害する設計上の条件。侵入・悪用の観測ではない。

| 重大度 | 問題・根拠 | 最終対策 |
|---|---|---|
| P0 | 署名だけのCookieでは個別失効・lock不可（browser-session.ts:19–37） | サーバーの親SID・epoch・grant |
| P0 | 受信時刻からのlease更新で遅延要求が15秒上限を超え得る | 固定期限チケット、single-flight、activation、epoch再確認 |
| P0 | 全権Bearerの公開経路継続で新lock境界が曖昧（worker/index.ts:270–279） | browser/automation/root互換経路を分離、scope/audience/methodでdefault deny |
| P1 | Cookie再発行で強認証からの絶対期限を固定できない（同280–289） | strongAuthenticatedAtと絶対期限を固定 |
| P1 | logoutがCookie削除のみ | サーバーSID失効、local消去を先行 |
| P1 | バックテスト独自fetchの403 | G3の共通client化 |
| P1 | 独自ファイルで失敗予約・登録・run失効の原子性が複雑 | 認証専用SQLite、ストアWorker |
| P1 | 非同期KDF Workerでも共有pool競合 | 専用Worker内の同期KDF、頻度/並行/queue上限 |
| P1 | メモリrun許可では再起動後unattended継続不可 | run許可だけ永続化、accessを再取得 |
| P1 | cancel/lock後の認証結果・Set-Cookie・KDF完了の競合 | client generation、server epoch、単回activation、確定状態照会 |
| P2 | 実機・証明書・誤lock率・KDF資源未確認 | 運用導入前の受け入れ条件 |

### G5. 自動検証移行とBot分離の受け入れ

現行30分composeは専用secret、preflight-audit.cjs:87–90はBearerでoperationsを読む。24時間はdeepbook-24h.mjs:121–145でコンテナ内secret→localhost API。2時間報告は停止状態の通信観測であり、認証導入を理由にstart/resetを追加しない。CIは一時認証値、PlaywrightはAPIモックだけで実認可の成功を証明しない。

移行は隔離instance→専用token対応→次の新規runから採用→既存run終了→承認した切替作業でroot互換経路縮小の順。進行中のPAPER検証の資格情報・image・volumeは変更しない。新WorkerとAUTH_DB_PATH等はloopbackガード/環境変数除去に対応する。

コード上、worker/index.ts:161–187/547のscheduler、128–141のwatchdog/validationHeartbeat、engine.ts:183–204の判断/記録、473/534のRiskEngine、458–471等のProfit Guard、579のcommitFill、615–636等の異常処理はブラウザ認証を開始条件にしていない。lock/logoutからruntime/control/scheduler/circuit resetを呼ばない。既存rule-based登録を確認したもので、外部AI利用を実証したものではない。

最終受け入れは、idle300秒、背景即時lock試行と固定上限、復帰barrier、server pattern照合、機密GET/POST拒否、Bot独立、専用run認証、管理トークン維持、通信断/期限/再起動の安全側処理、既存バックテスト/PAPER回帰合格の10条件。実装コード・実行証拠は今回作成しない。

ロールバックでは認証DBをversion管理し、新SID/grant/runを失効、patternを閉じて管理トークン強認証へ。取引DBを変更せず、旧暗号化pattern・コピー済み旧Cookieを再有効化しない。バックアップ復元でrun許可や失敗数を巻き戻して認証を弱めない。認証無効化フラグは禁止。Bot再起動を伴う適用・rollbackは別の運用承認で行う。

残るユーザー判断は、固定15秒上限の許容、認証専用SQLiteと人間/自動化の再起動仕様、親12時間/pattern8時間/離席30分/family lock。文書公開をこれらの運用値への承認や実装開始指示として扱わない。
