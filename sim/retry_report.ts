import { POLICIES } from "./engine";
import {
  ALL_METRIC_NAMES,
  REPORTED_METRICS,
  RETRY_HIGHER_IS_BETTER,
  type RetryMetricName,
  type RetryResults,
} from "./retry";
import { bootstrapMeanCI, makeBootstrapIndices, pairedDiff, type Interval } from "./stats";

export const RETRY_SCENARIOS = ["S1", "S4", "S6", "S10"] as const;
export const RETRY_VALUES = [0, 1, 5] as const;
export const COMPARATORS_RETRY = ["coordinated_latest", "random", "latest", "nearest"] as const;
/** 第二節補充用：不導流時，Care Score 排序相對 latest／nearest（兩邊都是 p = 基準，會隨 retry_max 而變）。 */
export const ABLATION_PAIRS: [string, string][] = [
  ["care_score_uncoordinated", "latest"],
  ["care_score_uncoordinated", "nearest"],
];

const TITLE: Record<string, string> = {
  S1: "主要",
  S4: "過剩（ratio 2.0）",
  S6: "對照（無偏差、供給充足）",
  S10: "強基準（p = 0.9）",
};

const LABEL: Record<string, string> = {
  median_wait_vulnerable: "弱勢：等待中位數（小時）",
  unserved_frac_vulnerable: "弱勢：T 內未獲志工比例",
  median_wait_nonvulnerable: "非弱勢：等待中位數（小時）【事後新增】",
  unserved_frac_nonvulnerable: "非弱勢：T 內未獲志工比例【事後新增】",
  fully_staffed_frac_all: "全體：T 內人力補滿比例（整體覆蓋率）【事後新增】",
  invalid_claim_frac: "無效認領比例（最終結果基準）",
  mean_commute_min: "平均通勤時間（分鐘）",
};

const isHours = (m: string) => m.startsWith("median_wait") || m === "mean_commute_min";
const fmt = (m: string, x: number) => x.toFixed(isHours(m) ? 2 : 3);
const cell = (m: string, v: Interval) => `${fmt(m, v.mean)} [${fmt(m, v.lo)}, ${fmt(m, v.hi)}]`;

export type Verdict = "win" | "ci_includes_zero" | "baseline_better";
export function verdict(metric: string, d: Interval): Verdict {
  if (RETRY_HIGHER_IS_BETTER[metric]) return d.lo > 0 ? "win" : d.hi < 0 ? "baseline_better" : "ci_includes_zero";
  return d.hi < 0 ? "win" : d.lo > 0 ? "baseline_better" : "ci_includes_zero";
}
const MARK: Record<Verdict, string> = { win: "", ci_includes_zero: "（CI 含 0）", baseline_better: "（**反轉**：對手較好）" };

function table(header: string[], rows: string[][]): string {
  const line = (c: string[]) => `| ${c.join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n");
}

export class RetryAnalysis {
  readonly idx: Int32Array;
  private cache = new Map<string, Interval>();
  constructor(readonly res: RetryResults, readonly R: number) {
    this.idx = makeBootstrapIndices(R);
  }
  vec(sc: string, k: number, pol: string, m: RetryMetricName): Float64Array {
    return this.res[sc][k][pol][m];
  }
  summary(sc: string, k: number, pol: string, m: RetryMetricName): Interval {
    const key = `s|${sc}|${k}|${pol}|${m}`;
    let v = this.cache.get(key);
    if (!v) this.cache.set(key, (v = bootstrapMeanCI(this.vec(sc, k, pol, m), this.idx)));
    return v;
  }
  /** x − y（同一個 retry_max、同一批重複配對）。 */
  diffPair(sc: string, k: number, x: string, y: string, m: RetryMetricName): Interval {
    const key = `d|${sc}|${k}|${x}|${y}|${m}`;
    let v = this.cache.get(key);
    if (!v) this.cache.set(key, (v = bootstrapMeanCI(pairedDiff(this.vec(sc, k, x, m), this.vec(sc, k, y, m)), this.idx)));
    return v;
  }
  /** care_score − 對手。 */
  diff(sc: string, k: number, comp: string, m: RetryMetricName): Interval {
    return this.diffPair(sc, k, "care_score", comp, m);
  }
}

export function buildRetryCsv(a: RetryAnalysis): string {
  const out = ["kind,scenario,retry_max,policy,metric,mean,ci_low,ci_high,care_score_mean,comparator_mean"];
  for (const sc of RETRY_SCENARIOS) {
    for (const k of RETRY_VALUES) {
      for (const pol of POLICIES) {
        for (const m of ALL_METRIC_NAMES) {
          const v = a.summary(sc, k, pol.name, m);
          out.push(["summary", sc, k, pol.name, m, v.mean, v.lo, v.hi, "", ""].join(","));
        }
      }
      for (const comp of COMPARATORS_RETRY) {
        for (const m of ALL_METRIC_NAMES) {
          const d = a.diff(sc, k, comp, m);
          out.push(["paired_diff", sc, k, comp, m, d.mean, d.lo, d.hi, a.summary(sc, k, "care_score", m).mean, a.summary(sc, k, comp, m).mean].join(","));
        }
      }
      for (const [x, y] of ABLATION_PAIRS) {
        for (const m of ALL_METRIC_NAMES) {
          const d = a.diffPair(sc, k, x, y, m);
          out.push(["ablation_diff", sc, k, `${x}_minus_${y}`, m, d.mean, d.lo, d.hi, a.summary(sc, k, x, m).mean, a.summary(sc, k, y, m).mean].join(","));
        }
      }
    }
  }
  return out.join("\n") + "\n";
}

export interface RetryMeta {
  preregSha: string;
  deviationSha: string;
  baseHead: string;
  R: number;
  delayMin: number;
  runtimeSeconds: number;
  nodeVersion: string;
  checksPassed: string;
  regressionLine: string;
}

export function buildRetryMd(a: RetryAnalysis, meta: RetryMeta): string {
  const out: string[] = [];
  const P = (s = "") => out.push(s);
  const pm = "median_wait_vulnerable";
  const um = "unserved_frac_vulnerable";

  P("# 探索性敏感度分析：志工遇到額滿案件時重挑（自動產生，請勿手改）");
  P();
  P("> **探索性、事後加入。** 這個分析是在看過 S1–S11 全部正式結果**之後**才加的，**不是**預註冊假設的檢定，");
  P("> 不改變、也不取代 H1–H6 的任何判定。情境、`retry_max` 取值、`retry_delay` 都是看過結果後選的，");
  P("> 帶有研究者自由度；它只回答一個問題：預註冊的「志工只認領一次、撞到額滿即作廢」這個假設，結論有多依賴它。");
  P("> 所有行為參數（含 `retry_delay` 與重挑行為本身）都是假設。信賴區間只反映模擬的隨機性。");
  P();
  P(`- **預註冊文件 commit**：\`${meta.preregSha.slice(0, 7)}\`（完整：\`${meta.preregSha}\`）`);
  P(`- **Deviations 追加（事後加入此分析）的 commit**：\`${meta.deviationSha.slice(0, 7)}\`（完整：\`${meta.deviationSha}\`）——先於實作 commit`);
  P(`- 產生結果時的 HEAD（程式碼與本結果在其後的 commit 提交，所以這裡是它的父 commit）：\`${meta.baseHead.slice(0, 7)}\`；Node ${meta.nodeVersion}`);
  P(`- 設定：情境 S1、S4、S6、S10；全部 9 個政策；\`retry_max\` ∈ {0, 1, 5}；\`retry_delay\` = ${meta.delayMin} 分鐘（假設）；R = ${meta.R}；種子 20261003 … ${20261003 + meta.R - 1}（與正式實驗相同，配對）；bootstrap B = 2000，重抽索引與正式分析相同。`);
  P(`- 驗證：${meta.checksPassed}`);
  P(`- 回歸：${meta.regressionLine}`);
  P(`- 實際執行時間（含檢查、回歸與 bootstrap）：${meta.runtimeSeconds.toFixed(1)} 秒`);
  P();
  P("**事後新增的指標**（看過正式結果之後才決定要報告）：非弱勢家戶的等待時間中位數與 T 內未獲志工比例；全體家戶 T 內人力補滿的比例（整體覆蓋率）。");
  P("**「無效認領比例」在本分析改用「最終結果」基準**：作廢的志工數 /（成功認領 + 作廢）；`retry_max = 0` 時與正式分析定義相同。");
  P();
  P("**重挑的設定（對所有政策一視同仁）**：志工認領到額滿案件（409）後，最多再重挑 `retry_max` 次；每次重挑多花 `retry_delay`；");
  P("重挑時以該政策自己的規則重新選案（包含 `fill_visibility` p 的新一次抽樣、`care_score` 的遵從抽籤重抽）；");
  P("已經撞過的每一戶都不會重選；重挑耗盡或已沒有可選案件則該志工的認領作廢。p = 1 的政策從不撞到額滿案件，所以不受 `retry_max` 影響。");
  P();
  P("> 差 = `care_score` − 對手；弱勢等待時間單位為小時，負值 = `care_score` 較快。比例為 0–1。");
  P();

  // ---- 一 ----
  P("## 一、結論對重挑假設的依賴程度");
  P();
  P("### 1.1 `care_score` 對各基準的弱勢等待中位數配對差（小時，平均 [95% CI]）");
  P();
  const rows1: string[][] = [];
  for (const sc of RETRY_SCENARIOS) {
    for (const comp of COMPARATORS_RETRY) {
      rows1.push([
        `${sc} ${TITLE[sc]}`,
        comp,
        ...RETRY_VALUES.map((k) => {
          const d = a.diff(sc, k, comp, pm);
          return `${cell(pm, d)}${MARK[verdict(pm, d)]}`;
        }),
      ]);
    }
  }
  P(table(["情境", "對手", "retry_max = 0", "retry_max = 1", "retry_max = 5"], rows1));
  P();

  const listNonWins = (m: RetryMetricName, label: string) => {
    P(`**retry_max = 5 時，${label} 的配對差 CI 含 0 或反轉的比較：**`);
    P();
    const items: string[] = [];
    for (const sc of RETRY_SCENARIOS) {
      for (const comp of COMPARATORS_RETRY) {
        const d = a.diff(sc, 5, comp, m);
        const v = verdict(m, d);
        if (v !== "win") items.push(`- ${sc}，對 ${comp}：${cell(m, d)} → ${v === "baseline_better" ? "**反轉（對手較好）**" : "CI 含 0"}`);
      }
    }
    P(items.length ? items.join("\n") : "（無：16 個比較的 CI 都完整落在有利側）");
    P();
  };
  listNonWins(pm, "弱勢等待中位數");
  listNonWins(um, "弱勢 T 內未獲志工比例");

  // 與 retry_max=0 比較，優勢縮了多少。
  P("### 1.2 優勢隨 `retry_max` 的變化（`care_score` 對 latest／nearest，弱勢等待中位數；基準 − `care_score`，小時）");
  P();
  P(table(["情境", "對手", "retry 0", "retry 1", "retry 5", "retry 5 相對 retry 0 保留的比例"], RETRY_SCENARIOS.flatMap((sc) =>
    (["latest", "nearest"] as const).map((comp) => {
      const adv = RETRY_VALUES.map((k) => -a.diff(sc, k, comp, pm).mean);
      return [`${sc}`, comp, ...adv.map((x) => x.toFixed(2)), adv[0] > 0 ? `${((adv[2] / adv[0]) * 100).toFixed(0)}%` : "—"];
    })
  )));
  P();
  P("### 1.3 機制：無效認領比例（最終結果基準）與重挑的關係（S1，平均 [95% CI]）");
  P();
  P(table(["政策", "retry 0", "retry 1", "retry 5"], POLICIES.map((p) => [p.name, ...RETRY_VALUES.map((k) => cell("invalid_claim_frac", a.summary("S1", k, p.name, "invalid_claim_frac")))])));
  P();
  const h1p = (k: number) => {
    const l = a.diff("S1", k, "latest", pm);
    const n = a.diff("S1", k, "nearest", pm);
    return `對 latest ${cell(pm, l)}、對 nearest ${cell(pm, n)} → ${l.hi < 0 && n.hi < 0 ? "兩者 CI 都整段在負側" : "至少一個 CI 含 0 或偏向基準"}`;
  };
  P("**把預註冊 H1 的判準（僅供對照，不是對 H1 的重新檢定）套用到 S1：**");
  P();
  P(`- retry_max = 0：${h1p(0)}`);
  P(`- retry_max = 1：${h1p(1)}`);
  P(`- retry_max = 5：${h1p(5)}`);
  P();

  // ---- 二 ----
  P("## 二、Care Score 排序本身的貢獻");
  P();
  P("### 2.1 `care_score` 對 `coordinated_latest`（兩者額滿資訊都完全準確，p = 1）");
  P();
  P("兩者都從不撞到額滿案件，所以它們的結果**與 `retry_max` 無關**——下表三列相同是構造上的結果（驗證檢查已確認 p = 1 的政策在");
  P("`retry_max` 0、1、5 之間逐位元相同），不是巧合。這代表「雙方都有完整額滿資訊時，Care Score 排序本身的貢獻」不依賴重挑假設；");
  P("會隨重挑而變的是 2.2（不導流的世界）。");
  P();
  for (const sc of RETRY_SCENARIOS) {
    P(`**${sc} ${TITLE[sc]}**`);
    P();
    const cols: RetryMetricName[] = ["unserved_frac_vulnerable", "median_wait_vulnerable", "median_wait_nonvulnerable", "unserved_frac_nonvulnerable", "fully_staffed_frac_all"];
    P(table(["retry_max", ...cols.map((m) => `Δ ${LABEL[m]}`)], RETRY_VALUES.map((k) => [String(k), ...cols.map((m) => {
      const d = a.diff(sc, k, "coordinated_latest", m);
      return `${cell(m, d)}${MARK[verdict(m, d)]}`;
    })])));
    P();
  }
  P("（Δ = `care_score` − `coordinated_latest`。非弱勢家戶的等待與未獲志工比例為**正值**代表非弱勢家戶付出的代價；全體覆蓋率為負值代表 `care_score` 覆蓋較少。）");
  P();
  P("### 2.2 不導流時（p 為基準值）Care Score 排序相對 latest／nearest 的差，隨 `retry_max` 的變化");
  P();
  P("`care_score_uncoordinated` 依 Care Score 排序、p 為基準值、c = 1；與 `latest`／`nearest` 的差別只在排序規則。這兩邊都會撞到額滿案件，所以會隨重挑而變。");
  P();
  for (const [x, y] of ABLATION_PAIRS) {
    P(`**${x} − ${y}**`);
    P();
    const cols: RetryMetricName[] = ["unserved_frac_vulnerable", "median_wait_vulnerable", "median_wait_nonvulnerable", "unserved_frac_nonvulnerable", "fully_staffed_frac_all"];
    P(table(["情境", "retry_max", ...cols.map((m) => `Δ ${LABEL[m]}`)], RETRY_SCENARIOS.flatMap((sc) => RETRY_VALUES.map((k) => [sc, String(k), ...cols.map((m) => {
      const d = a.diffPair(sc, k, x, y, m);
      return `${cell(m, d)}${MARK[verdict(m, d)]}`;
    })]))));
    P();
  }

  // ---- 三 ----
  P("## 三、S10（基準 p = 0.9）單獨列表");
  P();
  P("`care_score` 對各對手的配對差（平均 [95% CI]）：");
  P();
  const dm: RetryMetricName[] = ["median_wait_vulnerable", "unserved_frac_vulnerable", "median_wait_nonvulnerable", "unserved_frac_nonvulnerable", "fully_staffed_frac_all"];
  for (const k of RETRY_VALUES) {
    P(`**retry_max = ${k}**`);
    P();
    P(table(["對手", ...dm.map((m) => LABEL[m])], COMPARATORS_RETRY.map((comp) => [comp, ...dm.map((m) => {
      const d = a.diff("S10", k, comp, m);
      return `${cell(m, d)}${MARK[verdict(m, d)]}`;
    })])));
    P();
  }
  P("各政策的原始值（S10，平均 [95% CI]）：");
  P();
  for (const k of RETRY_VALUES) {
    P(`**retry_max = ${k}**`);
    P();
    P(table(["政策", ...REPORTED_METRICS.map((m) => LABEL[m])], POLICIES.map((p) => [p.name, ...REPORTED_METRICS.map((m) => cell(m, a.summary("S10", k, p.name, m)))])));
    P();
  }

  // ---- 四 附錄 ----
  P("## 四、附錄：S1、S4、S6 各政策的完整結果（平均 [95% CI]）");
  P();
  for (const sc of ["S1", "S4", "S6"]) {
    for (const k of RETRY_VALUES) {
      P(`### ${sc} ${TITLE[sc]}，retry_max = ${k}`);
      P();
      P(table(["政策", ...REPORTED_METRICS.map((m) => LABEL[m])], POLICIES.map((p) => [p.name, ...REPORTED_METRICS.map((m) => cell(m, a.summary(sc, k, p.name, m)))])));
      P();
    }
  }

  // ---- 五 限制 ----
  P("## 五、這個分析的限制");
  P();
  P("1. **`retry_delay`（5 分鐘）與重挑行為本身都是假設**，沒有實證依據。真實的志工可能撞到 409 就放棄、可能刷新清單後看到的是完整的最新狀態（等於 p 提高）、也可能延遲遠大於 5 分鐘。本分析沒有掃描 `retry_delay`，也沒有讓重挑時的 p 與第一次不同。");
  P("2. **參數是看過結果後選的**（情境、`retry_max` 取值、`retry_delay`），這是研究者自由度；不能把本分析當成比正式分析更準確的版本。");
  P("3. **只涵蓋 S1、S4、S6、S10**，沒有在其他 7 個情境重做；`retry_max = 5` 也不代表真實世界的上限。");
  P("4. **p = 1 的政策不受重挑影響**（從不撞到額滿案件），所以所有「優勢縮小」都來自基準端；`care_score` 本身沒有變。");
  P("5. **重挑沿用預註冊的所有其他假設**（只做一次「認領流程」、不含志工放棄、不含道路阻隔、通報時間與能見度的行為假設等），預註冊第 8 節的限制全部仍然適用。");
  P("6. **新增的 3 個指標與「最終結果基準」的無效認領比例是事後加入的**；它們沒有預先寫下的方向性預期。");
  P("7. 這是描述性的敏感度分析：比較數量多，不做顯著性宣稱；信賴區間只反映模擬的隨機性。結果只說明機制，不外推到真實災害，也不是「系統有效」的證明。");
  return out.join("\n") + "\n";
}
