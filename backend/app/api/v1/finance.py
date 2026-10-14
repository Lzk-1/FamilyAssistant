"""理财模块 API：M0 提供账户/流水列表（打通数据链路），写接口占位，M2 迭代实现。"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.api.deps import get_current_user, get_db
from app.core.errors import AppError
from app.core.responses import ok
from app.services import finance as finance_service

router = APIRouter()


@router.get("/accounts")
def list_accounts(conn=Depends(get_db), user=Depends(get_current_user)) -> dict:
    return ok(finance_service.list_accounts(conn))


@router.get("/transactions")
def list_transactions(conn=Depends(get_db), user=Depends(get_current_user)) -> dict:
    return ok(finance_service.list_transactions(conn))


@router.post("/accounts")
def create_account(user=Depends(get_current_user)) -> dict:
    raise AppError(5011, "理财模块写接口建设中，将在 M2 迭代实现", http_status=501)
