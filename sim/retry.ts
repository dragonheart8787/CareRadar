/**
 * 探索性、事後加入的敏感度分析：志工遇到額滿案件時重挑（retry-on-full）。
 * 設定與規則見 PREREGISTRATION.md 結尾的 Deviations 段落。
 *
 * 這個檔案刻意與 engine.ts 並存而不是修改它：engine.ts 是已 commit 的正式實驗所用的引擎，
 * 保持原樣才能確定既有結果不受影響。兩者的等價性由回歸檢查保證（retry_max = 0 必須逐位元相同）。
 */
import { computeCareScore } from "../src/care_score";
import type { CaseRow } from "../src/types";
import { assertVisible, type PolicySpec, type Rule, type RunResult } from "./engine";
import { computeMetrics, median, type MetricName } from "./experiment";
import {
  BASE_SEED,
  SPEED_KMH,
  T_HORIZON,
  generateWorld,
  hoursToDate,
  makeCaseRow,
  type Household,
  type Params,
  type Volunteer,
  type World,
} from "./model";
import { stream } from "./rng";

export interface RetryParams {
  /** 撞到額滿案件後最多再重挑幾次 */
  retryMax: number;
  /** 每次重挑多花的時間（小時）。預設 5 分鐘。 */
  delayH: number;
}

export const DEFAULT_RETRY_DELAY_H = 5 / 60;

export interface RetryRunResult extends RunResult {
  /** 所有撞到額滿的次數（409 次數，一位志工可能撞多次）；invalidClaims 則是「最終作廢」的志工數 */
  invalidAttempts: number;
  /** 事件處理時間倒退的次數，必為 0 */
  timeRegressions: number;
  /** 成功認領時，認領的時間（小時），依處理順序；給檢查用 */
  claimTimes: number[];
}

interface Ev {
  t: number;
  v: Volunteer;
  k: number;
  bumped: number[];
}

const less = (a: Ev, b: Ev): boolean =>
  a.t < b.t || (a.t === b.t && (a.v.id < b.v.id || (a.v.id === b.v.id && a.k < b.k)));

/** 最小堆（依 less），放等待重挑的事件。 */
class Heap {
  private a: Ev[] = [];
  get size(): number {
    return this.a.length;
  }
  peek(): Ev {
    return this.a[0];
  }
  push(e: Ev): void {
    const a = this.a;
    a.push(e);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(a[i], a[p])) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  pop(): Ev {
    const a = this.a;
    const top = a[0];
    const last = a.pop() as Ev;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && less(a[l], a[m])) m = l;
        if (r < a.length && less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

const dist = (h: Household, vx: number, vy: number) => Math.hypot(h.x - vx, h.y - vy);
const NO_BUMPS: number[] = [];

export function simulateRetry(
  world: World,
  policy: PolicySpec,
  params: Params,
  retry: RetryParams
): RetryRunResult {
  const hs = world.households;
  const n = hs.length;
  const assigned = new Int32Array(n);
  const arrivalsInT = new Int32Array(n);
  const firstArrival = new Float64Array(n).fill(Infinity);
  const rows: CaseRow[] = hs.map((h) => makeCaseRow(h, 0));
  // 與 engine.ts 相同的子流標籤：第一次嘗試的亂數序列與正式實驗一致。
  const rng = stream(world.seed, `policy:${policy.name}`);
  const p = policy.fill === "perfect" ? 1 : params.pBase;
  const cand = new Int32Array(n);
  const byReport = world.byReport;
  const vols = world.volunteers;
  const heap = new Heap();

  let vi = 0;
  let reported = 0;
  let validClaims = 0;
  let voided = 0;
  let invalidAttempts = 0;
  let noCandidate = 0;
  let commuteHoursSum = 0;
  let lastT = -Infinity;
  let timeRegressions = 0;
  const claimTimes: number[] = [];

  while (vi < vols.length || heap.size > 0) {
    // 下一個事件：主事件（志工上線）與重挑堆頂中較早者。
    let ev: Ev;
    if (vi < vols.length) {
      const primary: Ev = { t: vols[vi].t, v: vols[vi], k: 0, bumped: NO_BUMPS };
      if (heap.size > 0 && less(heap.peek(), primary)) ev = heap.pop();
      else {
        ev = primary;
        vi++;
      }
    } else {
      ev = heap.pop();
    }
    const t = ev.t;
    const v = ev.v;
    if (t < lastT) timeRegressions++;
    else lastT = t;

    while (reported < n && hs[byReport[reported]].reportT <= t) reported++;

    // 候選集：已通報；額滿案件中，志工已撞過的一律排除（他們知道那幾戶額滿），
    // 其餘額滿案件依該政策的 p 抽籤決定是否「正確知道」。
    let nc = 0;
    for (let k = 0; k < reported; k++) {
      const i = byReport[k];
      assertVisible(hs[i], t);
      if (assigned[i] >= hs[i].needed) {
        if (ev.bumped.length > 0 && ev.bumped.includes(i)) continue;
        if (p >= 1) continue;
        if (rng() < p) continue;
      }
      cand[nc++] = i;
    }
    if (nc === 0) {
      if (ev.k === 0) noCandidate++;
      else voided++; // 重挑時已沒有可選案件：認領作廢
      continue;
    }

    let rule: Rule = policy.rule;
    if (rule === "care" && policy.compliance === "param" && !(rng() < params.c)) {
      rule = "nearest";
    }

    let pick = -1;
    if (rule === "latest") {
      pick = cand[nc - 1];
    } else if (rule === "nearest") {
      let best = Infinity;
      for (let k = 0; k < nc; k++) {
        const d = dist(hs[cand[k]], v.x, v.y);
        if (d < best) {
          best = d;
          pick = cand[k];
        }
      }
    } else if (rule === "random") {
      pick = cand[Math.min(nc - 1, Math.floor(rng() * nc))];
    } else if (rule === "attention") {
      let total = 0;
      for (let k = 0; k < nc; k++) total += hs[cand[k]].visibility;
      let r = rng() * total;
      pick = cand[nc - 1];
      for (let k = 0; k < nc; k++) {
        r -= hs[cand[k]].visibility;
        if (r < 0) {
          pick = cand[k];
          break;
        }
      }
    } else {
      const now = hoursToDate(t);
      let best = -Infinity;
      for (let k = 0; k < nc; k++) {
        const total = computeCareScore(rows[cand[k]], now).total;
        if (total > best) {
          best = total;
          pick = cand[k];
        }
      }
    }

    if (assigned[pick] >= hs[pick].needed) {
      invalidAttempts++; // 409：撞到已額滿的案件
      if (ev.k < retry.retryMax) {
        heap.push({ t: t + retry.delayH, v, k: ev.k + 1, bumped: [...ev.bumped, pick] });
      } else {
        voided++; // 重挑耗盡，作廢
      }
      continue;
    }
    assigned[pick]++;
    rows[pick].volunteers_assigned = assigned[pick];
    validClaims++;
    claimTimes.push(t);
    const travel = dist(hs[pick], v.x, v.y) / SPEED_KMH;
    commuteHoursSum += travel;
    const arrive = t + travel;
    if (arrive < firstArrival[pick]) firstArrival[pick] = arrive;
    if (arrive <= T_HORIZON) arrivalsInT[pick]++;
  }

  return {
    assigned,
    arrivalsInT,
    firstArrival,
    volunteersTotal: vols.length,
    validClaims,
    invalidClaims: voided,
    noCandidate,
    commuteHoursSum,
    invalidAttempts,
    timeRegressions,
    claimTimes,
  };
}

// ---- 指標：既有 11 個（沿用 experiment.ts）＋ 3 個事後新增的 ----

export const EXTRA_METRICS = [
  "median_wait_nonvulnerable",
  "unserved_frac_nonvulnerable",
  "fully_staffed_frac_all",
] as const;
export type ExtraMetric = (typeof EXTRA_METRICS)[number];
export type RetryMetricName = MetricName | ExtraMetric;

/** 這個分析要報告的 7 個指標（見 Deviations）。 */
export const REPORTED_METRICS: RetryMetricName[] = [
  "median_wait_vulnerable",
  "unserved_frac_vulnerable",
  "median_wait_nonvulnerable",
  "unserved_frac_nonvulnerable",
  "fully_staffed_frac_all",
  "invalid_claim_frac",
  "mean_commute_min",
];

export const RETRY_HIGHER_IS_BETTER: Record<string, boolean> = {
  fully_staffed_frac_all: true,
};

export function computeAllMetrics(world: World, run: RunResult): Record<RetryMetricName, number> {
  const base = computeMetrics(world, run);
  const hs = world.households;
  const wait = hs.map((h, i) =>
    run.firstArrival[i] <= T_HORIZON ? run.firstArrival[i] - h.reportT : T_HORIZON - h.reportT
  );
  const non = hs.map((_, i) => i).filter((i) => !hs[i].vulnerable);
  const out = {
    ...base,
    median_wait_nonvulnerable: median(non.map((i) => wait[i])),
    unserved_frac_nonvulnerable: non.filter((i) => !(run.firstArrival[i] <= T_HORIZON)).length / non.length,
    fully_staffed_frac_all: hs.filter((h, i) => run.arrivalsInT[i] >= h.needed).length / hs.length,
  };
  for (const m of EXTRA_METRICS) {
    if (!Number.isFinite(out[m])) throw new Error(`non-finite metric ${m} (seed ${world.seed})`);
  }
  return out;
}

/** results[scenarioId][retryMax][policy][metric] = 長度 R 的向量。 */
export type RetryResults = Record<string, Record<number, Record<string, Record<RetryMetricName, Float64Array>>>>;

export const ALL_METRIC_NAMES: RetryMetricName[] = [
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
  ...EXTRA_METRICS,
];

export function runRetryCell(
  scenarioId: string,
  params: Params,
  policies: PolicySpec[],
  retryMax: number,
  delayH: number,
  R: number
): Record<string, Record<RetryMetricName, Float64Array>> {
  const perPolicy: Record<string, Record<RetryMetricName, Float64Array>> = {};
  for (const pol of policies) {
    const by = {} as Record<RetryMetricName, Float64Array>;
    for (const m of ALL_METRIC_NAMES) by[m] = new Float64Array(R);
    perPolicy[pol.name] = by;
  }
  for (let r = 0; r < R; r++) {
    const world = generateWorld(BASE_SEED + r, params);
    for (const pol of policies) {
      const run = simulateRetry(world, pol, params, { retryMax, delayH });
      if (run.timeRegressions !== 0) throw new Error(`${scenarioId}/${pol.name}/seed${r}: 事件處理時間倒退`);
      const m = computeAllMetrics(world, run);
      for (const name of ALL_METRIC_NAMES) perPolicy[pol.name][name][r] = m[name];
    }
  }
  return perPolicy;
}
