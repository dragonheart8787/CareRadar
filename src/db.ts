import type { CaseRow, ClaimResult, Env, ExtractedFields } from "./types";
import { computeConfidenceScore, needsHumanVerification } from "./care_score";

export async function logHistory(
  env: Env,
  caseId: number,
  event: string,
  detail?: string
) {
  await env.DB.prepare(
    `INSERT INTO case_status_history (case_id, event, detail) VALUES (?, ?, ?)`
  )
    .bind(caseId, event, detail ?? null)
    .run();
}

/**
 * 重複通報偵測：同一時間窗（24小時）內、座標落在同一個約 150 公尺網格內的案件，
 * 視為「疑似重複」。我們只標記、不自動合併 —— 誤合併(把兩戶不同人家的需求
 * 當成一件)比留著一個未合併的重複案件危害更大，合併必須留給人工複核。
 */
export async function findPossibleDuplicate(
  env: Env,
  lat: number | null,
  lng: number | null
): Promise<number | null> {
  if (lat === null || lng === null) return null;
  const DELTA = 0.0015; // 約 150 公尺
  const row = await env.DB.prepare(
    `SELECT id FROM cases
     WHERE status != 'closed'
       AND exact_lat IS NOT NULL AND exact_lng IS NOT NULL
       AND ABS(exact_lat - ?) < ? AND ABS(exact_lng - ?) < ?
       AND reported_at > datetime('now', '-24 hours')
     ORDER BY reported_at DESC
     LIMIT 1`
  )
    .bind(lat, DELTA, lng, DELTA)
    .first<{ id: number }>();
  return row?.id ?? null;
}

export async function insertCase(
  env: Env,
  params: {
    source: string;
    reporterLineUserId?: string | null;
    rawText: string;
    fields: ExtractedFields;
    exact: { lat: number; lng: number } | null;
    fuzzed: { lat: number; lng: number } | null;
  }
): Promise<CaseRow> {
  const { fields } = params;
  const volunteersNeeded = fields.volunteers_needed ?? 1;

  const duplicateOf = await findPossibleDuplicate(
    env,
    params.exact?.lat ?? null,
    params.exact?.lng ?? null
  );

  const result = await env.DB.prepare(
    `INSERT INTO cases (
      source, reporter_line_user_id, raw_text, location_text,
      exact_lat, exact_lng, public_lat, public_lng,
      age, lives_alone, mobility_impaired, has_young_children, household_size,
      flood_depth_cm, no_water, no_electricity, need_types,
      volunteers_needed, volunteers_assigned, summary,
      confidence_score, needs_human_verification, possible_duplicate_of, status
    ) VALUES (?,?,?,?, ?,?,?,?, ?,?,?,?,?, ?,?,?,?, ?,0,?, ?,?,?, 'open')
    RETURNING *`
  )
    .bind(
      params.source,
      params.reporterLineUserId ?? null,
      params.rawText,
      fields.location_text,
      params.exact?.lat ?? null,
      params.exact?.lng ?? null,
      params.fuzzed?.lat ?? null,
      params.fuzzed?.lng ?? null,
      fields.age,
      boolToInt(fields.lives_alone),
      boolToInt(fields.mobility_impaired),
      boolToInt(fields.has_young_children),
      fields.household_size,
      fields.flood_depth_cm,
      fields.no_water ? 1 : 0,
      fields.no_electricity ? 1 : 0,
      JSON.stringify(fields.need_types ?? []),
      volunteersNeeded,
      fields.summary,
      0, // confidence_score 先塞 0，下面用真正的 row 算完再 UPDATE
      0,
      duplicateOf
    )
    .first<CaseRow>();

  if (!result) throw new Error("Failed to insert case");

  const confidence = computeConfidenceScore(result);
  const needsVerify = needsHumanVerification(confidence) ? 1 : 0;
  await env.DB.prepare(
    `UPDATE cases SET confidence_score = ?, needs_human_verification = ? WHERE id = ?`
  )
    .bind(confidence, needsVerify, result.id)
    .run();
  result.confidence_score = confidence;
  result.needs_human_verification = needsVerify;

  await logHistory(env, result.id, "created", `confidence=${confidence}`);
  if (duplicateOf) {
    await logHistory(env, result.id, "flagged_duplicate", `possible_duplicate_of=${duplicateOf}`);
  }

  return result;
}

export async function listCases(
  env: Env,
  opts: { sort: "care_score" | "latest"; includeFull: boolean }
): Promise<CaseRow[]> {
  // sort=latest 刻意「不過濾額滿案件」——這是為了在 Demo 裡誠實地重現
  // 社群媒體式排序的問題：光看「最新」看不出這個案件其實已經不缺人了。
  // sort=care_score 只回傳 status='open' 的案件：額滿案件應該從志工的
  // 推薦清單消失，而不是排到很後面卻還留著。
  const whereClause =
    opts.sort === "care_score" && !opts.includeFull ? "WHERE status = 'open'" : "";
  const orderClause =
    opts.sort === "latest" ? "ORDER BY reported_at DESC" : "ORDER BY reported_at DESC";
  // 注意：care_score 排序在 JS 端算完才真正排序（見 index.ts），
  // 這裡先用 reported_at 撈出候選集合即可。
  const { results } = await env.DB.prepare(
    `SELECT * FROM cases ${whereClause} ${orderClause} LIMIT 200`
  ).all<CaseRow>();
  return results;
}

export async function getCase(env: Env, id: number): Promise<CaseRow | null> {
  return env.DB.prepare(`SELECT * FROM cases WHERE id = ?`).bind(id).first<CaseRow>();
}

/**
 * 原子性認領：靠 WHERE volunteers_assigned < volunteers_needed 這個條件，
 * 讓「兩位志工同時搶最後一個名額」在 SQLite/D1 的單一 UPDATE 語句層級
 * 被正確序列化 —— 不需要額外的鎖，也不會有名額被超額分配的競態條件。
 * 回傳 null 代表「你來晚了，名額剛好被別人搶走」。
 */
export async function claimCase(
  env: Env,
  caseId: number,
  volunteer: { name?: string; contact?: string }
): Promise<ClaimResult | null> {
  const updateResult = await env.DB.prepare(
    `UPDATE cases
     SET volunteers_assigned = volunteers_assigned + 1,
         updated_at = datetime('now')
     WHERE id = ? AND status = 'open' AND volunteers_assigned < volunteers_needed`
  )
    .bind(caseId)
    .run();

  if (!updateResult.meta.changes) {
    return null; // 名額已滿或案件不存在／不是 open 狀態
  }

  // 一次性認領憑證：原始字串只在這次回應裡交給認領者，資料庫只留 SHA-256 雜湊，
  // 系統本身之後也無法回推原始字串。
  const claimToken = crypto.randomUUID();
  const claimTokenHash = await sha256Hex(claimToken);

  await env.DB.prepare(
    `INSERT INTO volunteer_claims (case_id, volunteer_name, volunteer_contact, claim_token_hash)
     VALUES (?, ?, ?, ?)`
  )
    .bind(
      caseId,
      volunteer.name ?? null,
      volunteer.contact ?? null,
      claimTokenHash
    )
    .run();

  const updated = await getCase(env, caseId);
  if (!updated) return null;

  await logHistory(
    env,
    caseId,
    "claimed",
    `${updated.volunteers_assigned}/${updated.volunteers_needed}`
  );

  if (updated.volunteers_assigned >= updated.volunteers_needed) {
    await env.DB.prepare(`UPDATE cases SET status = 'full' WHERE id = ?`)
      .bind(caseId)
      .run();
    await logHistory(env, caseId, "full");
    updated.status = "full";
  }

  return { case: updated, claimToken };
}

/**
 * 驗證認領憑證：把傳入的 token 用同樣的 SHA-256 雜湊，比對 volunteer_claims
 * 裡是否有 case_id 與 claim_token_hash 都相符的紀錄。
 */
export async function verifyClaimToken(
  env: Env,
  caseId: number,
  token: string
): Promise<boolean> {
  if (!token) return false;
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT id FROM volunteer_claims
     WHERE case_id = ? AND claim_token_hash = ?
     LIMIT 1`
  )
    .bind(caseId, hash)
    .first<{ id: number }>();
  return row !== null;
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input)
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function boolToInt(b: boolean | null): number | null {
  if (b === null) return null;
  return b ? 1 : 0;
}
