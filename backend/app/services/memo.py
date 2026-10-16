"""备忘录模块服务层（M1 首个完整功能模块）。

TODO(M1)：增删改查、置顶、状态流转（open/done）、优先级、到期提醒、标签过滤。
"""

from __future__ import annotations

import sqlite3

from app.core.database import Database


def list_memos(conn: sqlite3.Connection) -> list[dict]:
    # M4 全家庭共享（design §4.3）：读不过滤 user_id
    return Database.query(
        conn,
        "SELECT * FROM memos ORDER BY pinned DESC, id DESC",
    )
