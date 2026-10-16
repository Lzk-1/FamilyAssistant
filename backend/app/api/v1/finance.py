"""理财模块 API（M2 家庭资产台账，dev-plan §4.1 全量端点）。

清单：分类/成员字典、资产 CRUD 与筛选、状态流转、市值历史、
附件上传下载删除、总览/趋势/日历聚合。统一响应包沿用 core 规范。
"""

from __future__ import annotations

import json
from datetime import datetime
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile
from fastapi.responses import FileResponse, Response

from app.api.deps import get_db, get_settings, require_admin
from app.core.config import Settings
from app.core.errors import AppError
from app.core.responses import ok
from app.services import finance as finance_service
from app.services import finance_io
from app.services.finance import MAX_FILE_SIZE

router = APIRouter()

# 理财模块权限模型（M4.1）：读接口全体成员可用；写接口（增删改/流转/附件/导入/
# 字典维护）仅 admin。require_admin 内部已依赖 get_current_user，并返回 user 供审计字段使用。
admin_write = [Depends(require_admin)]

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


@router.post("/members", dependencies=admin_write)
def create_member(payload: dict, conn=Depends(get_db)) -> dict:
    return ok(finance_service.create_member(conn, payload))


@router.put("/members/{member_id}", dependencies=admin_write)
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


@router.post("/assets", dependencies=admin_write)
def create_asset(payload: dict, conn=Depends(get_db), user=Depends(require_admin)) -> dict:
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


@router.put("/assets/{asset_id}", dependencies=admin_write)
def update_asset(asset_id: int, payload: dict, conn=Depends(get_db),
                 user=Depends(require_admin)) -> dict:
    finance_service.update_asset(conn, asset_id, payload, user["id"])
    return ok(finance_service.get_asset(conn, asset_id))


@router.delete("/assets/{asset_id}", dependencies=admin_write)
def delete_asset(asset_id: int, conn=Depends(get_db), user=Depends(require_admin)) -> dict:
    finance_service.soft_delete_asset(conn, asset_id, user["id"])
    return ok({"id": asset_id, "deleted": True})


@router.post("/assets/batch-delete", dependencies=admin_write)
def batch_delete_assets(payload: dict, conn=Depends(get_db),
                        user=Depends(require_admin)) -> dict:
    """批量软删除：body {"ids": [1,2,...]}；返回 {deleted, missing}。"""
    return ok(finance_service.batch_delete_assets(conn, payload.get("ids"), user["id"]))


# ============ 状态流转（FR-09） ============

@router.post("/assets/{asset_id}/settle", dependencies=admin_write)
def settle_asset(asset_id: int, payload: dict, conn=Depends(get_db),
                 user=Depends(require_admin)) -> dict:
    action = str(payload.get("action", ""))
    return ok(finance_service.settle_asset(conn, asset_id, action, payload, user["id"]))


# ============ 市值历史（FR-10） ============

@router.get("/assets/{asset_id}/values")
def list_values(asset_id: int, conn=Depends(get_db)) -> dict:
    return ok(finance_service.list_values(conn, asset_id))


@router.post("/assets/{asset_id}/values", dependencies=admin_write)
def add_value(asset_id: int, payload: dict, conn=Depends(get_db),
              user=Depends(require_admin)) -> dict:
    return ok(finance_service.add_value(conn, asset_id, payload, user["id"]))


@router.delete("/assets/{asset_id}/values/{value_id}", dependencies=admin_write)
def delete_value(asset_id: int, value_id: int, conn=Depends(get_db),
                 user=Depends(require_admin)) -> dict:
    finance_service.delete_value(conn, asset_id, value_id, user["id"])
    return ok({"id": value_id, "deleted": True})


# ============ 实际收益录入（M2d，仅理财产品） ============

@router.post("/assets/{asset_id}/interest", dependencies=admin_write)
def add_interest(asset_id: int, payload: dict, conn=Depends(get_db),
                 user=Depends(require_admin)) -> dict:
    return ok(finance_service.add_interest(conn, asset_id, payload, user["id"]))


# ============ 附件（FR-05，dev-plan §5） ============

@router.post("/assets/{asset_id}/attachments", dependencies=admin_write)
def upload_attachment(
    asset_id: int,
    upload: UploadFile = File(...),
    conn=Depends(get_db),
    settings: Settings = Depends(get_settings),
    user=Depends(require_admin),
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


@router.delete("/attachments/{attachment_id}", dependencies=admin_write)
def delete_attachment(
    attachment_id: int,
    conn=Depends(get_db),
    settings: Settings = Depends(get_settings),
    user=Depends(require_admin),
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


# ============ 导入导出（M3b · docs/finance-module-design.md §5.7） ============

@router.get("/export")
def export_backup(
    format: str = Query("json"),
    attachments: int = Query(0),
    conn=Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> Response:
    """导出备份：json（全量）/ csv（资产列表）/ json+attachments=1 → zip（含附件）。"""
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    if format == "csv":
        csv_text = finance_io.export_csv(conn)
        return Response(csv_text, media_type="text/csv; charset=utf-8",
                        headers={"Content-Disposition": f'attachment; filename="finance-assets-{stamp}.csv"'})
    payload = finance_io.build_backup(conn)
    if attachments:
        content = finance_io.build_zip(settings.upload_dir, payload)
        return Response(content, media_type="application/zip",
                        headers={"Content-Disposition": f'attachment; filename="finance-backup-{stamp}.zip"'})
    body = json.dumps(payload, ensure_ascii=False)
    return Response(body, media_type="application/json; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="finance-backup-{stamp}.json"'})


@router.post("/import", dependencies=admin_write)
def import_backup(
    upload: UploadFile = File(...),
    mode: str = Form("merge"),
    conn=Depends(get_db),
    settings: Settings = Depends(get_settings),
    user=Depends(require_admin),
) -> dict:
    """导入备份：merge（按主键合并）/ restore（清空后全量恢复，危险操作）。"""
    data = upload.file.read(finance_io.MAX_IMPORT_SIZE + 1)
    if len(data) > finance_io.MAX_IMPORT_SIZE:
        raise AppError(4001, f"备份文件不能超过 {finance_io.MAX_IMPORT_SIZE // (1024 * 1024)} MB")
    return ok(finance_io.import_backup(conn, settings.upload_dir, data, mode, user["id"]))
