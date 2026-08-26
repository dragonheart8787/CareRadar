export function renderHtml(): string {
  return /* html */ `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>災後需求雷達｜關懷優先排序 × 志工智慧媒合</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=IBM+Plex+Sans+TC:wght@400;500;700&family=IBM+Plex+Mono:wght@500;600&display=swap" rel="stylesheet">
<style>
  :root{
    --bg: #10151d;
    --panel: #161d29;
    --panel-2: #1c2432;
    --line: #2a3444;
    --ink: #e9edf3;
    --ink-dim: #93a1b5;
    --amber: #e2a23b;
    --amber-dim: #4a3a20;
    --teal: #4fb0a3;
    --red: #d9634a;
  }
  *{ box-sizing:border-box; }
  body{
    margin:0; background:var(--bg); color:var(--ink);
    font-family:"IBM Plex Sans TC", system-ui, sans-serif;
  }
  header{
    padding:20px 24px 14px; border-bottom:1px solid var(--line);
    display:flex; align-items:baseline; gap:14px; flex-wrap:wrap;
  }
  header h1{
    font-family:"Space Grotesk", "IBM Plex Sans TC", sans-serif;
    font-size:20px; font-weight:700; margin:0; letter-spacing:0.02em;
  }
  header p{ margin:0; color:var(--ink-dim); font-size:13px; }
  .layout{ display:grid; grid-template-columns: 420px 1fr; height:calc(100vh - 66px); }
  @media (max-width: 900px){ .layout{ grid-template-columns: 1fr; height:auto; } #map{ height:420px; } }

  .list-panel{ overflow-y:auto; border-right:1px solid var(--line); }
  .toggle-row{ display:flex; gap:8px; padding:14px; border-bottom:1px solid var(--line); }
  .toggle-btn{
    flex:1; padding:9px 8px; border-radius:8px; border:1px solid var(--line);
    background:var(--panel-2); color:var(--ink-dim); font-size:13px; cursor:pointer;
    font-family:"IBM Plex Sans TC", sans-serif;
  }
  .toggle-btn.active{ background:var(--amber-dim); color:var(--amber); border-color:var(--amber); }
  .hint{ padding:0 14px 10px; color:var(--ink-dim); font-size:12px; line-height:1.6; }

  .card{
    margin:10px 14px; padding:12px 14px; background:var(--panel);
    border:1px solid var(--line); border-radius:10px; cursor:pointer;
    transition:border-color .15s;
  }
  .card:hover{ border-color:var(--amber); }
  .card.full{ opacity:0.55; }
  .card-top{ display:flex; justify-content:space-between; align-items:flex-start; gap:8px; }
  .rank{ font-family:"IBM Plex Mono", monospace; color:var(--ink-dim); font-size:12px; }
  .score{ font-family:"IBM Plex Mono", monospace; font-size:22px; font-weight:600; color:var(--amber); }
  .score-label{ font-size:10px; color:var(--ink-dim); text-align:right; }
  .summary{ font-size:13.5px; margin:8px 0 6px; line-height:1.5; }
  .tags{ display:flex; gap:6px; flex-wrap:wrap; margin-bottom:8px; }
  .tag{ font-size:11px; padding:2px 8px; border-radius:100px; border:1px solid var(--line); color:var(--ink-dim); }
  .tag.warn{ color:var(--red); border-color:var(--red); }
  .tag.ok{ color:var(--teal); border-color:var(--teal); }

  .bars{ display:flex; height:6px; border-radius:4px; overflow:hidden; background:var(--panel-2); margin-bottom:8px; }
  .bar-v{ background:#c85fbf; } .bar-s{ background:var(--red); }
  .bar-u{ background:var(--amber); } .bar-r{ background:var(--teal); }

  .claim-row{ display:flex; gap:6px; align-items:center; font-size:12px; }
  .claim-row input{
    flex:1; background:var(--panel-2); border:1px solid var(--line); border-radius:6px;
    color:var(--ink); padding:6px 8px; font-size:12px; font-family:inherit;
  }
  .claim-row button{
    padding:6px 12px; border-radius:6px; border:1px solid var(--teal); background:transparent;
    color:var(--teal); font-size:12px; cursor:pointer; white-space:nowrap;
  }
  .claim-row button:disabled{ opacity:0.4; cursor:default; }
  .slots{ font-family:"IBM Plex Mono", monospace; font-size:12px; color:var(--ink-dim); }

  .addr-row{ margin-top:8px; }
  .addr-row button{
    padding:5px 10px; border-radius:6px; border:1px solid var(--amber); background:transparent;
    color:var(--amber); font-size:12px; cursor:pointer; font-family:inherit;
  }
  .addr-out:not(:empty){
    margin-top:6px; padding:7px 9px; border-radius:6px; background:var(--panel-2);
    font-size:12px; color:var(--ink); line-height:1.6; word-break:break-all;
  }

  #map{ height:100%; }
  .leaflet-popup-content{ font-family:"IBM Plex Sans TC", sans-serif; font-size:13px; }
</style>
</head>
<body>
<header>
  <h1>災後需求雷達</h1>
  <p>關懷優先排序（Care Score）× 志工智慧媒合 — MVP Demo</p>
</header>
<div class="layout">
  <div class="list-panel">
    <div class="toggle-row">
      <button class="toggle-btn" data-sort="latest">最新回報排序</button>
      <button class="toggle-btn active" data-sort="care_score">Care Score 排序</button>
    </div>
    <div class="hint" id="hint"></div>
    <div id="list"></div>
  </div>
  <div id="map"></div>
</div>

<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const HINTS = {
  latest: "模擬社群媒體式排序：只看誰最新發文，不知道案件其實已經有沒有人幫。額滿的案件（灰色）仍然會排在很前面。",
  care_score: "依關懷優先指數排序，額滿案件會自動從清單移除、志工自動被導向仍缺人的案件。",
};

const map = L.map('map').setView([22.972, 120.258], 15);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

let markers = [];
let currentSort = 'care_score';

function scoreTierColor(score){
  if (score >= 55) return '#d9634a';
  if (score >= 35) return '#e2a23b';
  return '#4fb0a3';
}

function needTypeLabel(t){
  return ({
    debris_removal: '清淤', furniture_moving: '搬家具', drinking_water: '飲用水',
    cleaning_supplies: '清潔用品', water_electricity_repair: '水電', other: '其他'
  })[t] || t;
}

async function loadCases(sort){
  const includeFull = sort === 'latest' ? '&include_full=1' : '';
  const res = await fetch('/api/cases?sort=' + sort + includeFull);
  return res.json();
}

function renderList(cases){
  const list = document.getElementById('list');
  list.innerHTML = '';
  cases.forEach((c, i) => {
    const needTypes = (c.need_types_parsed || []).map(needTypeLabel).join(' · ');
    const isFull = c.status === 'full';
    const b = c.score_breakdown;
    const totalForBar = Math.max(b.vulnerability + b.severity + b.urgency + b.resource_gap, 1);
    const claimToken = readClaimToken(c.id);
    const card = document.createElement('div');
    card.className = 'card' + (isFull ? ' full' : '');
    card.innerHTML = \`
      <div class="card-top">
        <div>
          <span class="rank">#\${i + 1}</span>
          <div class="summary">\${c.summary || c.raw_text}</div>
          <div class="tags">
            \${isFull ? '<span class="tag ok">已額滿</span>' : ''}
            \${c.needs_human_verification ? '<span class="tag warn">資訊待複核</span>' : ''}
            \${needTypes ? '<span class="tag">' + needTypes + '</span>' : ''}
          </div>
        </div>
        <div style="text-align:right">
          <div class="score">\${b.total.toFixed(1)}</div>
          <div class="score-label">CARE SCORE</div>
        </div>
      </div>
      <div class="bars">
        <div class="bar-v" style="width:\${(b.vulnerability/totalForBar)*100}%"></div>
        <div class="bar-s" style="width:\${(b.severity/totalForBar)*100}%"></div>
        <div class="bar-u" style="width:\${(b.urgency/totalForBar)*100}%"></div>
        <div class="bar-r" style="width:\${(b.resource_gap/totalForBar)*100}%"></div>
      </div>
      <div class="claim-row">
        <span class="slots">志工 \${c.volunteers_assigned}/\${c.volunteers_needed}</span>
        <input type="text" placeholder="你的稱呼（選填）" id="name-\${c.id}" \${isFull ? 'disabled' : ''}/>
        <button data-id="\${c.id}" \${isFull ? 'disabled' : ''}>我要認領</button>
      </div>
      \${claimToken ? '<div class="addr-row"><button class="addr-btn">查看精確地址</button><div class="addr-out" id="addr-' + c.id + '"></div></div>' : ''}
    \`;
    card.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
      if (c.public_lat) map.setView([c.public_lat, c.public_lng], 17);
    });
    card.querySelector('button')?.addEventListener('click', () => claimCase(c.id));
    card.querySelector('.addr-btn')?.addEventListener('click', () => showAddress(c.id));
    list.appendChild(card);
  });
}

function renderMarkers(cases){
  markers.forEach(m => map.removeLayer(m));
  markers = [];
  cases.forEach(c => {
    if (!c.public_lat || !c.public_lng) return;
    const color = c.status === 'full' ? '#3d4758' : scoreTierColor(c.score_breakdown.total);
    const marker = L.circleMarker([c.public_lat, c.public_lng], {
      radius: 9, color, fillColor: color, fillOpacity: 0.75, weight: 2,
    }).addTo(map);
    marker.bindPopup(
      '<b>Care Score: ' + c.score_breakdown.total.toFixed(1) + '</b><br>' +
      (c.summary || c.raw_text) + '<br>志工 ' + c.volunteers_assigned + '/' + c.volunteers_needed
    );
    markers.push(marker);
  });
}

async function refresh(){
  document.getElementById('hint').textContent = HINTS[currentSort];
  const cases = await loadCases(currentSort);
  renderList(cases);
  renderMarkers(cases);
}

async function claimCase(id){
  const nameInput = document.getElementById('name-' + id);
  const name = nameInput ? nameInput.value : '';
  const res = await fetch('/api/cases/' + id + '/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name || '匿名志工' }),
  });
  if (res.status === 409) {
    alert('慢了一步 —— 這個案件的志工名額剛好被別人搶走了，已經自動幫你換一個案件看看。');
  } else if (!res.ok) {
    alert('認領失敗，請稍後再試。');
  } else {
    // claim_token 只會在這一次回應裡出現，錯過就換不回精確地址了。
    const data = await res.json();
    if (data.claim_token) writeClaimToken(id, data.claim_token);
  }
  refresh();
}

function readClaimToken(id){
  try { return localStorage.getItem('claim_token_' + id); } catch { return null; }
}

function writeClaimToken(id, token){
  try { localStorage.setItem('claim_token_' + id, token); } catch {}
}

async function showAddress(id){
  const token = readClaimToken(id);
  const out = document.getElementById('addr-' + id);
  if (!token || !out) return;
  out.textContent = '查詢中…';
  const res = await fetch(
    '/api/cases/' + id + '/address?token=' + encodeURIComponent(token)
  );
  if (!res.ok) {
    out.textContent = '無法取得精確地址（認領憑證已失效）。';
    return;
  }
  const a = await res.json();
  const coords = (a.exact_lat != null && a.exact_lng != null)
    ? a.exact_lat.toFixed(6) + ', ' + a.exact_lng.toFixed(6)
    : '（無精確座標）';
  // 用 textContent 而不是 innerHTML：location_text 來自使用者通報的自由文字。
  out.textContent = (a.location_text || '（無地址文字）') + '\\n精確座標：' + coords;
  out.style.whiteSpace = 'pre-line';
}

document.querySelectorAll('.toggle-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentSort = btn.dataset.sort;
    refresh();
  });
});

refresh();
setInterval(refresh, 15000);
</script>
</body>
</html>`;
}
