"""文件存档模块服务层。

TODO(M1)：上传落盘（data/uploads/ 按模块子目录）、SHA256 校验、下载与预览、
分类与搜索、容量统计；大文件分块上传（M5 预留）。
"""

from __future__ import annotations

import sqlite3

from app.core.database import Database

_DEFAULT_USER_ID = 1


def list_records(conn: sqlite3.Connection) -> list[dict]:
    return Database.query(
        conn,
        "SELECT * FROM file_records WHERE user_id = ? ORDER BY id DESC",
        (_DEFAULT_USER_ID,),
    )
