"""系统模块：健康检查 / 模块注册表（前端导航数据源）。"""

from __future__ import annotations

from fastapi import APIRouter

from app import __version__
from app.core.registry import MODULES
from app.core.responses import ok

router = APIRouter(tags=["system"])


@router.get("/health")
def health() -> dict:
    return ok({"status": "ok", "app": "FamilyAssistant", "version": __version__, "modules": len(MODULES)})


@router.get("/modules")
def modules() -> dict:
    return ok(MODULES)
