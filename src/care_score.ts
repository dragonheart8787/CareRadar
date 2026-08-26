import type { CareScoreBreakdown, CaseRow } from "./types";

/**
 * Care Score 權重設定 —— 這個檔案就是「治理層」。
 *
 * 設計原則（對應簡報裡承諾評審的三件事）：
 *   1. 規則式、可解釋：每個分數都能拆解回「為什麼」。
 *   2. 資料不全時「fail-closed 但方向相反」：寧可多給一點分數、讓人工多看一眼，
 *      也不讓案件因為欄位缺漏而悄悄被排到後面（見 unknown_bonus）。
 *   3. Confidence 永遠不參與這裡的加總。信心不足只會讓 needs_human_verification=1，
 *      不會讓 total 分數變低。這是整個系統對「不會拍照定位的長輩」的承諾。
 *
 * 這些權重都應該被公開、被質疑、被實際的社工/長照/NGO 專業意見校正 ——
 * 目前的數字是工程起點，不是最終答案。
 */
export const CARE_SCORE_WEIGHTS = {
  vulnerability: {
    age80plus: 30,
    age65to79: 20,
    livesAlone: 25,
    mobilityImpaired: 25,
    hasYoungChildren: 15,
    cap: 100,
  },
  severity: {
    floodDepthCmToPoints: 0.4, // 每公分 0.4 分
    floodDepthCapCm: 150, // 超過150cm不再加分（避免極端值洗版）
    noWater: 15,
    noElectricity: 10,
    cap: 100,
  },
  urgency: {
    pointsPerHourWaited: 3,
    cap: 60, // 約20小時後觸頂，避免案件被演算法永遠遺忘
  },
  resourceGap: {
    pointsPerMissingVolunteer: 5,
    cap: 20,
  },
  unknownBonus: {
    // 當「三個核心脆弱欄位」(age / lives_alone / mobility_impaired) 全部缺漏時，
    // 代表這則通報很可能是文字很短、講不清楚的求助（常見於慌亂中打字的長輩、
    // 或代填但資訊不全的鄰居通報）。我們選擇「多給分」而不是「當作0分」，
    // 並同時標記 needs_human_verification，讓人工去電確認，而不是讓案件消失。
    points: 10,
  },
  // 四個子分數的加權比例，總和為 1。
  blend: {
    vulnerability: 0.4,
    severity: 0.3,
    urgency: 0.2,
    resourceGap: 0.1,
  },
} as const;

export function computeCareScore(
  row: CaseRow,
  now: Date = new Date()
): CareScoreBreakdown {
  const w = CARE_SCORE_WEIGHTS;

  // --- Vulnerability ---
  let vulnerability = 0;
  if (row.age !== null) {
    if (row.age >= 80) vulnerability += w.vulnerability.age80plus;
    else if (row.age >= 65) vulnerability += w.vulnerability.age65to79;
  }
  if (row.lives_alone === 1) vulnerability += w.vulnerability.livesAlone;
  if (row.mobility_impaired === 1)
    vulnerability += w.vulnerability.mobilityImpaired;
  if (row.has_young_children === 1)
    vulnerability += w.vulnerability.hasYoungChildren;
  vulnerability = Math.min(vulnerability, w.vulnerability.cap);

  // --- Severity ---
  let severity = 0;
  if (row.flood_depth_cm !== null) {
    const cappedDepth = Math.min(
      row.flood_depth_cm,
      w.severity.floodDepthCapCm
    );
    severity += cappedDepth * w.severity.floodDepthCmToPoints;
  }
  if (row.no_water) severity += w.severity.noWater;
  if (row.no_electricity) severity += w.severity.noElectricity;
  severity = Math.min(severity, w.severity.cap);

  // --- Urgency (time decay: 越等越優先，避免案件被遺忘) ---
  const reportedAt = new Date(row.reported_at + "Z"); // D1 datetime('now') 是 UTC
  const hoursWaited = Math.max(
    0,
    (now.getTime() - reportedAt.getTime()) / 3_600_000
  );
  const urgency = Math.min(
    hoursWaited * w.urgency.pointsPerHourWaited,
    w.urgency.cap
  );

  // --- Resource gap (缺口越大，優先度略為提高；額滿案件請在查詢層過濾掉，
  //     不要靠這裡的分數把它壓到後面 —— 那樣不夠明確、也不好稽核) ---
  const gap = Math.max(row.volunteers_needed - row.volunteers_assigned, 0);
  const resourceGap = Math.min(
    gap * w.resourceGap.pointsPerMissingVolunteer,
    w.resourceGap.cap
  );

  // --- Unknown bonus ---
  const coreFieldsAllMissing =
    row.age === null && row.lives_alone === null && row.mobility_impaired === null;
  const unknownBonus = coreFieldsAllMissing ? w.unknownBonus.points : 0;

  const total =
    vulnerability * w.blend.vulnerability +
    severity * w.blend.severity +
    urgency * w.blend.urgency +
    resourceGap * w.blend.resourceGap +
    unknownBonus;

  return {
    vulnerability: round1(vulnerability),
    severity: round1(severity),
    urgency: round1(urgency),
    resource_gap: round1(resourceGap),
    unknown_bonus: unknownBonus,
    total: round1(total),
  };
}

/**
 * Confidence Score：跟 Care Score 完全獨立的一條線。
 * 這是「資訊可信度／完整度」，只決定要不要送人工複核，
 * 絕對不會拿去影響上面的 Care Score 加總。
 *
 * 用規則式計算（核對關鍵欄位是否非空），不採信模型自報的信心值 ——
 * LLM 自己講「我有90%把握」不是一個可稽核、可信賴的數字。
 */
const CRITICAL_FIELDS: (keyof Pick<
  CaseRow,
  | "location_text"
  | "age"
  | "lives_alone"
  | "mobility_impaired"
  | "flood_depth_cm"
  | "volunteers_needed"
>)[] = [
  "location_text",
  "age",
  "lives_alone",
  "mobility_impaired",
  "flood_depth_cm",
  "volunteers_needed",
];

export function computeConfidenceScore(row: CaseRow): number {
  const filled = CRITICAL_FIELDS.filter(
    (f) => row[f] !== null && row[f] !== undefined
  ).length;
  return round2(filled / CRITICAL_FIELDS.length);
}

export function needsHumanVerification(confidence: number): boolean {
  return confidence < 0.5;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
