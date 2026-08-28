import type { CaseRow, Env } from "./types";
import { computeCareScore } from "./care_score";
import {
  cancelClaim,
  CaseNotMergeableError,
  claimCase,
  getCase,
  listCases,
  listPossibleDuplicates,
  markCaseCompleted,
  resolveDuplicate,
  verifyClaimToken,
  verifyClaimTokenReturningClaimId,
} from "./db";
import { handleLineWebhook, pushMessage, timingSafeEqual } from "./line";
import { renderHtml } from "./frontend";
import { renderDuplicatesHtml } from "./admin";

function toApiCase(row: CaseRow) {
  return {
    id: row.id,
    status: row.status,
    // raw_text 與 location_text 刻意不回傳：這是公開端點，不需要任何 token。
    // 兩者幾乎必然包含使用者輸入的完整地址，放行等於讓 claim token 的地址
    // 保護只擋住經緯度、卻放走更精確的文字門牌。精確地址一律走
    // GET /api/cases/:id/address（憑 claim token）。
    summary: row.summary,
    public_lat: row.public_lat,
    public_lng: row.public_lng,
    volunteers_needed: row.volunteers_needed,
    volunteers_assigned: row.volunteers_assigned,
    confidence_score: row.confidence_score,
    needs_human_verification: row.needs_human_verification === 1,
    need_types_parsed: safeParseArray(row.need_types),
    reported_at: row.reported_at,
    score_breakdown: computeCareScore(row),
  };
}

function safeParseArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

/**
 * 通知原始通報者：認領狀態有變化。
 *
 * 這是附加的 side effect，不是操作的一部分 —— 通報者可能根本不是從 LINE 來的
 * （里長代填的案件 reporter_line_user_id 就是 null），推播也可能失敗。
 * 兩種情況都不該讓認領／取消本身失敗，所以這裡吞掉所有錯誤、只留一筆記錄。
 */
async function notifyReporter(
  env: Env,
  caseRow: CaseRow,
  text: string
): Promise<void> {
  if (!caseRow.reporter_line_user_id) return;
  try {
    await pushMessage(env, caseRow.reporter_line_user_id, text);
  } catch (err) {
    console.error("Failed to notify reporter", err);
  }
}

/** 401 時要帶這個 header，瀏覽器看到才會跳出帳號密碼輸入視窗。 */
const BASIC_AUTH_CHALLENGE = { "WWW-Authenticate": 'Basic realm="CareRadar Admin"' };

/**
 * 後台授權：HTTP Basic Auth。
 *
 * 用 Basic Auth 而不是網址上的 ?key=，是因為 query string 會留在瀏覽器歷史、
 * 分享出去的連結、以及沿路每一層代理伺服器的存取日誌裡 —— 金鑰等於到處都是。
 * Basic Auth 的憑證放在 header，瀏覽器登入一次後會自動附加在後續請求上，
 * 頁面本身也就不需要把金鑰嵌進 JavaScript 給人看到。
 *
 * 帳號不檢查（填什麼都行），只驗密碼。ADMIN_KEY 沒設定一律拒絕（fail-closed）。
 */
function isAuthorizedViaBasicAuth(request: Request, env: Env): boolean {
  if (!env.ADMIN_KEY) return false;

  const header = request.headers.get("authorization");
  if (!header) return false;

  // scheme 依 RFC 7617 不分大小寫；瀏覽器都送 "Basic"，但別假設只有瀏覽器會來。
  const [scheme, encoded] = header.split(" ");
  if (!scheme || scheme.toLowerCase() !== "basic" || !encoded) return false;

  let credentials: string;
  try {
    // atob 回傳的是 binary string，非 ASCII 的金鑰要再解一次 UTF-8 才會正確，
    // 否則設了中文/emoji 金鑰的人會怎麼輸入都登不進來。
    const binary = atob(encoded);
    credentials = new TextDecoder().decode(
      Uint8Array.from(binary, (c) => c.charCodeAt(0))
    );
  } catch {
    return false; // base64 壞掉
  }

  // 只切第一個冒號：密碼本身允許包含冒號。
  const separator = credentials.indexOf(":");
  if (separator === -1) return false;
  const password = credentials.slice(separator + 1);
  if (!password) return false;

  // 常數時間比對，避免用 === 洩漏前綴資訊。
  return timingSafeEqual(env.ADMIN_KEY, password);
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(renderHtml(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (request.method === "POST" && url.pathname === "/webhook/line") {
      return handleLineWebhook(request, env, ctx);
    }

    if (request.method === "GET" && url.pathname === "/api/cases") {
      const sort = (url.searchParams.get("sort") ?? "care_score") as
        | "care_score"
        | "latest";
      const includeFull = url.searchParams.get("include_full") === "1";
      const rows = await listCases(env, { sort, includeFull });
      let cases = rows.map(toApiCase);

      if (sort === "care_score") {
        cases = cases.sort(
          (a, b) => b.score_breakdown.total - a.score_breakdown.total
        );
      } else {
        cases = cases.sort(
          (a, b) =>
            new Date(b.reported_at + "Z").getTime() -
            new Date(a.reported_at + "Z").getTime()
        );
      }

      return new Response(JSON.stringify(cases), { headers: JSON_HEADERS });
    }

    // 精確地址只給「認領過這個案件」的人：憑一次性 claim token 換 exact_* 座標。
    const addressMatch = url.pathname.match(/^\/api\/cases\/(\d+)\/address$/);
    if (request.method === "GET" && addressMatch) {
      const caseId = parseInt(addressMatch[1], 10);
      const token = url.searchParams.get("token") ?? "";
      const authorized = await verifyClaimToken(env, caseId, token);
      if (!authorized) {
        return new Response(
          JSON.stringify({ error: "invalid or missing token" }),
          { status: 403, headers: JSON_HEADERS }
        );
      }
      const row = await getCase(env, caseId);
      if (!row) {
        return new Response(JSON.stringify({ error: "case not found" }), {
          status: 404,
          headers: JSON_HEADERS,
        });
      }
      return new Response(
        JSON.stringify({
          location_text: row.location_text,
          exact_lat: row.exact_lat,
          exact_lng: row.exact_lng,
        }),
        { headers: JSON_HEADERS }
      );
    }

    const claimMatch = url.pathname.match(/^\/api\/cases\/(\d+)\/claim$/);
    if (request.method === "POST" && claimMatch) {
      // 這個端點完全公開、沒有身份驗證，所以先按來源 IP 限流再往下跑。
      const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
      const { success } = await env.CLAIM_RATE_LIMITER.limit({ key: ip });
      if (!success) {
        return new Response(
          JSON.stringify({ error: "too many requests, please slow down" }),
          { status: 429, headers: JSON_HEADERS }
        );
      }

      const caseId = parseInt(claimMatch[1], 10);
      let body: { name?: string; contact?: string } = {};
      try {
        body = await request.json();
      } catch {
        // 空 body 也允許（匿名認領）
      }
      const claimed = await claimCase(env, caseId, {
        name: body.name,
        contact: body.contact,
      });
      if (!claimed) {
        return new Response(
          JSON.stringify({ error: "case is full or not open" }),
          { status: 409, headers: JSON_HEADERS }
        );
      }
      // 通知通報者有人來幫忙了。用 waitUntil 丟到背景，不讓推播的往返時間
      // 拖慢志工端的回應。
      ctx.waitUntil(
        notifyReporter(
          env,
          claimed.case,
          `好消息！已經有志工認領您的需求，目前是 ${claimed.case.volunteers_assigned}/${claimed.case.volunteers_needed} 位志工協助中。\n認領志工：${body.name ?? "匿名志工"}`
        )
      );

      // claim_token 只在這一次回應出現，之後系統只留雜湊值。
      return new Response(
        JSON.stringify({
          ...toApiCase(claimed.case),
          claim_token: claimed.claimToken,
        }),
        { headers: JSON_HEADERS }
      );
    }

    // 認領者回報「處理完成」。憑同一組 claim token，不需要另外的身份驗證 ——
    // 能出示 token 就代表當初認領過這個案件。
    const completeMatch = url.pathname.match(/^\/api\/cases\/(\d+)\/complete$/);
    if (request.method === "POST" && completeMatch) {
      const caseId = parseInt(completeMatch[1], 10);
      let body: { token?: string } = {};
      try {
        body = await request.json();
      } catch {
        // 解析失敗就留空物件，下面的 token 驗證會擋掉
      }
      const updated = await markCaseCompleted(env, caseId, body.token ?? "");
      if (!updated) {
        // 刻意不區分「token 不對」與「案件已經結案／不存在」，
        // 跟 address 端點同一套慣例，避免用回應差異推敲案件狀態。
        return new Response(
          JSON.stringify({ error: "invalid token or case already resolved" }),
          { status: 403, headers: JSON_HEADERS }
        );
      }
      return new Response(JSON.stringify(toApiCase(updated)), {
        headers: JSON_HEADERS,
      });
    }

    // 認領者取消自己的認領，把名額還給案件。憑 token 精準對應到「哪一筆」
    // 認領紀錄，所以同案件裡其他志工的認領完全不受影響。
    const cancelMatch = url.pathname.match(/^\/api\/cases\/(\d+)\/cancel-claim$/);
    if (request.method === "POST" && cancelMatch) {
      const caseId = parseInt(cancelMatch[1], 10);
      let body: { token?: string } = {};
      try {
        body = await request.json();
      } catch {
        // 解析失敗就留空物件，下面的 token 驗證會擋掉
      }
      const claimRowId = await verifyClaimTokenReturningClaimId(
        env,
        caseId,
        body.token ?? ""
      );
      if (claimRowId === null) {
        // 跟其餘 token 端點一致：不區分「token 不對」與「案件已經結案」。
        return new Response(
          JSON.stringify({ error: "invalid token or case already resolved" }),
          { status: 403, headers: JSON_HEADERS }
        );
      }
      const result = await cancelClaim(env, caseId, claimRowId);
      if (!result) {
        return new Response(
          JSON.stringify({ error: "invalid token or case already resolved" }),
          { status: 403, headers: JSON_HEADERS }
        );
      }

      ctx.waitUntil(
        notifyReporter(
          env,
          result.case,
          `提醒：原本認領您需求的志工（${result.cancelledVolunteerName ?? "匿名志工"}）已取消協助，目前還缺 ${result.case.volunteers_needed - result.case.volunteers_assigned} 位志工，我們會持續媒合其他志工，請放心。`
        )
      );

      // cancelledVolunteerName 只用來組通知訊息，不回傳給前端。
      return new Response(JSON.stringify(toApiCase(result.case)), {
        headers: JSON_HEADERS,
      });
    }

    // 後台：疑似重複案件複核頁。回應一律不透露頁面內容或金鑰格式。
    if (request.method === "GET" && url.pathname === "/admin/duplicates") {
      if (!isAuthorizedViaBasicAuth(request, env)) {
        return new Response("unauthorized", {
          status: 401,
          headers: BASIC_AUTH_CHALLENGE,
        });
      }
      const pairs = await listPossibleDuplicates(env);
      return new Response(renderDuplicatesHtml(pairs), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    const resolveMatch = url.pathname.match(
      /^\/api\/admin\/duplicates\/(\d+)\/resolve$/
    );
    if (request.method === "POST" && resolveMatch) {
      // 授權先於解析 body：沒通過就不該讓未授權請求觸發任何後續處理。
      if (!isAuthorizedViaBasicAuth(request, env)) {
        // 這個端點不帶 WWW-Authenticate —— 那是給瀏覽器導覽用的，
        // 頁面上的 fetch 會自動附上先前登入快取的憑證。
        return new Response("unauthorized", { status: 401 });
      }
      let body: { action?: string } = {};
      try {
        body = await request.json();
      } catch {
        // 解析失敗就留空物件，下面的 action 檢查會擋掉
      }
      if (body.action !== "merge" && body.action !== "not_duplicate") {
        return new Response(JSON.stringify({ error: "invalid action" }), {
          status: 400,
          headers: JSON_HEADERS,
        });
      }
      const caseId = parseInt(resolveMatch[1], 10);
      let updated: CaseRow | null;
      try {
        updated = await resolveDuplicate(env, caseId, body.action);
      } catch (err) {
        // 案件存在、但已完成或已關閉：這不是 404（案件在），也不是 500
        // （沒有壞掉），是這個操作在目前狀態下不被允許 —— 409 才對得上。
        if (err instanceof CaseNotMergeableError) {
          return new Response(
            JSON.stringify({ error: "案件已完成或已關閉，無法合併" }),
            { status: 409, headers: JSON_HEADERS }
          );
        }
        throw err;
      }
      if (!updated) {
        return new Response(JSON.stringify({ error: "case not found" }), {
          status: 404,
          headers: JSON_HEADERS,
        });
      }
      return new Response(JSON.stringify(toApiCase(updated)), {
        headers: JSON_HEADERS,
      });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
