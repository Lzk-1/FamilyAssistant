"""统一成功响应包：{code: 0, message: "ok", data: ...}。

所有 API 成功路径一律返回 ok(...)；错误由 core.errors 全局处理器接管。
"""

from __future__ import annotations

from typing import Any


def ok(data: Any = None) -> dict:
    return {"code": 0, "message": "ok", "data": data}
