"""应用配置：单机模式零配置可用，云部署通过 FA_ 前缀环境变量覆盖（12-Factor）。

环境变量清单见 docs/architecture.md 第 9 节：
FA_HOST / FA_PORT / FA_DEBUG / FA_DATA_DIR / FA_AUTH_ENABLED / FA_SECRET_KEY / FA_CORS_ORIGINS
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[2]  # backend/
PROJECT_ROOT = BASE_DIR.parent


def _env_bool(value: str) -> bool:
    return value.lower() in ("1", "true", "yes", "on")


@dataclass
class Settings:
    """运行配置。默认值面向单机零配置；云端部署用环境变量覆盖。"""

    # --- 运行 ---
    host: str = "127.0.0.1"
    port: int = 8300
    debug: bool = False

    # --- 数据（data/ 目录即全部运行时状态，可整目录备份/迁移） ---
    data_dir: Path = PROJECT_ROOT / "data"

    # --- 认证（M0 单机免登录；M4 打开开关启用多用户 Token） ---
    auth_enabled: bool = False
    secret_key: str = "dev-insecure-secret-change-me"

    # --- 跨域（前后端分离部署时配置，逗号分隔） ---
    cors_origins: str = ""

    @property
    def db_file(self) -> Path:
        return self.data_dir / "family_assistant.db"

    @property
    def upload_dir(self) -> Path:
        return self.data_dir / "uploads"

    @property
    def migrations_dir(self) -> Path:
        return BASE_DIR / "migrations"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


def load_settings() -> Settings:
    """从环境变量构造配置，未设置的项使用单机默认值。"""
    overrides: dict = {}
    if os.getenv("FA_HOST"):
        overrides["host"] = os.environ["FA_HOST"]
    if os.getenv("FA_PORT"):
        overrides["port"] = int(os.environ["FA_PORT"])
    if os.getenv("FA_DEBUG"):
        overrides["debug"] = _env_bool(os.environ["FA_DEBUG"])
    if os.getenv("FA_DATA_DIR"):
        overrides["data_dir"] = Path(os.environ["FA_DATA_DIR"]).expanduser()
    if os.getenv("FA_AUTH_ENABLED"):
        overrides["auth_enabled"] = _env_bool(os.environ["FA_AUTH_ENABLED"])
    if os.getenv("FA_SECRET_KEY"):
        overrides["secret_key"] = os.environ["FA_SECRET_KEY"]
    if os.getenv("FA_CORS_ORIGINS"):
        overrides["cors_origins"] = os.environ["FA_CORS_ORIGINS"]
    return Settings(**overrides)
