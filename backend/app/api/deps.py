"""请求级公共依赖：SQLite 连接、当前用户、管理员校验、配置访问。

get_current_user（M4 实装，docs/multi-user-module-design.md §3.2/§3.4）：
- auth_enabled=false（单机免登录）：返回内置 admin，行为与 M0 完全一致（旁路回归零风险）
- auth_enabled=true：校验 fa_session cookie → sessions 表双限校验 + 滑动续期
  → is_active 校验；写方法须携带 X-Requested-With 头（CSRF 双保险之一）
"""

from __future__ import annotations

import sqlite3
from typing import Iterator

from fastapi import Depends, Request

from app.core.config import Settings
from app.core.database import Database
from app.core.errors import AppError
from app.services import auth as auth_service
from app.services.auth import SESSION_COOKIE

# M0 单机免登录模式下的内置管理员（字段形状与 auth_service._user_public 保持一致）
DEFAULT_USER = {
    "id": 1, "username": "admin", "display_name": "管理员", "role": "admin",
    "is_active": True, "must_change_password": False, "avatar_path": "",
}

_SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_database(request: Request) -> Database:
    return request.app.state.database


def get_db(db: Database = Depends(get_database)) -> Iterator[sqlite3.Connection]:
    """每请求一个短连接，请求结束自动关闭。"""
    conn = db.connect()
    try:
        yield conn
    finally:
        conn.close()


def _check_csrf_header(request: Request) -> None:
    """写方法必须携带 X-Requested-With: XMLHttpRequest（SameSite=Lax 之外的第二道防线）。

    跨站攻击页面附加自定义头会触发 CORS 预检被拦，无法伪造；GET 请求无副作用不校验。
    """
    if request.method in _SAFE_METHODS:
        return
    if request.headers.get("x-requested-with") != "XMLHttpRequest":
        raise AppError(4003, "缺少防跨站请求头，请从正常页面发起操作", http_status=403)


def get_current_user(request: Request, settings: Settings = Depends(get_settings),
                     conn: sqlite3.Connection = Depends(get_db)) -> dict:
    if not settings.auth_enabled:
        return DEFAULT_USER
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        raise AppError(4001, "未认证：请先登录", http_status=401)
    user = auth_service.validate_session(conn, token)
    if not user:
        raise AppError(4001, "登录已过期或失效，请重新登录", http_status=401)
    _check_csrf_header(request)
    return user


def require_admin(user: dict = Depends(get_current_user)) -> dict:
    """管理性写操作专用（成员管理、理财写接口等）：非 admin 一律 403。"""
    if user["role"] != "admin":
        raise AppError(4003, "权限不足：需要管理员权限", http_status=403)
    return user
