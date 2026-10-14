"""理财模块服务层。

TODO(M2)：账户 CRUD、流水记账、按月收支统计、资产负债总览、预算管理。
"""

from __future__ import annotations

import sqlite3

from app.core.database import Database

# M0 固定单机 admin；M4 打开认证后由路由层注入真实 user_id
_DEFAULT_USER_ID = 1


def list_accounts(conn: sqlite3.Connection) -> list[dict]:
    return Database.query(
        conn,
        "SELECT * FROM finance_accounts WHERE user_id = ? ORDER BY id DESC",
        (_DEFAULT_USER_ID,),
    )


def list_transactions(conn: sqlite3.Connection) -> list[dict]:
    return Database.query(
        conn,
        "SELECT * FROM finance_transactions WHERE user_id = ? ORDER BY id DESC LIMIT 200",
        (_DEFAULT_USER_ID,),
    )
