import type { CaseRow, ClaimResult, Env, ExtractedFields } from "./types";
import { computeConfidenceScore, needsHumanVerification } from "./care_score";

/**
 * claim token 的有效時數。72 小時是對齊這個專案 MVP 本來就定義的範圍
 * ——「淹水退水後 72 小時內的生活復原階段」，不是隨意挑的數字。
 * 用 volunteer_claims.claimed_at 現算，不另外存到期時間戳記，
 * 所以調整這個值不需要對正式環境的 D1 做任何 schema 變更。
 */
const CLAIM_TOKEN_VALID_HOURS = 72;

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

/**
 * 列出所有被標記為疑似重複、且尚未關閉的案件，連同它指向的原始案件。
 * 這裡刻意不做任何自動合併判斷 —— 誤合併（把兩戶不同人家的需求當成一件）
 * 比留著一個未處理的重複案件危害更大，決定權留給人工。
 */
export async function listPossibleDuplicates(
  env: Env
): Promise<Array<{ duplicate: CaseRow; original: CaseRow | null }>> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM cases
     WHERE possible_duplicate_of IS NOT NULL
       AND status != 'closed'
     ORDER BY reported_at DESC`
  ).all<CaseRow>();

  const pairs: Array<{ duplicate: CaseRow; original: CaseRow | null }> = [];
  for (const duplicate of results) {
    // 原始案件查不到（例如已被刪除）不該讓整頁掛掉，就顯示成「找不到」。
    const original =
      duplicate.possible_duplicate_of !== null
        ? await getCase(env, duplicate.possible_duplicate_of)
        : null;
    pairs.push({ duplicate, original });
  }
  return pairs;
}

/**
 * 人工裁決一筆疑似重複案件。
 *   merge         → 關閉這筆重複案件（原始案件不動）
 *   not_duplicate → 清掉標記，兩筆都留著
 * 兩種都寫進 case_status_history，讓「為什麼這筆消失了」有跡可循。
 */
export async function resolveDuplicate(
  env: Env,
  caseId: number,
  action: "merge" | "not_duplicate"
): Promise<CaseRow | null> {
  const existing = await getCase(env, caseId);
  if (!existing) return null;

  if (action === "merge") {
    await env.DB.prepare(
      `UPDATE cases SET status = 'closed', updated_at = datetime('now') WHERE id = ?`
    )
      .bind(caseId)
      .run();
    await logHistory(
      env,
      caseId,
      "merged",
      `merged_into=${existing.possible_duplicate_of}`
    );
  } else {
    await env.DB.prepare(
      `UPDATE cases SET possible_duplicate_of = NULL, updated_at = datetime('now') WHERE id = ?`
    )
      .bind(caseId)
      .run();
    await logHistory(env, caseId, "not_duplicate");
  }

  return getCase(env, caseId);
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
 * 找出這位使用者在時間窗內、還在等補充資訊的案件。
 * 不用 Durable Objects 保存對話狀態 —— 「哪一筆案件還缺資訊」本來就記在
 * D1 的 needs_human_verification 上，直接查它就是最誠實的狀態來源。
 */
export async function findPendingSupplementCase(
  env: Env,
  lineUserId: string | null | undefined,
  windowMinutes: number = 15
): Promise<CaseRow | null> {
  if (!lineUserId) return null; // 拿不到 userId 就無從對應，不猜
  return env.DB.prepare(
    `SELECT * FROM cases
     WHERE reporter_line_user_id = ?
       AND status = 'open'
       AND needs_human_verification = 1
       AND updated_at > datetime('now', '-' || ? || ' minutes')
     ORDER BY updated_at DESC
     LIMIT 1`
  )
    .bind(lineUserId, windowMinutes)
    .first<CaseRow>();
}

/**
 * 把後續訊息的新資訊補進既有案件，而不是另開一筆。
 *
 * 合併原則：**只填空，不覆蓋**。已經講過的資訊一律以先前那次為準 ——
 * 使用者補充時常常只回答被問到的那幾項，其餘欄位模型可能抽出 null 或
 * 抽錯，若讓新值蓋掉舊值，等於讓一次追問把原本正確的資料洗掉。
 */
export async function supplementCase(
  env: Env,
  caseId: number,
  newFields: ExtractedFields,
  newRawText: string,
  newExact: { lat: number; lng: number } | null,
  newFuzzed: { lat: number; lng: number } | null
): Promise<CaseRow> {
  const existing = await getCase(env, caseId);
  if (!existing) throw new Error(`Case ${caseId} not found`);

  // 缺水/缺電：任一次提到就算有（OR），不會因為第二則沒提到就被清掉。
  const noWater = existing.no_water || newFields.no_water ? 1 : 0;
  const noElectricity =
    existing.no_electricity || newFields.no_electricity ? 1 : 0;

  // need_types：兩次的聯集去重。
  const mergedNeedTypes = Array.from(
    new Set([
      ...parseNeedTypes(existing.need_types),
      ...(newFields.need_types ?? []),
    ])
  );

  // 保留完整對話軌跡，之後人工複核看得到使用者原話。
  const mergedRawText = `${existing.raw_text}\n---\n${newRawText}`;

  const newSummary = (newFields.summary ?? "").trim();
  const mergedSummary = !newSummary
    ? existing.summary
    : existing.summary
      ? `${existing.summary}；補充：${newSummary}`
      : newSummary;

  // location_text 是這次才第一次填上，才順帶帶入座標；原本已有座標不覆蓋。
  const locationJustFilled =
    existing.location_text === null && newFields.location_text !== null;
  const adoptCoords =
    locationJustFilled &&
    newExact !== null &&
    existing.exact_lat === null &&
    existing.exact_lng === null;

  const merged: CaseRow = {
    ...existing,
    location_text: existing.location_text ?? newFields.location_text,
    age: existing.age ?? newFields.age,
    lives_alone: existing.lives_alone ?? boolToInt(newFields.lives_alone),
    mobility_impaired:
      existing.mobility_impaired ?? boolToInt(newFields.mobility_impaired),
    has_young_children:
      existing.has_young_children ?? boolToInt(newFields.has_young_children),
    household_size: existing.household_size ?? newFields.household_size,
    flood_depth_cm: existing.flood_depth_cm ?? newFields.flood_depth_cm,
    // volunteers_needed 在 schema 是 NOT NULL DEFAULT 1，永遠不會是 null，
    // 依「現有值非 null 就保留」的規則，固定沿用現有值。
    volunteers_needed: existing.volunteers_needed,
    no_water: noWater,
    no_electricity: noElectricity,
    need_types: JSON.stringify(mergedNeedTypes),
    raw_text: mergedRawText,
    summary: mergedSummary,
    exact_lat: adoptCoords ? newExact.lat : existing.exact_lat,
    exact_lng: adoptCoords ? newExact.lng : existing.exact_lng,
    public_lat: adoptCoords ? (newFuzzed?.lat ?? null) : existing.public_lat,
    public_lng: adoptCoords ? (newFuzzed?.lng ?? null) : existing.public_lng,
  };

  // 用合併後的完整資料重算，補進來的欄位才會反映到信心分數上。
  const confidence = computeConfidenceScore(merged);
  const needsVerify = needsHumanVerification(confidence) ? 1 : 0;

  const updated = await env.DB.prepare(
    `UPDATE cases SET
       location_text = ?, exact_lat = ?, exact_lng = ?,
       public_lat = ?, public_lng = ?,
       age = ?, lives_alone = ?, mobility_impaired = ?,
       has_young_children = ?, household_size = ?,
       flood_depth_cm = ?, no_water = ?, no_electricity = ?, need_types = ?,
       volunteers_needed = ?, raw_text = ?, summary = ?,
       confidence_score = ?, needs_human_verification = ?,
       updated_at = datetime('now')
     WHERE id = ?
     RETURNING *`
  )
    .bind(
      merged.location_text,
      merged.exact_lat,
      merged.exact_lng,
      merged.public_lat,
      merged.public_lng,
      merged.age,
      merged.lives_alone,
      merged.mobility_impaired,
      merged.has_young_children,
      merged.household_size,
      merged.flood_depth_cm,
      merged.no_water,
      merged.no_electricity,
      merged.need_types,
      merged.volunteers_needed,
      merged.raw_text,
      merged.summary,
      confidence,
      needsVerify,
      caseId
    )
    .first<CaseRow>();

  if (!updated) throw new Error(`Failed to supplement case ${caseId}`);

  await logHistory(env, caseId, "supplemented", `confidence=${confidence}`);

  return updated;
}

/**
 * 專門補充「使用者直接分享 LINE 位置」得到的精確座標。
 *
 * 跟 supplementCase 刻意分開成兩個函式：那一個處理的是 AI 從文字抽出來的
 * 一整組 ExtractedFields，位置分享根本沒有那組欄位，硬套只會逼出一堆假的
 * null 去參與合併。這裡只做一件事 —— 案件還沒有座標時，把座標與地址描述填進去。
 *
 * 一樣遵守全檔一致的「只填空，不覆蓋」原則：已經有精確座標就整筆不動，
 * 連 updated_at 都不碰 —— 什麼都沒改卻推進時間戳記，會把
 * findPendingSupplementCase 的 15 分鐘補充視窗無謂地往後延。
 */
export async function supplementCaseLocation(
  env: Env,
  caseId: number,
  exact: { lat: number; lng: number },
  fuzzed: { lat: number; lng: number },
  addressText: string
): Promise<CaseRow | null> {
  const existing = await getCase(env, caseId);
  if (!existing) return null;

  if (existing.exact_lat !== null || existing.exact_lng !== null) {
    return existing;
  }

  const updated = await env.DB.prepare(
    `UPDATE cases SET
       location_text = ?, exact_lat = ?, exact_lng = ?,
       public_lat = ?, public_lng = ?,
       updated_at = datetime('now')
     WHERE id = ?
     RETURNING *`
  )
    .bind(addressText, exact.lat, exact.lng, fuzzed.lat, fuzzed.lng, caseId)
    .first<CaseRow>();

  if (!updated) return null;

  await logHistory(env, caseId, "supplemented", "location_share");

  return updated;
}

function parseNeedTypes(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
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
 * 裡是否有 case_id 與 claim_token_hash 都相符、且仍在有效期內的紀錄，
 * 同時要求該案件尚未被關閉。
 *
 * 三種失敗情形（token 不符、已過期、案件已被判定重複而合併關閉）**一律回傳
 * 同一個 false**，刻意不區分也不對外透露是哪一種 —— 否則等於告訴外部
 * 「你這組 token 曾經是有效的」或「這筆案件被合併了」，洩漏內部狀態。
 */
export async function verifyClaimToken(
  env: Env,
  caseId: number,
  token: string
): Promise<boolean> {
  if (!token) return false;
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT vc.id FROM volunteer_claims vc
     JOIN cases c ON c.id = vc.case_id
     WHERE vc.case_id = ? AND vc.claim_token_hash = ?
       AND vc.claimed_at > datetime('now', '-' || ? || ' hours')
       AND c.status != 'closed'
     LIMIT 1`
  )
    .bind(caseId, hash, CLAIM_TOKEN_VALID_HOURS)
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
