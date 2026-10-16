-- 003 选车模块（M-car1）：车型档案扩展 + 4S 报价单 + 实车照片
-- 设计依据：docs/car-module-design.md §2

-- 车型档案：指导价（分）+ 配置特点标签 JSON
ALTER TABLE car_candidates ADD COLUMN guide_price_cents INTEGER;
ALTER TABLE car_candidates ADD COLUMN features TEXT NOT NULL DEFAULT '[]';

-- M0 遗留 price（万元 REAL）一次性换算迁移到 guide_price_cents 后弃用（决策点 D2）
UPDATE car_candidates
   SET guide_price_cents = CAST(ROUND(price * 1000000) AS INTEGER)
 WHERE price IS NOT NULL AND guide_price_cents IS NULL;

-- 4S 店报价单：一车型多报价；优惠/费用/赠品为多条目 JSON 列表
CREATE TABLE IF NOT EXISTS car_offers (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id   INTEGER NOT NULL,
    dealer_name    TEXT    NOT NULL,
    city           TEXT    NOT NULL DEFAULT '',
    contact        TEXT    NOT NULL DEFAULT '',
    offer_date     TEXT    NOT NULL,
    discount_items TEXT    NOT NULL DEFAULT '[]',   -- [{label, amount_cents}]
    fee_items      TEXT    NOT NULL DEFAULT '[]',   -- [{label, amount_cents}]
    gift_items     TEXT    NOT NULL DEFAULT '[]',   -- [{label, note}]
    notes          TEXT    NOT NULL DEFAULT '',
    created_at     TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at     TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (candidate_id) REFERENCES car_candidates (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_car_offers_candidate ON car_offers (candidate_id);

-- 实车照片：文件体存 uploads/car/，仅元数据入库（架构硬约束）
CREATE TABLE IF NOT EXISTS car_photos (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id INTEGER NOT NULL,
    kind         TEXT    NOT NULL DEFAULT 'other',   -- exterior / interior / other
    file_name    TEXT    NOT NULL,
    file_path    TEXT    NOT NULL,
    file_size    INTEGER NOT NULL,
    file_type    TEXT    NOT NULL,                    -- jpg/jpeg/png/webp/heic
    remark       TEXT    NOT NULL DEFAULT '',
    created_at   TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (candidate_id) REFERENCES car_candidates (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_car_photos_candidate ON car_photos (candidate_id);
