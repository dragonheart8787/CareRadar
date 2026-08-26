export interface Env {
  AI: Ai;
  DB: D1Database;
  LINE_CHANNEL_SECRET?: string;
  LINE_CHANNEL_ACCESS_TOKEN?: string;
}

// AI 從自然語言抽取出來的結構化欄位。
// 每一個欄位都允許 null —— 「不知道」跟「填 0/false」是不一樣的語意，
// 絕對不能把抽取失敗悄悄當成「沒有這個需求」。
export interface ExtractedFields {
  location_text: string | null;
  age: number | null;
  lives_alone: boolean | null;
  mobility_impaired: boolean | null;
  has_young_children: boolean | null;
  household_size: number | null;
  flood_depth_cm: number | null;
  no_water: boolean;
  no_electricity: boolean;
  need_types: string[];
  volunteers_needed: number | null;
  summary: string;
}

export interface CaseRow {
  id: number;
  source: string;
  reporter_line_user_id: string | null;
  raw_text: string;
  location_text: string | null;
  exact_lat: number | null;
  exact_lng: number | null;
  public_lat: number | null;
  public_lng: number | null;
  age: number | null;
  lives_alone: number | null;
  mobility_impaired: number | null;
  has_young_children: number | null;
  household_size: number | null;
  flood_depth_cm: number | null;
  no_water: number;
  no_electricity: number;
  need_types: string | null; // JSON string in DB
  volunteers_needed: number;
  volunteers_assigned: number;
  summary: string | null;
  confidence_score: number | null;
  needs_human_verification: number;
  possible_duplicate_of: number | null;
  status: "open" | "full" | "closed";
  reported_at: string;
  updated_at: string;
}

// claimCase() 的回傳：case 是更新後的案件，claimToken 是「未雜湊」的原始字串。
// 這組原始字串只在認領當下回傳這一次，資料庫只留 SHA-256 雜湊值，無法回推。
export interface ClaimResult {
  case: CaseRow;
  claimToken: string;
}

export interface CareScoreBreakdown {
  vulnerability: number;
  severity: number;
  urgency: number;
  resource_gap: number;
  unknown_bonus: number;
  total: number;
}
