"""理财模块 API（M2 家庭资产台账，dev-plan §4.1 全量端点）。

清单：分类/成员字典、资产 CRUD 与筛选、状态流转、市值历史、
附件上传下载删除、总览/趋势/日历聚合。统一响应包沿用 core 规范。
"""

from __future__ import annotations

from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Query, UploadFile
from fastapi.responses import FileResponse

from app.api.deps import get_current_user, get_db, get_settings
from app.core.config import Settings
from app.core.errors import AppError
from app.core.responses import ok
from app.services import finance as finance_service
from app.services.finance import MAX_FILE_SIZE

router = APIRouter()

# 附件下载的媒体类型映射（file_type 已过服务端白名单）
_MEDIA_TYPES = {
    "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
    "webp": "image/webp", "heic": "image/heic", "pdf": "application/pdf",
}


# ============ 字典：分类 / 成员（FR-01/02） ============

@router.get("/categories")
def list_categories(conn=Depends(get_db)) -> dict:
    return ok(finance_service.list_categories(conn))


@router.get("/members")
def list_members(conn=Depends(get_db)) -> dict:
    return ok(finance_service.list_members(conn))


@router.post("/members", dependencies=[Depends(get_current_user)])
def create_member(payload: dict, conn=Depends(get_db)) -> dict:
    return ok(finance_service.create_member(conn, payload))


@router.put("/members/{member_id}", dependencies=[Depends(get_current_user)])
def update_member(member_id: int, payload: dict, conn=Depends(get_db)) -> dict:
    return ok(finance_service.update_member(conn, member_id, payload))


# ============ 台账：资产 CRUD（FR-02/03/04） ============

@router.get("/assets")
def list_assets(
    direction: str | None = None,
    category: str | None = None,
    holder_id: int | None = None,
    status: str | None = None,
    q: str | None = None,
    conn=Depends(get_db),
) -> dict:
    return ok(finance_service.list_assets(conn, {
        "direction": direction, "category": category, "holder_id": holder_id,
        "status": status, "q": q,
    }))


@router.post("/assets")
def create_asset(payload: dict, conn=Depends(get_db), user=Depends(get_current_user)) -> dict:
    asset_id = finance_service.create_asset(conn, payload, user["id"])
    return ok(finance_service.get_asset(conn, asset_id))


# 对比分析（M2c）：注册顺序必须先于 /assets/{asset_id}，避免 "compare" 被当作路径参数
@router.get("/assets/compare")
def compare_assets(ids: str = Query(..., description="逗号分隔的资产 id，最多 6 个"),
                   conn=Depends(get_db)) -> dict:
    try:
        id_list = [int(x) for x in ids.split(",") if x.strip()]
    except ValueError:
        raise AppError(4001, "ids: 应为逗号分隔的数字")
    return ok(finance_service.compare_assets(conn, id_list))


@router.get("/assets/{asset_id}")
def get_asset(asset_id: int, conn=Depends(get_db)) -> dict:
    return ok(finance_service.get_asset(conn, asset_id))


@router.put("/assets/{asset_id}")
def update_asset(asset_id: int, payload: dict, conn=Depends(get_db),
                 user=Depends(get_current_user)) -> dict:
    finance_service.update_asset(conn, asset_id, payload, user["id"])
    return ok(finance_service.get_asset(conn, asset_id))


@router.delete("/assets/{asset_id}")
def delete_asset(asset_id: int, conn=Depends(get_db), user=Depends(get_current_user)) -> dict:
    finance_service.soft_delete_asset(conn, asset_id, user["id"])
    return ok({"id": asset_id, "deleted": True})


# ============ 状态流转（FR-09） ============

@router.post("/assets/{asset_id}/settle")
def settle_asset(asset_id: int, payload: dict, conn=Depends(get_db),
                 user=Depends(get_current_user)) -> dict:
    action = str(payload.get("action", ""))
    return ok(finance_service.settle_asset(conn, asset_id, action, payload, user["id"]))


# ============ 市值历史（FR-10） ============

@router.get("/assets/{asset_id}/values")
def list_values(asset_id: int, conn=Depends(get_db)) -> dict:
    return ok(finance_service.list_values(conn, asset_id))


@router.post("/assets/{asset_id}/values")
def add_value(asset_id: int, payload: dict, conn=Depends(get_db),
              user=Depends(get_current_user)) -> dict:
    return ok(finance_service.add_value(conn, asset_id, payload, user["id"]))


# ============ 实际收益录入（M2d，仅理财产品） ============

@router.post("/assets/{asset_id}/interest")
def add_interest(asset_id: int, payload: dict, conn=Depends(get_db),
                 user=Depends(get_current_user)) -> dict:
    return ok(finance_service.add_interest(conn, asset_id, payload, user["id"]))


# ============ 附件（FR-05，dev-plan §5） ============

@router.post("/assets/{asset_id}/attachments")
def upload_attachment(
    asset_id: int,
    upload: UploadFile = File(...),
    conn=Depends(get_db),
    settings: Settings = Depends(get_settings),
    user=Depends(get_current_user),
) -> dict:
    # 同步端点与 get_db 同线程，避免 SQLite 跨线程限制；
    # 限量读取（10MB+1），超限内容交由服务层判定拒绝
    data = upload.file.read(MAX_FILE_SIZE + 1)
    return ok(finance_service.save_attachment(
        conn, settings.upload_dir, asset_id, upload.filename or "", data, user["id"]
    ))


@router.get("/attachments/{attachment_id}/download")
def download_attachment(
    attachment_id: int,
    conn=Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> FileResponse:
    row, path = finance_service.get_attachment(conn, settings.upload_dir, attachment_id)
    filename = quote(row["file_name"])
    return FileResponse(
        path,
        media_type=_MEDIA_TYPES.get(row["file_type"], "application/octet-stream"),
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"},
    )


@router.delete("/attachments/{attachment_id}")
def delete_attachment(
    attachment_id: int,
    conn=Depends(get_db),
    settings: Settings = Depends(get_settings),
    user=Depends(get_current_user),
) -> dict:
    finance_service.delete_attachment(conn, settings.upload_dir, attachment_id, user["id"])
    return ok({"id": attachment_id, "deleted": True})


# ============ 聚合：总览 / 趋势 / 日历（FR-06/07/08） ============

@router.get("/overview")
def overview(conn=Depends(get_db)) -> dict:
    return ok(finance_service.overview(conn))


@router.get("/trend")
def trend(months: int = Query(12, ge=1, le=60), conn=Depends(get_db)) -> dict:
    return ok(finance_service.trend(conn, months))


@router.get("/calendar")
def calendar(
    from_date: str | None = Query(None, alias="from"),
    to_date: str | None = Query(None, alias="to"),
    conn=Depends(get_db),
) -> dict:
    return ok(finance_service.calendar(conn, from_date, to_date))


@router.get("/analytics")
def analytics(months: int = Query(12, ge=1, le=24), conn=Depends(get_db)) -> dict:
    """收益分析（M3a）：已实现按月归集 + 分类/成员贡献 + 明细。"""
    return ok(finance_service.analytics(conn, months))
