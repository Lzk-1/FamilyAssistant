"""理财数据导入导出（M3b · docs/finance-module-design.md §5.7）。

三种产物：
- JSON 备份：全量结构化快照（成员/分类/资产/市值/事件/附件元数据，含软删除行）
- ZIP 备份：JSON 备份 + 附件物理文件打包（manifest.json + attachments/）
- CSV 列表：人工查看的资产摘要（Excel 友好，UTF-8 BOM），不做 CSV 导入

导入两种模式：
- merge：按主键 upsert 合并（同源备份的恢复/合并；跨设备建账 id 冲突会覆盖，需先比对）
- restore：清空理财数据后全量恢复到备份点（附件物理文件在库恢复成功后处理）

约束：仅标准库（json/csv/zipfile/io）；zip 解压做路径穿越防护；行级失败跳过并报告。
"""

from __future__ import annotations

import csv
import io
import json
import shutil
import sqlite3
import zipfile
from datetime import datetime
from pathlib import Path

from app.core.database import Database
from app.core.errors import AppError
from app.services.finance import _STATUS_LABELS, effective_status

BACKUP_FORMAT = "familyassistant.finance.backup"
BACKUP_VERSION = 1

# 导入白名单：表 → (主键冲突列, 允许写入的列)。防手改备份注入额外列名
_TABLE_COLUMNS: dict[str, tuple[str, tuple[str, ...]]] = {
    "finance_members": ("id", ("id", "name", "note", "user_id", "is_active",
                               "created_at", "updated_at")),
    "finance_categories": ("code", ("code", "name", "direction", "sort_order", "is_active")),
    "finance_assets": ("id", ("id", "name", "direction", "category", "holder_member_id",
                              "institution", "amount_cents", "start_date", "end_date",
                              "annual_rate", "status", "settle_action", "settled_at",
                              "extra", "note", "is_deleted", "user_id",
                              "created_at", "updated_at")),
    "finance_asset_values": ("id", ("id", "asset_id", "value_date", "value_cents",
                                    "note", "created_at")),
    "finance_asset_events": ("id", ("id", "asset_id", "event_type", "detail", "user_id",
                                    "created_at")),
    "finance_attachments": ("id", ("id", "asset_id", "file_name", "file_path", "file_type",
                                   "file_size", "created_at")),
}
# upsert 依赖外键存在性的顺序（分类 → 成员 → 资产 → 子表）
_IMPORT_ORDER = ["finance_categories", "finance_members", "finance_assets",
                 "finance_asset_values", "finance_asset_events", "finance_attachments"]

MAX_IMPORT_SIZE = 200 * 1024 * 1024  # 200 MB（含附件的 ZIP 备份可达数十 MB）


# ============================================================
# 导出
# ============================================================

def build_backup(conn: sqlite3.Connection) -> dict:
    """全量结构化备份：全部行（含软删除），列全量保留。"""
    data = {}
    for table in _IMPORT_ORDER:
        data[table] = Database.query(conn, f"SELECT * FROM {table}")
    return {
        "format": BACKUP_FORMAT,
        "version": BACKUP_VERSION,
        "exported_at": datetime.now().isoformat(timespec="seconds"),
        "app_version": _app_version(),
        "data": data,
    }


def build_zip(upload_dir: Path, payload: dict) -> bytes:
    """ZIP 备份：manifest.json + attachments/{file_path}（缺失文件跳过并计入 warnings）。"""
    buf = io.BytesIO()
    warnings: list[str] = []
    root = upload_dir / "finance"
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        manifest = dict(payload)
        manifest["warnings"] = warnings
        zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False))
        missing = 0
        for att in payload["data"].get("finance_attachments", []):
            full = root / str(att["file_path"])
            if full.is_file():
                zf.write(full, f"attachments/{att['file_path']}")
            else:
                missing += 1
    if missing:
        warnings.append(f"{missing} 个附件物理文件缺失，仅备份了元数据")
    return buf.getvalue()


def export_csv(conn: sqlite3.Connection) -> str:
    """资产列表 CSV（人工查看用）：未删除资产 + 友好文案列，UTF-8 BOM 兼容 Excel。"""
    members = {m["id"]: m["name"] for m in Database.query(conn, "SELECT id, name FROM finance_members")}
    categories = {c["code"]: c["name"]
                  for c in Database.query(conn, "SELECT code, name FROM finance_categories")}
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["ID", "名称", "方向", "分类", "归属人", "机构", "金额(元)",
                     "起始日", "到期日", "年利率(%)", "状态", "备注"])
    rows = Database.query(
        conn, "SELECT * FROM finance_assets WHERE is_deleted = 0 ORDER BY id"
    )
    for r in rows:
        writer.writerow([
            r["id"], r["name"], "资产" if r["direction"] == "asset" else "负债",
            categories.get(r["category"], r["category"]),
            members.get(r["holder_member_id"], "—"), r["institution"] or "",
            f"{r['amount_cents'] / 100:.2f}", r["start_date"] or "", r["end_date"] or "",
            r["annual_rate"] if r["annual_rate"] is not None else "",
            _STATUS_LABELS.get(effective_status(r), r["status"]),
            r["note"] or "",
        ])
    return "\ufeff" + buf.getvalue()


def _app_version() -> str:
    from app import __version__
    return __version__


# ============================================================
# 导入
# ============================================================

def read_backup(data: bytes) -> tuple[dict, zipfile.ZipFile | None]:
    """嗅探备份格式：PK 头 → ZIP（返回 manifest 与句柄），否则按 JSON 解析。"""
    if not data:
        raise AppError(4001, "备份文件为空")
    if data[:2] == b"PK":
        try:
            zf = zipfile.ZipFile(io.BytesIO(data))
            manifest = json.loads(zf.read("manifest.json"))
        except (zipfile.BadZipFile, KeyError, json.JSONDecodeError):
            raise AppError(4001, "无法解析备份文件：损坏的 ZIP 或缺少 manifest.json")
        return manifest, zf
    try:
        return json.loads(data), None
    except json.JSONDecodeError:
        raise AppError(4001, "无法解析备份文件：JSON 格式错误")


def import_backup(conn: sqlite3.Connection, upload_dir: Path, data: bytes, mode: str,
                 default_user_id: int) -> dict:
    """导入备份。mode=merge（按主键 upsert）/ restore（清空后全量恢复）。

    行级失败（外键缺失/约束冲突）跳过并计入 skipped；整个导入单事务，格式错误回滚。
    """
    if mode not in ("merge", "restore"):
        raise AppError(4001, "mode: 取值应为 merge/restore")
    manifest, zf = read_backup(data)
    if manifest.get("format") != BACKUP_FORMAT or manifest.get("version") != BACKUP_VERSION:
        raise AppError(4001, "不是有效的理财数据备份文件（format/version 不匹配）")
    table_data = manifest.get("data")
    if not isinstance(table_data, dict):
        raise AppError(4001, "备份内容缺少 data 字段")

    imported: dict[str, int] = {}
    skipped: list[dict] = []
    # 手改备份可能缺时间戳列；NOT NULL 列显式插 NULL 会失败，补当前本地时间
    # （格式与迁移脚本 DEFAULT datetime('now','localtime') 一致）
    now_text = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # 备份中的 user_id 指向导出机的用户表，跨机恢复不可靠：
    # members 可空 → 失效置 NULL；assets/events 不可空 → 归导入操作者
    valid_users = {r["id"] for r in Database.query(conn, "SELECT id FROM users")}

    try:
        conn.execute("BEGIN")
        if mode == "restore":
            conn.execute("DELETE FROM finance_assets")   # CASCADE → values/events/attachments 行
            conn.execute("DELETE FROM finance_members")
        for table in _IMPORT_ORDER:
            conflict, columns = _TABLE_COLUMNS[table]
            sql = _upsert_sql(table, columns, conflict)
            count = 0
            for raw in _as_rows(table_data.get(table)):
                row = {c: raw.get(c) for c in columns}
                for ts in ("created_at", "updated_at"):
                    if ts in row and row[ts] is None:
                        row[ts] = now_text
                if table == "finance_members" and row["user_id"] not in valid_users:
                    row["user_id"] = None
                if table in ("finance_assets", "finance_asset_events") \
                        and row["user_id"] not in valid_users:
                    row["user_id"] = default_user_id
                try:
                    conn.execute(sql, [row[c] for c in columns])
                    count += 1
                except (sqlite3.IntegrityError, sqlite3.OperationalError) as exc:
                    skipped.append({"table": table, "id": raw.get(conflict),
                                   "reason": _skip_reason(exc)})
            imported[table] = count
        conn.commit()
    except Exception:
        conn.rollback()
        raise

    # DB 事务成功后再处理附件物理文件（restore 先清目录；提取失败仅告警不回滚）
    files_restored = _restore_files(upload_dir, zf, mode)

    result = {"mode": mode, "imported": imported, "skipped": skipped, "files_restored": files_restored}
    if skipped:
        result["warnings"] = [f"跳过 {len(skipped)} 行（引用了缺失的成员/分类等）"]
    return result


def _as_rows(value) -> list[dict]:
    if not isinstance(value, list):
        return []
    return [r for r in value if isinstance(r, dict)]


def _upsert_sql(table: str, columns: tuple[str, ...], conflict: str) -> str:
    cols = ", ".join(columns)
    marks = ", ".join("?" for _ in columns)
    updates = ", ".join(f"{c} = excluded.{c}" for c in columns if c != conflict)
    return (f"INSERT INTO {table} ({cols}) VALUES ({marks}) "
            f"ON CONFLICT({conflict}) DO UPDATE SET {updates}")


def _skip_reason(exc: sqlite3.SQLiteError) -> str:
    text = str(exc)
    if "FOREIGN KEY" in text:
        return "外键引用缺失（成员/分类/资产不存在）"
    if "UNIQUE" in text:
        return "唯一约束冲突"
    if "NOT NULL" in text:
        return "必填字段缺失"
    return "数据约束不满足"


def _restore_files(upload_dir: Path, zf: zipfile.ZipFile | None, mode: str) -> int:
    """restore 清空附件目录后重建；从 ZIP 提取附件文件（zip slip 防护）。"""
    root = upload_dir / "finance"
    if mode == "restore":
        shutil.rmtree(root, ignore_errors=True)
    if zf is None:
        return 0
    root.mkdir(parents=True, exist_ok=True)
    restored = 0
    for info in zf.infolist():
        name = info.filename
        if not name.startswith("attachments/"):
            continue  # manifest.json 等非附件条目
        rel = name[len("attachments/"):]
        target = (root / rel).resolve()
        if not str(target).startswith(str(root.resolve()) + "/"):
            raise AppError(4001, f"压缩包内路径不合法：{name}")
        target.parent.mkdir(parents=True, exist_ok=True)
        with zf.open(info) as src, open(target, "wb") as dst:
            shutil.copyfileobj(src, dst)
        restored += 1
    return restored
