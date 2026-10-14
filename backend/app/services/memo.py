"""备忘录模块服务层（M1 首个完整功能模块）。

TODO(M1)：增删改查、置顶、状态流转（open/done）、优先级、到期提醒、标签过滤、家庭共享。
"""

from __future__ import annotations

import sqlite3

from app.core.database import Database

_DEFAULT_USER_ID = 1


def list_memos(conn: sqlite3.Connection) -> list[dict]:
    return Database.query(
        conn,
        "SELECT * FROM memos WHERE user_id = ? ORDER BY pinned DESC, id DESC",
        (_DEFAULT_USER_ID,),
    )
