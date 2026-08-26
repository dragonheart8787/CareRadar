import type { CaseRow } from "./types";

/** raw_text / summary 都是使用者自由文字，一律逸出後才進 HTML。 */
function escapeHtml(value: string | null): string {
  if (value === null) return "";
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderCaseColumn(
  label: string,
  row: CaseRow | null,
  missingText: string
): string {
  if (!row) {
    return /* html */ `<div class="col">
      <div class="col-label">${escapeHtml(label)}</div>
      <div class="missing">${escapeHtml(missingText)}</div>
    </div>`;
  }
  return /* html */ `<div class="col">
    <div class="col-label">${escapeHtml(label)}</div>
    <div class="case-id">#${row.id}</div>
    <dl>
      <dt>摘要</dt><dd>${escapeHtml(row.summary) || "（無）"}</dd>
      <dt>原始通報內容</dt><dd class="raw">${escapeHtml(row.raw_text)}</dd>
      <dt>通報時間</dt><dd>${escapeHtml(row.reported_at)} UTC</dd>
      <dt>狀態</dt><dd>${escapeHtml(row.status)}</dd>
    </dl>
  </div>`;
}

export function renderDuplicatesHtml(
  pairs: Array<{ duplicate: CaseRow; original: CaseRow | null }>,
  adminKey: string
): string {
  // JSON.stringify 不會逸出 "</script>"，額外把 < 轉成 < 才不會提早結束 script。
  const keyLiteral = JSON.stringify(adminKey).replace(/</g, "\\u003c");

  const body = pairs.length
    ? pairs
        .map(
          (p) => /* html */ `<section class="pair">
      <h2>疑似重複：#${p.duplicate.id} ↔ #${
        p.duplicate.possible_duplicate_of ?? "?"
      }</h2>
      <div class="cols">
        ${renderCaseColumn("這筆（疑似重複）", p.duplicate, "（案件不存在）")}
        ${renderCaseColumn(
          "原始案件",
          p.original,
          "（找不到原始案件，可能已被刪除）"
        )}
      </div>
      <div class="actions">
        <button class="danger" data-id="${p.duplicate.id}" data-action="merge">
          確認合併（關閉這筆重複案件）
        </button>
        <button data-id="${p.duplicate.id}" data-action="not_duplicate">
          不是重複（保留兩筆）
        </button>
      </div>
    </section>`
        )
        .join("\n")
    : /* html */ `<p class="empty">目前沒有待複核的疑似重複案件。</p>`;

  return /* html */ `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>疑似重複案件複核｜災後需求雷達</title>
<style>
  :root{
    --bg:#10151d; --panel:#161d29; --panel-2:#1c2432; --line:#2a3444;
    --ink:#e9edf3; --ink-dim:#93a1b5; --amber:#e2a23b; --red:#d9634a; --teal:#4fb0a3;
  }
  *{ box-sizing:border-box; }
  body{
    margin:0; padding:24px; background:var(--bg); color:var(--ink);
    font-family:system-ui, "Noto Sans TC", sans-serif; line-height:1.6;
  }
  h1{ font-size:20px; margin:0 0 4px; }
  .lede{ color:var(--ink-dim); font-size:13px; margin:0 0 24px; max-width:70ch; }
  .empty{ color:var(--ink-dim); }
  .pair{
    background:var(--panel); border:1px solid var(--line); border-radius:10px;
    padding:14px 16px; margin-bottom:16px;
  }
  .pair h2{ font-size:14px; margin:0 0 12px; color:var(--amber); }
  .cols{ display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  @media (max-width:760px){ .cols{ grid-template-columns:1fr; } }
  .col{ background:var(--panel-2); border:1px solid var(--line); border-radius:8px; padding:10px 12px; }
  .col-label{ font-size:11px; color:var(--ink-dim); text-transform:uppercase; letter-spacing:.05em; }
  .case-id{ font-family:ui-monospace, monospace; font-size:18px; color:var(--teal); margin-bottom:6px; }
  dl{ margin:0; font-size:13px; }
  dt{ color:var(--ink-dim); font-size:11px; margin-top:8px; }
  dd{ margin:0; }
  dd.raw{ white-space:pre-wrap; word-break:break-word; }
  .missing{ color:var(--ink-dim); font-style:italic; padding:8px 0; }
  .actions{ display:flex; gap:8px; margin-top:12px; flex-wrap:wrap; }
  button{
    padding:8px 14px; border-radius:6px; border:1px solid var(--teal);
    background:transparent; color:var(--teal); font-size:13px; cursor:pointer;
    font-family:inherit;
  }
  button.danger{ border-color:var(--red); color:var(--red); }
  button:disabled{ opacity:.4; cursor:default; }
</style>
</head>
<body>
<h1>疑似重複案件複核</h1>
<p class="lede">
  系統只標記、不自動合併 —— 誤合併（把兩戶不同人家的需求當成一件）比留著一個
  未處理的重複案件危害更大。請比對兩筆的原始通報內容後再決定。
</p>
${body}

<script>
const ADMIN_KEY = ${keyLiteral};

document.querySelectorAll('button[data-id]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const id = btn.dataset.id;
    const action = btn.dataset.action;
    document.querySelectorAll('button[data-id]').forEach(b => b.disabled = true);
    try {
      const res = await fetch('/api/admin/duplicates/' + id + '/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, key: ADMIN_KEY }),
      });
      if (!res.ok) {
        alert('處理失敗（HTTP ' + res.status + '），請重新整理後再試。');
        document.querySelectorAll('button[data-id]').forEach(b => b.disabled = false);
        return;
      }
      // 重新 GET 同一個網址（query string 裡的 key 會一起帶著）。
      location.reload();
    } catch (err) {
      alert('連線失敗，請重新整理後再試。');
      document.querySelectorAll('button[data-id]').forEach(b => b.disabled = false);
    }
  });
});
</script>
</body>
</html>`;
}
