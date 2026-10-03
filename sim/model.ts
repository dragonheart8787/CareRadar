import type { CaseRow } from "../src/types";
import { gauss, stream } from "./rng";

// ---- 固定常數（見 PREREGISTRATION.md 第 2 節）----
export const T_HORIZON = 72;
export const AREA_KM = 10;
export const N_HOUSEHOLDS = 200;
export const N_CLUSTERS = 8;
export const CLUSTER_SIGMA_KM = 0.8;
export const SPEED_KMH = 15;
export const HUB: readonly [number, number] = [2, 2];
export const REPORT_WINDOW_H = 24;
export const REPORT_MEAN_H = 8;
export const BASE_SEED = 20261003;

/** 模擬紀元：reported_at 與 now 都由此換算，只是為了餵給真實的 computeCareScore。 */
const EPOCH_MS = Date.UTC(2026, 0, 1);

export interface Params {
  ratio: number;
  origin: "hub" | "local";
  lag: number;
  vis: number;
  /** care_score 的遵從率 */
  c: number;
  miss: number;
  /** 基準政策「正確知道某案已額滿」的機率 */
  pBase: number;
  /** S9：每次重複抖動 Care Score 權重 */
  jitter: boolean;
}

export const DEFAULTS: Params = {
  ratio: 0.7,
  origin: "hub",
  lag: 1.5,
  vis: 0.5,
  c: 0.7,
  miss: 0.15,
  pBase: 0.5,
  jitter: false,
};

/** Care Score 實際看到的輸入（經過缺漏與翻轉的觀察層）。 */
export interface Observed {
  age: number | null;
  livesAlone: 0 | 1 | null;
  mobility: 0 | 1 | null;
  young: 0 | 1;
  depth: number | null;
  noWater: 0 | 1;
  noElec: 0 | 1;
}

export interface Household {
  id: number;
  x: number;
  y: number;
  // 真值（只用來決定標籤與觀察層，Care Score 看不到）
  age: number;
  livesAlone: boolean;
  mobility: boolean;
  young: boolean;
  depth: number;
  noWater: boolean;
  noElec: boolean;
  vulnerable: boolean;
  severe: boolean;
  needed: number;
  reportT: number;
  reportedAt: string;
  visibility: number;
  obs: Observed;
}

export interface Volunteer {
  id: number;
  t: number;
  x: number;
  y: number;
}

export interface World {
  seed: number;
  households: Household[];
  volunteers: Volunteer[];
  /** 家戶編號，依通報時間由早到晚排序（平手取編號小者） */
  byReport: Int32Array;
}

export function hoursToDate(h: number): Date {
  return new Date(EPOCH_MS + h * 3_600_000);
}

/** 轉成 care_score.ts 要求的 "YYYY-MM-DD HH:MM:SS"（UTC，無時區後綴）。 */
export function formatReportedAt(h: number): string {
  return hoursToDate(h).toISOString().slice(0, 19).replace("T", " ");
}

/** 把家戶（觀察層資料）組成 computeCareScore 吃的 CaseRow。評分包裝層的唯一入口。 */
export function makeCaseRow(h: Household, assigned: number): CaseRow {
  const o = h.obs;
  return {
    id: h.id,
    source: "sim",
    reporter_line_user_id: null,
    raw_text: "",
    location_text: "sim",
    exact_lat: null,
    exact_lng: null,
    public_lat: null,
    public_lng: null,
    location_precision: null,
    age: o.age,
    lives_alone: o.livesAlone,
    mobility_impaired: o.mobility,
    has_young_children: o.young,
    household_size: null,
    flood_depth_cm: o.depth,
    no_water: o.noWater,
    no_electricity: o.noElec,
    need_types: null,
    access_obstacle: null,
    volunteers_needed: h.needed,
    volunteers_assigned: assigned,
    summary: null,
    confidence_score: null,
    needs_human_verification: 0,
    emergency_flagged: 0,
    possible_duplicate_of: null,
    status: "open",
    reported_at: h.reportedAt,
    updated_at: h.reportedAt,
  };
}

const NEED_CDF = [0.35, 0.65, 0.85, 0.95, 1.0];

/** [0,24] 上的截斷指數（反函數法）；scale 是截斷前的平均。 */
function truncatedExp(u: number, scale: number): number {
  return -scale * Math.log(1 - u * (1 - Math.exp(-REPORT_WINDOW_H / scale)));
}

export function generateWorld(seed: number, p: Params): World {
  const centersRng = stream(seed, "centers");
  const centers: [number, number][] = [];
  for (let k = 0; k < N_CLUSTERS; k++) {
    centers.push([1 + 8 * centersRng(), 1 + 8 * centersRng()]);
  }
  const clamp = (v: number) => Math.min(AREA_KM, Math.max(0, v));

  const households: Household[] = [];
  for (let i = 0; i < N_HOUSEHOLDS; i++) {
    // 每個用途各自一條流；hh 流的抽取順序與次數固定，不隨參數變動。
    const r = stream(seed, `hh:${i}`);
    const cluster = Math.min(N_CLUSTERS - 1, Math.floor(r() * N_CLUSTERS));
    const gx = gauss(r);
    const gy = gauss(r);
    const old = r() < 0.3;
    const ageU = r();
    const aloneU = r();
    const mobU = r();
    const youngU = r();
    const nwU = r();
    const neU = r();
    const needU = r();

    const age = old ? 65 + Math.floor(ageU * 28) : 18 + Math.floor(ageU * 47);
    const livesAlone = aloneU < (old ? 0.5 : 0.1);
    const mobility = mobU < (old ? 0.25 : 0.04);
    const young = youngU < (old ? 0.02 : 0.2);

    // 淹水深度：對數常態（中位數 40、log sd 0.8），拒絕重抽截斷在 [5,150]。
    const dr = stream(seed, `depth:${i}`);
    let depth = 0;
    for (;;) {
      const d = 40 * Math.exp(0.8 * gauss(dr));
      if (d >= 5 && d <= 150) {
        depth = Math.round(d);
        break;
      }
    }
    const deep = depth > 60;
    const noWater = nwU < (deep ? 0.55 : 0.15);
    const noElec = neU < (deep ? 0.6 : 0.2);

    let needed = 5;
    for (let k = 0; k < NEED_CDF.length; k++) {
      if (needU < NEED_CDF[k]) {
        needed = k + 1;
        break;
      }
    }

    const vulnerable =
      (age >= 65 && livesAlone) || mobility || (young && (noWater || noElec));
    const severe = depth >= 100 || (noWater && noElec);

    const reportT = truncatedExp(stream(seed, `report:${i}`)(), REPORT_MEAN_H * (vulnerable ? p.lag : 1));
    const visibility = Math.exp(gauss(stream(seed, `vis:${i}`))) * (vulnerable ? p.vis : 1);

    // 觀察層：固定抽 9 個均勻亂數，順序固定。
    const orng = stream(seed, `obs:${i}`);
    const missProb = Math.min(1, p.miss * (vulnerable ? 1.5 : 1));
    const missAge = orng() < missProb;
    const missAlone = orng() < missProb;
    const missMob = orng() < missProb;
    const missDepth = orng() < missProb;
    const flipAlone = orng() < 0.05;
    const flipMob = orng() < 0.05;
    const flipYoung = orng() < 0.05;
    const leakWater = orng() < 0.1;
    const leakElec = orng() < 0.1;

    const aloneObs = flipAlone ? !livesAlone : livesAlone;
    const mobObs = flipMob ? !mobility : mobility;
    const youngObs = flipYoung ? !young : young;
    const obs: Observed = {
      age: missAge ? null : age,
      livesAlone: missAlone ? null : aloneObs ? 1 : 0,
      mobility: missMob ? null : mobObs ? 1 : 0,
      young: youngObs ? 1 : 0,
      depth: missDepth ? null : depth,
      noWater: noWater && !leakWater ? 1 : 0,
      noElec: noElec && !leakElec ? 1 : 0,
    };

    households.push({
      id: i,
      x: clamp(centers[cluster][0] + CLUSTER_SIGMA_KM * gx),
      y: clamp(centers[cluster][1] + CLUSTER_SIGMA_KM * gy),
      age,
      livesAlone,
      mobility,
      young,
      depth,
      noWater,
      noElec,
      vulnerable,
      severe,
      needed,
      reportT,
      reportedAt: formatReportedAt(reportT),
      visibility,
      obs,
    });
  }

  const totalNeed = households.reduce((s, h) => s + h.needed, 0);
  const M = Math.round(p.ratio * totalNeed);
  const half = Math.floor(M / 2);
  const volunteers: Volunteer[] = [];
  for (let j = 0; j < M; j++) {
    const vr = stream(seed, `vol:${j}`);
    const tu = vr();
    const ox = vr();
    const oy = vr();
    volunteers.push({
      id: j,
      t: j < half ? 6 + 24 * tu : 72 * tu,
      x: p.origin === "hub" ? HUB[0] : AREA_KM * ox,
      y: p.origin === "hub" ? HUB[1] : AREA_KM * oy,
    });
  }
  volunteers.sort((a, b) => a.t - b.t || a.id - b.id);

  const byReport = Int32Array.from(
    households.map((h) => h.id).sort((a, b) => households[a].reportT - households[b].reportT || a - b)
  );
  return { seed, households, volunteers, byReport };
}
