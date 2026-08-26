-- 災後需求雷達 - D1 schema
-- 設計原則：
--   1. exact_lat/exact_lng 只給已認領的志工看；public_lat/public_lng 是模糊化後
--      的座標，是地圖上公開顯示的內容（保護獨居/弱勢者的精確位置）。
--   2. case_status_history 是稽核軌跡，用來回答「這個案件為什麼被排到這裡」。
--   3. 沒有任何一個查詢會「悄悄」把資料不全的案件過濾掉 —— 資料不全只會被標記
--      needs_human_verification，不會被拿掉。

CREATE TABLE IF NOT EXISTS cases (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  source                  TEXT NOT NULL DEFAULT 'line',     -- line | web | proxy(里長代填)
  reporter_line_user_id   TEXT,
  raw_text                TEXT NOT NULL,

  location_text           TEXT,                              -- AI 抽取出的地址/地區文字
  exact_lat               REAL,
  exact_lng               REAL,
  public_lat              REAL,                              -- 模糊化座標（公開地圖用）
  public_lng              REAL,

  age                     INTEGER,
  lives_alone             INTEGER,                           -- 0/1, NULL=未知
  mobility_impaired       INTEGER,
  has_young_children      INTEGER,
  household_size          INTEGER,

  flood_depth_cm          INTEGER,
  no_water                INTEGER DEFAULT 0,
  no_electricity          INTEGER DEFAULT 0,
  need_types              TEXT,                              -- JSON array, e.g. ["debris_removal","drinking_water"]

  volunteers_needed       INTEGER NOT NULL DEFAULT 1,
  volunteers_assigned     INTEGER NOT NULL DEFAULT 0,

  summary                 TEXT,                              -- AI 產生的一行摘要
  confidence_score        REAL,                              -- 0~1，規則式計算，不是模型自報
  needs_human_verification INTEGER NOT NULL DEFAULT 0,
  possible_duplicate_of   INTEGER,                            -- 指向疑似重複的案件 id（不自動合併）

  status                  TEXT NOT NULL DEFAULT 'open',      -- open | full | closed
  reported_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status);
CREATE INDEX IF NOT EXISTS idx_cases_location ON cases(public_lat, public_lng);

CREATE TABLE IF NOT EXISTS case_status_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id     INTEGER NOT NULL,
  event       TEXT NOT NULL,   -- created | claimed | full | reopened | verified | flagged_duplicate
  detail      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (case_id) REFERENCES cases(id)
);

CREATE TABLE IF NOT EXISTS volunteer_claims (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id             INTEGER NOT NULL,
  volunteer_name      TEXT,
  volunteer_contact   TEXT,
  claimed_at          TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (case_id) REFERENCES cases(id)
);
