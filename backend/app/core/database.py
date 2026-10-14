"""SQLite 存储层：连接管理 + 版本化迁移执行器。

设计要点（见 docs/architecture.md 第 6.2 节）：
- 每请求一个短连接（由 FastAPI 依赖注入管理生命周期），规避多线程复用问题
- WAL 模式提升并发读性能（SQLite 单写者限制 → 未来多实例按预案切换 PostgreSQL）
- 迁移：backend/migrations/NNN_desc.sql 按序执行，PRAGMA user_version 记录进度
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any, Iterable


class Database:
    def __init__(self, db_file: Path, migrations_dir: Path) -> None:
        self.db_file = db_file
        self.migrations_dir = migrations_dir
        db_file.parent.mkdir(parents=True, exist_ok=True)

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_file, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    # --- 查询工具（供服务层使用，保持 SQL 集中在服务层） ---
    @staticmethod
    def query(conn: sqlite3.Connection, sql: str, params: Iterable[Any] = ()) -> list[dict]:
        return [dict(row) for row in conn.execute(sql, tuple(params)).fetchall()]

    @staticmethod
    def execute(conn: sqlite3.Connection, sql: str, params: Iterable[Any] = ()) -> int:
        cursor = conn.execute(sql, tuple(params))
        conn.commit()
        return cursor.lastrowid or 0

    # --- 迁移执行器 ---
    def run_migrations(self) -> list[str]:
        """顺序执行未应用的迁移脚本，返回本次应用的文件名列表。"""
        applied: list[str] = []
        if not self.migrations_dir.exists():
            return applied
        conn = self.connect()
        try:
            conn.execute("PRAGMA journal_mode = WAL")
            current = conn.execute("PRAGMA user_version").fetchone()[0]
            for path in sorted(self.migrations_dir.glob("*.sql")):
                version = int(path.name.split("_", 1)[0])
                if version <= current:
                    continue
                conn.executescript(path.read_text(encoding="utf-8"))
                conn.execute(f"PRAGMA user_version = {version}")
                applied.append(path.name)
        finally:
            conn.close()
        return applied
