import type { CaseRow, Env } from "./types";
import { computeCareScore } from "./care_score";
import { claimCase, getCase, listCases, verifyClaimToken } from "./db";
import { handleLineWebhook } from "./line";
import { renderHtml } from "./frontend";

function toApiCase(row: CaseRow) {
  return {
    id: row.id,
    status: row.status,
    raw_text: row.raw_text,
    summary: row.summary,
    location_text: row.location_text,
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
      // claim_token 只在這一次回應出現，之後系統只留雜湊值。
      return new Response(
        JSON.stringify({
          ...toApiCase(claimed.case),
          claim_token: claimed.claimToken,
        }),
        { headers: JSON_HEADERS }
      );
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
