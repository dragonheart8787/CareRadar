# sim/ — Care Score 排序＋額滿導流的模擬實驗

這個目錄是一個**預先註冊**的模擬實驗，比較 CareRadar 的「Care Score 排序＋額滿導流」與
常見的志工自行挑案方式。它是在明確假設下的**機制展示**，不是現實世界有效性的證明。

- 先讀 [`PREREGISTRATION.md`](./PREREGISTRATION.md)：假設、模型、政策、情境、指標、否證條件、
  已知限制，全部在寫任何模擬程式之前 commit（`git log --diff-filter=A -- sim/PREREGISTRATION.md`
  可找到那個 commit）。commit 之後原文不得編輯，只能在結尾新增 `Deviations` 段落。
- 結果在 [`RESULTS.md`](./RESULTS.md)（自動產生）與 `results/`。

## 隔離

- 不修改 `src/`、`wrangler.toml`、`schema.sql`；不新增 devDependency；不在 CI 裡跑；
  `sim/` 不會被打包進 Worker（`wrangler.toml` 的 `main` 是 `src/index.ts`）。
- 評分呼叫的是真實的 `src/care_score.ts` 的 `computeCareScore`（由 esbuild 一起打包），
  沒有重寫公式。只有 S9（權重抖動）會在執行期暫時改寫 `CARE_SCORE_WEIGHTS` 物件的數值，
  每次重複結束後還原；`cap` 與 `floodDepthCapCm` 兩個上限不抖動。
- `esbuild` 來自 `wrangler` 的相依套件（`node_modules/.bin/esbuild`），不是新增的相依。

## 重現

```bash
npm ci            # 若 node_modules 不存在
npm run sim       # 先跑驗證檢查（全過才會繼續），再跑 11 情境 × 9 政策 × 300 次重複
npm run sim -- check                     # 只跑驗證檢查
npm run sim -- --reps 12 --out /tmp/sim  # 小規模試跑；輸出到別處，不會動 sim/RESULTS.md 與 sim/results/
```

- 種子：第 r 次重複用 `20261003 + r`（r = 0…299）；bootstrap 重抽索引用固定種子 `20261003`
  的獨立子流。隨機性只用手寫的 mulberry32，沒有 `Math.random()`。
- 同一組種子在任何機器上都會得到逐位元相同的結果（唯一會變的是 `RESULTS.md` 裡的執行時間那一行）。
- 執行時間：驗證檢查約 5 秒；正式實驗與 bootstrap 合計約 3 分鐘（單執行緒，Node 22；實測 188 秒）。
  實際時間見 `RESULTS.md` 的標頭。

## 驗證檢查（`checks.ts`，每次 `npm run sim` 都會先跑）

黃金測試（README 案例 1 → 36.7，走模擬用的 `makeCaseRow` 包裝層）、同一個種子跑兩次逐位元相同、
權重抖動後還原、ratio 20 且 p = 1 時所有政策服務到所有家戶、志工守恆／認領數／無負的時間、
p = 1 的政策無效認領為 0（並以 p = 0.5 的 `latest` 作正向對照）、政策語意與「看不到尚未通報的案件」
（手工小世界）、`care_score(c=0) ≡ coordinated_nearest` 與 `care_score(c=1) ≡ care_score_full_compliance`。

這些檢查本身也做過突變測試：刻意把額滿判定改成差一、讓政策看到未來案件、讓 care 挑最低分、
讓 random 用 `Math.random()`、讓權重抖動不還原、把無效認領算成有效——每一種都會被檢查抓到。

## 檔案

| 檔案 | 內容 |
|---|---|
| `rng.ts` | mulberry32 與由 (種子, 標籤) 衍生的子流 |
| `model.ts` | 參數、家戶／志工／觀察層的生成、`makeCaseRow`（評分包裝層） |
| `engine.ts` | 9 個政策與模擬主迴圈、權重抖動 |
| `experiment.ts` | 11 個情境、11 個指標、重複迴圈 |
| `stats.ts`, `analysis.ts` | percentile bootstrap（B = 2000）與配對差 |
| `checks.ts` | 驗證檢查 |
| `report.ts`, `main.ts` | CSV、SVG、`RESULTS.md` 的產生與入口 |
| `tsconfig.json`, `node-shims.d.ts` | 讓 `sim/` 能獨立通過 `tsc -p sim/tsconfig.json`（沒有 `@types/node`） |
| `results/summary.csv` | 情境、政策、指標、平均、CI 下限、CI 上限 |
| `results/paired_diffs.csv` | `care_score` 對每個對手的配對差與 CI |
| `results/h6_decomposition.csv` | H6 的效應拆解（含 CI） |
| `results/s1_primary_metric.svg`, `results/paired_diff_vs_latest.svg` | 兩張圖 |

## 閱讀結果時請留意

- 信賴區間只反映模擬的隨機性，不代表真實世界的不確定性。
- 所有行為參數都是假設（見預註冊第 8 節）。特別是：志工「只做一次認領」且認領到額滿案件就浪費掉，
  加上基準政策的 `fill_visibility` 預設 0.5，會讓使用同一個排序的基準（`nearest`、不導流的
  Care Score）產生大量無效認領。`RESULTS.md` 的 H1 與 H6 有把這一點拆開來呈現。

## 探索性敏感度分析：志工遇到額滿案件時重挑（事後加入）

看過正式結果之後才加的、**不是預註冊假設的檢定**的分析；原因、設定與規則記錄在
[`PREREGISTRATION.md`](./PREREGISTRATION.md) 結尾 Deviations 的最後一節（該節的 commit 先於實作）。
結果在 [`SENSITIVITY_RETRY.md`](./SENSITIVITY_RETRY.md) 與 `results/sensitivity_retry.csv`；
不覆蓋 `RESULTS.md`、`results/summary.csv`、`results/paired_diffs.csv`。

```bash
npm run sim:retry                                # 先跑全部檢查與回歸，全過才產生結果（單執行緒約 10 分鐘；實測 625 秒）
npm run sim:retry -- --reps 6 --out /tmp/retry   # 小規模試跑；輸出到別處，不會動 repo 內的檔案
```

- `retry.ts`：重挑版引擎（事件佇列）。**刻意與 `engine.ts` 並存而不是修改它**，所以正式實驗的程式碼
  與結果不受影響；兩者的等價性由「`retry_max = 0` 逐位元相同」保證——單戶層級（11 情境 × 9 政策 × 4 種子）
  與已 commit 的 `results/summary.csv`（4 情境 × 9 政策 × 11 指標）兩種層級的回歸檢查。
- `checks_retry.ts`：新檢查（等價性、志工守恆與時間、p = 1 政策與 `retry_max` 無關、`retry_delay` = 1e6
  時 T 內結果與 `retry_max = 0` 相同、手工小世界的排除／延遲／交錯／作廢、無效認領比例單調不增）。
- 新檢查做過 6 種突變測試，每一種都被抓到：重挑時不排除已撞到的案件、重挑沒有加上延遲、只排除最近一次撞到的案件、
  事件堆的排序顛倒、重挑時沒有可選案件卻算成「找不到案件」、成功認領的抵達時間從第一次嘗試起算。
- `retry_report.ts`、`retry_main.ts`：報告、CSV 與入口。

