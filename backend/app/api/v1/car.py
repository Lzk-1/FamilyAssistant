"""选车模块 API（M-car1，design：docs/car-module-design.md §5）。

清单：车型档案 CRUD、4S 报价单 CRUD（含购置税推算）、实车照片上传/下载/删除、
车型对比矩阵。统一响应包沿用 core 规范。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile
from fastapi.responses import FileResponse, Response

from app.api.deps import get_current_user, get_db, get_settings
from app.core.errors import AppError
from app.core.responses import ok
from app.services import car as car_service

router = APIRouter()

# 照片下载的媒体类型映射（file_type 已过服务端白名单 + 内容特征校验）
_MEDIA_TYPES = {
    "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
    "webp": "image/webp", "heic": "image/heic",
}


# ============ 车型档案 ============

@router.get("/candidates", dependencies=[Depends(get_current_user)])
def list_candidates(conn=Depends(get_db)) -> dict:
    return ok(car_service.list_candidates(conn))


@router.post("/candidates", dependencies=[Depends(get_current_user)])
def create_candidate(payload: dict, conn=Depends(get_db)) -> dict:
    return ok(car_service.create_candidate(conn, payload))


# 对比矩阵：注册顺序必须先于 /candidates/{candidate_id}，避免 "compare" 被当作路径参数
@router.get("/candidates/compare", dependencies=[Depends(get_current_user)])
def compare_candidates(ids: str = Query(..., description="逗号分隔的车型 id，最多 6 个"),
                       conn=Depends(get_db)) -> dict:
    try:
        id_list = [int(x) for x in ids.split(",") if x.strip()]
    except ValueError:
        raise AppError(4001, "ids: 应为逗号分隔的数字")
    if not 2 <= len(id_list) <= 6:
        raise AppError(4001, "ids: 需选择 2~6 个车型进行对比")
    return ok(car_service.compare(conn, id_list))


@router.get("/candidates/{candidate_id}", dependencies=[Depends(get_current_user)])
def get_candidate(candidate_id: int, conn=Depends(get_db)) -> dict:
    return ok(car_service.get_candidate(conn, candidate_id))


@router.put("/candidates/{candidate_id}", dependencies=[Depends(get_current_user)])
def update_candidate(candidate_id: int, payload: dict, conn=Depends(get_db)) -> dict:
    return ok(car_service.update_candidate(conn, candidate_id, payload))


@router.delete("/candidates/{candidate_id}", dependencies=[Depends(get_current_user)])
def delete_candidate(candidate_id: int, conn=Depends(get_db),
                     settings=Depends(get_settings)) -> dict:
    car_service.delete_candidate(conn, settings.upload_dir, candidate_id)
    return ok({"id": candidate_id, "deleted": True})


# ============ 4S 报价单 ============

@router.post("/offers", dependencies=[Depends(get_current_user)])
def create_offer(payload: dict, conn=Depends(get_db)) -> dict:
    return ok(car_service.create_offer(conn, payload))


@router.put("/offers/{offer_id}", dependencies=[Depends(get_current_user)])
def update_offer(offer_id: int, payload: dict, conn=Depends(get_db)) -> dict:
    return ok(car_service.update_offer(conn, offer_id, payload))


@router.delete("/offers/{offer_id}", dependencies=[Depends(get_current_user)])
def delete_offer(offer_id: int, conn=Depends(get_db)) -> dict:
    car_service.delete_offer(conn, offer_id)
    return ok({"id": offer_id, "deleted": True})


# ============ 实车照片 ============

@router.post("/candidates/{candidate_id}/photos", dependencies=[Depends(get_current_user)])
def upload_photo(candidate_id: int, upload: UploadFile = File(...), kind: str = Form("other"),
                 conn=Depends(get_db), settings=Depends(get_settings)) -> dict:
    data = upload.file.read(car_service.MAX_FILE_SIZE + 1)
    if len(data) > car_service.MAX_FILE_SIZE:
        raise AppError(4001, "file: 单文件不能超过 10 MB")
    return ok(car_service.save_photo(conn, settings.upload_dir, candidate_id,
                                     upload.filename or "photo.jpg", data, kind))


@router.get("/photos/{photo_id}/download", dependencies=[Depends(get_current_user)])
def download_photo(photo_id: int, conn=Depends(get_db), settings=Depends(get_settings)) -> Response:
    row, full = car_service.get_photo(conn, settings.upload_dir, photo_id)
    media = _MEDIA_TYPES.get(row["file_type"], "application/octet-stream")
    return FileResponse(full, media_type=media, filename=row["file_name"])


@router.delete("/photos/{photo_id}", dependencies=[Depends(get_current_user)])
def delete_photo(photo_id: int, conn=Depends(get_db), settings=Depends(get_settings)) -> dict:
    car_service.delete_photo(conn, settings.upload_dir, photo_id)
    return ok({"id": photo_id, "deleted": True})
