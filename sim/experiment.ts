import { POLICIES, simulate, withJitteredWeights, type PolicySpec, type RunResult } from "./engine";
import { BASE_SEED, DEFAULTS, T_HORIZON, generateWorld, type Params, type World } from "./model";

export interface Scenario {
  id: string;
  title: string;
  /** 與預設值不同之處（給報告用的文字） */
  diff: string;
  params: Params;
}

const S = (id: string, title: string, diff: string, over: Partial<Params>): Scenario => ({
  id,
  title,
  diff,
  params: { ...DEFAULTS, ...over },
});

export const SCENARIOS: Scenario[] = [
  S("S1", "主要", "全部預設（ratio 0.7、hub、lag 1.5、vis 0.5、c 0.7、miss 0.15、p 0.5）", {}),
  S("S2", "稀缺", "ratio 0.5", { ratio: 0.5 }),
  S("S3", "平衡", "ratio 1.0", { ratio: 1.0 }),
  S("S4", "過剩", "ratio 2.0", { ratio: 2.0 }),
  S("S5", "在地志工", "local 出發（ratio 0.7）", { origin: "local" }),
  S("S6", "對照（無偏差、供給充足）", "lag 1.0、vis 1.0、ratio 2.0", { lag: 1.0, vis: 1.0, ratio: 2.0 }),
  S("S7", "低遵從", "c 0.4", { c: 0.4 }),
  S("S8", "高缺漏", "miss 0.4", { miss: 0.4 }),
  S("S9", "權重抖動", "每次重複把 Care Score 各項權重乘以 U(0.7,1.3)", { jitter: true }),
  S("S10", "強基準", "基準的 p = 0.9", { pBase: 0.9 }),
  S("S11", "反向偏差", "lag 0.7、vis 1.5", { lag: 0.7, vis: 1.5 }),
];

export const METRICS = [
  "median_wait_vulnerable",
  "unserved_frac_vulnerable",
  "fully_staffed_frac_vulnerable",
  "wait_gap_vulnerable",
  "median_wait_severe",
  "unserved_frac_severe",
  "fully_staffed_frac_severe",
  "wait_gap_severe",
  "invalid_claim_frac",
  "gini",
  "mean_commute_min",
] as const;
export type MetricName = (typeof METRICS)[number];

/** true = 數值越高越好；false = 越低越好（commute、gini 的方向僅供標示，gini 不是好壞判斷）。 */
export const HIGHER_IS_BETTER: Record<MetricName, boolean> = {
  median_wait_vulnerable: false,
  unserved_frac_vulnerable: false,
  fully_staffed_frac_vulnerable: true,
  wait_gap_vulnerable: false,
  median_wait_severe: false,
  unserved_frac_severe: false,
  fully_staffed_frac_severe: true,
  wait_gap_severe: false,
  invalid_claim_frac: false,
  gini: false,
  mean_commute_min: false,
};

export function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Gini：升冪排序後 G = 2·Σ(i·x_i)/(n·Σx) − (n+1)/n；全為 0 時定為 0。 */
export function gini(xs: ArrayLike<number>): number {
  const n = xs.length;
  const s = Array.from(xs).sort((a, b) => a - b);
  let sum = 0;
  let w = 0;
  for (let i = 0; i < n; i++) {
    sum += s[i];
    w += (i + 1) * s[i];
  }
  return sum === 0 ? 0 : (2 * w) / (n * sum) - (n + 1) / n;
}

export function computeMetrics(world: World, run: RunResult): Record<MetricName, number> {
  const hs = world.households;
  const wait = hs.map((h, i) =>
    run.firstArrival[i] <= T_HORIZON ? run.firstArrival[i] - h.reportT : T_HORIZON - h.reportT
  );
  const unserved = hs.map((_, i) => !(run.firstArrival[i] <= T_HORIZON));
  const staffed = hs.map((h, i) => run.arrivalsInT[i] >= h.needed);

  const group = (inG: (i: number) => boolean) => {
    const inIdx: number[] = [];
    const outIdx: number[] = [];
    hs.forEach((_, i) => (inG(i) ? inIdx : outIdx).push(i));
    const medIn = median(inIdx.map((i) => wait[i]));
    const medOut = median(outIdx.map((i) => wait[i]));
    return {
      median: medIn,
      unserved: inIdx.filter((i) => unserved[i]).length / inIdx.length,
      staffed: inIdx.filter((i) => staffed[i]).length / inIdx.length,
      gap: medIn - medOut,
    };
  };
  const v = group((i) => hs[i].vulnerable);
  const s = group((i) => hs[i].severe);
  const claims = run.validClaims + run.invalidClaims;

  const out: Record<MetricName, number> = {
    median_wait_vulnerable: v.median,
    unserved_frac_vulnerable: v.unserved,
    fully_staffed_frac_vulnerable: v.staffed,
    wait_gap_vulnerable: v.gap,
    median_wait_severe: s.median,
    unserved_frac_severe: s.unserved,
    fully_staffed_frac_severe: s.staffed,
    wait_gap_severe: s.gap,
    invalid_claim_frac: claims === 0 ? 0 : run.invalidClaims / claims,
    gini: gini(run.arrivalsInT),
    mean_commute_min: run.validClaims === 0 ? 0 : (run.commuteHoursSum / run.validClaims) * 60,
  };
  for (const m of METRICS) {
    if (!Number.isFinite(out[m])) throw new Error(`non-finite metric ${m} (seed ${world.seed})`);
  }
  return out;
}

/** results[scenarioId][policy][metric] = 長度 R 的向量（依重複編號排列）。 */
export type Results = Record<string, Record<string, Record<MetricName, Float64Array>>>;

export function runExperiment(
  scenarios: Scenario[],
  R: number,
  onScenarioDone?: (id: string, elapsedMs: number) => void
): Results {
  const results: Results = {};
  for (const sc of scenarios) {
    const t0 = performance.now();
    const perPolicy: Record<string, Record<MetricName, Float64Array>> = {};
    for (const pol of POLICIES) {
      const byMetric = {} as Record<MetricName, Float64Array>;
      for (const m of METRICS) byMetric[m] = new Float64Array(R);
      perPolicy[pol.name] = byMetric;
    }
    for (let r = 0; r < R; r++) {
      const seed = BASE_SEED + r;
      const world = generateWorld(seed, sc.params);
      const body = () => {
        for (const pol of POLICIES) {
          const metrics = computeMetrics(world, simulate(world, pol, sc.params));
          for (const m of METRICS) perPolicy[pol.name][m][r] = metrics[m];
        }
      };
      if (sc.params.jitter) withJitteredWeights(seed, body);
      else body();
    }
    results[sc.id] = perPolicy;
    onScenarioDone?.(sc.id, performance.now() - t0);
  }
  return results;
}

export type { PolicySpec };
