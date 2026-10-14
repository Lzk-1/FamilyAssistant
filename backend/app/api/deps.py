"""请求级公共依赖：SQLite 连接、当前用户、配置访问。"""

from __future__ import annotations

import sqlite3
from typing import Iterator

from fastapi import Depends, Request

from app.core.config import Settings
from app.core.database import Database
from app.core.errors import AppError

# M0 单机免登录模式下的内置管理员；M4 由 Token 校验替换
DEFAULT_USER = {"id": 1, "username": "admin", "display_name": "管理员", "role": "admin"}


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


def get_current_user(request: Request, settings: Settings = Depends(get_settings)) -> dict:
    """M0：认证关闭时返回内置 admin。

    TODO(M4)：FA_AUTH_ENABLED=true 时校验 Authorization: Bearer <token>，
    经 api_tokens 表加载真实用户；行级数据隔离统一按 user_id 过滤。
    """
    if not settings.auth_enabled:
        return DEFAULT_USER
    raise AppError(4001, "未认证：请先登录", http_status=401)
