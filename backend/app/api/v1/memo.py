"""备忘录模块 API：M0 提供列表，写接口占位，M1 迭代实现（首个完整功能模块）。"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.api.deps import get_current_user, get_db
from app.core.errors import AppError
from app.core.responses import ok
from app.services import memo as memo_service

router = APIRouter()


@router.get("/memos")
def list_memos(conn=Depends(get_db), user=Depends(get_current_user)) -> dict:
    return ok(memo_service.list_memos(conn))


@router.post("/memos")
def create_memo(user=Depends(get_current_user)) -> dict:
    raise AppError(5011, "备忘录模块写接口建设中，将在 M1 迭代实现", http_status=501)
