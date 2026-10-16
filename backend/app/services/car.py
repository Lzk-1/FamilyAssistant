"""选车模块服务层（M-car1，design：docs/car-module-design.md）。

领域：候选车型档案（含配置特点标签）、4S 店报价单（多优惠/费用/赠品条目）、
实车照片归档。价格口径：裸车价 = 指导价 − Σ优惠；落地价 = 裸车价 + Σ费用；
购置税按 2026 年政策推算（新能源减半、减税额上限 1.5 万），仅作预填参考。
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime
from pathlib import Path

from app.core.database import Database
from app.core.errors import AppError

MAX_FILE_SIZE = 10 * 1024 * 1024
_MAX_PHOTOS_PER_CANDIDATE = 24
_MAX_ITEMS_PER_LIST = 12

_ENERGY_TYPES = {"fuel", "ev", "hybrid"}
_STATUSES = {"watching", "test_driving", "comparing", "dropped", "chosen"}
_PHOTO_KINDS = {"exterior", "interior", "other"}

# 图片白名单 + 内容特征双校验（沿用理财附件标准）
_MAGIC_RULES = {
    "jpg": [(0, b"\xff\xd8\xff")], "jpeg": [(0, b"\xff\xd8\xff")],
    "png": [(0, b"\x89PNG\r\n\x1a\n")],
    "webp": [(0, b"RIFF"), (8, b"WEBP")],
    "heic": [(4, b"ftyp")],
}

_DATE_FMT = "%Y-%m-%d"


# ============================================================
# 工具
# ============================================================

def _row(conn: sqlite3.Connection, sql: str, params: tuple = ()) -> dict | None:
    rows = Database.query(conn, sql, params)
    return rows[0] if rows else None


def _today() -> str:
    return datetime.now().strftime(_DATE_FMT)


def _parse_items(raw: object, key: str, errors: list[str]) -> list[dict]:
    """条目列表校验：[{label, amount_cents?}]，返回规范化列表。"""
    if raw is None:
        return []
    if not isinstance(raw, list):
        errors.append(f"{key}: 应为条目数组")
        return []
    if len(raw) > _MAX_ITEMS_PER_LIST:
        errors.append(f"{key}: 单项不能超过 {_MAX_ITEMS_PER_LIST} 条")
    items: list[dict] = []
    for entry in raw[:_MAX_ITEMS_PER_LIST]:
        if not isinstance(entry, dict):
            errors.append(f"{key}: 条目应为对象")
            continue
        label = str(entry.get("label", "")).strip()
        if not label or len(label) > 40:
            errors.append(f"{key}: 条目名称必填且不超过 40 字")
            continue
        item: dict = {"label": label}
        if key in ("discount_items", "fee_items"):
            amount = entry.get("amount_cents")
            if not isinstance(amount, int) or amount <= 0:
                errors.append(f"{key}「{label}」: 金额应为正整数（分）")
                continue
            item["amount_cents"] = amount
        else:  # gift_items：赠品可附备注，不折价
            note = str(entry.get("note", "") or "").strip()
            item["note"] = note[:100]
        items.append(item)
    return items


def _dump_items(items: list[dict]) -> str:
    return json.dumps(items, ensure_ascii=False)


def _load_items(raw: str) -> list[dict]:
    try:
        data = json.loads(raw or "[]")
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, TypeError):
        return []


def _parse_features(raw: object, errors: list[str]) -> list[dict]:
    """配置特点标签校验：[{label, value}]，label 唯一。"""
    if raw is None:
        return []
    if not isinstance(raw, list):
        errors.append("features: 应为标签数组")
        return []
    features: list[dict] = []
    seen: set[str] = set()
    for entry in raw[:_MAX_ITEMS_PER_LIST]:
        if not isinstance(entry, dict):
            errors.append("features: 标签应为对象")
            continue
        label = str(entry.get("label", "")).strip()
        value = str(entry.get("value", "")).strip()
        if not label or len(label) > 30 or len(value) > 60:
            errors.append("features: 标签名必填（≤30 字）、值不超过 60 字")
            continue
        if label in seen:
            errors.append(f"features: 标签「{label}」重复")
            continue
        seen.add(label)
        features.append({"label": label, "value": value})
    return features


# ============================================================
# 车型档案 CRUD
# ============================================================

def _validate_candidate(payload: dict, original: dict | None = None) -> tuple[dict, list]:
    """校验并规范化车型档案字段（design §2.1）。"""
    errors: list[str] = []
    data: dict = {}
    base = original or {}

    name = str(payload.get("brand") or base.get("brand") or "").strip()
    if not name or len(name) > 40:
        errors.append("brand: 品牌必填且不超过 40 字")
    data["brand"] = name

    model = str(payload.get("model") or base.get("model") or "").strip()
    if not model or len(model) > 60:
        errors.append("model: 车型必填且不超过 60 字")
    data["model"] = model

    data["version"] = str(payload.get("version", base.get("version", "")) or "").strip()[:60]

    year = payload.get("year", base.get("year"))
    if year in (None, ""):
        data["year"] = None
    elif isinstance(year, int) and 1990 <= year <= 2100:
        data["year"] = year
    else:
        errors.append("year: 应为 1990~2100 的年份数字")

    energy = str(payload.get("energy") or base.get("energy") or "fuel").strip()
    if energy not in _ENERGY_TYPES:
        errors.append("energy: 应为 fuel/ev/hybrid")
    data["energy"] = energy

    mileage = payload.get("mileage", base.get("mileage"))
    if mileage in (None, ""):
        data["mileage"] = None
    elif isinstance(mileage, (int, float)) and mileage >= 0:
        data["mileage"] = round(float(mileage), 1)
    else:
        errors.append("mileage: 应为非负数字（万公里）")

    guide = payload.get("guide_price_cents", base.get("guide_price_cents"))
    if guide in (None, ""):
        data["guide_price_cents"] = None
    elif isinstance(guide, int) and 0 < guide <= 100 * 100 * 1000000:
        data["guide_price_cents"] = guide
    else:
        errors.append("guide_price_cents: 指导价应为正整数（分）")

    status = str(payload.get("status") or base.get("status") or "watching").strip()
    if status not in _STATUSES:
        errors.append("status: 枚举不合法")
    data["status"] = status

    score = payload.get("score", base.get("score"))
    if score in (None, ""):
        data["score"] = None
    elif isinstance(score, (int, float)) and 0 <= float(score) <= 5:
        data["score"] = round(float(score), 1)
    else:
        errors.append("score: 应为 0~5 的评分（支持一位小数）")

    data["pros"] = str(payload.get("pros", base.get("pros", "")) or "").strip()[:500]
    data["cons"] = str(payload.get("cons", base.get("cons", "")) or "").strip()[:500]
    data["notes"] = str(payload.get("notes", base.get("notes", "")) or "").strip()[:500]

    features_raw = payload.get("features", base.get("features") if original else None)
    data["features"] = _parse_features(features_raw, errors)
    return data, errors


def _decorate(conn: sqlite3.Connection, row: dict) -> dict:
    """附加展示字段：features 解析 + 报价/照片聚合（design §3）。"""
    row["features"] = _load_items(row.get("features") or "[]")
    offers = list_offers(conn, row["id"])
    totals = [o["computed"]["total_cents"] for o in offers if o["computed"]["total_cents"] is not None]
    photos = _row(conn, "SELECT COUNT(*) AS n FROM car_photos WHERE candidate_id = ?", (row["id"],))["n"]
    row["computed"] = {
        "offer_count": len(offers),
        "photo_count": photos,
        "best_total_cents": min(totals) if totals else None,
        "avg_total_cents": round(sum(totals) / len(totals)) if totals else None,
        "max_discount_cents": max((o["computed"]["discount_total_cents"] for o in offers), default=None),
    }
    return row


def list_candidates(conn: sqlite3.Connection) -> list[dict]:
    # M4 全家庭共享（design §4.3）：读不过滤 user_id，user_id 仅为创建者审计
    rows = Database.query(conn, "SELECT * FROM car_candidates ORDER BY id DESC")
    return [_decorate(conn, r) for r in rows]


def get_candidate(conn: sqlite3.Connection, candidate_id: int) -> dict:
    row = _row(conn, "SELECT * FROM car_candidates WHERE id = ?", (candidate_id,))
    if not row:
        raise AppError(4004, "候选车型不存在")
    row = _decorate(conn, row)
    row["offers"] = list_offers(conn, candidate_id)
    row["photos"] = list_photos(conn, candidate_id)
    return row


def create_candidate(conn: sqlite3.Connection, payload: dict, user_id: int) -> dict:
    data, errors = _validate_candidate(payload)
    if errors:
        raise AppError(4001, "车型校验失败", data={"errors": errors})
    candidate_id = Database.execute(
        conn,
        "INSERT INTO car_candidates (user_id, brand, model, version, year, energy, mileage, "
        "guide_price_cents, status, score, pros, cons, notes, features) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (user_id, data["brand"], data["model"], data["version"], data["year"],
         data["energy"], data["mileage"], data["guide_price_cents"], data["status"],
         data["score"], data["pros"], data["cons"], data["notes"], _dump_items(data["features"])),
    )
    return get_candidate(conn, candidate_id)


def update_candidate(conn: sqlite3.Connection, candidate_id: int, payload: dict) -> dict:
    original = _row(conn, "SELECT * FROM car_candidates WHERE id = ?", (candidate_id,))
    if not original:
        raise AppError(4004, "候选车型不存在")
    data, errors = _validate_candidate(payload, original)
    if errors:
        raise AppError(4001, "车型校验失败", data={"errors": errors})
    Database.execute(
        conn,
        "UPDATE car_candidates SET brand=?, model=?, version=?, year=?, energy=?, mileage=?, "
        "guide_price_cents=?, status=?, score=?, pros=?, cons=?, notes=?, features=? "
        "WHERE id=?",
        (data["brand"], data["model"], data["version"], data["year"], data["energy"],
         data["mileage"], data["guide_price_cents"], data["status"], data["score"],
         data["pros"], data["cons"], data["notes"], _dump_items(data["features"]), candidate_id),
    )
    return get_candidate(conn, candidate_id)


def delete_candidate(conn: sqlite3.Connection, upload_dir: Path, candidate_id: int) -> None:
    """物理删除：级联 offers/photos 行由 FK CASCADE 处理，照片物理文件逐一清理。"""
    row = _row(conn, "SELECT id FROM car_candidates WHERE id = ?", (candidate_id,))
    if not row:
        raise AppError(4004, "候选车型不存在")
    for photo in Database.query(
        conn, "SELECT file_path FROM car_photos WHERE candidate_id = ?", (candidate_id,)):
        (_photo_root(upload_dir) / photo["file_path"]).unlink(missing_ok=True)
    Database.execute(conn, "DELETE FROM car_candidates WHERE id = ?", (candidate_id,))


# ============================================================
# 报价单（多 4S 店）
# ============================================================

def _validate_offer(conn: sqlite3.Connection, payload: dict,
                    original: dict | None = None) -> tuple[dict, list]:
    errors: list[str] = []
    data: dict = {}
    base = original or {}  # original 为已解析条目的报价行

    candidate_id = payload.get("candidate_id", base.get("candidate_id"))
    if not isinstance(candidate_id, int) or not _row(
            conn, "SELECT id FROM car_candidates WHERE id = ?", (candidate_id,)):
        errors.append("candidate_id: 候选车型不存在")
    data["candidate_id"] = candidate_id

    dealer = str(payload.get("dealer_name") or base.get("dealer_name") or "").strip()
    if not dealer or len(dealer) > 60:
        errors.append("dealer_name: 4S 店名称必填且不超过 60 字")
    data["dealer_name"] = dealer

    data["city"] = str(payload.get("city", base.get("city", "")) or "").strip()[:30]
    data["contact"] = str(payload.get("contact", base.get("contact", "")) or "").strip()[:60]

    offer_date = str(payload.get("offer_date") or base.get("offer_date") or "").strip()
    try:
        datetime.strptime(offer_date, _DATE_FMT)
        data["offer_date"] = offer_date
    except ValueError:
        errors.append("offer_date: 应为 YYYY-MM-DD 日期")

    # 条目列表：payload 未提供时沿用原值（部分更新友好）
    for key in ("discount_items", "fee_items", "gift_items"):
        if key in payload or original is None:
            data[key] = _parse_items(payload.get(key), key, errors)
        else:
            data[key] = base[key]

    data["notes"] = str(payload.get("notes", base.get("notes", "")) or "").strip()[:500]
    return data, errors


def _decorate_offer(row: dict) -> dict:
    """条目 JSON 解析 + 落地价计算（design §3：裸车 = 指导价 − Σ优惠；落地 = 裸车 + Σ费用）。"""
    row["discount_items"] = _load_items(row["discount_items"])
    row["fee_items"] = _load_items(row["fee_items"])
    row["gift_items"] = _load_items(row["gift_items"])
    discount_total = sum(i["amount_cents"] for i in row["discount_items"])
    fee_total = sum(i["amount_cents"] for i in row["fee_items"])
    guide = row.get("guide_price_cents")
    bare = guide - discount_total if guide is not None else None
    total = bare + fee_total if bare is not None else None
    row["computed"] = {
        "discount_total_cents": discount_total,
        "fee_total_cents": fee_total,
        "bare_price_cents": bare,
        "total_cents": total,
    }
    return row


def list_offers(conn: sqlite3.Connection, candidate_id: int) -> list[dict]:
    rows = Database.query(
        conn,
        "SELECT o.*, c.guide_price_cents FROM car_offers o "
        "JOIN car_candidates c ON c.id = o.candidate_id "
        "WHERE o.candidate_id = ? ORDER BY o.offer_date DESC, o.id DESC",
        (candidate_id,),
    )
    return [_decorate_offer(r) for r in rows]


def _get_offer_row(conn: sqlite3.Connection, offer_id: int) -> dict:
    row = _row(
        conn,
        "SELECT o.*, c.guide_price_cents, c.energy FROM car_offers o "
        "JOIN car_candidates c ON c.id = o.candidate_id WHERE o.id = ?",
        (offer_id,),
    )
    if not row:
        raise AppError(4004, "报价单不存在")
    return row


def get_offer(conn: sqlite3.Connection, offer_id: int) -> dict:
    row = _get_offer_row(conn, offer_id)
    row = _decorate_offer(row)
    row["tax_hint_cents"] = tax_hint(row["energy"], row["computed"]["bare_price_cents"])
    return row


def create_offer(conn: sqlite3.Connection, payload: dict) -> dict:
    data, errors = _validate_offer(conn, payload)
    if errors:
        raise AppError(4001, "报价校验失败", data={"errors": errors})
    offer_id = Database.execute(
        conn,
        "INSERT INTO car_offers (candidate_id, dealer_name, city, contact, offer_date, "
        "discount_items, fee_items, gift_items, notes) VALUES (?,?,?,?,?,?,?,?,?)",
        (data["candidate_id"], data["dealer_name"], data["city"], data["contact"],
         data["offer_date"], _dump_items(data["discount_items"]), _dump_items(data["fee_items"]),
         _dump_items(data["gift_items"]), data["notes"]),
    )
    return get_offer(conn, offer_id)


def update_offer(conn: sqlite3.Connection, offer_id: int, payload: dict) -> dict:
    original = _decorate_offer(_get_offer_row(conn, offer_id))
    data, errors = _validate_offer(conn, payload, original)
    if errors:
        raise AppError(4001, "报价校验失败", data={"errors": errors})
    Database.execute(
        conn,
        "UPDATE car_offers SET dealer_name=?, city=?, contact=?, offer_date=?, "
        "discount_items=?, fee_items=?, gift_items=?, notes=? WHERE id=?",
        (data["dealer_name"], data["city"], data["contact"], data["offer_date"],
         _dump_items(data["discount_items"]), _dump_items(data["fee_items"]),
         _dump_items(data["gift_items"]), data["notes"], offer_id),
    )
    return get_offer(conn, offer_id)


def delete_offer(conn: sqlite3.Connection, offer_id: int) -> None:
    _get_offer_row(conn, offer_id)  # 存在性校验
    Database.execute(conn, "DELETE FROM car_offers WHERE id = ?", (offer_id,))


# ============================================================
# 购置税推算（design §3，仅作预填参考，以 4S 实际报价为准）
# ============================================================

def tax_hint(energy: str, bare_price_cents: int | None) -> int | None:
    """2026 政策：计税价 = 裸车 ÷ 1.13；燃油 10%；新能源减半（减税额 ≤ 15000 分位为 1,500,000 分）。"""
    if bare_price_cents is None or bare_price_cents <= 0:
        return None
    taxable = bare_price_cents * 100 // 113  # ÷ 1.13（整数分）
    full = taxable * 10 // 100                # 10% 口径
    if energy == "fuel":
        return full
    relief = min(full * 50 // 100, 15000 * 100)  # 减半且减税额上限 1.5 万元
    return full - relief


# ============================================================
# 照片
# ============================================================

def _photo_root(upload_dir: Path) -> Path:
    root = upload_dir / "car"
    root.mkdir(parents=True, exist_ok=True)
    return root


def list_photos(conn: sqlite3.Connection, candidate_id: int) -> list[dict]:
    return Database.query(
        conn,
        "SELECT id, candidate_id, kind, file_name, file_path, file_size, file_type, remark, created_at "
        "FROM car_photos WHERE candidate_id = ? ORDER BY kind, id",
        (candidate_id,),
    )


def save_photo(conn: sqlite3.Connection, upload_dir: Path, candidate_id: int,
               file_name: str, data: bytes, kind: str = "other") -> dict:
    if not _row(conn, "SELECT id FROM car_candidates WHERE id = ?", (candidate_id,)):
        raise AppError(4004, "候选车型不存在")
    errors: list[str] = []
    k = str(kind or "other").strip() or "other"
    if k not in _PHOTO_KINDS:
        errors.append("kind: 应为 exterior/interior/other")
    ext = Path(file_name).suffix.lstrip(".").lower()
    if ext not in _MAGIC_RULES:
        errors.append("file: 仅支持 jpg/jpeg/png/webp/heic 格式")
    if len(data) > MAX_FILE_SIZE:
        errors.append("file: 单文件不能超过 10 MB")
    if len(data) == 0:
        errors.append("file: 文件为空")
    count = _row(conn, "SELECT COUNT(*) AS n FROM car_photos WHERE candidate_id = ?",
                 (candidate_id,))["n"]
    if count >= _MAX_PHOTOS_PER_CANDIDATE:
        errors.append(f"file: 单车型照片不能超过 {_MAX_PHOTOS_PER_CANDIDATE} 张")
    if ext in _MAGIC_RULES and data:
        for offset, signature in _MAGIC_RULES[ext]:
            if data[offset:offset + len(signature)] != signature:
                errors.append(f"file: 文件内容与 {ext} 格式不符")
                break
    if errors:
        raise AppError(4001, "照片校验失败", data={"errors": errors})

    stored = f"{uuid.uuid4().hex}.{ext}"
    rel_path = f"{candidate_id}/{stored}"
    target = _photo_root(upload_dir) / str(candidate_id)
    target.mkdir(parents=True, exist_ok=True)
    (target / stored).write_bytes(data)
    photo_id = Database.execute(
        conn,
        "INSERT INTO car_photos (candidate_id, kind, file_name, file_path, file_size, file_type) "
        "VALUES (?,?,?,?,?,?)",
        (candidate_id, k, file_name[:200], rel_path, len(data), ext),
    )
    return {"id": photo_id, "file_name": file_name, "file_type": ext, "file_size": len(data), "kind": k}


def get_photo(conn: sqlite3.Connection, upload_dir: Path, photo_id: int) -> tuple[dict, Path]:
    row = _row(conn, "SELECT * FROM car_photos WHERE id = ?", (photo_id,))
    if not row:
        raise AppError(4004, "照片不存在")
    root = _photo_root(upload_dir).resolve()
    full = (root / row["file_path"]).resolve()
    if not str(full).startswith(str(root) + "/") and full != root:
        raise AppError(4004, "照片路径不合法")
    if not full.is_file():
        raise AppError(4004, "照片文件已丢失")
    return row, full


def delete_photo(conn: sqlite3.Connection, upload_dir: Path, photo_id: int) -> None:
    _, full = get_photo(conn, upload_dir, photo_id)
    full.unlink(missing_ok=True)
    Database.execute(conn, "DELETE FROM car_photos WHERE id = ?", (photo_id,))


# ============================================================
# 对比矩阵（design §4.3，决策点 D3：全标签并集 + 独有高亮）
# ============================================================

def compare(conn: sqlite3.Connection, id_list: list[int]) -> dict:
    rows = []
    for cid in id_list:
        row = _row(conn, "SELECT * FROM car_candidates WHERE id = ?", (cid,))
        if not row:
            raise AppError(4004, f"候选车型 {cid} 不存在")
        rows.append(_decorate(conn, row))

    # 配置特点行：所选车型标签并集，独有（仅一个车型有此标签）标记 highlight。
    # 标签存在即代表具备该配置；value 留空时规范化为「有」（未注明参数，区别于无此标签的 None→—）。
    label_order: list[str] = []
    label_values: dict[str, dict[int, str]] = {}
    for row in rows:
        for feature in row["features"]:
            label = feature["label"]
            if label not in label_values:
                label_order.append(label)
                label_values[label] = {}
            value = (feature.get("value") or "").strip()
            label_values[label][row["id"]] = value or "有"

    feature_rows = []
    for label in label_order:
        values = {row["id"]: label_values[label].get(row["id"]) for row in rows}
        feature_rows.append({
            "label": label,
            "values": values,
            "unique": sum(1 for v in values.values() if v is not None) == 1,
        })

    return {"candidates": rows, "feature_rows": feature_rows}
