"""理财模块服务层（M2 家庭资产台账）。

领域规则与公式见 docs/finance-dev-plan.md §3；字段模板见 §2.2。
约定：金额一律整数分；SQLite JSON 键在服务层用 json.loads 处理（家庭量级 <10k 行可控）。
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

from app.core.database import Database
from app.core.errors import AppError

_DEFAULT_USER_ID = 1
_MAX_AMOUNT_CENTS = 10**13
MAX_FILE_SIZE = 10 * 1024 * 1024
_MAX_ATTACHMENTS_PER_ASSET = 20
_DATE_FMT = "%Y-%m-%d"

# 到期按"逾期"处理的借贷类分类（其余到期资产显示"已到期待处理"）
_LOAN_CATEGORIES = {"loan_out", "loan_in", "credit_card"}
# 允许"登记还款"的分类
_REPAYABLE = {"loan_out", "loan_in", "credit_card"}

# extra 模板：分类 → {键: 校验函数}；未声明的键按前向兼容原则保留不校验
_EXTRA_RULES: dict[str, dict[str, str]] = {
    "fixed_deposit": {"deposit_no": "str?", "auto_renew": "int01"},
    "demand": {"last_update_date": "date?"},
    "wealth": {"risk_level": "risk?", "base_rate": "rate?"},
    "metal": {"variety": "str?", "form": "metal_form?", "quantity": "pos",
              "cost_price_cents": "pos_int?", "current_price_cents": "pos_int?"},
    "stock": {"code": "str?", "market": "str?", "quantity": "pos", "cost_cents": "pos_int?"},
    "loan_out": {"repay_method": "repay_method?", "relation": "str?"},
    "loan_in": {"repay_method": "repay_method?", "relation": "str?"},
    "bond_insurance": {},
    "asset_other": {},
    "mortgage": {"total_cents": "pos_int?", "monthly_payment_cents": "pos_int?", "pay_day": "day?"},
    "credit_card": {"bill_day": "day?", "repay_day": "day?", "installment": "int01"},
    "liability_other": {},
}

# 各分类模板级必填字段（dev-plan §4.3）
_REQUIRED_FIELDS: dict[str, list[str]] = {
    "fixed_deposit": ["start_date", "end_date", "annual_rate"],
    "wealth": ["start_date", "end_date"],
    "metal": [],
    "stock": [],
    "loan_out": ["institution", "end_date"],
    "loan_in": ["institution", "end_date"],
}

# 附件白名单：扩展名 → magic bytes 斤校验（前缀或偏移特征）
_MAGIC_RULES = {
    "jpg": [(0, b"\xff\xd8\xff")], "jpeg": [(0, b"\xff\xd8\xff")],
    "png": [(0, b"\x89PNG\r\n\x1a\n")],
    "webp": [(0, b"RIFF"), (8, b"WEBP")],
    "heic": [(4, b"ftyp")],
    "pdf": [(0, b"%PDF")],
}

_STATUS_LABELS = {
    "holding": "持有中", "urgent": "即将到期", "soon": "30天内到期",
    "matured": "已到期", "overdue": "已逾期",
    "settled_withdraw": "已支取", "settled_renew": "已续存", "settled_clear": "已结清",
}
_SETTLE_LABELS = {"withdraw": "支取", "renew": "续存", "repay": "登记还款", "clear": "结清"}


# ============================================================
# 基础工具
# ============================================================

def _today() -> date:
    return date.today()


def _parse_date(value: str | None, field: str, errors: list) -> date | None:
    if value in (None, ""):
        return None
    try:
        return datetime.strptime(str(value), _DATE_FMT).date()
    except ValueError:
        errors.append(f"{field}: 日期格式应为 YYYY-MM-DD")
        return None


def _months_between(start: date, end: date) -> int:
    months = (end.year - start.year) * 12 + (end.month - start.month)
    if end.day < start.day:
        months -= 1
    return max(months, 0)


def _add_months(start: date, months: int) -> date:
    total = start.year * 12 + start.month - 1 + months
    year, month = total // 12, total % 12 + 1
    day = min(start.day, [31, 29 if year % 4 == 0 and (year % 100 != 0 or year % 400 == 0) else 28,
                          31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1])
    return date(year, month, day)


def _cents(amount: float) -> int:
    return int(round(amount))


def _validate_extra(category: str, extra: dict, errors: list) -> None:
    for key, rule in _EXTRA_RULES.get(category, {}).items():
        if key not in extra:
            if rule in ("pos",):  # 模板级必填的 extra 键
                errors.append(f"extra.{key}: 必填")
            continue
        value = extra[key]
        try:
            if rule == "int01" and str(value) not in ("0", "1"):
                raise ValueError("取值应为 0 或 1")
            if rule == "pos" and not float(value) > 0:
                raise ValueError("必须大于 0")
            if rule in ("pos_int", "pos_int?") and not int(value) > 0:
                raise ValueError("必须为正整数")
            if rule == "rate?" and not 0 <= float(value) <= 100:
                raise ValueError("应在 0~100 之间")
            if rule == "risk?" and str(value) not in {"R1", "R2", "R3", "R4", "R5"}:
                raise ValueError("应为 R1~R5")
            if rule == "metal_form?" and str(value) not in {"physical", "paper", "accumulate"}:
                raise ValueError("取值应为 physical/paper/accumulate")
            if rule == "repay_method?" and str(value) not in {"once", "installment"}:
                raise ValueError("取值应为 once/installment")
            if rule == "day?" and not 1 <= int(value) <= 28:
                raise ValueError("应在 1~28 之间")
            if rule == "date?":
                datetime.strptime(str(value), _DATE_FMT)
        except (ValueError, TypeError):
            errors.append(f"extra.{key}: 取值不合法")


def _row(conn: sqlite3.Connection, sql: str, params: tuple) -> dict | None:
    rows = Database.query(conn, sql, params)
    return rows[0] if rows else None


def add_event(conn: sqlite3.Connection, asset_id: int, event_type: str,
              detail: dict, user_id: int = _DEFAULT_USER_ID) -> None:
    Database.execute(
        conn,
        "INSERT INTO finance_asset_events (asset_id, event_type, detail, user_id) VALUES (?,?,?,?)",
        (asset_id, event_type, json.dumps(detail, ensure_ascii=False), user_id),
    )


def _event_summary(event_type: str, detail: dict, asset_name: str) -> str:
    amount = detail.get("amount_cents")
    money = f" ¥{amount / 100:,.2f}" if isinstance(amount, (int, float)) else ""
    mapping = {
        "create": f"创建资产 {asset_name}",
        "update": f"更新 {asset_name} 信息",
        "value": f"更新 {asset_name} 市值{money}",
        "attachment": f"{asset_name} 上传附件 {detail.get('file_name', '')}",
        "settle": f"{asset_name} {_SETTLE_LABELS.get(detail.get('action', ''), '流转')}{money}",
        "repay": f"{asset_name} 登记还款{money}",
    }
    return mapping.get(event_type, f"{asset_name} {event_type}")


# ============================================================
# 分类与成员
# ============================================================

def list_categories(conn: sqlite3.Connection) -> list[dict]:
    return Database.query(
        conn, "SELECT code, name, direction, sort_order, is_active FROM finance_categories ORDER BY sort_order"
    )


def list_members(conn: sqlite3.Connection) -> list[dict]:
    return Database.query(
        conn,
        "SELECT id, name, note, user_id, is_active, created_at FROM finance_members "
        "ORDER BY is_active DESC, id",
    )


def create_member(conn: sqlite3.Connection, payload: dict) -> dict:
    name = str(payload.get("name", "")).strip()
    errors = []
    if not name:
        errors.append("name: 必填")
    elif len(name) > 20:
        errors.append("name: 长度不能超过 20 字")
    elif _row(conn, "SELECT id FROM finance_members WHERE name = ?", (name,)):
        errors.append(f"name: 成员「{name}」已存在")
    if errors:
        raise AppError(4001, "参数校验失败", data={"errors": errors})
    note = str(payload.get("note", "") or "")[:200]
    member_id = Database.execute(
        conn, "INSERT INTO finance_members (name, note) VALUES (?,?)", (name, note)
    )
    return {"id": member_id, "name": name, "note": note, "is_active": 1}


def update_member(conn: sqlite3.Connection, member_id: int, payload: dict) -> dict:
    member = _row(conn, "SELECT * FROM finance_members WHERE id = ?", (member_id,))
    if not member:
        raise AppError(4004, "成员不存在")
    errors = []
    name = member["name"]
    if "name" in payload:
        name = str(payload["name"]).strip()
        if not name:
            errors.append("name: 不能为空")
        elif len(name) > 20:
            errors.append("name: 长度不能超过 20 字")
        elif member["name"] == "本人" and name != "本人":
            errors.append("name: 默认成员「本人」不可改名")
    is_active = member["is_active"]
    if "is_active" in payload:
        is_active = 1 if payload["is_active"] else 0
        if member["name"] == "本人" and not is_active:
            errors.append("is_active: 默认成员「本人」不可停用")
    if errors:
        raise AppError(4001, "参数校验失败", data={"errors": errors})
    note = str(payload.get("note", member["note"]) or "")[:200]
    Database.execute(
        conn,
        "UPDATE finance_members SET name=?, note=?, is_active=?, updated_at=datetime('now','localtime') WHERE id=?",
        (name, note, is_active, member_id),
    )
    return {"id": member_id, "name": name, "note": note, "is_active": is_active}


# ============================================================
# 有效状态与计算（§3）
# ============================================================

def _repaid_cents(conn: sqlite3.Connection, asset_id: int, until: str | None = None) -> int:
    """累计已还金额：取 repay 事件汇总（until 用于趋势的历史某日口径）。"""
    total = 0
    for row in Database.query(
        conn, "SELECT detail FROM finance_asset_events WHERE asset_id = ? AND event_type = 'repay'", (asset_id,)
    ):
        detail = json.loads(row["detail"])
        if until is None or str(detail.get("date", "")) <= until:
            total += int(detail.get("amount_cents", 0))
    return total


def effective_status(asset: dict) -> str:
    """读取时派生，不落库（dev-plan §3.1）。"""
    if asset["status"] == "settled":
        action = asset["settle_action"] or "clear"
        return f"settled_{action}"
    end = _parse_date(asset["end_date"], "end_date", [])
    if end is None:
        return "holding"
    days = (end - _today()).days
    if days < 0:
        return "overdue" if asset["category"] in _LOAN_CATEGORIES else "matured"
    if days <= 7:
        return "urgent"
    if days <= 30:
        return "soon"
    return "holding"


def compute(conn: sqlite3.Connection, asset: dict) -> dict:
    """分类计算结果（dev-plan §3.2）：按分类输出适用项。"""
    result: dict[str, Any] = {}
    category = asset["category"]
    start = _parse_date(asset["start_date"], "start_date", [])
    end = _parse_date(asset["end_date"], "end_date", [])
    extra = json.loads(asset["extra"] or "{}")

    if end:
        result["days_to_end"] = (end - _today()).days
        if start:
            result["days_held"] = max((_today() - start).days, 0)

    if category == "fixed_deposit" and start and end and asset["annual_rate"]:
        months = _months_between(start, end)
        interest = _cents(asset["amount_cents"] * asset["annual_rate"] / 100 * months / 12)
        result.update(months=months, interest_cents=interest, maturity_cents=asset["amount_cents"] + interest)

    if category == "wealth" and start and end and extra.get("base_rate"):
        # 业绩基准年化存于 extra.base_rate（非"年利率"，理财无固定利率概念）
        days = (end - start).days
        est = _cents(asset["amount_cents"] * float(extra["base_rate"]) / 100 * days / 365)
        result.update(days=days, est_interest_cents=est, maturity_cents=asset["amount_cents"] + est)

    if category == "wealth":
        # 实际收益（M2d）：最近一次收益录入事件的累计收益 + 实际年化推导
        row = _row(
            conn,
            "SELECT detail FROM finance_asset_events "
            "WHERE asset_id = ? AND event_type = 'interest' ORDER BY id DESC LIMIT 1",
            (asset["id"],),
        )
        if row:
            detail = json.loads(row["detail"])
            actual = int(detail.get("interest_cents", 0))
            result["actual_interest_cents"] = actual
            asof = _parse_date(str(detail.get("date", "")), "date", []) or _today()
            if start and asset["amount_cents"] > 0 and asof > start:
                held = (asof - start).days
                if held > 0:
                    # 实际年化（%）= 累计收益 ÷ 本金 × 365 ÷ 持有天数
                    result["actual_annualized_rate"] = round(
                        actual / asset["amount_cents"] * 100 * 365 / held, 2
                    )

    if category == "metal" and extra.get("quantity") and extra.get("current_price_cents"):
        market = _cents(float(extra["quantity"]) * int(extra["current_price_cents"]))
        cost = _cents(float(extra["quantity"]) * int(extra.get("cost_price_cents", 0)))
        result.update(market_value_cents=market, pnl_cents=market - cost)

    if category == "stock" and extra.get("cost_cents"):
        result.update(pnl_cents=asset["amount_cents"] - int(extra["cost_cents"]))

    if category in _REPAYABLE:
        repaid = _repaid_cents(conn, asset["id"])
        remaining = max(asset["amount_cents"] - repaid, 0)
        result.update(repaid_cents=repaid, remaining_cents=remaining, can_settle=remaining == 0)

    if category == "mortgage" and extra.get("monthly_payment_cents"):
        monthly = int(extra["monthly_payment_cents"])
        if monthly > 0:
            result.update(remaining_months=_cents(asset["amount_cents"] / monthly))
    return result


def _due_amount(conn: sqlite3.Connection, asset: dict, computed: dict | None = None) -> int:
    """到期金额口径：定期/理财=到期本息；借贷=未还；其余=当前金额。"""
    computed = computed if computed is not None else compute(conn, asset)
    if asset["category"] in ("fixed_deposit", "wealth"):
        return computed.get("maturity_cents", asset["amount_cents"])
    if asset["category"] in _REPAYABLE:
        return computed.get("remaining_cents", asset["amount_cents"])
    return asset["amount_cents"]


def _decorate(conn: sqlite3.Connection, asset: dict) -> dict:
    asset["effective_status"] = effective_status(asset)
    asset["status_label"] = _STATUS_LABELS.get(asset["effective_status"], asset["effective_status"])
    asset["computed"] = compute(conn, asset)
    cat = _row(conn, "SELECT name FROM finance_categories WHERE code = ?", (asset["category"],))
    asset["category_name"] = cat["name"] if cat else asset["category"]
    holder = _row(conn, "SELECT name FROM finance_members WHERE id = ?", (asset["holder_member_id"],))
    asset["holder_name"] = holder["name"] if holder else "—"
    asset["extra_data"] = json.loads(asset["extra"] or "{}")
    return asset


# ============================================================
# 资产 CRUD
# ============================================================

def _validate_asset(conn: sqlite3.Connection, payload: dict, original: dict | None = None) -> tuple[dict, list]:
    """校验并归一化资产字段；original 提供时为编辑合并模式。返回 (归一化字段, 错误清单)。"""
    data = dict(original) if original else {}
    errors: list[str] = []

    for key in ("name", "direction", "category", "institution", "note"):
        if key in payload or original is None:
            data[key] = str(payload.get(key, data.get(key, "")) or "")
    name = data.get("name", "").strip()
    if not name:
        errors.append("name: 必填")
    elif len(name) > 100:
        errors.append("name: 长度不能超过 100 字")
    data["name"] = name
    data["institution"] = str(data.get("institution", "") or "")[:100]
    data["note"] = str(payload.get("note", data.get("note", "")) or "")[:500]

    # 方向与分类
    category_code = payload.get("category", data.get("category"))
    if original is None or "category" in payload:
        cat = _row(conn, "SELECT * FROM finance_categories WHERE code = ?", (category_code,))
        if not cat:
            errors.append(f"category: 分类 {category_code} 不存在")
        else:
            data["category"] = cat["code"]
            if not cat["is_active"]:
                errors.append(f"category: 分类 {cat['name']} 已停用")
    direction = payload.get("direction", data.get("direction"))
    if direction not in ("asset", "liability"):
        errors.append("direction: 取值应为 asset/liability")
    else:
        data["direction"] = direction
        cat = _row(conn, "SELECT * FROM finance_categories WHERE code = ?", (data.get("category"),))
        if cat and cat["direction"] != direction:  # 编辑只改 direction 时同样交叉校验
            errors.append(f"direction: 与分类方向不符（{cat['direction']}）")

    # 金额
    if "amount_cents" in payload or original is None:
        try:
            amount = int(payload.get("amount_cents", data.get("amount_cents", 0)))
            if not 0 < amount <= _MAX_AMOUNT_CENTS:
                raise ValueError
            data["amount_cents"] = amount
        except (TypeError, ValueError):
            errors.append("amount_cents: 必须为 0~10^13 之间的正整数（单位：分）")

    # 归属人
    if "holder_member_id" in payload or original is None:
        try:
            holder_id = int(payload.get("holder_member_id", data.get("holder_member_id")))
            member = _row(conn, "SELECT * FROM finance_members WHERE id = ?", (holder_id,))
            if not member or not member["is_active"]:
                errors.append(f"holder_member_id: 成员不存在或已停用")
            else:
                data["holder_member_id"] = holder_id
        except (TypeError, ValueError):
            errors.append("holder_member_id: 必填")

    # 日期与利率
    for key in ("start_date", "end_date"):
        if key in payload or original is None:
            value = payload.get(key, data.get(key)) or None
            parsed = _parse_date(value, key, errors)
            data[key] = parsed.isoformat() if parsed else None
    if "annual_rate" in payload or original is None:
        rate = payload.get("annual_rate", data.get("annual_rate"))
        if rate in (None, ""):
            data["annual_rate"] = None
        else:
            try:
                rate = float(rate)
                if not 0 <= rate <= 100:
                    raise ValueError
                data["annual_rate"] = rate
            except (TypeError, ValueError):
                errors.append("annual_rate: 应为 0~100 之间的百分数")

    if data.get("start_date") and data.get("end_date") and data["end_date"] < data["start_date"]:
        errors.append("end_date: 不能早于 start_date")

    # extra 合并与模板校验
    if "extra" in payload or original is None:
        base = json.loads(data.get("extra") or "{}") if original is not None else {}
        incoming = payload.get("extra") or {}
        if not isinstance(incoming, dict):
            errors.append("extra: 应为对象")
            incoming = {}
        for key, value in incoming.items():
            if value in (None, ""):
                base.pop(key, None)
            else:
                base[key] = value
        data["extra"] = base
    if isinstance(data.get("extra"), str):  # 编辑未传 extra 时保持原 JSON 字符串，统一转回对象
        data["extra"] = json.loads(data["extra"] or "{}")
    _validate_extra(data.get("category", ""), data.get("extra", {}), errors)

    # 模板级必填
    for field in _REQUIRED_FIELDS.get(data.get("category", ""), []):
        if not data.get(field):
            errors.append(f"{field}: 该分类下必填")

    return data, errors


def create_asset(conn: sqlite3.Connection, payload: dict, user_id: int = _DEFAULT_USER_ID) -> int:
    data, errors = _validate_asset(conn, payload)
    if errors:
        raise AppError(4001, "参数校验失败", data={"errors": errors})
    asset_id = Database.execute(
        conn,
        "INSERT INTO finance_assets (name, direction, category, holder_member_id, institution, "
        "amount_cents, start_date, end_date, annual_rate, extra, note, user_id) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (data["name"], data["direction"], data["category"], data["holder_member_id"],
         data["institution"], data["amount_cents"], data.get("start_date"), data.get("end_date"),
         data.get("annual_rate"), json.dumps(data.get("extra", {}), ensure_ascii=False),
         data["note"], user_id),
    )
    add_event(conn, asset_id, "create", {"name": data["name"]}, user_id)
    return asset_id


def update_asset(conn: sqlite3.Connection, asset_id: int, payload: dict,
                 user_id: int = _DEFAULT_USER_ID) -> None:
    asset = _row(conn, "SELECT * FROM finance_assets WHERE id = ? AND is_deleted = 0", (asset_id,))
    if not asset:
        raise AppError(4004, "资产不存在")
    if asset["status"] == "settled":
        raise AppError(4001, "已结清记录不可编辑，请通过「续存」生成新记录")
    data, errors = _validate_asset(conn, payload, original=asset)
    if errors:
        raise AppError(4001, "参数校验失败", data={"errors": errors})
    Database.execute(
        conn,
        "UPDATE finance_assets SET name=?, direction=?, category=?, holder_member_id=?, institution=?, "
        "amount_cents=?, start_date=?, end_date=?, annual_rate=?, extra=?, note=?, "
        "updated_at=datetime('now','localtime') WHERE id=?",
        (data["name"], data["direction"], data["category"], data["holder_member_id"],
         data["institution"], data["amount_cents"], data.get("start_date"), data.get("end_date"),
         data.get("annual_rate"), json.dumps(data.get("extra", {}), ensure_ascii=False),
         data["note"], asset_id),
    )
    add_event(conn, asset_id, "update", {"name": data["name"]}, user_id)


def soft_delete_asset(conn: sqlite3.Connection, asset_id: int, user_id: int = _DEFAULT_USER_ID) -> None:
    asset = _row(conn, "SELECT * FROM finance_assets WHERE id = ? AND is_deleted = 0", (asset_id,))
    if not asset:
        raise AppError(4004, "资产不存在")
    Database.execute(
        conn, "UPDATE finance_assets SET is_deleted = 1, updated_at=datetime('now','localtime') WHERE id=?",
        (asset_id,),
    )
    add_event(conn, asset_id, "settle", {"action": "delete", "name": asset["name"]}, user_id)


def get_asset(conn: sqlite3.Connection, asset_id: int) -> dict:
    asset = _row(conn, "SELECT * FROM finance_assets WHERE id = ? AND is_deleted = 0", (asset_id,))
    if not asset:
        raise AppError(4004, "资产不存在")
    _decorate(conn, asset)
    asset["values"] = Database.query(
        conn,
        "SELECT id, value_date, value_cents, note, created_at FROM finance_asset_values "
        "WHERE asset_id = ? ORDER BY value_date",
        (asset_id,),
    )
    asset["attachments"] = Database.query(
        conn,
        "SELECT id, file_name, file_type, file_size, created_at FROM finance_attachments "
        "WHERE asset_id = ? ORDER BY id DESC",
        (asset_id,),
    )
    asset["events"] = Database.query(
        conn,
        "SELECT id, event_type, detail, created_at FROM finance_asset_events "
        "WHERE asset_id = ? ORDER BY id DESC LIMIT 100",
        (asset_id,),
    )
    for ev in asset["events"]:
        detail = json.loads(ev["detail"] or "{}")
        ev["detail_data"] = detail
        ev["summary"] = _event_summary(ev["event_type"], detail, asset["name"])
    return asset


def list_assets(conn: sqlite3.Connection, filters: dict) -> dict:
    where = ["a.is_deleted = 0"]
    params: list[Any] = []
    if filters.get("direction"):
        where.append("a.direction = ?")
        params.append(filters["direction"])
    if filters.get("category"):
        where.append("a.category = ?")
        params.append(filters["category"])
    if filters.get("holder_id"):
        where.append("a.holder_member_id = ?")
        params.append(int(filters["holder_id"]))
    if filters.get("q"):
        where.append("(a.name LIKE ? OR a.institution LIKE ?)")
        keyword = f"%{filters['q']}%"
        params.extend([keyword, keyword])
    rows = Database.query(
        conn,
        f"SELECT a.*, (SELECT COUNT(*) FROM finance_attachments t WHERE t.asset_id = a.id) AS attachment_count "
        f"FROM finance_assets a WHERE {' AND '.join(where)} ORDER BY a.category, a.end_date IS NULL, a.end_date, a.id",
        tuple(params),
    )
    status_filter = filters.get("status")
    items, groups = [], {}
    for row in rows:
        _decorate(conn, row)
        if status_filter and row["effective_status"] != status_filter \
                and not (status_filter == "settled" and row["effective_status"].startswith("settled")):
            continue
        items.append(row)
        g = groups.setdefault(row["category"], {
            "code": row["category"], "name": None, "direction": row["direction"], "count": 0, "amount_cents": 0,
        })
        g["count"] += 1
        g["amount_cents"] += row["computed"].get("remaining_cents", row["amount_cents"]) \
            if row["category"] in _REPAYABLE else row["amount_cents"]
    for g in groups.values():
        cat = _row(conn, "SELECT name FROM finance_categories WHERE code = ?", (g["code"],))
        g["name"] = cat["name"] if cat else g["code"]
    ordered = {c["code"]: None for c in list_categories(conn)}
    group_list = [groups[c] for c in ordered if c in groups]
    return {"items": items, "groups": group_list}


# ============================================================
# 状态流转（FR-09）
# ============================================================

def settle_asset(conn: sqlite3.Connection, asset_id: int, action: str, payload: dict,
                 user_id: int = _DEFAULT_USER_ID) -> dict:
    asset = _row(conn, "SELECT * FROM finance_assets WHERE id = ? AND is_deleted = 0", (asset_id,))
    if not asset:
        raise AppError(4004, "资产不存在")
    if action not in ("withdraw", "renew", "repay", "clear"):
        raise AppError(4001, "action: 取值应为 withdraw/renew/repay/clear")
    if asset["status"] != "holding":
        raise AppError(4001, "该记录已结清，不能重复流转")
    errors: list[str] = []

    if action == "renew" and asset["category"] != "fixed_deposit":
        errors.append("action: 仅银行定期支持续存")
    if action == "repay" and asset["category"] not in _REPAYABLE:
        errors.append("action: 仅借贷类分类支持登记还款")
    if errors:
        raise AppError(4001, "参数校验失败", data={"errors": errors})

    if action == "repay":
        computed = compute(conn, asset)
        remaining = computed.get("remaining_cents", asset["amount_cents"])
        try:
            amount = int(payload.get("amount_cents", 0))
            if not 0 < amount <= remaining:
                raise ValueError
        except (TypeError, ValueError):
            raise AppError(4001, f"还款金额必须为 0~¥{remaining / 100:,.2f} 之间的正数")
        repay_date = str(payload.get("date") or _today().isoformat())
        if not _parse_date(repay_date, "date", []):
            raise AppError(4001, "date: 日期格式应为 YYYY-MM-DD")
        add_event(conn, asset_id, "repay", {"amount_cents": amount, "date": repay_date}, user_id)
        repaid = _repaid_cents(conn, asset_id)
        remaining = max(asset["amount_cents"] - repaid, 0)
        return {"repaid_cents": repaid, "remaining_cents": remaining, "can_settle": remaining == 0}

    # withdraw / renew / clear → 结清该记录；renew 先校验日期再落库，避免结清后无新记录
    new_asset_id = None
    if action == "renew":
        start = _parse_date(asset["end_date"], "end_date", [])
        orig_start = _parse_date(asset["start_date"], "start_date", [])
        if not (start and orig_start):
            raise AppError(4001, "该定期缺少存入日或到期日，请先补全信息后再续存")
        renew_months = _months_between(orig_start, start)
    detail: dict = {"action": action}
    if action == "withdraw" and payload.get("amount_cents") is not None:
        detail["amount_cents"] = int(payload["amount_cents"])  # 实际支取金额（提前支取）
    Database.execute(
        conn,
        "UPDATE finance_assets SET status='settled', settle_action=?, settled_at=datetime('now','localtime'), "
        "updated_at=datetime('now','localtime') WHERE id=?",
        (action, asset_id),
    )
    add_event(conn, asset_id, "settle", detail, user_id)

    if action == "renew":
        new_asset_id = create_asset(conn, {
            "name": asset["name"], "direction": "asset", "category": "fixed_deposit",
            "holder_member_id": asset["holder_member_id"], "institution": asset["institution"],
            "amount_cents": asset["amount_cents"], "start_date": start.isoformat(),
            "end_date": _add_months(start, renew_months).isoformat(), "annual_rate": asset["annual_rate"],
            "extra": json.loads(asset["extra"] or "{}"), "note": asset["note"],
        }, user_id)
    return {"settled": True, "action": action, "new_asset_id": new_asset_id}


# ============================================================
# 市值历史（FR-10）
# ============================================================

def list_values(conn: sqlite3.Connection, asset_id: int) -> list[dict]:
    if not _row(conn, "SELECT id FROM finance_assets WHERE id = ? AND is_deleted = 0", (asset_id,)):
        raise AppError(4004, "资产不存在")
    return Database.query(
        conn,
        "SELECT id, value_date, value_cents, note, created_at FROM finance_asset_values "
        "WHERE asset_id = ? ORDER BY value_date",
        (asset_id,),
    )


def add_value(conn: sqlite3.Connection, asset_id: int, payload: dict,
              user_id: int = _DEFAULT_USER_ID) -> dict:
    asset = _row(conn, "SELECT * FROM finance_assets WHERE id = ? AND is_deleted = 0", (asset_id,))
    if not asset:
        raise AppError(4004, "资产不存在")
    if asset["status"] != "holding":
        raise AppError(4001, "已结清记录不能更新市值")
    errors: list[str] = []
    try:
        value = int(payload.get("value_cents", 0))
        if not 0 < value <= _MAX_AMOUNT_CENTS:
            raise ValueError
    except (TypeError, ValueError):
        errors.append("value_cents: 必须为正整数（单位：分）")
    value_date = str(payload.get("value_date") or _today().isoformat())
    if not _parse_date(value_date, "value_date", errors):
        errors.append("value_date: 日期格式应为 YYYY-MM-DD")
    if errors:
        raise AppError(4001, "参数校验失败", data={"errors": errors})
    note = str(payload.get("note", "") or "")[:200]
    Database.execute(
        conn,
        "INSERT INTO finance_asset_values (asset_id, value_date, value_cents, note) VALUES (?,?,?,?)",
        (asset_id, value_date, value, note),
    )
    # 手动更新市值同时刷新当前金额与活期余额更新日期（FR-10）
    Database.execute(
        conn, "UPDATE finance_assets SET amount_cents=?, updated_at=datetime('now','localtime') WHERE id=?",
        (value, asset_id),
    )
    add_event(conn, asset_id, "value", {"amount_cents": value, "date": value_date}, user_id)
    return {"value_cents": value, "value_date": value_date}


def add_interest(conn: sqlite3.Connection, asset_id: int, payload: dict,
                 user_id: int = _DEFAULT_USER_ID) -> dict:
    """录入理财实际累计收益（M2d）：快照存市值轨迹（本金+收益），事件存收益数值。

    不刷新 amount_cents（理财的 amount_cents 始终是本金语义，与定期口径一致）。
    """
    asset = _row(conn, "SELECT * FROM finance_assets WHERE id = ? AND is_deleted = 0", (asset_id,))
    if not asset:
        raise AppError(4004, "资产不存在")
    if asset["category"] != "wealth":
        raise AppError(4001, "仅理财产品支持实际收益录入")
    if asset["status"] != "holding":
        raise AppError(4001, "已结清记录不能录入收益")
    errors: list[str] = []
    try:
        interest = int(payload.get("interest_cents", -1))
        if not 0 <= interest <= _MAX_AMOUNT_CENTS:
            raise ValueError
    except (TypeError, ValueError):
        errors.append("interest_cents: 必须为 0~最大金额之间的整数（单位：分）")
    value_date = str(payload.get("value_date") or _today().isoformat())
    if not _parse_date(value_date, "value_date", errors):
        errors.append("value_date: 日期格式应为 YYYY-MM-DD")
    if errors:
        raise AppError(4001, "参数校验失败", data={"errors": errors})
    note = str(payload.get("note", "") or "")[:200]
    market = asset["amount_cents"] + interest  # 市值 = 本金 + 累计收益
    Database.execute(
        conn,
        "INSERT INTO finance_asset_values (asset_id, value_date, value_cents, note) VALUES (?,?,?,?)",
        (asset_id, value_date, market, note),
    )
    add_event(conn, asset_id, "interest",
              {"interest_cents": interest, "date": value_date, "market_value_cents": market}, user_id)
    return {"interest_cents": interest, "value_cents": market, "value_date": value_date}


# ============================================================
# 附件（FR-05，dev-plan §5）
# ============================================================

def _attachment_root(upload_dir: Path) -> Path:
    root = upload_dir / "finance"
    root.mkdir(parents=True, exist_ok=True)
    return root


def save_attachment(conn: sqlite3.Connection, upload_dir: Path, asset_id: int,
                    file_name: str, data: bytes, user_id: int = _DEFAULT_USER_ID) -> dict:
    asset = _row(conn, "SELECT * FROM finance_assets WHERE id = ? AND is_deleted = 0", (asset_id,))
    if not asset:
        raise AppError(4004, "资产不存在")
    errors: list[str] = []
    ext = Path(file_name).suffix.lstrip(".").lower()
    if ext not in _MAGIC_RULES:
        errors.append("file: 仅支持 jpg/jpeg/png/webp/heic/pdf 格式")
    if len(data) > MAX_FILE_SIZE:
        errors.append("file: 单文件不能超过 10 MB")
    count = _row(conn, "SELECT COUNT(*) AS n FROM finance_attachments WHERE asset_id = ?", (asset_id,))["n"]
    if count >= _MAX_ATTACHMENTS_PER_ASSET:
        errors.append(f"file: 单资产附件不能超过 {_MAX_ATTACHMENTS_PER_ASSET} 个")
    # magic bytes 双校验（白名单 + 内容特征）
    if ext in _MAGIC_RULES and data:
        for offset, signature in _MAGIC_RULES[ext]:
            if data[offset:offset + len(signature)] != signature:
                errors.append(f"file: 文件内容与 {ext} 格式不符")
                break
    if errors:
        raise AppError(4001, "附件校验失败", data={"errors": errors})

    stored = f"{uuid.uuid4().hex}.{ext}"
    rel_path = f"{asset_id}/{stored}"
    target = _attachment_root(upload_dir) / str(asset_id)
    target.mkdir(parents=True, exist_ok=True)
    (target / stored).write_bytes(data)

    attachment_id = Database.execute(
        conn,
        "INSERT INTO finance_attachments (asset_id, file_name, file_path, file_type, file_size) VALUES (?,?,?,?,?)",
        (asset_id, file_name[:200], rel_path, ext, len(data)),
    )
    add_event(conn, asset_id, "attachment", {"file_name": file_name}, user_id)
    return {"id": attachment_id, "file_name": file_name, "file_type": ext, "file_size": len(data)}


def get_attachment(conn: sqlite3.Connection, upload_dir: Path, attachment_id: int) -> tuple[dict, Path]:
    """返回 (附件行, 物理路径)。路径规范化校验杜绝穿越（dev-plan §5）。"""
    row = _row(conn, "SELECT * FROM finance_attachments WHERE id = ?", (attachment_id,))
    if not row:
        raise AppError(4004, "附件不存在")
    root = _attachment_root(upload_dir).resolve()
    full = (root / row["file_path"]).resolve()
    if not str(full).startswith(str(root) + "/") and full != root:
        raise AppError(4004, "附件路径不合法")
    if not full.is_file():
        raise AppError(4004, "附件文件已丢失")
    return row, full


def delete_attachment(conn: sqlite3.Connection, upload_dir: Path, attachment_id: int,
                      user_id: int = _DEFAULT_USER_ID) -> None:
    row, full = get_attachment(conn, upload_dir, attachment_id)
    full.unlink(missing_ok=True)
    Database.execute(conn, "DELETE FROM finance_attachments WHERE id = ?", (attachment_id,))
    add_event(conn, row["asset_id"], "attachment", {"file_name": row["file_name"], "deleted": 1}, user_id)


# ============================================================
# 总览 / 趋势 / 日历（FR-06~08）
# ============================================================

def _holding_assets(conn: sqlite3.Connection) -> list[dict]:
    return Database.query(
        conn,
        "SELECT * FROM finance_assets WHERE is_deleted = 0 AND status = 'holding' "
        "ORDER BY category, end_date IS NULL, end_date, id",
    )


def overview(conn: sqlite3.Connection) -> dict:
    assets_rows = _holding_assets(conn)
    totals = {"assets_cents": 0, "liabilities_cents": 0, "net_cents": 0}
    by_category: dict[str, dict] = {}
    by_member: dict[int, dict] = {}
    by_institution: dict[str, dict] = {}
    members = {m["id"]: m["name"] for m in list_members(conn)}
    for row in assets_rows:
        _decorate(conn, row)
        amount = row["computed"].get("remaining_cents", row["amount_cents"]) \
            if row["category"] in _REPAYABLE else row["amount_cents"]
        if row["direction"] == "asset":
            totals["assets_cents"] += amount
        else:
            totals["liabilities_cents"] += amount
        cat = by_category.setdefault(row["category"], {
            "code": row["category"], "name": row["category_name"],
            "direction": row["direction"], "count": 0, "amount_cents": 0,
        })
        cat["count"] += 1
        cat["amount_cents"] += amount
        if row["direction"] == "asset":
            mem = by_member.setdefault(row["holder_member_id"], {
                "member_id": row["holder_member_id"], "name": members.get(row["holder_member_id"], "—"),
                "amount_cents": 0,
            })
            mem["amount_cents"] += amount
            inst_name = (row["institution"] or "").strip() or "未填写机构"
            inst = by_institution.setdefault(inst_name, {
                "name": inst_name, "count": 0, "amount_cents": 0,
            })
            inst["count"] += 1
            inst["amount_cents"] += amount
    totals["net_cents"] = totals["assets_cents"] - totals["liabilities_cents"]

    upcoming = []
    for row in assets_rows:
        if row["end_date"] and row["computed"].get("days_to_end") is not None \
                and row["computed"]["days_to_end"] <= 30:
            upcoming.append({
                "asset_id": row["id"], "name": row["name"], "category": row["category"],
                "end_date": row["end_date"], "level": row["effective_status"],
                "days_to_end": row["computed"]["days_to_end"],
                "amount_cents": _due_amount(conn, row, row["computed"]),
            })
    upcoming.sort(key=lambda x: x["days_to_end"])
    upcoming = upcoming[:8]

    recent = Database.query(
        conn,
        "SELECT e.event_type, e.detail, e.created_at, a.name AS asset_name FROM finance_asset_events e "
        "JOIN finance_assets a ON a.id = e.asset_id WHERE a.is_deleted = 0 "
        "ORDER BY e.id DESC LIMIT 8",
    )
    recent_events = [{
        "type": ev["event_type"], "summary": _event_summary(ev["event_type"], json.loads(ev["detail"] or "{}"), ev["asset_name"]),
        "at": ev["created_at"],
    } for ev in recent]

    return {
        "totals": totals,
        "by_category": sorted(by_category.values(), key=lambda g: (-g["amount_cents"])),
        "by_member": sorted(by_member.values(), key=lambda m: -m["amount_cents"]),
        "by_institution": sorted(by_institution.values(), key=lambda i: -i["amount_cents"]),
        "upcoming": upcoming,
        "recent_events": recent_events,
    }


def _value_at(conn: sqlite3.Connection, asset: dict, day: date) -> int | None:
    """资产在历史某日的价值：优先取快照；定期类按利息逐月累计推算；否则取当前金额。"""
    start = _parse_date(asset["start_date"], "start", [])
    if start and start > day:
        return None  # 尚未持有
    iso = day.isoformat()
    snap = _row(
        conn,
        "SELECT value_cents FROM finance_asset_values WHERE asset_id = ? AND value_date <= ? "
        "ORDER BY value_date DESC LIMIT 1",
        (asset["id"], iso),
    )
    if snap:
        return snap["value_cents"]
    end = _parse_date(asset["end_date"], "end", [])
    if asset["category"] == "fixed_deposit" and start and asset["annual_rate"]:
        anchor = min(end, day) if end else day
        months = _months_between(start, anchor)
        return asset["amount_cents"] + _cents(asset["amount_cents"] * asset["annual_rate"] / 100 * months / 12)
    return asset["amount_cents"]


def trend(conn: sqlite3.Connection, months: int = 12) -> list[dict]:
    try:
        months = max(1, min(int(months), 60))
    except (TypeError, ValueError):
        months = 12
    today = _today()
    assets_rows = [a for a in _holding_assets(conn) if a["direction"] == "asset"]
    liab_rows = [a for a in _holding_assets(conn) if a["direction"] == "liability"]
    series = []
    for i in range(months - 1, -1, -1):
        month = _add_months(date(today.year, today.month, 1), -i)
        month_end = _add_months(month, 1) - timedelta(days=1)
        anchor = min(month_end, today)
        assets_sum = sum(v for a in assets_rows if (v := _value_at(conn, a, anchor)) is not None)
        liab_sum = 0
        for a in liab_rows:
            if _value_at(conn, a, anchor) is None:
                continue
            liab_sum += max(a["amount_cents"] - _repaid_cents(conn, a["id"], until=anchor.isoformat()), 0)
        series.append({
            "date": month.isoformat()[:7],
            "assets_cents": assets_sum, "liabilities_cents": liab_sum,
            "net_cents": assets_sum - liab_sum,
        })
    return series


def calendar(conn: sqlite3.Connection, from_date: str | None, to_date: str | None) -> dict:
    start = _parse_date(from_date, "from", []) if from_date else _today()
    end = _parse_date(to_date, "to", []) if to_date else _today() + timedelta(days=90)
    levels = ["overdue", "matured", "urgent", "soon"]
    buckets: dict[str, list] = {lv: [] for lv in levels}
    for row in _holding_assets(conn):
        if not row["end_date"]:
            continue
        _decorate(conn, row)
        status = row["effective_status"]
        if status not in buckets:
            continue
        end_date = _parse_date(row["end_date"], "end", [])
        if status in ("urgent", "soon") and not (start <= end_date <= end):
            continue
        buckets[status].append({
            "asset_id": row["id"], "name": row["name"], "category": row["category"],
            "holder_name": row["holder_name"], "end_date": row["end_date"],
            "level": status, "days_to_end": row["computed"].get("days_to_end"),
            "amount_cents": _due_amount(conn, row, row["computed"]),
            "category_label": row["category_name"],
        })
    for lv in buckets:
        buckets[lv].sort(key=lambda x: x["days_to_end"] if x["days_to_end"] is not None else 0)
    return {"groups": [{"level": lv, "label": _STATUS_LABELS[lv], "items": buckets[lv]} for lv in levels]}


# ============================================================
# 对比分析（M2c · docs/finance-compare-design.md）
# ============================================================

# 浮动收益类：不参与统一年化与收益模拟（compare-design §3.2）
_FLOATING_CATEGORIES = {"demand", "metal", "stock", "asset_other"}


def _annualized_rate(asset: dict, extra: dict) -> tuple[float | None, str | None]:
    """统一年化收益率归一：定期/借贷/国债保险=annual_rate；理财=extra.base_rate（标注"业绩基准"）；
    浮动类/无利率返回 (None, None)。"""
    category = asset["category"]
    if category == "wealth":
        rate = extra.get("base_rate")
        return (float(rate), "业绩基准") if rate is not None else (None, None)
    if category in _FLOATING_CATEGORIES:
        return None, None
    rate = asset.get("annual_rate")
    return (float(rate), None) if rate is not None else (None, None)


def _rate_label(category: str, rate: float | None, extra: dict) -> str | None:
    """利率原文标签（按分类拼装口径，compare-design §5）。"""
    if category == "wealth":
        base = extra.get("base_rate")
        return f"业绩基准 {base}%" if base is not None else None
    if rate is None:
        return None
    if category in ("loan_out", "loan_in"):
        return f"约定利率 {rate}%"
    return f"年利率 {rate}%"


def _period_label(asset: dict, computed: dict, start: date | None, end: date | None) -> str | None:
    """期限标签：定期=存期月数；理财/借贷=起止天数；无区间为 None。"""
    if not (start and end):
        return None
    if asset["category"] == "fixed_deposit" and computed.get("months") is not None:
        return f"{computed['months']} 个月"
    days = (end - start).days
    return f"{days} 天" if days > 0 else None


def _due_label(asset: dict, end: date | None, days_to_end: int | None) -> str | None:
    """到期描述（与到期日历同口径）：无到期日"—"；过期标注已到期/已逾期天数。"""
    if end is None:
        return "—"
    if days_to_end is None:
        return None
    if days_to_end < 0:
        word = "已逾期" if asset["category"] in _LOAN_CATEGORIES else "已到期"
        return f"{word} {abs(days_to_end)} 天"
    return f"{days_to_end} 天后到期"


def compare_assets(conn: sqlite3.Connection, ids: list[int]) -> dict:
    """多资产并排对比（compare-design §5）：ids 去重后取前 6 个；仅资产方向，失效 id 静默跳过。"""
    unique_ids = list(dict.fromkeys(int(i) for i in ids))[:6]
    items = []
    for asset_id in unique_ids:
        row = _row(conn, "SELECT * FROM finance_assets WHERE id = ? AND is_deleted = 0", (asset_id,))
        if row is None or row["direction"] != "asset":
            continue
        _decorate(conn, row)
        extra = row["extra_data"]
        computed = row["computed"]
        start = _parse_date(row["start_date"], "start_date", [])
        end = _parse_date(row["end_date"], "end_date", [])
        rate, note = _annualized_rate(row, extra)
        risk = extra.get("risk_level")
        risk_label = f"{risk} " + {"R1": "低风险", "R2": "中低风险", "R3": "中风险",
                                   "R4": "中高风险", "R5": "高风险"}.get(str(risk), "") if risk else None
        items.append({
            "id": row["id"], "name": row["name"], "category": row["category"],
            "category_name": row["category_name"], "institution": row["institution"],
            "amount_cents": row["amount_cents"], "holder_name": row["holder_name"],
            "start_date": row["start_date"], "end_date": row["end_date"],
            "period_label": _period_label(row, computed, start, end),
            "status": row["effective_status"], "status_label": row["status_label"],
            "rate_label": _rate_label(row["category"], rate, extra),
            "annualized_rate": rate, "annualized_note": note,
            "est_interest_cents": computed.get("est_interest_cents", computed.get("interest_cents")),
            "maturity_cents": computed.get("maturity_cents"),
            "actual_interest_cents": computed.get("actual_interest_cents"),
            "actual_annualized_rate": computed.get("actual_annualized_rate"),
            "risk_level": risk, "risk_label": risk_label,
            "days_to_due": computed.get("days_to_end"),
            "due_label": _due_label(row, end, computed.get("days_to_end")),
            "attachment_count": Database.query(
                conn, "SELECT COUNT(*) AS c FROM finance_attachments WHERE asset_id = ?", (row["id"],)
            )[0]["c"],
            "floating": row["category"] in _FLOATING_CATEGORIES,
        })
    return {"items": items}
