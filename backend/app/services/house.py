"""选房模块服务层（M-house1，design：docs/house-module-design.md）。

领域：候选房源档案（配套设施标签 + 六维度评分）、房源照片归档、
多房源对比矩阵、加权评分（权重用户可自定义，合计 100，决策点 D5）。
价格口径：总价/单价统一为分；单价缺失时按 总价÷面积 推算，总价缺失时按 单价×面积 推算。
加权评分 = Σ(维度得分×权重) ÷ 已评维度权重之和（部分维度未评时权重归一化）。
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from pathlib import Path

from app.core.database import Database
from app.core.errors import AppError

MAX_FILE_SIZE = 10 * 1024 * 1024
_MAX_PHOTOS_PER_CANDIDATE = 24
_MAX_ITEMS_PER_LIST = 12

_STATUSES = {"watching", "visiting", "comparing", "dropped", "chosen"}
_PHOTO_KINDS = {"exterior", "interior", "layout", "other"}

# 六大评分维度（业界权重共识为默认值，用户可通过 scoring-config 自定义，design §5/调研）
DIMENSIONS: list[tuple[str, str, int]] = [
    ("location", "区位交通", 25),
    ("facilities", "配套资源", 20),
    ("price", "价格性价比", 20),
    ("layout", "户型产品", 15),
    ("quality", "楼盘品质", 10),
    ("liquidity", "流通性", 10),
]
_DIM_KEYS = {k for k, _, _ in DIMENSIONS}
_DEFAULT_WEIGHTS = {k: w for k, _, w in DIMENSIONS}

# 图片白名单 + 内容特征双校验（沿用理财/选车附件标准）
_MAGIC_RULES = {
    "jpg": [(0, b"\xff\xd8\xff")], "jpeg": [(0, b"\xff\xd8\xff")],
    "png": [(0, b"\x89PNG\r\n\x1a\n")],
    "webp": [(0, b"RIFF"), (8, b"WEBP")],
    "heic": [(4, b"ftyp")],
}


# ============================================================
# 工具
# ============================================================

def _row(conn: sqlite3.Connection, sql: str, params: tuple = ()) -> dict | None:
    rows = Database.query(conn, sql, params)
    return rows[0] if rows else None


def _dump_json(data) -> str:
    return json.dumps(data, ensure_ascii=False)


def _load_items(raw: str) -> list[dict]:
    try:
        data = json.loads(raw or "[]")
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, TypeError):
        return []


def _parse_features(raw: object, errors: list[str]) -> list[dict]:
    """配套设施标签校验：[{label, value}]，label 唯一（与选车同模式）。"""
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
        value = str(entry.get("value", "") or "").strip()
        if not label or len(label) > 30 or len(value) > 60:
            errors.append("features: 标签名必填（≤30 字）、值不超过 60 字")
            continue
        if label in seen:
            errors.append(f"features: 标签「{label}」重复")
            continue
        seen.add(label)
        features.append({"label": label, "value": value})
    return features


def _load_dim_scores(raw: str) -> dict:
    try:
        data = json.loads(raw or "{}")
        if not isinstance(data, dict):
            return {}
        return {k: v for k, v in data.items() if k in _DIM_KEYS and isinstance(v, int)
                and not isinstance(v, bool) and 0 <= v <= 5}
    except (json.JSONDecodeError, TypeError):
        return {}


def _parse_dim_scores(raw: object, errors: list[str]) -> dict:
    """维度评分校验：{维度键: 0~5 整数}，键限 6 维度、子集允许（未评维度不参与计算）。"""
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        errors.append("dim_scores: 应为维度评分对象")
        return {}
    scores: dict = {}
    for key, value in raw.items():
        if key not in _DIM_KEYS:
            errors.append(f"dim_scores: 未知维度「{key}」")
            continue
        if value in (None, ""):
            continue
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 5:
            errors.append(f"dim_scores: 维度「{key}」应为 0~5 的整数评分")
            continue
        scores[key] = value
    return scores


def _weighted_score(dim_scores: dict, weights: dict) -> float | None:
    """加权评分 = Σ(得分×权重) ÷ 已评维度权重之和（部分未评时归一化，design §5）。"""
    if not dim_scores:
        return None
    total_weight = sum(weights.get(k, 0) for k in dim_scores)
    if total_weight <= 0:
        return None
    return round(sum(s * weights.get(k, 0) for k, s in dim_scores.items()) / total_weight, 1)


# ============================================================
# 评分权重配置（决策点 D5：用户可自定义，合计 100）
# ============================================================

def get_weights(conn: sqlite3.Connection, user_id: int) -> dict:
    return get_scoring_config(conn, user_id)["weights"]


def get_scoring_config(conn: sqlite3.Connection, user_id: int) -> dict:
    """评分权重为每用户一行（个人偏好不共享，design §4.3）。"""
    row = _row(conn, "SELECT weights FROM house_scoring_config WHERE user_id = ?",
               (user_id,))
    if row:
        try:
            weights = json.loads(row["weights"])
            if isinstance(weights, dict) and set(weights) == _DIM_KEYS \
                    and all(isinstance(v, int) and not isinstance(v, bool)
                            and 0 <= v <= 100 for v in weights.values()):
                return {"weights": weights, "is_default": False}
        except (json.JSONDecodeError, TypeError):
            pass
    return {"weights": dict(_DEFAULT_WEIGHTS), "is_default": True}


def update_scoring_config(conn: sqlite3.Connection, payload: dict, user_id: int) -> dict:
    errors: list[str] = []
    raw = payload.get("weights")
    if not isinstance(raw, dict):
        raise AppError(4001, "评分权重校验失败", data={"errors": ["weights: 应为权重对象"]})
    weights: dict = {}
    for key, value in raw.items():
        if key not in _DIM_KEYS:
            errors.append(f"weights: 未知维度「{key}」")
            continue
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 100:
            errors.append(f"weights: 维度「{key}」应为 0~100 的整数")
            continue
        weights[key] = value
    if len(weights) != len(_DIM_KEYS):
        errors.append("weights: 需提供全部 6 个维度的权重")
    elif sum(weights.values()) != 100:
        errors.append(f"weights: 权重合计应为 100（当前 {sum(weights.values())}）")
    if errors:
        raise AppError(4001, "评分权重校验失败", data={"errors": errors})
    Database.execute(
        conn,
        "INSERT INTO house_scoring_config (user_id, weights) VALUES (?, ?) "
        "ON CONFLICT(user_id) DO UPDATE SET weights=excluded.weights, "
        "updated_at=datetime('now', 'localtime')",
        (user_id, _dump_json(weights)),
    )
    return get_scoring_config(conn, user_id)


# ============================================================
# 房源档案 CRUD
# ============================================================

def _validate_candidate(payload: dict, original: dict | None = None) -> tuple[dict, list]:
    """校验并规范化房源档案字段（design §2.1/§3）。"""
    errors: list[str] = []
    data: dict = {}
    base = original or {}

    title = str(payload.get("title") or base.get("title") or "").strip()
    if not title or len(title) > 60:
        errors.append("title: 房源名称必填且不超过 60 字")
    data["title"] = title

    for key, limit in (("community", 60), ("city", 30), ("district", 30),
                       ("layout", 30), ("floor_info", 30), ("orientation", 30)):
        data[key] = str(payload.get(key, base.get(key, "")) or "").strip()[:limit]

    area = payload.get("area", base.get("area"))
    if area in (None, ""):
        data["area"] = None
    elif isinstance(area, (int, float)) and not isinstance(area, bool) and 0 < float(area) <= 10000:
        data["area"] = round(float(area), 1)
    else:
        errors.append("area: 应为 0~10000 的面积数字（㎡）")
        data["area"] = None

    build_year = payload.get("build_year", base.get("build_year"))
    if build_year in (None, ""):
        data["build_year"] = None
    elif isinstance(build_year, int) and not isinstance(build_year, bool) \
            and 1900 <= build_year <= 2100:
        data["build_year"] = build_year
    else:
        errors.append("build_year: 应为 1900~2100 的年份数字")
        data["build_year"] = None

    total = payload.get("total_price_cents", base.get("total_price_cents"))
    if total in (None, ""):
        data["total_price_cents"] = None
    elif isinstance(total, int) and not isinstance(total, bool) \
            and 0 < total <= 100_000 * 100 * 1_000_000:
        data["total_price_cents"] = total
    else:
        errors.append("total_price_cents: 总价应为正整数（分）")
        data["total_price_cents"] = None

    unit = payload.get("unit_price_cents", base.get("unit_price_cents"))
    if unit in (None, ""):
        data["unit_price_cents"] = None
    elif isinstance(unit, int) and not isinstance(unit, bool) \
            and 0 < unit <= 1_000_000 * 100:
        data["unit_price_cents"] = unit
    else:
        errors.append("unit_price_cents: 单价应为正整数（分/㎡）")
        data["unit_price_cents"] = None

    # 价格推算（design §3）：缺单价时 总价÷面积，缺总价时 单价×面积
    if data["total_price_cents"] is None and data["unit_price_cents"] is not None and data["area"]:
        data["total_price_cents"] = round(data["unit_price_cents"] * data["area"])
    if data["unit_price_cents"] is None and data["total_price_cents"] is not None and data["area"]:
        data["unit_price_cents"] = round(data["total_price_cents"] / data["area"])

    status = str(payload.get("status") or base.get("status") or "watching").strip()
    if status not in _STATUSES:
        errors.append("status: 枚举不合法")
    data["status"] = status

    score = payload.get("score", base.get("score"))
    if score in (None, ""):
        data["score"] = None
    elif isinstance(score, (int, float)) and not isinstance(score, bool) and 0 <= float(score) <= 5:
        data["score"] = round(float(score), 1)
    else:
        errors.append("score: 应为 0~5 的评分（支持一位小数）")
        data["score"] = None

    data["pros"] = str(payload.get("pros", base.get("pros", "")) or "").strip()[:500]
    data["cons"] = str(payload.get("cons", base.get("cons", "")) or "").strip()[:500]
    data["notes"] = str(payload.get("notes", base.get("notes", "")) or "").strip()[:500]

    features_raw = payload.get("features", base.get("features") if original else None)
    data["features"] = _parse_features(features_raw, errors)

    dim_raw = payload.get("dim_scores", _load_dim_scores(base.get("dim_scores", "{}")) if original else None)
    data["dim_scores"] = _parse_dim_scores(dim_raw, errors)
    return data, errors


def _decorate(conn: sqlite3.Connection, row: dict, weights: dict) -> dict:
    """附加展示字段：features/dim_scores 解析 + 照片聚合 + 加权评分（design §3/§5）。

    weights 由调用方按当前请求用户查出传入（评分权重为个人偏好，不随家庭共享）。
    """
    row["features"] = _load_items(row.get("features") or "[]")
    row["dim_scores"] = _load_dim_scores(row.get("dim_scores") or "{}")
    photos = _row(conn, "SELECT COUNT(*) AS n FROM house_photos WHERE candidate_id = ?",
                 (row["id"],))["n"]
    row["computed"] = {
        "photo_count": photos,
        "weighted_score": _weighted_score(row["dim_scores"], weights),
    }
    return row


def list_candidates(conn: sqlite3.Connection, user_id: int) -> list[dict]:
    # M4 全家庭共享（design §4.3）：读不过滤 user_id，user_id 仅为创建者审计
    rows = Database.query(conn, "SELECT * FROM house_candidates ORDER BY id DESC")
    weights = get_weights(conn, user_id)
    return [_decorate(conn, r, weights) for r in rows]


def get_candidate(conn: sqlite3.Connection, candidate_id: int, user_id: int) -> dict:
    row = _row(conn, "SELECT * FROM house_candidates WHERE id = ?", (candidate_id,))
    if not row:
        raise AppError(4004, "候选房源不存在")
    row = _decorate(conn, row, get_weights(conn, user_id))
    row["photos"] = list_photos(conn, candidate_id)
    return row


def create_candidate(conn: sqlite3.Connection, payload: dict, user_id: int) -> dict:
    data, errors = _validate_candidate(payload)
    if errors:
        raise AppError(4001, "房源校验失败", data={"errors": errors})
    candidate_id = Database.execute(
        conn,
        "INSERT INTO house_candidates (user_id, title, community, city, district, area, layout, "
        "floor_info, orientation, build_year, total_price_cents, unit_price_cents, status, score, "
        "pros, cons, notes, features, dim_scores) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (user_id, data["title"], data["community"], data["city"], data["district"],
         data["area"], data["layout"], data["floor_info"], data["orientation"],
         data["build_year"], data["total_price_cents"], data["unit_price_cents"],
         data["status"], data["score"], data["pros"], data["cons"], data["notes"],
         _dump_json(data["features"]), _dump_json(data["dim_scores"])),
    )
    return get_candidate(conn, candidate_id, user_id)


def update_candidate(conn: sqlite3.Connection, candidate_id: int, payload: dict,
                     user_id: int) -> dict:
    original = _row(conn, "SELECT * FROM house_candidates WHERE id = ?", (candidate_id,))
    if not original:
        raise AppError(4004, "候选房源不存在")
    data, errors = _validate_candidate(payload, original)
    if errors:
        raise AppError(4001, "房源校验失败", data={"errors": errors})
    Database.execute(
        conn,
        "UPDATE house_candidates SET title=?, community=?, city=?, district=?, area=?, layout=?, "
        "floor_info=?, orientation=?, build_year=?, total_price_cents=?, unit_price_cents=?, "
        "status=?, score=?, pros=?, cons=?, notes=?, features=?, dim_scores=? WHERE id=?",
        (data["title"], data["community"], data["city"], data["district"], data["area"],
         data["layout"], data["floor_info"], data["orientation"], data["build_year"],
         data["total_price_cents"], data["unit_price_cents"], data["status"], data["score"],
         data["pros"], data["cons"], data["notes"], _dump_json(data["features"]),
         _dump_json(data["dim_scores"]), candidate_id),
    )
    return get_candidate(conn, candidate_id, user_id)


def delete_candidate(conn: sqlite3.Connection, upload_dir: Path, candidate_id: int) -> None:
    """物理删除：级联 photos 行由 FK CASCADE 处理，照片物理文件逐一清理。"""
    row = _row(conn, "SELECT id FROM house_candidates WHERE id = ?", (candidate_id,))
    if not row:
        raise AppError(4004, "候选房源不存在")
    for photo in Database.query(
            conn, "SELECT file_path FROM house_photos WHERE candidate_id = ?", (candidate_id,)):
        (_photo_root(upload_dir) / photo["file_path"]).unlink(missing_ok=True)
    Database.execute(conn, "DELETE FROM house_candidates WHERE id = ?", (candidate_id,))


# ============================================================
# 房源照片
# ============================================================

def _photo_root(upload_dir: Path) -> Path:
    root = upload_dir / "house"
    root.mkdir(parents=True, exist_ok=True)
    return root


def list_photos(conn: sqlite3.Connection, candidate_id: int) -> list[dict]:
    return Database.query(
        conn,
        "SELECT id, candidate_id, kind, file_name, file_path, file_size, file_type, remark, created_at "
        "FROM house_photos WHERE candidate_id = ? ORDER BY kind, id",
        (candidate_id,),
    )


def save_photo(conn: sqlite3.Connection, upload_dir: Path, candidate_id: int,
               file_name: str, data: bytes, kind: str = "other") -> dict:
    if not _row(conn, "SELECT id FROM house_candidates WHERE id = ?", (candidate_id,)):
        raise AppError(4004, "候选房源不存在")
    errors: list[str] = []
    k = str(kind or "other").strip() or "other"
    if k not in _PHOTO_KINDS:
        errors.append("kind: 应为 exterior/interior/layout/other")
    ext = Path(file_name).suffix.lstrip(".").lower()
    if ext not in _MAGIC_RULES:
        errors.append("file: 仅支持 jpg/jpeg/png/webp/heic 格式")
    if len(data) > MAX_FILE_SIZE:
        errors.append("file: 单文件不能超过 10 MB")
    if len(data) == 0:
        errors.append("file: 文件为空")
    count = _row(conn, "SELECT COUNT(*) AS n FROM house_photos WHERE candidate_id = ?",
                 (candidate_id,))["n"]
    if count >= _MAX_PHOTOS_PER_CANDIDATE:
        errors.append(f"file: 单房源照片不能超过 {_MAX_PHOTOS_PER_CANDIDATE} 张")
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
        "INSERT INTO house_photos (candidate_id, kind, file_name, file_path, file_size, file_type) "
        "VALUES (?,?,?,?,?,?)",
        (candidate_id, k, file_name[:200], rel_path, len(data), ext),
    )
    return {"id": photo_id, "file_name": file_name, "file_type": ext, "file_size": len(data), "kind": k}


def get_photo(conn: sqlite3.Connection, upload_dir: Path, photo_id: int) -> tuple[dict, Path]:
    row = _row(conn, "SELECT * FROM house_photos WHERE id = ?", (photo_id,))
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
    Database.execute(conn, "DELETE FROM house_photos WHERE id = ?", (photo_id,))


# ============================================================
# 对比矩阵（design §4.3，决策点 D3：全标签并集 + 独有高亮）
# ============================================================

def compare(conn: sqlite3.Connection, id_list: list[int], user_id: int) -> dict:
    rows = []
    weights = get_weights(conn, user_id)
    for cid in id_list:
        row = _row(conn, "SELECT * FROM house_candidates WHERE id = ?", (cid,))
        if not row:
            raise AppError(4004, f"候选房源 {cid} 不存在")
        rows.append(_decorate(conn, row, weights))

    # 配套设施行：所选房源标签并集，独有（仅一个房源有此标签）标记 highlight。
    # 标签存在即代表具备；value 留空时规范化为「有」（与选车口径一致）。
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

    return {"candidates": rows, "feature_rows": feature_rows, "weights": weights}
