"""文件存档模块服务层。

TODO(M1)：上传落盘（data/uploads/ 按模块子目录）、SHA256 校验、下载与预览、
分类与搜索、容量统计；大文件分块上传（M5 预留）。
"""

from __future__ import annotations

import sqlite3

from app.core.database import Database


def list_records(conn: sqlite3.Connection) -> list[dict]:
    # M4 全家庭共享（design §4.3）：读不过滤 user_id
    return Database.query(
        conn,
        "SELECT * FROM file_records ORDER BY id DESC",
    )
