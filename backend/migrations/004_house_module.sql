-- 004 选房模块（M-house1）：房源档案扩展（价格分制 + 配套标签 + 维度评分）+ 房源照片 + 评分权重配置
-- 设计依据：docs/house-module-design.md §2

-- 房源档案：价格统一为分（决策点 D2）+ 配套设施标签 + 六维度评分 JSON
ALTER TABLE house_candidates ADD COLUMN total_price_cents INTEGER;   -- 总价（分）
ALTER TABLE house_candidates ADD COLUMN unit_price_cents  INTEGER;   -- 单价（分/㎡）
ALTER TABLE house_candidates ADD COLUMN features   TEXT NOT NULL DEFAULT '[]'; -- 配套设施标签 [{label, value}]
ALTER TABLE house_candidates ADD COLUMN dim_scores TEXT NOT NULL DEFAULT '{}'; -- 维度评分 {location: 0~5, ...}

-- M0 遗留价格（REAL：万元 / 元㎡）一次性换算迁移后弃用（决策点 D2）
UPDATE house_candidates
   SET total_price_cents = CAST(ROUND(total_price * 1000000) AS INTEGER)
 WHERE total_price IS NOT NULL AND total_price_cents IS NULL;
UPDATE house_candidates
   SET unit_price_cents = CAST(ROUND(unit_price * 100) AS INTEGER)
 WHERE unit_price IS NOT NULL AND unit_price_cents IS NULL;

-- 房源照片：文件体存 uploads/house/，仅元数据入库（架构硬约束）
CREATE TABLE IF NOT EXISTS house_photos (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id  INTEGER NOT NULL,
    kind          TEXT    NOT NULL DEFAULT 'other',   -- exterior 外观 / interior 室内 / layout 户型图 / other 其他
    file_name     TEXT    NOT NULL,
    file_path     TEXT    NOT NULL,                   -- uploads/house/{candidate_id}/{uuid}.{ext}
    file_size     INTEGER NOT NULL,
    file_type     TEXT    NOT NULL,                   -- jpg/jpeg/png/webp/heic
    remark        TEXT    NOT NULL DEFAULT '',
    created_at    TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (candidate_id) REFERENCES house_candidates (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_house_photos_candidate ON house_photos (candidate_id);

-- 加权评分权重配置（每用户一行）：键为 6 维度，值 0~100 整数、合计 100（决策点 D5：用户可自定义）
CREATE TABLE IF NOT EXISTS house_scoring_config (
    user_id    INTEGER PRIMARY KEY,
    weights    TEXT    NOT NULL,
    updated_at TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);
