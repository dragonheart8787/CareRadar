import type { CareScoreBreakdown, CaseRow } from "./types";

/**
 * Care Score 權重設定 —— 這個檔案就是「治理層」。
 *
 * 設計原則（對應簡報裡承諾評審的三件事）：
 *   1. 規則式、可解釋：每個分數都能拆解回「為什麼」。
 *   2. 資料不全「不加分也不扣分」：欄位缺漏完全不影響 Care Score，只會讓
 *      needs_human_verification=1，交給人工去電確認。（早期版本會替全缺漏的
 *      案件加 10 分，那其實是讓 Confidence 反向滲進了分數，已移除。）
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

  // --- 加權貢獻 ---
  // 資訊不足「完全不影響」這裡的任何一項。缺漏只由 needs_human_verification
  // 這條獨立的線處理（見下方 Confidence Score）—— 讓資訊不足去動分數本身，
  // 等於把 Confidence 偷渡進 Care Score，那正是這個檔案承諾不做的事。
  const vulnerabilityContribution = round1(vulnerability * w.blend.vulnerability);
  const severityContribution = round1(severity * w.blend.severity);
  const urgencyContribution = round1(urgency * w.blend.urgency);
  const resourceGapContribution = round1(resourceGap * w.blend.resourceGap);

  // 加總已經四捨五入過的貢獻值，讓畫面上列出的四個數字永遠加得出 total ——
  // 一個「可解釋」的分數，不該讓人自己加一遍卻對不起來。
  const total = round1(
    vulnerabilityContribution +
      severityContribution +
      urgencyContribution +
      resourceGapContribution
  );

  return {
    vulnerability: round1(vulnerability),
    severity: round1(severity),
    urgency: round1(urgency),
    resource_gap: round1(resourceGap),
    vulnerability_contribution: vulnerabilityContribution,
    severity_contribution: severityContribution,
    urgency_contribution: urgencyContribution,
    resource_gap_contribution: resourceGapContribution,
    total,
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
export const CRITICAL_FIELDS: (keyof Pick<
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

/** CRITICAL_FIELDS 的元素型別，讓鍵名陣列能安全地拿去查標籤表。 */
type CriticalField = (typeof CRITICAL_FIELDS)[number];

export function computeConfidenceScore(row: CaseRow): number {
  const filled = CRITICAL_FIELDS.filter(
    (f) => row[f] !== null && row[f] !== undefined
  ).length;
  return round2(filled / CRITICAL_FIELDS.length);
}

export function needsHumanVerification(confidence: number): boolean {
  return confidence < 0.5;
}

/** 關鍵欄位對使用者說得懂的中文說法（追問時用）。 */
const CRITICAL_FIELD_LABELS: Record<(typeof CRITICAL_FIELDS)[number], string> = {
  location_text: "所在地區",
  age: "年齡",
  lives_alone: "是否獨居",
  mobility_impaired: "是否行動不便",
  flood_depth_cm: "淹水深度",
  volunteers_needed: "需要幾位志工協助",
};

/**
 * 還缺哪些關鍵欄位，回傳欄位鍵名（不是中文標籤）。
 *
 * 這是全專案唯一一處判斷「什麼叫沒填」的地方：describeMissingFields 的中文
 * 標籤、以及 LINE 快速回覆按鈕要顯示哪幾組選項，全都從這裡衍生，判斷標準
 * 也跟 computeConfidenceScore 一致，三邊不會各自漂移。
 *
 * 回傳型別比 string[] 窄，但對只要 string[] 的呼叫端完全相容；保留窄型別是
 * 為了讓下面查 CRITICAL_FIELD_LABELS 時不需要任何轉型。
 */
export function getMissingFieldKeys(row: CaseRow): CriticalField[] {
  return CRITICAL_FIELDS.filter(
    (f) => row[f] === null || row[f] === undefined
  );
}

/** 還缺哪些關鍵欄位，轉成使用者看得懂的中文說法。 */
export function describeMissingFields(row: CaseRow): string[] {
  return getMissingFieldKeys(row).map((f) => CRITICAL_FIELD_LABELS[f]);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
