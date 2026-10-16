-- ============ M4 多用户协作 ============
-- 设计依据：docs/multi-user-module-design.md §2
-- ① sessions：服务端会话表（opaque token 只存 SHA-256 哈希，双限过期：空闲 14 天滑动续期 + 绝对 30 天）
-- ② users.must_change_password：内置弱口令 admin 首登强制改密（D4，按哈希指纹精确匹配，不误伤已改密用户）

CREATE TABLE IF NOT EXISTS sessions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash     TEXT    NOT NULL UNIQUE,    -- token 的 SHA-256 hex（非明文，拖库不可复用）
    user_id        INTEGER NOT NULL,
    created_at     TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
    expires_at     TEXT    NOT NULL,           -- 绝对上限：created_at + 30 天，不可续（OWASP 双限时）
    last_active_at TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),  -- 滑动基准：空闲 14 天失效
    user_agent     TEXT    NOT NULL DEFAULT '',
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;

-- 仅当内置 admin 的密码哈希未被修改过时标记强制改密（新装库与存量库路径一致）
UPDATE users SET must_change_password = 1
 WHERE id = 1
   AND password_hash = 'pbkdf2_sha256$19270a0d690f42a9623202ab9fbc5741$d45f7e5a76a72091f8b3473b68f3fb354e8927f8e47ef82bc06b8436b744bd7c';
