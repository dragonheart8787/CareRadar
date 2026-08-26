# 災後需求雷達｜關懷優先排序 × 志工智慧媒合（Demo）

競賽 MVP：用 LINE Bot 自然語言通報 → AI 結構化 → 可解釋的 Care Score 排序，
取代「最新／最近」式的志工媒合，並在名額額滿時自動把志工導向其他仍缺人的案件。

單一 Cloudflare Worker，沒有任何需要另外付費申請的 API 金鑰：
NLU 用 **Cloudflare Workers AI**（Qwen3，跟著你的 Cloudflare 帳號走，
每天 10,000 Neurons 免費額度），地理編碼用 **OpenStreetMap Nominatim**（免金鑰、
有使用限制）。你只需要自己已有的 LINE Developers Channel 憑證。

## 架構

```
LINE 使用者傳文字
   │  POST /webhook/line  (HMAC-SHA256 簽章驗證)
   ▼
Workers AI (Qwen3, JSON Schema 結構化抽取)  ──► 只填「文字裡明確提到」的欄位，
   │                                              不確定一律 null，不腦補
   ▼
Nominatim 地理編碼 → 座標模糊化 (fuzzLocation, ~300m 網格)
   │
   ▼
D1 (SQLite)：cases / case_status_history / volunteer_claims
   │
   ├─ 重複通報偵測（150m + 24hr 內，只標記不自動合併）
   ├─ Confidence Score（規則式：關鍵欄位填了幾個，不採信模型自報）
   └─ Care Score（規則式加權，見下方公式，跟 Confidence 完全獨立）
   ▼
GET /api/cases?sort=care_score   → 志工看到的排序清單 + 地圖（只有 public_* 模糊化座標）
POST /api/cases/:id/claim        → 原子性認領，名額滿自動 status='full' 並從清單消失
                                   回應帶一組一次性 claim token
GET /api/cases/:id/address?token=… → 憑 claim token 換精確地址（exact_* + location_text）
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
UnknownBonus  = 若「年齡/獨居/行動能力」三個核心欄位全部缺漏 → +10

Total = Vulnerability×0.4 + Severity×0.3 + Urgency×0.2 + ResourceGap×0.1 + UnknownBonus
```

帶入原題情境算一次：76歲（落在65-79級距）、獨居、淹水60cm、缺水、通報10小時、0志工/需2人：
`V = 20(65-79) + 25(獨居) = 45 → ×0.4 = 18.0`
`S = min(60,150)×0.4 + 15(缺水) = 39 → ×0.3 = 11.7`
`U = min(10×3, 60) = 30 → ×0.2 = 6.0`
`R = min((2-0)×5, 20) = 10 → ×0.1 = 1.0`
`Total = 18.0+11.7+6.0+1.0 = 36.7`

這組數字已經用 `src/care_score.ts` 實際跑過驗證（見下方測試），跟 seed 資料裡的
案件1一致。同一個情境下，案件2「已額滿的年輕家庭」（20分鐘前發文、志工2/2已滿）
只有 2.6 分且會被過濾出清單；案件5「很新但輕微」（5分鐘前發文）只有 1.7 分 ——
這兩個案件在「最新回報」排序都會排到案件1前面，這正是要在 Demo 裡對比給評審看的重點。

**Confidence Score 不會出現在上面任何一項** —— 它只決定
`needs_human_verification`，永遠不拿去乘進 Total。這是對「無法拍照定位的長輩」
的明確承諾，Demo 時建議直接打開 `src/care_score.ts` 給評審看這一行的注解。

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

- **claim token 沒有過期機制，也不限制使用次數**：一旦認領過就永久有效，
  次數不限。它目前只做到「防止未認領者查看精確地址」，不是一套完整的存取
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
