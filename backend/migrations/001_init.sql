-- 001_init.sql — FamilyAssistant 初始 schema（M0 框架阶段）
-- 通用约定：id 自增主键；user_id 预留多用户（M0 固定 1=admin）；
--          created_at/updated_at 为 ISO 时间戳文本；命名蛇形复数。
-- 迁移机制：core/database 按 PRAGMA user_version 顺序执行，禁止修改历史迁移。
BEGIN TRANSACTION;

-- ============ 用户（多团队协作预留） ============
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    display_name  TEXT    NOT NULL DEFAULT '',
    role          TEXT    NOT NULL DEFAULT 'member',  -- admin / member
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at    TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- 内置管理员：admin / admin123（占位口令，启用认证 FA_AUTH_ENABLED=true 前必须修改）
INSERT OR IGNORE INTO users (username, password_hash, display_name, role)
VALUES ('admin',
        'pbkdf2_sha256$19270a0d690f42a9623202ab9fbc5741$d45f7e5a76a72091f8b3473b68f3fb354e8927f8e47ef82bc06b8436b744bd7c',
        '管理员', 'admin');

-- ============ 理财 ============
CREATE TABLE IF NOT EXISTS finance_accounts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL DEFAULT 1,
    name            TEXT    NOT NULL,
    type            TEXT    NOT NULL DEFAULT 'cash',   -- cash / bank / investment / debt
    currency        TEXT    NOT NULL DEFAULT 'CNY',
    initial_balance REAL    NOT NULL DEFAULT 0,
    note            TEXT    NOT NULL DEFAULT '',
    created_at      TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (user_id) REFERENCES users (id)
);

CREATE TABLE IF NOT EXISTS finance_transactions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id  INTEGER NOT NULL,
    user_id     INTEGER NOT NULL DEFAULT 1,
    kind        TEXT    NOT NULL DEFAULT 'expense',    -- income / expense / transfer
    category    TEXT    NOT NULL DEFAULT '',
    amount      REAL    NOT NULL,
    occurred_at TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
    note        TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (account_id) REFERENCES finance_accounts (id),
    FOREIGN KEY (user_id)  REFERENCES users (id)
);

-- ============ 选房 ============
CREATE TABLE IF NOT EXISTS house_candidates (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL DEFAULT 1,
    title       TEXT    NOT NULL,
    community   TEXT    NOT NULL DEFAULT '',
    city        TEXT    NOT NULL DEFAULT '',
    district    TEXT    NOT NULL DEFAULT '',
    total_price REAL,
    unit_price  REAL,
    area        REAL,
    layout      TEXT    NOT NULL DEFAULT '',           -- 如 3室2厅2卫
    floor_info  TEXT    NOT NULL DEFAULT '',
    orientation TEXT    NOT NULL DEFAULT '',
    build_year  INTEGER,
    metro       TEXT    NOT NULL DEFAULT '',           -- 通勤/地铁信息
    status      TEXT    NOT NULL DEFAULT 'watching',   -- watching / visiting / comparing / dropped / chosen
    score       REAL,                                  -- 综合评分（M3 评分模型）
    pros        TEXT    NOT NULL DEFAULT '',
    cons        TEXT    NOT NULL DEFAULT '',
    notes       TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (user_id) REFERENCES users (id)
);

-- ============ 选车 ============
CREATE TABLE IF NOT EXISTS car_candidates (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL DEFAULT 1,
    brand      TEXT    NOT NULL,
    model      TEXT    NOT NULL,
    version    TEXT    NOT NULL DEFAULT '',
    year       INTEGER,
    energy     TEXT    NOT NULL DEFAULT 'fuel',       -- fuel / ev / hybrid
    price      REAL,
    mileage    REAL,                                   -- 二手车里程
    status     TEXT    NOT NULL DEFAULT 'watching',   -- watching / test_driving / comparing / dropped / chosen
    score      REAL,
    pros       TEXT    NOT NULL DEFAULT '',
    cons       TEXT    NOT NULL DEFAULT '',
    notes      TEXT    NOT NULL DEFAULT '',
    created_at TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (user_id) REFERENCES users (id)
);

-- ============ 备忘录 ============
CREATE TABLE IF NOT EXISTS memos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL DEFAULT 1,
    title      TEXT    NOT NULL,
    content    TEXT    NOT NULL DEFAULT '',
    priority   TEXT    NOT NULL DEFAULT 'normal',     -- low / normal / high
    status     TEXT    NOT NULL DEFAULT 'open',       -- open / done
    due_at     TEXT,
    tags       TEXT    NOT NULL DEFAULT '[]',          -- JSON 数组字符串（M1 解析）
    pinned     INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (user_id) REFERENCES users (id)
);

-- ============ 文件存档 ============
CREATE TABLE IF NOT EXISTS file_records (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL DEFAULT 1,
    original_name TEXT    NOT NULL,
    stored_path   TEXT    NOT NULL,                    -- data/uploads/ 下的相对路径
    size          INTEGER NOT NULL DEFAULT 0,
    mime_type     TEXT    NOT NULL DEFAULT '',
    category      TEXT    NOT NULL DEFAULT '',         -- 证件 / 合同 / 票据 / 其他（M1 细化）
    sha256        TEXT    NOT NULL DEFAULT '',
    note          TEXT    NOT NULL DEFAULT '',
    created_at    TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at    TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (user_id) REFERENCES users (id)
);

-- ============ 常用索引 ============
CREATE INDEX IF NOT EXISTS idx_finance_accounts_user   ON finance_accounts (user_id);
CREATE INDEX IF NOT EXISTS idx_finance_tx_user         ON finance_transactions (user_id);
CREATE INDEX IF NOT EXISTS idx_finance_tx_account      ON finance_transactions (account_id);
CREATE INDEX IF NOT EXISTS idx_house_candidates_user   ON house_candidates (user_id);
CREATE INDEX IF NOT EXISTS idx_car_candidates_user     ON car_candidates (user_id);
CREATE INDEX IF NOT EXISTS idx_memos_user_status       ON memos (user_id, status);
CREATE INDEX IF NOT EXISTS idx_file_records_user       ON file_records (user_id);

COMMIT;
