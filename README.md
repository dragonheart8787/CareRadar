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
這位使用者 15 分鐘內有待複核的案件嗎？
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
GET  /admin/duplicates?key=…                → 列出疑似重複案件，兩筆並排比對
POST /api/admin/duplicates/:id/resolve      → 確認合併（關閉重複那筆）或標記非重複
     body: { action: "merge" | "not_duplicate", key: "…" }

ADMIN_KEY 未設定、請求沒帶金鑰、或金鑰不符 → 一律 401，不透露頁面內容或金鑰格式。
```

前端是單一 HTML（`src/frontend.ts` 回傳字串），地圖用 Leaflet + OSM 圖磚，
沒有額外的建置流程，方便你在 Demo 現場直接改。

## 精確地址存取控制

`/api/cases` 這個公開清單**只會回傳模糊化後的 `public_lat` / `public_lng`**，
精確座標和地址文字不會出現在任何公開回應裡。要看到精確位置，必須先認領：

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
有 token 的案件卡片才會多出一個「查看精確地址」按鈕。沒認領過、或換了瀏覽器／
清過快取的人，卡片上不會出現這個按鈕，也不會顯示任何提示文字 —— 就是安靜地
不出現，只看得到模糊化座標。

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
`status='open'` 且 `needs_human_verification=1`，就會被視為**補充**、合併進原本
那筆案件，而不是兩則訊息各自建立一筆。合併規則（`supplementCase()`）：

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
- **多輪追問未實作**：AI 抽取失敗或欄位缺漏時，目前只在 LINE 回覆裡提醒
  「已標記待複核」，還沒有真的追問「請問您幾歲？」的多輪對話（需要 Durable
  Objects 或某種 session 儲存）。
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
- **後台金鑰走 query string**：`/admin/duplicates?key=…` 會留在瀏覽器歷史紀錄，
  以及任何中介代理的存取日誌裡。目前僅供內部少量使用，正式對外應改成透過
  header 或 cookie 傳遞。
- **多輪追問會誤合併兩件不相關的通報**：同一位使用者若在 15 分鐘內想通報兩件事
  （例如先報自己家、再報鄰居家），第二則會被當成第一則的補充而合併在一起。
  這跟「重複通報偵測」其實是同一類問題的另一種呈現 —— 根源都是**地址不夠明確**，
  系統無法確信兩段文字講的是不是同一戶。
- **地理編碼精確度的反直覺實測結果**：地址描述得**越精確**（例如完整門牌
  「XX路三段100號」），Nominatim 有時反而因為資料庫涵蓋不到門牌層級，導致同一個
  地址前後兩次查詢解析到**不同座標**、距離超過 150 公尺的重複判定門檻；相對地，
  只寫到區級的粗略地址（例如「台南仁德」）每次都能穩定解析到同一個代表座標。
  這是開發過程中用真實資料測出來的現象，也再次印證「未來方向」裡提到的：應該
  優先支援 LINE 原生的分享位置（GPS），而不是完全依賴文字地址交給 Nominatim。

## 未來方向（不是限制，是刻意的路線圖）

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
