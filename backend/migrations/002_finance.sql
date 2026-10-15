-- 002_finance.sql — 理财模块 M2：家庭资产台账（docs/finance-dev-plan.md §2）
-- 设计：资产负债表型 asset registry；金额一律整数分；extra JSON 存分类专属字段；
--       已还金额不落库，由 finance_asset_events(type='repay') 汇总（还款留痕）。
BEGIN TRANSACTION;

-- 清理 M0 占位表（尚无业务数据，直接删除；旧索引随表自动清理）
DROP TABLE IF EXISTS finance_accounts;
DROP TABLE IF EXISTS finance_transactions;

-- ============ 家庭成员字典（归属人） ============
CREATE TABLE IF NOT EXISTS finance_members (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    note       TEXT    NOT NULL DEFAULT '',
    user_id    INTEGER,                          -- 预留：M4 关联 users.id
    is_active  INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ============ 预置资产分类（仅允许停用，不允许新建/改名） ============
CREATE TABLE IF NOT EXISTS finance_categories (
    code       TEXT PRIMARY KEY,                 -- 编码表见 dev-plan §2.1
    name       TEXT NOT NULL,
    direction  TEXT NOT NULL,                    -- asset / liability
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active  INTEGER NOT NULL DEFAULT 1
);

-- ============ 资产/负债台账（核心实体） ============
CREATE TABLE IF NOT EXISTS finance_assets (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL,
    direction        TEXT    NOT NULL,           -- asset / liability
    category         TEXT    NOT NULL,           -- 引用 finance_categories.code
    holder_member_id INTEGER NOT NULL,
    institution      TEXT    NOT NULL DEFAULT '', -- 银行/发行机构/借款人/债权人
    amount_cents     INTEGER NOT NULL,           -- 定期=本金 活期=余额 股票=市值 外借=借款总额 房贷=剩余本金
    start_date       TEXT,                       -- YYYY-MM-DD，可空
    end_date         TEXT,                       -- 到期/约定归还日，可空
    annual_rate      REAL,                       -- 年利率 %（NULL = 无息/不适用）
    status           TEXT    NOT NULL DEFAULT 'holding',  -- holding / settled
    settle_action    TEXT,                       -- withdraw / renew / repay / clear
    settled_at       TEXT,
    extra            TEXT    NOT NULL DEFAULT '{}',  -- 分类专属字段 JSON
    note             TEXT    NOT NULL DEFAULT '',
    is_deleted       INTEGER NOT NULL DEFAULT 0,     -- 软删除
    user_id          INTEGER NOT NULL,
    created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (holder_member_id) REFERENCES finance_members (id),
    FOREIGN KEY (user_id)          REFERENCES users (id)
);

-- ============ 价值/市值历史（趋势图与"手动更新市值"数据源） ============
CREATE TABLE IF NOT EXISTS finance_asset_values (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id    INTEGER NOT NULL,
    value_date  TEXT    NOT NULL,                -- YYYY-MM-DD
    value_cents INTEGER NOT NULL,
    note        TEXT    NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (asset_id) REFERENCES finance_assets (id) ON DELETE CASCADE
);

-- ============ 附件（借据/存单/合同扫描件） ============
CREATE TABLE IF NOT EXISTS finance_attachments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id   INTEGER NOT NULL,
    file_name  TEXT    NOT NULL,                 -- 展示用原始文件名
    file_path  TEXT    NOT NULL,                 -- 相对 data/uploads/finance 的路径
    file_type  TEXT    NOT NULL,                 -- 扩展名（白名单）
    file_size  INTEGER NOT NULL,                 -- 字节
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (asset_id) REFERENCES finance_assets (id) ON DELETE CASCADE
);

-- ============ 操作日志 + 还款记录 ============
CREATE TABLE IF NOT EXISTS finance_asset_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id   INTEGER NOT NULL,
    event_type TEXT    NOT NULL,                 -- create/update/value/attachment/settle/repay
    detail     TEXT    NOT NULL DEFAULT '{}',    -- JSON 摘要（repay 含 amount_cents/date）
    user_id    INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (asset_id) REFERENCES finance_assets (id) ON DELETE CASCADE
);

-- ============ 索引 ============
CREATE INDEX IF NOT EXISTS idx_fa_category ON finance_assets (category);
CREATE INDEX IF NOT EXISTS idx_fa_holder   ON finance_assets (holder_member_id);
CREATE INDEX IF NOT EXISTS idx_fa_end_date ON finance_assets (end_date);
CREATE INDEX IF NOT EXISTS idx_fa_deleted  ON finance_assets (is_deleted);
CREATE INDEX IF NOT EXISTS idx_fav_asset   ON finance_asset_values (asset_id, value_date);
CREATE INDEX IF NOT EXISTS idx_fae_asset   ON finance_asset_events (asset_id, created_at);

-- ============ 种子：预置分类（12 类，与前端 common.js 镜像一致） ============
INSERT OR IGNORE INTO finance_categories (code, name, direction, sort_order) VALUES
 ('fixed_deposit','银行定期','asset',1),  ('demand','银行活期','asset',2),
 ('wealth','理财产品','asset',3),        ('metal','贵金属','asset',4),
 ('stock','股票基金','asset',5),         ('loan_out','外借（债权）','asset',6),
 ('bond_insurance','国债保险','asset',7),('asset_other','其他资产','asset',8),
 ('mortgage','房贷','liability',9),      ('loan_in','外债（欠款）','liability',10),
 ('credit_card','信用卡/消费贷','liability',11), ('liability_other','其他负债','liability',12);

-- 默认家庭成员（首位成员即"归属人=本人"默认项）
INSERT OR IGNORE INTO finance_members (name, note) VALUES ('本人', '默认成员');

COMMIT;
