import { CARE_SCORE_WEIGHTS, computeCareScore } from "../src/care_score";
import type { CaseRow } from "../src/types";
import {
  SPEED_KMH,
  T_HORIZON,
  hoursToDate,
  makeCaseRow,
  type Household,
  type Params,
  type World,
} from "./model";
import { stream } from "./rng";

export type Rule = "latest" | "nearest" | "attention" | "random" | "care";

export interface PolicySpec {
  name: string;
  rule: Rule;
  /** "base" = 用情境的 pBase；"perfect" = 額滿狀態完全準確（p = 1） */
  fill: "base" | "perfect";
  /** 只有 care 規則有意義："param" = 用情境的 c；"full" = c = 1 */
  compliance: "param" | "full";
}

export const POLICIES: PolicySpec[] = [
  { name: "latest", rule: "latest", fill: "base", compliance: "full" },
  { name: "nearest", rule: "nearest", fill: "base", compliance: "full" },
  { name: "attention", rule: "attention", fill: "base", compliance: "full" },
  { name: "random", rule: "random", fill: "base", compliance: "full" },
  { name: "care_score", rule: "care", fill: "perfect", compliance: "param" },
  { name: "coordinated_latest", rule: "latest", fill: "perfect", compliance: "full" },
  { name: "coordinated_nearest", rule: "nearest", fill: "perfect", compliance: "full" },
  { name: "care_score_uncoordinated", rule: "care", fill: "base", compliance: "full" },
  { name: "care_score_full_compliance", rule: "care", fill: "perfect", compliance: "full" },
];

export function policyByName(name: string): PolicySpec {
  const p = POLICIES.find((x) => x.name === name);
  if (!p) throw new Error(`unknown policy ${name}`);
  return p;
}

export interface RunResult {
  /** 有效認領數（認領當下計入，與資料庫的原子認領一致） */
  assigned: Int32Array;
  /** T 內抵達該戶的志工數 */
  arrivalsInT: Int32Array;
  /** 第一位志工抵達時間（可能 > T；沒有則為 Infinity） */
  firstArrival: Float64Array;
  volunteersTotal: number;
  validClaims: number;
  invalidClaims: number;
  noCandidate: number;
  commuteHoursSum: number;
}

/** 防線：政策絕不能看到尚未通報的案件。違反就直接丟錯，不是靜默修正。 */
export function assertVisible(h: Household, t: number): void {
  if (h.reportT > t) {
    throw new Error(`policy saw unreported case ${h.id}: reportT=${h.reportT} > t=${t}`);
  }
}

const dist = (h: Household, vx: number, vy: number) => Math.hypot(h.x - vx, h.y - vy);

export function simulate(world: World, policy: PolicySpec, params: Params): RunResult {
  const hs = world.households;
  const n = hs.length;
  const assigned = new Int32Array(n);
  const arrivalsInT = new Int32Array(n);
  const firstArrival = new Float64Array(n).fill(Infinity);
  const rows: CaseRow[] = hs.map((h) => makeCaseRow(h, 0));
  const rng = stream(world.seed, `policy:${policy.name}`);
  const p = policy.fill === "perfect" ? 1 : params.pBase;
  const cand = new Int32Array(n);
  const byReport = world.byReport;

  let reported = 0;
  let validClaims = 0;
  let invalidClaims = 0;
  let noCandidate = 0;
  let commuteHoursSum = 0;

  for (const v of world.volunteers) {
    while (reported < n && hs[byReport[reported]].reportT <= v.t) reported++;

    // 候選集：已通報，扣掉「志工以機率 p 正確知道已額滿而跳過」的額滿案件。
    let nc = 0;
    for (let k = 0; k < reported; k++) {
      const i = byReport[k];
      assertVisible(hs[i], v.t);
      if (assigned[i] >= hs[i].needed) {
        if (p >= 1) continue;
        if (rng() < p) continue;
      }
      cand[nc++] = i;
    }
    if (nc === 0) {
      noCandidate++;
      continue;
    }

    let rule: Rule = policy.rule;
    if (rule === "care" && policy.compliance === "param" && !(rng() < params.c)) {
      rule = "nearest"; // 不遵從：仍透過平台（額滿案件已被隱藏），改挑最近的
    }

    let pick = -1;
    if (rule === "latest") {
      pick = cand[nc - 1]; // 候選依通報時間由早到晚排列
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
      // care：呼叫真實的 computeCareScore，以「當下模擬時間」重算。
      const now = hoursToDate(v.t);
      let best = -Infinity;
      for (let k = 0; k < nc; k++) {
        const total = computeCareScore(rows[cand[k]], now).total;
        // 嚴格大於：平手保留先出現者；候選依 (通報時間, 編號) 排列，
        // 所以平手會落在較早通報者。
        if (total > best) {
          best = total;
          pick = cand[k];
        }
      }
    }

    if (assigned[pick] >= hs[pick].needed) {
      invalidClaims++; // 認領到已額滿的案件：被原子條件拒絕，志工只有這一次機會，浪費掉
      continue;
    }
    assigned[pick]++;
    rows[pick].volunteers_assigned = assigned[pick];
    validClaims++;
    const travel = dist(hs[pick], v.x, v.y) / SPEED_KMH;
    commuteHoursSum += travel;
    const arrive = v.t + travel;
    if (arrive < firstArrival[pick]) firstArrival[pick] = arrive;
    if (arrive <= T_HORIZON) arrivalsInT[pick]++;
  }

  return {
    assigned,
    arrivalsInT,
    firstArrival,
    volunteersTotal: world.volunteers.length,
    validClaims,
    invalidClaims,
    noCandidate,
    commuteHoursSum,
  };
}

// ---- S9：權重抖動（執行期暫時改寫 CARE_SCORE_WEIGHTS，不改 src/ 檔案）----

type Mutable<X> = { -readonly [K in keyof X]: X[K] extends object ? Mutable<X[K]> : X[K] };
const W = CARE_SCORE_WEIGHTS as unknown as Mutable<typeof CARE_SCORE_WEIGHTS>;

/** 上限類（cap、floodDepthCapCm）不動；其餘點數／係數與 blend 各自獨立乘以 U(0.7,1.3)。 */
function isCapKey(key: string): boolean {
  return key === "cap" || key === "floodDepthCapCm";
}

function leafPaths(obj: Record<string, unknown>, prefix: string[] = []): string[][] {
  const out: string[][] = [];
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (v !== null && typeof v === "object") {
      out.push(...leafPaths(v as Record<string, unknown>, [...prefix, key]));
    } else {
      out.push([...prefix, key]);
    }
  }
  return out;
}

function getAt(root: unknown, path: string[]): number {
  let cur = root as Record<string, unknown>;
  for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]] as Record<string, unknown>;
  return cur[path[path.length - 1]] as number;
}

function setAt(root: unknown, path: string[], value: number): void {
  let cur = root as Record<string, unknown>;
  for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]] as Record<string, unknown>;
  cur[path[path.length - 1]] = value;
}

export function withJitteredWeights<R>(seed: number, fn: () => R): R {
  const paths = leafPaths(W as unknown as Record<string, unknown>);
  const original = paths.map((pth) => getAt(W, pth));
  const rng = stream(seed, "jitter");
  paths.forEach((pth, k) => {
    const mult = 0.7 + 0.6 * rng(); // 每個葉節點都抽一次（含 cap），確保抽取次數固定
    if (!isCapKey(pth[pth.length - 1])) setAt(W, pth, original[k] * mult);
  });
  try {
    return fn();
  } finally {
    paths.forEach((pth, k) => setAt(W, pth, original[k]));
  }
}

export function currentWeightsSnapshot(): string {
  return JSON.stringify(W);
}
