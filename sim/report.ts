import { ABLATIONS, Analysis, BASELINES, COMPARATORS, verdictOf, type Verdict } from "./analysis";
import { POLICIES } from "./engine";
import { METRICS, SCENARIOS, type MetricName } from "./experiment";
import type { Interval } from "./stats";

export interface Meta {
  preregSha: string;
  preregIntegrity: string;
  deviations: string;
  baseHead: string;
  R: number;
  runtimeSeconds: number;
  nodeVersion: string;
}

const LABEL: Record<MetricName, string> = {
  median_wait_vulnerable: "弱勢：等待中位數（小時）",
  unserved_frac_vulnerable: "弱勢：T 內未獲志工比例",
  fully_staffed_frac_vulnerable: "弱勢：T 內人力補滿比例",
  wait_gap_vulnerable: "弱勢減非弱勢：等待中位數差（小時）",
  median_wait_severe: "severe：等待中位數（小時）",
  unserved_frac_severe: "severe：T 內未獲志工比例",
  fully_staffed_frac_severe: "severe：T 內人力補滿比例",
  wait_gap_severe: "severe 減其餘：等待中位數差（小時）",
  invalid_claim_frac: "無效認領比例",
  gini: "每戶志工數 Gini（描述性）",
  mean_commute_min: "平均通勤時間（分鐘）",
};

const isHours = (m: MetricName) => m.startsWith("median_wait") || m.startsWith("wait_gap") || m === "mean_commute_min";
const fmt = (m: MetricName, x: number) => x.toFixed(isHours(m) ? 2 : 3);
const cell = (m: MetricName, v: Interval) => `${fmt(m, v.mean)} [${fmt(m, v.lo)}, ${fmt(m, v.hi)}]`;
const h2 = (x: number, d = 2) => x.toFixed(d);
const hrs = (v: Interval) => `${h2(v.mean)} [${h2(v.lo)}, ${h2(v.hi)}]`;

function table(header: string[], rows: string[][]): string {
  const line = (cols: string[]) => `| ${cols.join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n");
}

const VERDICT_TEXT: Record<Verdict, string> = {
  win: "CI 完全在有利側",
  ci_includes_zero: "CI 包含 0",
  baseline_better: "基準較好",
};

export function buildCsvs(a: Analysis): { summary: string; paired: string; h6: string } {
  const sum = ["scenario,policy,metric,mean,ci_low,ci_high"];
  const paired = ["scenario,comparator,metric,care_score_mean,comparator_mean,mean_diff,ci_low,ci_high,verdict"];
  for (const sc of SCENARIOS) {
    for (const pol of POLICIES) {
      for (const m of METRICS) {
        const v = a.summary(sc.id, pol.name, m);
        sum.push([sc.id, pol.name, m, v.mean, v.lo, v.hi].join(","));
      }
    }
    for (const comp of COMPARATORS) {
      for (const m of METRICS) {
        const d = a.diff(sc.id, "care_score", comp, m);
        paired.push(
          [sc.id, comp, m, a.summary(sc.id, "care_score", m).mean, a.summary(sc.id, comp, m).mean, d.mean, d.lo, d.hi, verdictOf(m, d)].join(",")
        );
      }
    }
  }
  const h6 = ["scenario,metric,term,mean,ci_low,ci_high"];
  for (const sc of SCENARIOS) {
    for (const m of ["median_wait_vulnerable", "unserved_frac_vulnerable"] as const) {
      for (const t of h6Terms()) {
        const v = a.combo(sc.id, m, t.terms);
        h6.push([sc.id, m, `"${t.long}"`, v.mean, v.lo, v.hi].join(","));
      }
    }
  }
  return { summary: sum.join("\n") + "\n", paired: paired.join("\n") + "\n", h6: h6.join("\n") + "\n" };
}

/** H6 的效應拆解（每項都是政策指標的線性組合；負值 = 該項讓指標變小）。 */
interface H6Term {
  short: string;
  long: string;
  terms: [string, number][];
}
function h6Terms(): H6Term[] {
  return [
    { short: "導流（latest）", long: "額滿導流效應（latest 排序）= coordinated_latest − latest", terms: [["coordinated_latest", 1], ["latest", -1]] },
    { short: "導流（nearest）", long: "額滿導流效應（nearest 排序）= coordinated_nearest − nearest", terms: [["coordinated_nearest", 1], ["nearest", -1]] },
    { short: "導流（Care Score）", long: "額滿導流效應（Care Score 排序）= care_score_full_compliance − care_score_uncoordinated", terms: [["care_score_full_compliance", 1], ["care_score_uncoordinated", -1]] },
    { short: "排序（p 基準，對 latest）", long: "排序效應（p 為基準值，相對 latest）= care_score_uncoordinated − latest", terms: [["care_score_uncoordinated", 1], ["latest", -1]] },
    { short: "排序（p 基準，對 nearest）", long: "排序效應（p 為基準值，相對 nearest）= care_score_uncoordinated − nearest", terms: [["care_score_uncoordinated", 1], ["nearest", -1]] },
    { short: "排序（p=1，對 coord_latest）", long: "排序效應（p = 1，相對 coordinated_latest）= care_score_full_compliance − coordinated_latest", terms: [["care_score_full_compliance", 1], ["coordinated_latest", -1]] },
    { short: "排序（p=1，對 coord_nearest）", long: "排序效應（p = 1，相對 coordinated_nearest）= care_score_full_compliance − coordinated_nearest", terms: [["care_score_full_compliance", 1], ["coordinated_nearest", -1]] },
    { short: "合計（對 latest）", long: "兩者合計（相對 latest）= care_score_full_compliance − latest", terms: [["care_score_full_compliance", 1], ["latest", -1]] },
    { short: "交互（對 latest）", long: "交互作用（相對 latest）= 合計 − 導流效應 − 排序效應", terms: [["care_score_full_compliance", 1], ["coordinated_latest", -1], ["care_score_uncoordinated", -1], ["latest", 1]] },
    { short: "合計（對 nearest）", long: "兩者合計（相對 nearest）= care_score_full_compliance − nearest", terms: [["care_score_full_compliance", 1], ["nearest", -1]] },
    { short: "交互（對 nearest）", long: "交互作用（相對 nearest）= 合計 − 導流效應 − 排序效應", terms: [["care_score_full_compliance", 1], ["coordinated_nearest", -1], ["care_score_uncoordinated", -1], ["nearest", 1]] },
    { short: "遵從率 0.7 的代價", long: "遵從率 0.7 的代價 = care_score − care_score_full_compliance", terms: [["care_score", 1], ["care_score_full_compliance", -1]] },
  ];
}

export function buildResultsMd(a: Analysis, meta: Meta): string {
  const out: string[] = [];
  const P = (s = "") => out.push(s);
  const baselineRows = SCENARIOS.flatMap((sc) =>
    BASELINES.flatMap((b) =>
      METRICS.map((m) => {
        const d = a.diff(sc.id, "care_score", b, m);
        return { sc, b, m, d, v: verdictOf(m, d) };
      })
    )
  );
  const nonWins = baselineRows.filter((r) => r.v !== "win");
  const wins = baselineRows.filter((r) => r.v === "win");

  P("# 模擬結果（自動產生，請勿手改）");
  P();
  P(`- **預註冊文件 commit**：\`${meta.preregSha.slice(0, 7)}\`（完整：\`${meta.preregSha}\`）`);
  P(`- 預註冊原文完整性檢查：${meta.preregIntegrity}`);
  P(`- 產生結果時的 HEAD（程式碼與本結果在其後的同一個 commit 提交，所以這裡是它的父 commit）：\`${meta.baseHead.slice(0, 7)}\`；重複次數 R = ${meta.R}；種子 20261003 … ${20261003 + meta.R - 1}；Node ${meta.nodeVersion}`);
  P(`- 實際執行時間（含檢查與 bootstrap）：${meta.runtimeSeconds.toFixed(1)} 秒（結果可由種子逐位元重現；只有這一行會隨機器而變）`);
  P();
  P("> **性質聲明**：這是在明確假設下的機制展示，不是現實世界有效性的證明。所有行為參數");
  P("> （通報延遲、能見度、遵從率、集散點出發……）都是假設；信賴區間只反映模擬的隨機性，");
  P("> 不代表真實世界的不確定性。下文只描述數據，不作「系統有效」的宣稱。");
  P();
  P("> 數字約定：差 = `care_score` − 對手。等待時間、通勤的單位已標示；比例為 0–1。");
  P("> 「有利側」：等待、未服務、無效認領、通勤、Gini 越低越有利；人力補滿比例越高越有利。");
  P("> 通勤時間與 Gini 的「有利」方向只是形式上的標示，不是好壞判斷。");
  P();

  // ---- 沒有贏的地方 ----
  P("## 一、CareRadar 沒有贏的地方");
  P();
  P(`比較對象：4 個基準（latest、nearest、attention、random）× 11 個情境 × 11 個指標 = ${baselineRows.length} 個比較。`);
  P(`**沒有贏**（CI 包含 0，或偏向基準）：**${nonWins.length}** 個；CI 完全落在有利側：${wins.length} 個。`);
  P(`其中 CI 包含 0：${nonWins.filter((r) => r.v === "ci_includes_zero").length} 個；基準明確較好：${nonWins.filter((r) => r.v === "baseline_better").length} 個。`);
  P();
  P("各情境 × 基準的計分（贏 / CI 含 0 / 基準較好，11 個指標）：");
  P();
  P(
    table(
      ["情境", ...BASELINES],
      SCENARIOS.map((sc) => [
        `${sc.id} ${sc.title}`,
        ...BASELINES.map((b) => {
          const rs = baselineRows.filter((r) => r.sc.id === sc.id && r.b === b);
          return `${rs.filter((r) => r.v === "win").length} / ${rs.filter((r) => r.v === "ci_includes_zero").length} / ${rs.filter((r) => r.v === "baseline_better").length}`;
        }),
      ])
    )
  );
  P();
  for (const sc of SCENARIOS) {
    const rs = nonWins.filter((r) => r.sc.id === sc.id);
    P(`### ${sc.id} ${sc.title}（${sc.diff}）：${rs.length} 個沒有贏`);
    P();
    if (rs.length === 0) {
      P("（無）");
    } else {
      P(
        table(
          ["對手", "指標", "care_score 平均", "對手平均", "差 [95% CI]", "判定"],
          rs.map((r) => [
            r.b,
            LABEL[r.m],
            fmt(r.m, a.summary(r.sc.id, "care_score", r.m).mean),
            fmt(r.m, a.summary(r.sc.id, r.b, r.m).mean),
            cell(r.m, r.d),
            VERDICT_TEXT[r.v],
          ])
        )
      );
    }
    P();
  }

  // ---- 贏的地方 ----
  P("## 二、CareRadar 贏的地方（CI 完全落在有利側；描述性）");
  P();
  P("「贏」只代表在這組假設下，該指標的配對差 CI 不含 0 且方向有利。比較數量很多，不做顯著性宣稱。");
  P();
  for (const sc of SCENARIOS) {
    const n = wins.filter((r) => r.sc.id === sc.id).length;
    P(`### ${sc.id} ${sc.title}：${n} 個`);
    P();
    P("格內為「差 [95% CI]」（care_score − 對手）；「—」表示該比較沒有贏（見第一節）。");
    P();
    P(
      table(
        ["指標", ...BASELINES.map((b) => `對 ${b}`)],
        METRICS.map((m) => [
          LABEL[m],
          ...BASELINES.map((b) => {
            const d = a.diff(sc.id, "care_score", b, m);
            return verdictOf(m, d) === "win" ? cell(m, d) : "—";
          }),
        ])
      )
    );
    P();
  }

  // ---- 各情境結果表 ----
  P(`## 三、各情境結果表（平均 [95% CI]，${meta.R} 次重複）`);
  P();
  const A: MetricName[] = ["median_wait_vulnerable", "unserved_frac_vulnerable", "fully_staffed_frac_vulnerable", "wait_gap_vulnerable", "invalid_claim_frac", "gini", "mean_commute_min"];
  const B: MetricName[] = ["median_wait_severe", "unserved_frac_severe", "fully_staffed_frac_severe", "wait_gap_severe"];
  for (const sc of SCENARIOS) {
    P(`### ${sc.id} ${sc.title}`);
    P();
    P(`設定：${sc.diff}`);
    P();
    P("**弱勢子群與全體指標**");
    P();
    P(table(["政策", ...A.map((m) => LABEL[m])], POLICIES.map((p) => [p.name, ...A.map((m) => cell(m, a.summary(sc.id, p.name, m)))])));
    P();
    P("**severe 子群**");
    P();
    P(table(["政策", ...B.map((m) => LABEL[m])], POLICIES.map((p) => [p.name, ...B.map((m) => cell(m, a.summary(sc.id, p.name, m)))])));
    P();
  }

  // ---- H1–H6 ----
  const pm: MetricName = "median_wait_vulnerable";
  P("## 四、H1–H6 逐項結論（依預註冊的否證條件機械判定；只描述數據）");
  P();

  const dL = a.diff("S1", "care_score", "latest", pm);
  const dN = a.diff("S1", "care_score", "nearest", pm);
  const h1 = dL.hi < 0 && dN.hi < 0;
  P("### H1（主要，驗證性）：S1 弱勢家戶等待時間");
  P();
  P(`- 對 latest：care_score ${h2(a.summary("S1", "care_score", pm).mean)} 小時 vs latest ${h2(a.summary("S1", "latest", pm).mean)} 小時；差 ${hrs(dL)} 小時 → ${VERDICT_TEXT[verdictOf(pm, dL)]}`);
  P(`- 對 nearest：nearest ${h2(a.summary("S1", "nearest", pm).mean)} 小時；差 ${hrs(dN)} 小時 → ${VERDICT_TEXT[verdictOf(pm, dN)]}`);
  P(`- **判定：H1 ${h1 ? "成立（兩個比較的 CI 都整段落在 0 的負側）" : "不成立（至少一個比較的 CI 包含 0 或偏向基準）"}**`);
  P();
  P("**判讀提醒（描述性，來自同一批數據）**：H1 的比較對象 `latest`、`nearest` 都是 `fill_visibility` p = 0.5 的基準，且志工「只做一次認領」、");
  P("認領到額滿案件就浪費掉（預註冊第 8 節限制 4）。下表把同樣的基準改成「額滿狀態完全準確」（p = 1），看優勢還剩多少：");
  P();
  P(table(["care_score 相對…", "弱勢等待中位數差（小時）[CI]", "弱勢 T 內未獲志工比例差 [CI]"], [
    ["latest（p = 0.5）", hrs(dL), cell("unserved_frac_vulnerable", a.diff("S1", "care_score", "latest", "unserved_frac_vulnerable"))],
    ["coordinated_latest（p = 1）", hrs(a.diff("S1", "care_score", "coordinated_latest", pm)), cell("unserved_frac_vulnerable", a.diff("S1", "care_score", "coordinated_latest", "unserved_frac_vulnerable"))],
    ["nearest（p = 0.5）", hrs(dN), cell("unserved_frac_vulnerable", a.diff("S1", "care_score", "nearest", "unserved_frac_vulnerable"))],
    ["coordinated_nearest（p = 1）", hrs(a.diff("S1", "care_score", "coordinated_nearest", pm)), cell("unserved_frac_vulnerable", a.diff("S1", "care_score", "coordinated_nearest", "unserved_frac_vulnerable"))],
  ]));
  P();
  P(`S1 各基準的無效認領比例：latest ${fmt("invalid_claim_frac", a.summary("S1", "latest", "invalid_claim_frac").mean)}、nearest ${fmt("invalid_claim_frac", a.summary("S1", "nearest", "invalid_claim_frac").mean)}、attention ${fmt("invalid_claim_frac", a.summary("S1", "attention", "invalid_claim_frac").mean)}、random ${fmt("invalid_claim_frac", a.summary("S1", "random", "invalid_claim_frac").mean)}。`);
  P();

  P("### H2：無效認領比例（機制使然，非新發現）");
  P();
  P(table(["情境", "care_score", ...BASELINES.map((b) => `${b}`)], SCENARIOS.map((sc) => [`${sc.id}`, fmt("invalid_claim_frac", a.summary(sc.id, "care_score", "invalid_claim_frac").mean), ...BASELINES.map((b) => fmt("invalid_claim_frac", a.summary(sc.id, b, "invalid_claim_frac").mean))])));
  P();
  P(`S1 配對差（care_score − 基準）：` + BASELINES.map((b) => `${b} ${cell("invalid_claim_frac", a.diff("S1", "care_score", b, "invalid_claim_frac"))}`).join("；"));
  P();
  P("care_score 的認領經過資料庫的原子條件與完整的額滿資訊，無效認領為 0 是構造上的結果；基準的無效認領則完全由假設的 `fill_visibility` 決定。");
  P();

  P("### H3：弱勢與非弱勢的等待差距（S1，有號：弱勢 − 非弱勢）");
  P();
  const gapRows = ["care_score", ...BASELINES].map((p) => [p, cell("wait_gap_vulnerable", a.summary("S1", p, "wait_gap_vulnerable")), h2(Math.abs(a.summary("S1", p, "wait_gap_vulnerable").mean))]);
  P(table(["政策", "gap 平均 [CI]（小時）", "|gap|（小時）"], gapRows));
  P();
  const g = BASELINES.map((b) => ({ b, d: a.diff("S1", "care_score", b, "wait_gap_vulnerable") }));
  const cg = a.summary("S1", "care_score", "wait_gap_vulnerable").mean;
  for (const { b, d } of g) {
    const bg = a.summary("S1", b, "wait_gap_vulnerable").mean;
    let kind: string;
    if (bg > 0 && cg < 0) kind = "差距反轉：基準的弱勢家戶等得比其餘家戶久，care_score 下相反";
    else if (bg <= 0 && Math.abs(cg) > Math.abs(bg)) kind = "同方向但絕對差距**更大**：弱勢家戶本來就等得較短，care_score 下短得更多（不是「差距縮小」）";
    else if (Math.abs(cg) < Math.abs(bg)) kind = "絕對差距較小";
    else kind = "絕對差距相近";
    P(`- 對 ${b}：有號配對差 ${hrs(d)} 小時 → ${VERDICT_TEXT[verdictOf("wait_gap_vulnerable", d)]}；|gap| ${h2(Math.abs(cg))} vs ${h2(Math.abs(bg))}（${kind}）`);
  }
  const h3all = g.every(({ d }) => d.hi < 0);
  const shrink = BASELINES.filter((b) => Math.abs(cg) < Math.abs(a.summary("S1", b, "wait_gap_vulnerable").mean));
  P(`- **判定（預註冊的有號判準）：H3 ${h3all ? "對 4 個基準皆成立" : "並非對 4 個基準皆成立（見上列各項）"}**`);
  P(`- 以絕對值衡量，care_score 的差距比較小的基準：${shrink.length ? shrink.join("、") : "（無）"}。有號判準成立不代表「差距縮小」：它反映的是弱勢家戶被排得更前面。`);
  P(`- 注意：未被服務者的等待時間是右設限（T − 通報時間），晚通報者的設限值較短，會影響各政策的 gap；描述性判讀時需留意。`);
  P();

  P("### H4（成本）：平均通勤時間");
  P();
  P(table(["情境", "care_score − nearest（分鐘）[CI]", "care_score（分鐘）", "nearest（分鐘）"], SCENARIOS.map((sc) => [sc.id, cell("mean_commute_min", a.diff(sc.id, "care_score", "nearest", "mean_commute_min")), fmt("mean_commute_min", a.summary(sc.id, "care_score", "mean_commute_min").mean), fmt("mean_commute_min", a.summary(sc.id, "nearest", "mean_commute_min").mean)])));
  P();
  const c1 = a.diff("S1", "care_score", "nearest", "mean_commute_min");
  P(`- S1：care_score 比 nearest ${c1.mean >= 0 ? "多" : "少"}約 ${h2(Math.abs(c1.mean))} 分鐘（CI ${h2(c1.lo)} 到 ${h2(c1.hi)}）→ ${c1.lo > 0 ? "預期的成本出現了" : "預期的成本沒有明確出現（CI 包含 0 或為負）"}。`);
  P();

  P("### H5（對照）：S6 無偏差且供給充足");
  P();
  const advL = -a.diff("S6", "care_score", "latest", pm).mean;
  const advN = -a.diff("S6", "care_score", "nearest", pm).mean;
  P(`- S6 弱勢等待中位數：care_score ${h2(a.summary("S6", "care_score", pm).mean)}、latest ${h2(a.summary("S6", "latest", pm).mean)}、nearest ${h2(a.summary("S6", "nearest", pm).mean)} 小時`);
  P(`- care_score 的優勢（基準 − care_score）：對 latest ${h2(advL)} 小時、對 nearest ${h2(advN)} 小時；配對差 CI：latest ${hrs(a.diff("S6", "care_score", "latest", pm))}；nearest ${hrs(a.diff("S6", "care_score", "nearest", pm))}`);
  const h5 = advL <= 2 && advN <= 2;
  P(`- **判定：H5 ${h5 ? "成立（兩個優勢都不超過 2 小時）" : "不成立（優勢超過 2 小時；以下為預註冊要求的來源說明）"}**`);
  if (!h5) {
    P();
    P("  預註冊要求說明優勢來源。以下是 S6 的 H6 拆解（同一個指標，配對差，小時；描述性，不作因果宣稱）：");
    P();
    P(table(["項目", "S6 弱勢等待中位數（小時）[CI]"], h6Terms().map((t) => [t.long, cell(pm, a.combo("S6", pm, t.terms))])));
  }
  P();
  P("**預期優勢縮小**：S4、S6、S11 的優勢（基準 − care_score，小時，弱勢等待中位數）與 S1 比較：");
  P();
  P(table(["情境", "對 latest 的優勢", "對 nearest 的優勢", "相對 S1 縮小？（點估計，latest／nearest）"], ["S1", "S4", "S6", "S11"].map((id) => {
    const l = -a.diff(id, "care_score", "latest", pm).mean;
    const n = -a.diff(id, "care_score", "nearest", pm).mean;
    const l1 = -a.diff("S1", "care_score", "latest", pm).mean;
    const n1 = -a.diff("S1", "care_score", "nearest", pm).mean;
    return [id, h2(l), h2(n), id === "S1" ? "—" : `${Math.abs(l) < Math.abs(l1) ? "是" : "否"}／${Math.abs(n) < Math.abs(n1) ? "是" : "否"}`];
  })));
  P();

  P("### H6（消融）：額滿導流與 Care Score 排序各自的貢獻（弱勢等待中位數，小時；負值 = 讓等待變短）");
  P();
  P("2×3 表（S1，平均 [CI]）：");
  P();
  P(table(["排序規則", "不導流（p = 0.5）", "導流（p = 1）"], [
    ["latest", cell(pm, a.summary("S1", "latest", pm)), cell(pm, a.summary("S1", "coordinated_latest", pm))],
    ["nearest", cell(pm, a.summary("S1", "nearest", pm)), cell(pm, a.summary("S1", "coordinated_nearest", pm))],
    ["Care Score（c = 1）", cell(pm, a.summary("S1", "care_score_uncoordinated", pm)), cell(pm, a.summary("S1", "care_score_full_compliance", pm))],
  ]));
  P();
  P(`加上 care_score（導流、c = 0.7）：${cell(pm, a.summary("S1", "care_score", pm))}。`);
  P();
  P("S1 的效應拆解（配對差，平均 [95% CI]）：");
  P();
  P(table(["項目", "弱勢等待中位數（小時）", "弱勢 T 內未獲志工比例"], h6Terms().map((t) => [t.long, cell(pm, a.combo("S1", pm, t.terms)), cell("unserved_frac_vulnerable", a.combo("S1", "unserved_frac_vulnerable", t.terms))])));
  P();
  P("全部情境的拆解（點估計，小時）；完整 CI 見 `results/h6_decomposition.csv`：");
  P();
  const terms6 = h6Terms();
  P(table(["情境", ...terms6.map((t) => t.short)], SCENARIOS.map((sc) => [sc.id, ...terms6.map((t) => h2(a.combo(sc.id, pm, t.terms).mean))])));
  P();
  P("H6 不預設方向，也沒有否證條件；以上只呈現各項的大小與符號。");
  P();

  P("## 五、偏離預註冊之處");
  P();
  if (meta.deviations.trim()) {
    P("預註冊文件結尾的 Deviations 段落（原文）：");
    P();
    // 內嵌的標題各降一級，讓它們收在「五」之下。
    P(meta.deviations.trim().replace(/^(#+) /gm, "#$1 "));
  } else {
    P("預註冊文件結尾沒有 Deviations 段落；執行過程中沒有改動任何預註冊的設定。");
  }
  P();
  P("---");
  P(`消融比較對象（${ABLATIONS.join("、")}）的配對差見 \`results/paired_diffs.csv\`。`);
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// SVG（手寫，不依賴外部套件；白底，淺色與深色背景都看得清楚）

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const FONT = `font-family="system-ui, -apple-system, 'Noto Sans TC', 'Microsoft JhengHei', sans-serif"`;

function niceTicks(lo: number, hi: number, n = 5): number[] {
  const span = hi - lo;
  const raw = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v / step) * step);
  return out;
}

const COLOR_BASE = "#8a8f98";
const COLOR_CARE = "#1b6ef3";
const COLOR_ABL = "#7fb0f5";
function colorOf(pol: string): string {
  if (pol === "care_score") return COLOR_CARE;
  if (pol.startsWith("care_score") || pol.startsWith("coordinated")) return COLOR_ABL;
  return COLOR_BASE;
}

export function svgS1Primary(a: Analysis): string {
  const m: MetricName = "median_wait_vulnerable";
  const pols = POLICIES.map((p) => p.name);
  const vals = pols.map((p) => a.summary("S1", p, m));
  const W = 900;
  const rowH = 34;
  const top = 78;
  const left = 230;
  const right = 190;
  const H = top + rowH * pols.length + 52;
  const maxV = Math.max(...vals.map((v) => v.hi)) * 1.08;
  const x = (v: number) => left + ((W - left - right) * v) / maxV;
  const o: string[] = [];
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" ${FONT}>`);
  o.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);
  o.push(`<text x="20" y="28" font-size="17" font-weight="600" fill="#1a1a1a">S1 主要情境：弱勢家戶「通報到第一位志工抵達」的等待時間中位數</text>`);
  o.push(`<text x="20" y="49" font-size="12" fill="#555">單位：小時，越低越好；未被服務者以 T − 通報時間 計；誤差線 = 95% percentile bootstrap CI（300 次重複）</text>`);
  o.push(`<text x="20" y="66" font-size="12" fill="#555">模擬假設下的機制展示，不是現實世界有效性的證明</text>`);
  for (const t of niceTicks(0, maxV)) {
    o.push(`<line x1="${x(t)}" y1="${top - 6}" x2="${x(t)}" y2="${top + rowH * pols.length}" stroke="#e3e5e8"/>`);
    o.push(`<text x="${x(t)}" y="${top + rowH * pols.length + 16}" font-size="11" fill="#666" text-anchor="middle">${t}</text>`);
  }
  pols.forEach((p, i) => {
    const y = top + i * rowH;
    const v = vals[i];
    const c = colorOf(p);
    o.push(`<text x="${left - 10}" y="${y + rowH / 2 + 4}" font-size="12.5" fill="#222" text-anchor="end"${p === "care_score" ? ' font-weight="700"' : ""}>${esc(p)}</text>`);
    o.push(`<rect x="${left}" y="${y + 7}" width="${Math.max(0, x(v.mean) - left)}" height="${rowH - 16}" fill="${c}" opacity="0.85"/>`);
    o.push(`<line x1="${x(v.lo)}" y1="${y + rowH / 2}" x2="${x(v.hi)}" y2="${y + rowH / 2}" stroke="#111" stroke-width="1.5"/>`);
    o.push(`<line x1="${x(v.lo)}" y1="${y + 10}" x2="${x(v.lo)}" y2="${y + rowH - 10}" stroke="#111" stroke-width="1.5"/>`);
    o.push(`<line x1="${x(v.hi)}" y1="${y + 10}" x2="${x(v.hi)}" y2="${y + rowH - 10}" stroke="#111" stroke-width="1.5"/>`);
    o.push(`<text x="${W - right + 12}" y="${y + rowH / 2 + 4}" font-size="12" fill="#222">${v.mean.toFixed(2)} [${v.lo.toFixed(2)}, ${v.hi.toFixed(2)}]</text>`);
  });
  const ly = H - 14;
  o.push(`<rect x="20" y="${ly - 9}" width="10" height="10" fill="${COLOR_BASE}"/><text x="35" y="${ly}" font-size="11.5" fill="#444">基準（p = 0.5）</text>`);
  o.push(`<rect x="150" y="${ly - 9}" width="10" height="10" fill="${COLOR_CARE}"/><text x="165" y="${ly}" font-size="11.5" fill="#444">care_score（CareRadar）</text>`);
  o.push(`<rect x="320" y="${ly - 9}" width="10" height="10" fill="${COLOR_ABL}"/><text x="335" y="${ly}" font-size="11.5" fill="#444">消融組</text>`);
  o.push(`</svg>`);
  return o.join("\n") + "\n";
}

export function svgPairedVsLatest(a: Analysis): string {
  const m: MetricName = "median_wait_vulnerable";
  const rows = SCENARIOS.map((sc) => ({ sc, d: a.diff(sc.id, "care_score", "latest", m) }));
  const W = 900;
  const rowH = 32;
  const top = 78;
  const left = 250;
  const right = 190;
  const H = top + rowH * rows.length + 52;
  const lo = Math.min(0, ...rows.map((r) => r.d.lo)) * 1.1;
  const hi = Math.max(0, ...rows.map((r) => r.d.hi)) * 1.1 || 1;
  const x = (v: number) => left + ((W - left - right) * (v - lo)) / (hi - lo);
  const o: string[] = [];
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" ${FONT}>`);
  o.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);
  o.push(`<text x="20" y="28" font-size="17" font-weight="600" fill="#1a1a1a">各情境：care_score 相對 latest 的配對差（弱勢等待時間中位數）</text>`);
  o.push(`<text x="20" y="49" font-size="12" fill="#555">單位：小時；負值 = care_score 較快，正值 = latest 較快；點 = 平均差，線 = 95% percentile bootstrap CI</text>`);
  o.push(`<text x="20" y="66" font-size="12" fill="#555">CI 跨過 0（虛線）的情境，在這組假設下看不出差異；模擬假設下的機制展示，不是現實世界有效性的證明</text>`);
  for (const t of niceTicks(lo, hi)) {
    o.push(`<line x1="${x(t)}" y1="${top - 6}" x2="${x(t)}" y2="${top + rowH * rows.length}" stroke="#e3e5e8"/>`);
    o.push(`<text x="${x(t)}" y="${top + rowH * rows.length + 16}" font-size="11" fill="#666" text-anchor="middle">${t}</text>`);
  }
  o.push(`<line x1="${x(0)}" y1="${top - 6}" x2="${x(0)}" y2="${top + rowH * rows.length}" stroke="#333" stroke-dasharray="4 3"/>`);
  rows.forEach(({ sc, d }, i) => {
    const y = top + i * rowH;
    const win = verdictOf(m, d) === "win";
    const c = win ? COLOR_CARE : d.lo > 0 ? "#c0392b" : "#777";
    o.push(`<text x="${left - 10}" y="${y + rowH / 2 + 4}" font-size="12.5" fill="#222" text-anchor="end">${esc(`${sc.id} ${sc.title}`)}</text>`);
    o.push(`<line x1="${x(d.lo)}" y1="${y + rowH / 2}" x2="${x(d.hi)}" y2="${y + rowH / 2}" stroke="${c}" stroke-width="2"/>`);
    o.push(`<line x1="${x(d.lo)}" y1="${y + 9}" x2="${x(d.lo)}" y2="${y + rowH - 9}" stroke="${c}" stroke-width="2"/>`);
    o.push(`<line x1="${x(d.hi)}" y1="${y + 9}" x2="${x(d.hi)}" y2="${y + rowH - 9}" stroke="${c}" stroke-width="2"/>`);
    o.push(`<circle cx="${x(d.mean)}" cy="${y + rowH / 2}" r="4.5" fill="${c}"/>`);
    o.push(`<text x="${W - right + 12}" y="${y + rowH / 2 + 4}" font-size="12" fill="#222">${d.mean.toFixed(2)} [${d.lo.toFixed(2)}, ${d.hi.toFixed(2)}]</text>`);
  });
  const ly = H - 14;
  o.push(`<circle cx="26" cy="${ly - 4}" r="4.5" fill="${COLOR_CARE}"/><text x="38" y="${ly}" font-size="11.5" fill="#444">CI 完全在負側（care_score 較快）</text>`);
  o.push(`<circle cx="260" cy="${ly - 4}" r="4.5" fill="#777"/><text x="272" y="${ly}" font-size="11.5" fill="#444">CI 包含 0</text>`);
  o.push(`<circle cx="360" cy="${ly - 4}" r="4.5" fill="#c0392b"/><text x="372" y="${ly}" font-size="11.5" fill="#444">CI 完全在正側（latest 較快）</text>`);
  o.push(`</svg>`);
  return o.join("\n") + "\n";
}
