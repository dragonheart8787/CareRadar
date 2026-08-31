# 災後需求雷達｜關懷優先排序 × 志工智慧媒合（Demo）

競賽 MVP：用 LINE Bot 自然語言通報 → AI 結構化 → 可解釋的 Care Score 排序，
取代「最新／最近」式的志工媒合，並在名額額滿時自動把志工導向其他仍缺人的案件。

## ⚠️ 服務範圍與邊界：這不是緊急救援通報系統

**本系統的服務範圍，是「災害官方應變、110／119 等緊急救援之後」的 72 小時
生活復原階段志工協調。它不是緊急救援通報系統，不取代也無意取代任何正式管道：**

| 正式管道 | 用途 |
| --- | --- |
| **110** | 警察 |
| **119** | 消防／救護 |
| **1991** | 行政院災害緊急應變中心 |

系統內建兩層判斷（送出訊息當下的關鍵字比對、以及 AI 的語意判斷），偵測到訊息
透露立即性生命危險時，會額外提醒使用者撥打 110／119。但這**只是輔助提醒，
無法保證可靠偵測所有緊急狀況**——它會漏判。

**真正的緊急狀況，永遠應該第一時間撥打上述正式管道，不應該等待這個系統的回應，
也不應該等待志工媒合。**

---

單一 Cloudflare Worker，沒有任何需要另外付費申請的 API 金鑰：
NLU 用 **Cloudflare Workers AI**（Qwen3，跟著你的 Cloudflare 帳號走，
每天 10,000 Neurons 免費額度），地理編碼用 **OpenStreetMap Nominatim**（免金鑰、
有使用限制）。你只需要自己已有的 LINE Developers Channel 憑證。

## 架構

```
LINE 使用者傳文字
   │  POST /webhook/line  (HMAC-SHA256 簽章驗證)
   ▼
立刻回應 LINE 200 ──► 後續全部丟進 ctx.waitUntil() 背景執行
   │                   (LINE 要求 2 秒內回應；背景處理不受這個時限約束)
   ▼
follow 事件（加好友）→ 自動回覆歡迎訊息，說明使用方式與範例格式，到此結束
   │
   ▼
LINE_RATE_LIMITER（依 LINE userId，10 次 / 60 秒）
   │  超過 → 回覆提醒訊息，不進入後續處理
   ▼
Workers AI (Qwen3, JSON Schema 結構化抽取)  ──► 只填「文字裡明確提到」的欄位，
   │                                              不確定一律 null，不腦補
   ▼
Nominatim 地理編碼 → 座標模糊化 (fuzzLocation, ~300m 網格)
   │
   ▼
這位使用者 15 分鐘內有仍開放（status='open'）的案件嗎？
   ├─ 有 → 視為補充，合併進原本那筆（見下方「多輪追問」）
   └─ 沒有 → 建立新案件
   ▼
D1 (SQLite)：cases / case_status_history / volunteer_claims
   │
   ├─ 重複通報偵測（150m + 24hr 內，只標記不自動合併）
   ├─ Confidence Score（規則式：關鍵欄位填了幾個，不採信模型自報）
   └─ Care Score（規則式加權，見下方公式，跟 Confidence 完全獨立）
   ▼
GET /api/cases?sort=care_score   → 志工看到的排序清單 + 地圖（只有 public_* 模糊化座標）
POST /api/cases/:id/claim        → 先過 CLAIM_RATE_LIMITER（依 IP，5 次 / 60 秒）
                                   原子性認領，名額滿自動 status='full' 並從清單消失
                                   回應帶一組一次性 claim token
GET /api/cases/:id/address?token=… → 憑 claim token 換精確地址（exact_* + location_text）
```

後台管理（需要 `ADMIN_KEY` 這個 secret）：

```
GET  /admin/duplicates                      → 列出疑似重複案件，兩筆並排比對
POST /api/admin/duplicates/:id/resolve      → 確認合併（關閉重複那筆）或標記非重複
     body: { action: "merge" | "not_duplicate" }

授權方式：HTTP Basic Auth。直接用瀏覽器打開 /admin/duplicates，會跳出原生的
帳號密碼登入視窗 —— **帳號可以隨意填**（不檢查），**密碼填 ADMIN_KEY 的值**。
登入一次之後瀏覽器會自動把憑證帶在後續請求上，包含頁面上按鈕觸發的 fetch，
所以金鑰不會出現在網址列、瀏覽器歷史、代理伺服器日誌，也不會被嵌進頁面的
JavaScript 原始碼裡。

ADMIN_KEY 未設定、沒帶憑證、或密碼不符 → 一律 401，不透露頁面內容或金鑰格式。
```

前端是單一 HTML（`src/frontend.ts` 回傳字串），地圖用 Leaflet + OSM 圖磚，
沒有額外的建置流程，方便你在 Demo 現場直接改。

## 精確地址存取控制

`/api/cases` 這個公開清單（不論 `sort=care_score` 或 `sort=latest`）**只回傳
`summary`、`public_lat` / `public_lng` 這類不含使用者原始輸入、也不到街道地址
等級的欄位**。`raw_text` 與 `location_text` 完全不會出現在這個端點的回應裡 ——
不是空字串，是連鍵名都沒有。

看得到這兩個欄位的只有兩條路徑：帶正確 claim token 呼叫
`GET /api/cases/:id/address`（只回 `location_text`），以及通過 Basic Auth 的
admin 後台（看得到 `raw_text`，因為人工比對重複案件需要讀原話；後台不顯示
`location_text`）。

`summary` 是 AI 產生的，而抽取用的 SYSTEM_PROMPT 明確要求它**只寫到縣市／
鄉鎮區等級**（例如「台南仁德」），不得包含門牌等可定位到特定住戶的資訊 ——
這是縱深防禦：就算欄位本身是公開的，內容粒度也先被限制過。

要看到精確位置，必須先認領：

```
POST /api/cases/:id/claim
  → 回應 { ...case, claim_token: "…" }        ← 只在這一次回應出現

GET /api/cases/:id/address?token=<claim_token>
  → 200 { location_text, exact_lat, exact_lng }
  → 403 { error: "invalid or missing token" }  ← token 錯誤或缺漏
```

`claim_token` 由 `crypto.randomUUID()` 產生，資料庫（`volunteer_claims.claim_token_hash`）
只存它的 SHA-256 雜湊值，**系統本身也無法從資料庫回推原始字串**。驗證時把傳入的
token 用同樣方式雜湊後比對。

前端在認領成功後把 token 存進 `localStorage`（key 為 `claim_token_<caseId>`），
有 token 的案件卡片才會多出「查看精確地址」與「回報完成」按鈕。沒認領過、或換了
瀏覽器／清過快取的人，卡片上不會出現這些按鈕，也不會顯示任何提示文字 —— 就是
安靜地不出現，只看得到模糊化座標。

### 回報完成（同一組 claim token 的另一個用途）

志工處理完之後，可以用**同一組 claim token** 把案件標記為已完成，讓它真正結案，
而不是永遠停在 `full` 狀態：

```
POST /api/cases/:id/complete
  body: { token: "<claim_token>" }
  → 200 { ...case }                                        ← status 變成 "completed"
  → 403 { error: "invalid token or case already resolved" }
```

只有還在 `open` 或 `full` 的案件能被標記完成，判斷靠單一 UPDATE 的 `meta.changes`，
所以兩位志工同時回報也不會重複寫入。403 刻意不區分「token 不對」與「案件已經結案」，
跟地址端點同一套慣例。

**`completed` 會讓這個案件的 claim token 立即失效** —— 跟案件被判定重複而合併
關閉（`closed`）完全一樣的處理：結案之後就不該再查得到精確地址。前端在回報成功後
也會把本機那份 token 從 `localStorage` 移除。

顯示上，`completed` 案件比照 `full`：卡片半透明並標示「已完成」tag、不再提供任何
操作按鈕，地圖標記顯示為灰色而不是分數色。它不會出現在 `sort=care_score` 的推薦
清單裡（那裡只撈 `status = 'open'`），只在「最新回報」排序看得到。

### 取消認領（把名額還回去）

志工臨時去不了時，可以用同一組 claim token 取消自己的認領：

```
POST /api/cases/:id/cancel-claim
  body: { token: "<claim_token>" }
  → 200 { ...case }
  → 403 { error: "invalid token or case already resolved" }
```

一個案件在 `volunteers_needed > 1` 時會有多位志工，**每個人認領時各自拿到獨立的
claim token、在 `volunteer_claims` 各自有一筆紀錄**。取消時系統會用 token 精準
對應到「哪一筆」認領，所以只會刪掉自己那一份，同案件裡其他志工的認領與 token
完全不受影響。（這也是為什麼取消要用一個獨立的驗證函式，而不是沿用查地址那個 ——
「這組 token 對得上這個案件」不足以決定該退回哪一筆。）

取消後 `volunteers_assigned` 減一；案件原本若是 `full`，會打回 `open`、重新出現在
Care Score 推薦清單上讓其他志工補位。

**這組 token 在取消的當下立即失效** —— 那筆 `volunteer_claims` 紀錄已經被刪除，
之後拿它查精確地址或回報完成都會查不到而失敗。前端也會同步清掉 `localStorage`
裡的那份。

按鈕在卡片上跟「查看精確地址」「回報完成」並列，但刻意用中性的邊框與次要文字色
（不是旁邊兩顆的琥珀色）—— 取消是一個相對負面的動作，視覺重量不該跟它們一樣，
更不該被鼓勵優先點擊。

## 志工異動通知

志工認領或取消認領時，系統會用 **LINE Push API** 主動通知原本的通報者：

```
認領：好消息！已經有志工認領您的需求，目前是 1/3 位志工協助中。
      認領志工：王小明

取消：提醒：原本認領您需求的志工（王小明）已取消協助，目前還缺 2 位志工，
      我們會持續媒合其他志工，請放心。
```

志工沒留名字時顯示「匿名志工」。取消訊息帶的是**被取消那一位**的名字（取消前先把
名字撈出來，因為紀錄馬上就要被刪掉了）。

案件的 `reporter_line_user_id` 若是 `null`（例如里長代填、沒有經過 LINE 通報的
案件），直接跳過不送，**不視為錯誤** —— 這種案件本來就沒有可推播的對象。

通知是 best-effort 的附加行為，不是操作的一部分：用 `ctx.waitUntil()` 丟到背景，
不讓推播的往返時間拖慢志工端的回應；推播失敗也**不會**讓認領／取消本身失敗。
失敗時會記錄到 Workers Logs，並且**帶上 LINE 回傳的實際狀態碼與錯誤內容**，
例如：

```
Failed to notify reporter LINE API 403: {"message":"You cannot send messages to this user"}
```

有這行才查得出某位通報者收不到通知是因為封鎖了官方帳號、userId 失效、還是推播
額度用盡 —— 而不是只知道「沒送到」。

## Care Score 公式（可調權重都在 `src/care_score.ts`）

```
Vulnerability = age(80+:30 / 65-79:20) + 獨居:25 + 行動不便:25 + 幼兒:15   （上限100）
Severity      = min(淹水深度cm,150)×0.4 + 缺水:15 + 缺電:10                （上限100）
Urgency       = 已等待時數 × 3                                            （上限60，約20小時觸頂）
ResourceGap   = (需求人數 - 已認領人數) × 5                                （上限20）

Total = Vulnerability×0.4 + Severity×0.3 + Urgency×0.2 + ResourceGap×0.1
```

四項是**先各自四捨五入到小數點一位、再相加**，不是加總後才四捨五入 —— 這樣使用者
在案件卡片上看到的分項數字（`脆弱程度 +18.0 · 災害程度 +11.7 · …`）加起來一定
等於顯示的總分。一個標榜「可解釋」的分數，不該讓人自己加一遍卻對不起來。

帶入原題情境算一次：76歲（落在65-79級距）、獨居、淹水60cm、缺水、通報10小時、0志工/需2人：
`V = 20(65-79) + 25(獨居) = 45 → ×0.4 = 18.0`
`S = min(60,150)×0.4 + 15(缺水) = 39 → ×0.3 = 11.7`
`U = min(10×3, 60) = 30 → ×0.2 = 6.0`
`R = min((2-0)×5, 20) = 10 → ×0.1 = 1.0`
`Total = 18.0+11.7+6.0+1.0 = 36.7`

這組數字已經用 `src/care_score.ts` 實際跑過驗證（見下方測試），跟 seed 資料裡的
案件1一致。同一個情境下，案件2「已額滿的年輕家庭」（20分鐘前發文、志工2/2已滿）
只有 2.6 分且會被過濾出清單；案件5「很新但輕微」（5分鐘前發文）只有 1.8 分 ——
這兩個案件在「最新回報」排序都會排到案件1前面，這正是要在 Demo 裡對比給評審看的重點。

**Confidence Score 不會出現在上面任何一項** —— 它只決定
`needs_human_verification`，永遠不拿去乘進 Total。這是對「無法拍照定位的長輩」
的明確承諾，Demo 時建議直接打開 `src/care_score.ts` 給評審看這一行的注解。

**資訊不足現在完全不影響 Care Score。** 早期版本有一個 `UnknownBonus`：年齡/獨居/
行動能力三個核心欄位全部未知時，直接加 10 分進總分。立意是「不讓資訊不全的案件
被埋掉」，但作法其實違背了上面那條原則 —— 那等於讓 Confidence 反向滲進了分數本身。
現在改成：資訊不足**不加分也不扣分**，一律由 `needs_human_verification` 這個獨立
旗標處理，這類案件會出現在前端的**「待人工複核」面板**（列出已等待時數，提醒盡快
電話確認），跟 Care Score 排序完全脫鉤。

## 多輪追問（缺資訊時主動問，而不是默默存起來）

Confidence Score 不足時，系統不會只回一句「已收到」就把資料不全的案件丟著 ——
它會直接說出**還缺哪幾個欄位**，並邀請使用者補充：

```
已經收到您的訊息，還需要以下資訊才能準確評估優先順序，麻煩直接回覆補充：
所在地區、年齡、是否獨居、淹水深度

即使暫時不方便補充，我們也會請在地志工/里長協助電話確認，不會因此降低協助的優先順序。
```

同一位 LINE 使用者在 **15 分鐘內**的下一則訊息，只要原本那筆案件仍是
`status='open'`，就會被視為**補充**、合併進原本那筆案件，而不是兩則訊息各自
建立一筆。**這跟該案件的資訊填得完不完整無關** —— 已經補齊、不再需要人工複核
的案件，一樣會在時間窗內繼續吸收後續訊息。

這一點是刻意的。早期版本額外要求 `needs_human_verification=1`，結果是案件的
信心分數一跨過 0.5（實測填 2～3 個關鍵欄位就會發生）就不再是可補充的目標，
但使用者聊天視窗裡那則追問訊息的快速回覆按鈕還在、還能按 —— 於是接下來每按
一顆就開一筆新案件，同一戶被切成好幾筆沒有地址、地圖上畫不出來、連重複偵測
都比對不到的碎片。「還能不能補充」該由時間窗與案件是否仍開放決定，跟資訊夠
不夠完整無關。代價寫在下方「已知限制」。

合併規則（`supplementCase()`）：

| 欄位 | 規則 |
|---|---|
| `location_text` / `age` / `lives_alone` / `mobility_impaired` / `has_young_children` / `household_size` / `flood_depth_cm` | **只填空，不覆蓋** —— 原本是 `null` 才採用新值 |
| `no_water` / `no_electricity` | 取 **OR** —— 任一次提到就算有，不會因為第二則沒提到就被清掉 |
| `need_types` | 兩次的**聯集**去重 |
| `raw_text` | `原文 + "\n---\n" + 新訊息`，完整保留對話軌跡供人工複核 |
| `summary` | 新摘要有實質內容才接成「原摘要；補充：新摘要」 |
| `exact_*` / `public_*` | 只有在 `location_text` 是這次才第一次填上、且原本沒有座標時才帶入 |

「只填空、不覆蓋」是刻意的：使用者補充時常常只回答被問到的那幾項，其餘欄位模型
可能抽出 `null` 或抽錯，若讓新值蓋掉舊值，等於讓一次追問把原本正確的資料洗掉。

合併後用完整資料重算 Confidence，補齊了就改回一般的確認訊息；還是不足就再問一次。
狀態不靠 Durable Objects 保存 —— 「哪一筆案件還缺資訊」本來就記在 D1 的
`needs_human_verification` 上，直接查它就是最誠實的狀態來源。

## 部署步驟

```bash
npm install

# 1. 建立 D1 資料庫，把回傳的 database_id 貼進 wrangler.toml
npx wrangler d1 create disaster-care-radar-db

# 2. 建表 + 灌示範資料（先 local 跑起來看看，之後再 remote）
npm run db:schema:local && npm run db:seed:local
npm run db:schema:remote && npm run db:seed:remote

# 3. 設定 LINE 憑證（去 LINE Developers Console 的 Channel 設定頁拿）
npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN

# 同樣方式設定 ADMIN_KEY，用來保護 /admin/duplicates 後台頁面。
# 建議用一長串隨機字串（例如 openssl rand -hex 32），不要用容易猜到的值。
# 沒設定的話後台一律回 401（fail-closed），不會變成「沒設就不用驗」。
npx wrangler secret put ADMIN_KEY

# 4. 本機開發（不含 LINE webhook，因為 LINE 需要打得到的公開網址）
npm run dev

# 5. 部署
npm run deploy
```

部署後，把 LINE Developers Console 裡這個 Channel 的 **Webhook URL** 設成：

```
https://<你的-worker-子網域>.workers.dev/webhook/line
```

記得在 Console 打開「Use webhook」，並把「自動回應訊息」關掉（不然使用者會同時
收到 LINE 官方的罐頭回覆和系統的結構化回覆，混在一起）。

## 推上你已建立的 GitHub repo

```bash
git add -A
git commit -m "MVP: LINE 通報 + Care Score 排序 + 志工認領"
git remote add origin <你的 GitHub repo URL>
git branch -M main
git push -u origin main
```

`.github/workflows/ci.yml` 只做 typecheck 和 `wrangler deploy --dry-run`，
不需要在 GitHub 上放任何 Cloudflare API Token 就能跑，也不會真的部署。

## 已知限制（誠實列出，不要在 Demo 被問到才臨場編）

- **claim token 有 72 小時效期，但不限使用次數**：72 小時是對齊 MVP 定義的
  「淹水退水後的生活復原期」。期限內可重複查詢、次數不限；超過 72 小時，
  或案件已被 admin 後台判定為重複並合併關閉，token 都會一併失效。這兩種
  情況跟「token 打錯」一律回傳相同的 403、不區分原因 —— 刻意不讓外部分辨得出
  是「曾經有效但過期了」還是「這筆案件被合併了」，避免洩漏內部狀態。
  即使如此，它做到的仍只是「防止未認領者查看精確地址」，不是一套完整的存取
  控制系統 —— 沒有志工身份驗證，任何人都還是能認領案件來取得 token。
- **重複案件只標記、不合併**：`possible_duplicate_of` 會被寫入，但後台沒有
  「confirm 合併」的介面，目前要手動去 D1 查。
- **Nominatim 有速率限制**（1 req/sec，且需要合理的 User-Agent），示範規模沒問題，
  正式上線規模變大要換付費地理編碼或內政部門牌坐標服務。
- **沒有 rate limiting / 反灌水機制**：目前任何人都可以無限次通報。
- **API 沒有auth**：`/api/cases/:id/claim` 目前任何人都能打，Demo 用沒問題，
  公開對外前需要加上驗證。
- **前端每 15 秒自動刷新清單**，會把使用者剛展開的精確地址畫面收合，需要重新
  點一次「查看精確地址」。
- **AI 對 `need_types` 的分類偶爾不夠準**：例如「搬運家具」被分到 `other` 而不是
  `furniture_moving`。這不影響 Care Score 計算（分數不看 need_types），但會影響
  志工在卡片上看到的需求標籤。之後可以在抽取 prompt 裡幫每個 enum 值補上中文
  範例詞來改善。
- **AI 對極短、模糊的輸入偶爾會用簡體中文回應**：例如只有兩三個字的求救訊息，
  即使系統提示是全繁體撰寫也可能出現。之後可以在抽取的 system prompt 裡加強
  「必須使用繁體中文」的強制要求。
- **案件合併後 `volunteer_claims` 紀錄不會被清理**：案件被判定重複而合併關閉後，
  claim token 已經會立刻失效（見上一條），但 `volunteer_claims` 裡那筆認領紀錄
  本身不會被刪除，也不會被標記成已失效，志工端也不會收到任何通知。這是資料
  整潔問題，不是安全問題 —— 存取權限本身已經收回了。
- **`volunteer_claims` 沒有索引**：目前沒有針對 `case_id` 或 `claim_token_hash`
  建立索引。Demo 規模（數十筆）完全無感，但 `verifyClaimToken` 每次驗證都要
  JOIN `cases` 並比對雜湊值，資料量成長後會退化成全表掃描，屆時應補上索引。
- **公開 API 曾經外洩地址文字（已修）**：早期版本的 `/api/cases` 直接回傳
  `raw_text` 與 `location_text`，等於讓 claim token 的地址保護形同虛設 ——
  token 只保護了經緯度，文字門牌任何人都拿得到，而前端從不顯示這兩個欄位，
  讓它看起來像是有保護的。這個問題是後續做安全稽核時才發現並修掉的，不是
  一開始就設計成現在這樣。
- **LINE 推播失敗只會留在 log 裡，沒有重試、也沒有介面提示**：通知送不出去時
  只會寫進 Workers Logs，系統不會重試，通報者與志工協調者在任何介面上都看不到
  「這則通知沒送達」。如果某位通報者持續收不到通知（最典型的是他封鎖了官方帳號），
  目前只能靠事後翻 log 才會發現。
- **`closed` 案件的地圖標記沒有特別標示**：`full` 與 `completed` 的標記都會轉成
  灰色表示非活躍，但被判定重複而合併關閉的 `closed` 案件，標記仍然是一般的分數色。
  因為 `closed` 案件只會出現在「最新回報」排序、實務上很少被看到，這個不一致
  目前刻意不處理。
- **多輪追問會誤合併兩件不相關的通報**：同一位 LINE 使用者若在 15 分鐘內想通報
  兩件事（例如先報自己家、再報鄰居家），只要第一筆案件仍是 `status='open'`，
  第二則就會被當成第一則的補充而合併在一起 —— **不論第一筆的資訊是否已經完整**。
  由於合併規則是「只填空、不覆蓋」，第二戶的地址與淹水深度會被靜默丟棄。
  這個限制本來就存在，觸發範圍在這一輪稽核後略為擴大：先前只有「待複核」的
  案件會吸收後續訊息，現在所有仍開放的案件都會。這是修掉「案件被切成碎片」
  那個問題的代價 —— 兩者是同一個機制的兩面，只靠「同一人＋時間窗」這組訊號
  無法分辨「補充同一戶」與「通報另一戶」，只能在兩種錯法之間選一種。徹底的
  解法寫在下方「未來方向」的 postback 那一條。
  這跟「重複通報偵測」其實是同一類問題的另一種呈現 —— 根源都是**地址不夠明確**，
  系統無法確信兩段文字講的是不是同一戶。
- **地理編碼精確度的反直覺實測結果**：地址描述得**越精確**（例如完整門牌
  「XX路三段100號」），Nominatim 有時反而因為資料庫涵蓋不到門牌層級，導致同一個
  地址前後兩次查詢解析到**不同座標**、距離超過 150 公尺的重複判定門檻；相對地，
  只寫到區級的粗略地址（例如「台南仁德」）每次都能穩定解析到同一個代表座標。
  這是開發過程中用真實資料測出來的現象，也再次印證「未來方向」裡提到的：應該
  優先支援 LINE 原生的分享位置（GPS），而不是完全依賴文字地址交給 Nominatim。
- **`claimCase` 與 `cancelClaim` 的多條寫入沒有包成單一交易**：兩者內部各自是
  兩條獨立的 D1 語句 —— `claimCase` 先更新 `volunteers_assigned` / `status`、
  再寫入 `volunteer_claims` 紀錄；`cancelClaim` 順序相反，先刪除紀錄、再回補
  計數。這兩句沒有包在同一個交易（transaction）裡。如果 Worker 剛好在兩句
  之間被中止（CPU 逾時、部署版本切換），`volunteers_assigned` 的計數就可能
  與 `volunteer_claims` 的實際筆數對不上，而且系統沒有任何偵測或自我修復
  機制。發生窗口極短（`claimCase` 的兩句之間只隔一次 UUID 產生與 SHA-256
  運算），在目前的展示規模下風險可忽略；正式擴大規模使用前，應該用 D1 的
  `batch()` 把這兩句包成單一原子操作。
- **`volunteers_needed` 的補充永遠會被忽略**：這個欄位在 schema 是
  `NOT NULL DEFAULT 1`，**永遠不可能是 `null`**，而多輪追問的合併規則是「只填空、
  不覆蓋」—— 於是使用者後來補的「需要3位志工協助」一定會被丟棄，案件固定沿用
  建立當下的預設值 1，而且沒有任何提示。連帶兩個後果：這個欄位永遠不會被判定
  為缺漏，所以**對應的 3 顆快速回覆按鈕永遠不會出現在追問訊息裡**（實際送得出去
  的按鈕最多 10 顆，不是 13 顆）；信心分數也因此永遠白送 1/6，一筆「AI 什麼都
  沒抽到」的案件 confidence 是 0.17 而不是 0。徹底解決要嘛調整資料庫欄位限制
  （讓它可為 `null`），要嘛改變「一律不覆蓋」這條單一合併規則 —— 前者牽動
  Care Score 的 `ResourceGap` 計算，後者破壞目前八個欄位共用一條規則的簡潔性，
  兩者都是需要另外討論的設計決定。目前先接受這個限制。
- **AI 輸出的異常數值已在源頭攔截（本輪稽核修復）**：模型回傳的負數、超大值、
  非整數現在會由 `extractFields` 的正規化邏輯轉成缺漏欄位（`null`）或四捨五入
  成整數，不會再原樣流進 D1。修掉的具體症狀包括：負的淹水深度讓 Care Score
  出現負分、把那一戶推到清單最底；志工需求人數為 0 或負數讓案件永遠通不過
  認領的名額檢查、變成留在清單上卻沒人點得動的殭屍案件。空白的 `location_text`
  也一併視為沒填，跟 `geocode()` 的判斷標準對齊。

## 未來方向（不是限制，是刻意的路線圖）

- **快速回覆按鈕改用 postback 帶上案件 ID**：目前按鈕送出的是一句自然語言
  （例如「我年齡80歲以上」），系統只能靠「同一位使用者 ＋ 15 分鐘時間窗」去
  *猜*這則訊息要補進哪一筆案件。改用 LINE 的 postback 機制、在按鈕上明確帶著
  它所屬的 `caseId`，「要補到哪一筆」就從猜測變成明確資訊。這會**同時**根治
  兩個方向的錯誤 —— 案件被切成碎片、以及兩件不相關的通報被誤合併 —— 而不是
  像現在只能在兩者之間取捨。這是「時間窗合併」這個機制本身無法解決的問題，
  必須換掉機制才行，也是上面兩條已知限制真正的解法。
- **精確地址改用 LINE 推播單獨發送**：更貼近實務的做法是志工認領成功後，直接
  透過 LINE 把精確地址推播給該名志工，而不是留在網頁上讓瀏覽器保管。本版先用
  claim token 作為過渡方案，把「公開清單只有模糊座標」這件事先立起來。
- **改用 LINE 分享的 GPS 定位做地理編碼**：目前 webhook 只處理文字訊息，使用者
  若直接用 LINE 原生的「分享位置」功能傳送 GPS 定位會被忽略（`line.ts` 裡非文字
  類型的事件一律 `continue` 跳過）。之後應該讓地理編碼優先採用使用者分享的精確
  GPS，而不是完全依賴文字描述交給 Nominatim 解析 —— 這樣定位準確度會大幅提升，
  使用者也不用自己打出完整地址。

這些都是刻意的範圍取捨，不是疏忽 —— 在簡報第10點被問到「還缺什麼」時，
直接照這份清單回答即可。
