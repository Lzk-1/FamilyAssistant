"""选房模块 API（M-house1，design：docs/house-module-design.md §5）。

清单：房源档案 CRUD、房源照片上传/下载/删除、多房源对比矩阵、
评分权重配置（GET/PUT，决策点 D5：用户可自定义权重）。统一响应包沿用 core 规范。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile
from fastapi.responses import FileResponse, Response

from app.api.deps import get_current_user, get_db, get_settings
from app.core.errors import AppError
from app.core.responses import ok
from app.services import house as house_service

router = APIRouter()

# 照片下载的媒体类型映射（file_type 已过服务端白名单 + 内容特征校验）
_MEDIA_TYPES = {
    "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
    "webp": "image/webp", "heic": "image/heic",
}


# ============ 房源档案 ============

@router.get("/candidates")
def list_candidates(conn=Depends(get_db), user=Depends(get_current_user)) -> dict:
    return ok(house_service.list_candidates(conn, user["id"]))


@router.post("/candidates")
def create_candidate(payload: dict, conn=Depends(get_db), user=Depends(get_current_user)) -> dict:
    return ok(house_service.create_candidate(conn, payload, user["id"]))


# 对比矩阵：注册顺序必须先于 /candidates/{candidate_id}，避免 "compare" 被当作路径参数
@router.get("/candidates/compare")
def compare_candidates(ids: str = Query(..., description="逗号分隔的房源 id，最多 6 个"),
                       conn=Depends(get_db), user=Depends(get_current_user)) -> dict:
    try:
        id_list = [int(x) for x in ids.split(",") if x.strip()]
    except ValueError:
        raise AppError(4001, "ids: 应为逗号分隔的数字")
    if not 2 <= len(id_list) <= 6:
        raise AppError(4001, "ids: 需选择 2~6 个房源进行对比")
    return ok(house_service.compare(conn, id_list, user["id"]))


@router.get("/candidates/{candidate_id}")
def get_candidate(candidate_id: int, conn=Depends(get_db), user=Depends(get_current_user)) -> dict:
    return ok(house_service.get_candidate(conn, candidate_id, user["id"]))


@router.put("/candidates/{candidate_id}")
def update_candidate(candidate_id: int, payload: dict, conn=Depends(get_db),
                     user=Depends(get_current_user)) -> dict:
    return ok(house_service.update_candidate(conn, candidate_id, payload, user["id"]))


@router.delete("/candidates/{candidate_id}", dependencies=[Depends(get_current_user)])
def delete_candidate(candidate_id: int, conn=Depends(get_db),
                     settings=Depends(get_settings)) -> dict:
    house_service.delete_candidate(conn, settings.upload_dir, candidate_id)
    return ok({"id": candidate_id, "deleted": True})


# ============ 房源照片 ============

@router.post("/candidates/{candidate_id}/photos", dependencies=[Depends(get_current_user)])
def upload_photo(candidate_id: int, upload: UploadFile = File(...), kind: str = Form("other"),
                 conn=Depends(get_db), settings=Depends(get_settings)) -> dict:
    data = upload.file.read(house_service.MAX_FILE_SIZE + 1)
    if len(data) > house_service.MAX_FILE_SIZE:
        raise AppError(4001, "file: 单文件不能超过 10 MB")
    return ok(house_service.save_photo(conn, settings.upload_dir, candidate_id,
                                       upload.filename or "photo.jpg", data, kind))


@router.get("/photos/{photo_id}/download", dependencies=[Depends(get_current_user)])
def download_photo(photo_id: int, conn=Depends(get_db), settings=Depends(get_settings)) -> Response:
    row, full = house_service.get_photo(conn, settings.upload_dir, photo_id)
    media = _MEDIA_TYPES.get(row["file_type"], "application/octet-stream")
    return FileResponse(full, media_type=media, filename=row["file_name"])


@router.delete("/photos/{photo_id}", dependencies=[Depends(get_current_user)])
def delete_photo(photo_id: int, conn=Depends(get_db), settings=Depends(get_settings)) -> dict:
    house_service.delete_photo(conn, settings.upload_dir, photo_id)
    return ok({"id": photo_id, "deleted": True})


# ============ 评分权重配置（决策点 D5） ============

@router.get("/scoring-config")
def get_scoring_config(conn=Depends(get_db), user=Depends(get_current_user)) -> dict:
    return ok(house_service.get_scoring_config(conn, user["id"]))


@router.put("/scoring-config")
def update_scoring_config(payload: dict, conn=Depends(get_db), user=Depends(get_current_user)) -> dict:
    return ok(house_service.update_scoring_config(conn, payload, user["id"]))
