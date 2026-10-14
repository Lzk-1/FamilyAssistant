"""选房模块服务层。

TODO(M3)：候选房源 CRUD、多房源对比矩阵、评分模型（价格/通勤/学区/楼龄加权）、看房时间线记录。
"""

from __future__ import annotations

import sqlite3

from app.core.database import Database

_DEFAULT_USER_ID = 1


def list_candidates(conn: sqlite3.Connection) -> list[dict]:
    return Database.query(
        conn,
        "SELECT * FROM house_candidates WHERE user_id = ? ORDER BY id DESC",
        (_DEFAULT_USER_ID,),
    )
