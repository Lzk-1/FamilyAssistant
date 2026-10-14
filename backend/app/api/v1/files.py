"""文件存档模块 API：M0 提供文件记录列表，上传/下载占位，M1 迭代实现。

上传依赖 python-multipart（已在 requirements.txt 就绪）。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.api.deps import get_current_user, get_db
from app.core.errors import AppError
from app.core.responses import ok
from app.services import files as files_service

router = APIRouter()


@router.get("/records")
def list_records(conn=Depends(get_db), user=Depends(get_current_user)) -> dict:
    return ok(files_service.list_records(conn))


@router.post("/upload")
def upload(user=Depends(get_current_user)) -> dict:
    raise AppError(5011, "文件上传接口建设中，将在 M1 迭代实现", http_status=501)
