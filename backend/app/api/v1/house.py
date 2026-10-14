"""选房模块 API：M0 提供候选房源列表，写接口占位，M3 迭代实现。"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.api.deps import get_current_user, get_db
from app.core.errors import AppError
from app.core.responses import ok
from app.services import house as house_service

router = APIRouter()


@router.get("/candidates")
def list_candidates(conn=Depends(get_db), user=Depends(get_current_user)) -> dict:
    return ok(house_service.list_candidates(conn))


@router.post("/candidates")
def create_candidate(user=Depends(get_current_user)) -> dict:
    raise AppError(5011, "选房模块写接口建设中，将在 M3 迭代实现", http_status=501)
