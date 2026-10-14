"""选车模块服务层。

TODO(M3)：候选车型 CRUD、参数对比、持有成本测算（保险/能耗/保养）、评分与决策记录。
"""

from __future__ import annotations

import sqlite3

from app.core.database import Database

_DEFAULT_USER_ID = 1


def list_candidates(conn: sqlite3.Connection) -> list[dict]:
    return Database.query(
        conn,
        "SELECT * FROM car_candidates WHERE user_id = ? ORDER BY id DESC",
        (_DEFAULT_USER_ID,),
    )
