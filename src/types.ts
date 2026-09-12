export interface Env {
  AI: Ai;
  DB: D1Database;
  LINE_CHANNEL_SECRET?: string;
  LINE_CHANNEL_ACCESS_TOKEN?: string;
  CLAIM_RATE_LIMITER: RateLimit;
  LINE_RATE_LIMITER: RateLimit;
  // 後台頁面金鑰。用 Dashboard 的 Variables and Secrets 設定，不進 wrangler.toml。
  // 沒設定時後台一律視為未授權（fail-closed），不會變成「沒設就不用驗」。
  ADMIN_KEY?: string;
  // Debug 用的「重置我的測試案件」暗號開關。只有值剛好是字串 "true" 才啟用，
  // 沒設定或設成別的值一律關閉（fail-closed，跟 ADMIN_KEY 同一個方向）。
  // 正式對外的環境不該設這個 —— 那句暗號一次關掉使用者名下所有 open 案件，
  // 而且沒有復原路徑。
  ENABLE_DEBUG_RESET?: string;
}

// AI 從自然語言抽取出來的結構化欄位。
// 每一個欄位都允許 null —— 「不知道」跟「填 0/false」是不一樣的語意，
// 絕對不能把抽取失敗悄悄當成「沒有這個需求」。
/**
 * 一組座標是怎麼來的、精確到什麼程度。
 *   gps            → 使用者用 LINE 分享位置，裝置直接給的座標
 *   nominatim_high → 文字地址交給 Nominatim，解析到建築物/門牌等級
 *   nominatim_low  → 同上，但只解析到行政區等級（誤差可能數百公尺以上）
 *   null           → 沒有座標，或這筆是在這個欄位存在之前建立的舊資料
 */
export type LocationPrecision = "gps" | "nominatim_high" | "nominatim_low";

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
  // 通行阻礙（路斷、車輛進不去、需徒步等）。選填：AI 沒抽到就是 null，
  // 不代表資料有問題，所以不在 CRITICAL_FIELDS 裡、也不會觸發追問。
  access_obstacle: string | null;
  // location_text 的詳細程度，只用來決定這次回覆要不要附上「補個門牌會更好」
  // 的建議。**不寫進 D1** —— 它是這次抽取的當下判斷，不是案件的持久屬性；
  // 案件座標的精確度由 cases.location_precision 負責，兩者不是同一件事。
  location_detail_level: "district" | "street";
  volunteers_needed: number | null;
  summary: string;
  // 是否透露立即性生命危險。純粹用來決定回覆要不要附上 119/110 提醒 ——
  // 不進 Care Score、不進 confidence_score、也不寫進 D1。
  emergency_signal: boolean;
  emotional_distress_signal: boolean;
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
  location_precision: LocationPrecision | null;
  age: number | null;
  lives_alone: number | null;
  mobility_impaired: number | null;
  has_young_children: number | null;
  household_size: number | null;
  flood_depth_cm: number | null;
  no_water: number;
  no_electricity: number;
  need_types: string | null; // JSON string in DB
  access_obstacle: string | null;
  volunteers_needed: number;
  volunteers_assigned: number;
  summary: string | null;
  confidence_score: number | null;
  needs_human_verification: number;
  // 0/1：這筆案件曾經有訊息命中 containsEmergencyKeyword。只會從 0 變 1。
  // 純粹給志工看的資訊標籤 —— 不進 Care Score、不影響 confidence、不影響排序。
  emergency_flagged: number;
  possible_duplicate_of: number | null;
  status: "open" | "full" | "closed" | "completed";
  reported_at: string;
  updated_at: string;
}

// claimCase() 的回傳：case 是更新後的案件，claimToken 是「未雜湊」的原始字串。
// 這組原始字串只在認領當下回傳這一次，資料庫只留 SHA-256 雜湊值，無法回推。
export interface ClaimResult {
  case: CaseRow;
  claimToken: string;
  // 一次性的 6 碼驗證碼，讓志工用 LINE 傳「驗證 XXXXXX」把這筆認領綁到自己的
  // LINE 帳號，之後精確地址就能直接推播過去。跟 claimToken 是兩條平行的路徑：
  // claimToken 走網頁，這組走 LINE，互不取代。
  lineVerifyCode: string;
}

export interface CareScoreBreakdown {
  // 四個子分數的「原始分量」（未加權），README 的公式說明用得到。
  vulnerability: number;
  severity: number;
  urgency: number;
  resource_gap: number;
  // 乘上 blend 權重之後、實際貢獻給 total 的值。前端要用這組畫比例，
  // 用原始分量畫會讓視覺比例跟實際貢獻不一致。
  vulnerability_contribution: number;
  severity_contribution: number;
  urgency_contribution: number;
  resource_gap_contribution: number;
  total: number;
}
