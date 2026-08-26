-- 合成示範資料（台南仁德區一帶座標），刻意設計成能在 Demo 現場對比
-- 「最新回報排序」vs「Care Score排序」的差異。
-- exact_* 與 public_* 座標在示範資料中相同，方便你自己核對模糊化邏輯；
-- 實際上線時 public_* 應該用 fuzzLocation() 產生。

-- 案件 1：本題原始情境 —— 高脆弱、高嚴重度，但通報已 10 小時、0 志工、無照片
-- 在「最新回報」排序下會被埋在很後面；在 Care Score 排序應該衝到第一。
INSERT INTO cases
  (source, raw_text, location_text, exact_lat, exact_lng, public_lat, public_lng,
   age, lives_alone, mobility_impaired, has_young_children, household_size,
   flood_depth_cm, no_water, no_electricity, need_types,
   volunteers_needed, volunteers_assigned, summary, confidence_score,
   needs_human_verification, status, reported_at)
VALUES
  ('line', '我住台南仁德，76歲，一個人住，家裡淹了60公分，需要兩個人幫忙搬家具，也沒有飲用水。',
   '台南市仁德區', 22.9715, 120.2570, 22.9715, 120.2570,
   76, 1, 0, 0, 1,
   60, 1, 0, '["furniture_moving","drinking_water"]',
   2, 0, '76歲獨居長者，淹水60cm，需2人搬家具，缺飲用水', 0.9,
   0, 'open', datetime('now','-10 hours'));

-- 案件 2：曝光度高、恢復快的「網路熱門」案件 —— 20 分鐘前才發文，
-- 需求 2 人已經額滿。故意讓它在「最新回報」排序名列前茅，
-- 藉此展示：naive 排序無法反映「其實已經不缺人了」。
INSERT INTO cases
  (source, raw_text, location_text, exact_lat, exact_lng, public_lat, public_lng,
   age, lives_alone, mobility_impaired, has_young_children, household_size,
   flood_depth_cm, no_water, no_electricity, need_types,
   volunteers_needed, volunteers_assigned, summary, confidence_score,
   needs_human_verification, status, reported_at)
VALUES
  ('line', '仁德附近淹水大概20公分，家裡兩個年輕人自己可以整理，缺工具，已經有朋友要來幫忙了！',
   '台南市仁德區', 22.9740, 120.2600, 22.9740, 120.2600,
   NULL, 0, 0, 0, 2,
   20, 0, 0, '["cleaning_supplies"]',
   2, 2, '年輕家庭，輕度淹水，志工名額已滿', 0.7,
   0, 'full', datetime('now','-20 minutes'));

-- 案件 3：中度優先 —— 高齡行動不便，已有 1 位志工，還缺 2 位
INSERT INTO cases
  (source, raw_text, location_text, exact_lat, exact_lng, public_lat, public_lng,
   age, lives_alone, mobility_impaired, has_young_children, household_size,
   flood_depth_cm, no_water, no_electricity, need_types,
   volunteers_needed, volunteers_assigned, summary, confidence_score,
   needs_human_verification, status, reported_at)
VALUES
  ('proxy', '（里長代填）仁德一戶老夫妻，阿公中風行動不便，家裡淹水約40公分，需要清淤跟搬家具。',
   '台南市仁德區', 22.9690, 120.2540, 22.9690, 120.2540,
   82, 0, 1, 0, 2,
   40, 0, 1, '["debris_removal","furniture_moving"]',
   3, 1, '高齡夫妻，一人行動不便，缺水電已排除但仍缺清淤人力', 0.85,
   0, 'open', datetime('now','-3 hours'));

-- 案件 4：有幼兒的家庭，缺水缺電，1 小時前通報，尚無志工
INSERT INTO cases
  (source, raw_text, location_text, exact_lat, exact_lng, public_lat, public_lng,
   age, lives_alone, mobility_impaired, has_young_children, household_size,
   flood_depth_cm, no_water, no_electricity, need_types,
   volunteers_needed, volunteers_assigned, summary, confidence_score,
   needs_human_verification, status, reported_at)
VALUES
  ('line', '仁德，家裡有一個一歲小孩，淹水約35公分，沒水沒電，需要幫忙清潔跟搬東西，2位就好。',
   '台南市仁德區', 22.9760, 120.2555, 22.9760, 120.2555,
   NULL, 0, 0, 1, 3,
   35, 1, 1, '["cleaning_supplies","furniture_moving"]',
   2, 0, '有一歲幼兒的家庭，缺水缺電，尚無志工承接', 0.75,
   0, 'open', datetime('now','-1 hours'));

-- 案件 5：很新但優先度低 —— 5 分鐘前發文，年輕單身、輕微清潔需求
-- 用來凸顯「最新回報」排序會把這種案件排到最前面
INSERT INTO cases
  (source, raw_text, location_text, exact_lat, exact_lng, public_lat, public_lng,
   age, lives_alone, mobility_impaired, has_young_children, household_size,
   flood_depth_cm, no_water, no_electricity, need_types,
   volunteers_needed, volunteers_assigned, summary, confidence_score,
   needs_human_verification, status, reported_at)
VALUES
  ('line', '仁德租屋處進了一點水，大概10公分，需要一個人幫忙搬一下東西就好，我自己也可以。',
   '台南市仁德區', 22.9700, 120.2620, 22.9700, 120.2620,
   NULL, 0, 0, 0, 1,
   10, 0, 0, '["furniture_moving"]',
   1, 0, '單人租屋，輕度淹水，需求較輕微', 0.6,
   0, 'open', datetime('now','-5 minutes'));

-- 案件 6：低 Confidence（資訊不全）—— 沒有年齡/獨居資訊，用來展示
-- 「Confidence Score 低」不等於「Priority 被打折」：unknown_bonus 會補償，
-- 並標記 needs_human_verification=1 讓人工去電確認。
INSERT INTO cases
  (source, raw_text, location_text, exact_lat, exact_lng, public_lat, public_lng,
   age, lives_alone, mobility_impaired, has_young_children, household_size,
   flood_depth_cm, no_water, no_electricity, need_types,
   volunteers_needed, volunteers_assigned, summary, confidence_score,
   needs_human_verification, status, reported_at)
VALUES
  ('line', '仁德那邊淹水很嚴重，我阿嬤家沒人可以顧，麻煩幫忙看一下',
   '台南市仁德區', 22.9725, 120.2585, 22.9725, 120.2585,
   NULL, NULL, NULL, 0, NULL,
   NULL, 0, 0, '["debris_removal"]',
   2, 0, '資訊不全（無年齡/獨居狀態），需人工複核確認詳情', 0.3,
   1, 'open', datetime('now','-2 hours'));
