"""认证服务：会话生命周期管理 + 成员管理（M4，docs/multi-user-module-design.md §3/§4）。

会话机制（D2）：opaque token 只存 SHA-256 哈希；双限过期——空闲 14 天滑动续期
（1 小时节流刷新，避免每请求写库）+ 绝对 30 天上限；登录签发新 token（会话固定防护）。

成员管理三条铁律（D3/D5）：
1. id=1 首管理员：不可禁用、不可降级（Home Assistant Owner 原则简化版）
2. 最后一个活跃 admin 不可禁用/降级
3. 成员只软禁用（is_active=0）不物理删除——user_id 被 30+ 业务行 FK 引用
"""

from __future__ import annotations

import sqlite3
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from app.core.database import Database
from app.core.errors import AppError
from app.core.security import hash_password, hash_token, issue_token, verify_password

SESSION_COOKIE = "fa_session"
IDLE_TIMEOUT = timedelta(days=14)        # 空闲过期：14 天滑动
ABSOLUTE_TIMEOUT = timedelta(days=30)   # 绝对上限：30 天不可续
REFRESH_INTERVAL = timedelta(hours=1)   # 滑动续期节流：距上次刷新超过 1 小时才写库
COOKIE_MAX_AGE = int(ABSOLUTE_TIMEOUT.total_seconds())

VALID_ROLES = ("admin", "member")
MIN_PASSWORD_LEN = 8

# 001_init.sql 内置弱口令 admin 的 260k 三段式哈希（用于迁移后二次校验，见 005_multi_user.sql）
BUILTIN_ADMIN_HASH = ("pbkdf2_sha256$19270a0d690f42a9623202ab9fbc5741"
                      "$d45f7e5a76a72091f8b3473b68f3fb354e8927f8e47ef82bc06b8436b744bd7c")


def _now() -> datetime:
    return datetime.now()


def _fmt(dt: datetime) -> str:
    """与 SQLite datetime('now','localtime') 同格式的本地时间字符串。"""
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def _parse(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%d %H:%M:%S")


def _user_public(row: dict) -> dict:
    """对外输出形状：绝不含 password_hash。avatar_path 为 uploads 下相对路径（空串=默认头像）。"""
    return {
        "id": row["id"],
        "username": row["username"],
        "display_name": row["display_name"],
        "role": row["role"],
        "is_active": bool(row["is_active"]),
        "must_change_password": bool(row.get("must_change_password", 0)),
        "avatar_path": row.get("avatar_path", "") or "",
    }


# ============================================================
# 会话生命周期
# ============================================================

def login(conn: sqlite3.Connection, username: str, password: str, user_agent: str = "") -> dict:
    """校验登录 → 透明哈希升级 → 签发会话。失败统一「用户名或密码不正确」防用户枚举。"""
    rows = Database.query(conn, "SELECT * FROM users WHERE username = ?", (username,))
    if not rows:
        raise AppError(4001, "用户名或密码不正确", http_status=401)
    row = rows[0]
    valid, needs_rehash = verify_password(password, row["password_hash"])
    if not valid:
        raise AppError(4001, "用户名或密码不正确", http_status=401)
    if not row["is_active"]:
        raise AppError(4003, "账号已被禁用，请联系管理员", http_status=403)

    if needs_rehash:  # 旧格式/低轮数 → 现行 600k 四段式（Django 同款透明升级）
        Database.execute(
            conn, "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?",
            (hash_password(password), _fmt(_now()), row["id"]),
        )

    token = issue_token()
    now = _now()
    Database.execute(
        conn,
        "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_active_at, user_agent) "
        "VALUES (?,?,?,?,?,?)",
        (hash_token(token), row["id"], _fmt(now), _fmt(now + ABSOLUTE_TIMEOUT), _fmt(now),
         user_agent[:200]),
    )
    return {
        "user": _user_public(row),
        "must_change_password": bool(row["must_change_password"]),
        "token": token,
        "cookie_max_age": COOKIE_MAX_AGE,
    }


def validate_session(conn: sqlite3.Connection, token: str) -> dict | None:
    """按 token 哈希加载用户：双限校验 + 节流续期 + is_active 校验。无效/过期删行返回 None。"""
    rows = Database.query(
        conn,
        "SELECT s.id AS session_id, s.expires_at, s.last_active_at, u.* "
        "FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?",
        (hash_token(token),),
    )
    if not rows:
        return None
    s = rows[0]
    now = _now()
    expired = (
        not s["is_active"]
        or now > _parse(s["expires_at"])
        or now - _parse(s["last_active_at"]) > IDLE_TIMEOUT
    )
    if expired:
        Database.execute(conn, "DELETE FROM sessions WHERE id = ?", (s["session_id"],))
        return None
    # 滑动续期节流：超过 1 小时未刷新才写库
    if now - _parse(s["last_active_at"]) > REFRESH_INTERVAL:
        Database.execute(
            conn, "UPDATE sessions SET last_active_at = ? WHERE id = ?",
            (_fmt(now), s["session_id"]),
        )
    return _user_public(s)


def logout(conn: sqlite3.Connection, token: str) -> None:
    """登出即吊销：删除会话行（cookie 由路由层清除）。"""
    Database.execute(conn, "DELETE FROM sessions WHERE token_hash = ?", (hash_token(token),))


def _assert_password_strength(new_password: Any, username: str) -> None:
    if not isinstance(new_password, str) or len(new_password) < MIN_PASSWORD_LEN:
        raise AppError(4001, f"密码至少 {MIN_PASSWORD_LEN} 位")
    if new_password == username:
        raise AppError(4001, "密码不能与用户名相同")


def change_password(conn: sqlite3.Connection, user_id: int, old_password: str, new_password: Any,
                    current_token: str) -> dict:
    """本人改密：更新哈希 → 清强制改密标记 → 吊销其他会话。

    强制改密态（must_change_password=1，首登或管理员重置后）下会话本身已由
    登录接口校验过凭据，豁免旧密码（刷新页面重入也无需再输一次当前密码）；
    普通自助改密必须验证旧密码。
    """
    rows = Database.query(conn, "SELECT * FROM users WHERE id = ?", (user_id,))
    if not rows:
        raise AppError(4001, "旧密码不正确", http_status=401)
    if not rows[0]["must_change_password"] and not verify_password(
            old_password or "", rows[0]["password_hash"])[0]:
        raise AppError(4001, "旧密码不正确", http_status=401)
    _assert_password_strength(new_password, rows[0]["username"])
    Database.execute(
        conn,
        "UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?",
        (hash_password(new_password), _fmt(_now()), user_id),
    )
    Database.execute(
        conn, "DELETE FROM sessions WHERE user_id = ? AND token_hash != ?",
        (user_id, hash_token(current_token)),
    )
    return _user_public(rows[0]) | {"must_change_password": False}


# ============================================================
# 成员管理（admin 限定，路由层 require_admin）
# ============================================================

def list_users(conn: sqlite3.Connection) -> list[dict]:
    rows = Database.query(conn, "SELECT * FROM users ORDER BY id ASC")
    stats = {
        r["user_id"]: r
        for r in Database.query(
            conn,
            "SELECT user_id, COUNT(*) AS active_sessions, MAX(last_active_at) AS recent_active_at "
            "FROM sessions GROUP BY user_id",
        )
    }
    out = []
    for row in rows:
        st = stats.get(row["id"], {})
        out.append(_user_public(row) | {
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "active_sessions": st.get("active_sessions", 0),
            "recent_active_at": st.get("recent_active_at"),
        })
    return out


def get_user(conn: sqlite3.Connection, user_id: int) -> dict:
    rows = Database.query(conn, "SELECT * FROM users WHERE id = ?", (user_id,))
    if not rows:
        raise AppError(4004, "成员不存在")
    return rows[0]


def create_user(conn: sqlite3.Connection, payload: dict) -> dict:
    username = (payload.get("username") or "").strip()
    password = payload.get("password")
    display_name = (payload.get("display_name") or "").strip()
    role = payload.get("role") or "member"
    if not username or len(username) > 32:
        raise AppError(4001, "用户名必填且不超过 32 个字符")
    _assert_password_strength(password, username)
    if role not in VALID_ROLES:
        raise AppError(4001, f"角色必须是 {'/'.join(VALID_ROLES)}")
    if Database.query(conn, "SELECT id FROM users WHERE username = ?", (username,)):
        raise AppError(4001, "用户名已存在")
    user_id = Database.execute(
        conn,
        "INSERT INTO users (username, password_hash, display_name, role, must_change_password) "
        "VALUES (?,?,?,?,1)",  # admin 设置的初始密码：首登强制改密（design §5.2/D7）
        (username, hash_password(password), display_name or username, role),
    )
    return {"id": user_id, "username": username, "display_name": display_name or username, "role": role}


def _active_admin_count(conn: sqlite3.Connection, exclude_id: int | None = None) -> int:
    sql = "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1"
    params: tuple = ()
    if exclude_id is not None:
        sql += " AND id != ?"
        params = (exclude_id,)
    return int(Database.query(conn, sql, params)[0]["n"])


def update_user(conn: sqlite3.Connection, target_id: int, payload: dict) -> dict:
    """更新成员（display_name/role/is_active）。三条铁律服务层校验。"""
    row = get_user(conn, target_id)

    display_name = payload.get("display_name", None)
    role = payload.get("role", None)
    is_active = payload.get("is_active", None)

    if role is not None and role not in VALID_ROLES:
        raise AppError(4001, f"角色必须是 {'/'.join(VALID_ROLES)}")

    demote = role is not None and row["role"] == "admin" and role != "admin"
    disable = is_active is not None and not is_active and row["is_active"]

    # 铁律 1：id=1 首管理员不可禁用、不可降级
    if target_id == 1 and (demote or disable):
        raise AppError(4001, "首管理员不可禁用或降级")
    # 铁律 2：最后一个活跃 admin 不可禁用/降级
    if (demote or disable) and _active_admin_count(conn, exclude_id=target_id) == 0:
        raise AppError(4001, "系统至少需要保留一个启用状态的管理员")

    sets, params = ["updated_at = ?"], [_fmt(_now())]
    if display_name is not None:
        display_name = display_name.strip()
        if not display_name:
            raise AppError(4001, "显示名不能为空")
        sets.append("display_name = ?")
        params.append(display_name)
    if role is not None:
        sets.append("role = ?")
        params.append(role)
    if is_active is not None:
        sets.append("is_active = ?")
        params.append(int(bool(is_active)))
        if not is_active:  # 禁用即时吊销其全部会话
            Database.execute(conn, "DELETE FROM sessions WHERE user_id = ?", (target_id,))
    params.append(target_id)
    Database.execute(conn, f"UPDATE users SET {', '.join(sets)} WHERE id = ?", tuple(params))
    return _user_public(get_user(conn, target_id)) | {
        "created_at": row["created_at"], "updated_at": row["updated_at"],
    }


def reset_member_password(conn: sqlite3.Connection, target_id: int, payload: dict) -> dict:
    """admin 重置成员密码：强制下次登录改密 + 吊销其全部会话。"""
    row = get_user(conn, target_id)
    _assert_password_strength(payload.get("password"), row["username"])
    Database.execute(
        conn,
        "UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?",
        (hash_password(payload["password"]), _fmt(_now()), target_id),
    )
    Database.execute(conn, "DELETE FROM sessions WHERE user_id = ?", (target_id,))
    return {"id": target_id, "must_change_password": True}


# ============================================================
# 本人资料 + 头像（头像只允许本人管理，admin 不代传，HA/Gitea 共识）
# ============================================================

def update_profile(conn: sqlite3.Connection, user_id: int, payload: dict) -> dict:
    """本人更新自己的显示名（用户名/角色等敏感字段不在此接口）。"""
    display_name = payload.get("display_name", None)
    if display_name is None:
        raise AppError(4001, "缺少 display_name")
    display_name = display_name.strip()
    if not display_name:
        raise AppError(4001, "显示名不能为空")
    if len(display_name) > 32:
        raise AppError(4001, "显示名不超过 32 个字符")
    Database.execute(
        conn, "UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?",
        (display_name, _fmt(_now()), user_id),
    )
    return _user_public(get_user(conn, user_id))


AVATAR_MAX_SIZE = 2 * 1024 * 1024  # 头像小于业务照片：2 MB 足够
_AVATAR_MAGIC = {
    "jpg": [(0, b"\xff\xd8\xff")], "jpeg": [(0, b"\xff\xd8\xff")],
    "png": [(0, b"\x89PNG\r\n\x1a\n")],
    "webp": [(0, b"RIFF"), (8, b"WEBP")],
}
AVATAR_MEDIA_TYPES = {
    "jpg": "image/jpeg", "jpeg": "image/jpeg",
    "png": "image/png", "webp": "image/webp",
}


def _avatar_root(upload_dir: Path) -> Path:
    root = upload_dir / "avatars"
    root.mkdir(parents=True, exist_ok=True)
    return root


def save_avatar(conn: sqlite3.Connection, upload_dir: Path, user_id: int,
                file_name: str, data: bytes) -> dict:
    """替换式上传本人头像：白名单扩展名 + 魔数内容校验；旧文件同步删除。"""
    errors: list[str] = []
    ext = Path(file_name).suffix.lstrip(".").lower()
    if ext not in _AVATAR_MAGIC:
        errors.append("file: 仅支持 jpg/jpeg/png/webp 格式")
    if len(data) == 0:
        errors.append("file: 文件为空")
    if len(data) > AVATAR_MAX_SIZE:
        errors.append("file: 头像不能超过 2 MB")
    if ext in _AVATAR_MAGIC and data:
        for offset, signature in _AVATAR_MAGIC[ext]:
            if data[offset:offset + len(signature)] != signature:
                errors.append(f"file: 文件内容与 {ext} 格式不符")
                break
    if errors:
        raise AppError(4001, "头像校验失败", data={"errors": errors})

    row = get_user(conn, user_id)  # 顺带校验账号存在
    root = _avatar_root(upload_dir)
    stored = f"{uuid.uuid4().hex}.{ext}"
    rel_path = f"{user_id}/{stored}"
    target_dir = root / str(user_id)
    target_dir.mkdir(parents=True, exist_ok=True)
    (target_dir / stored).write_bytes(data)

    old_rel = row.get("avatar_path", "") or ""
    Database.execute(
        conn, "UPDATE users SET avatar_path = ?, updated_at = ? WHERE id = ?",
        (rel_path, _fmt(_now()), user_id),
    )
    if old_rel:  # 替换旧头像，避免孤儿文件
        old_full = (root / old_rel).resolve()
        if str(old_full).startswith(str(root.resolve()) + "/"):
            old_full.unlink(missing_ok=True)
    return {"avatar_path": rel_path}


def get_avatar_file(conn: sqlite3.Connection, upload_dir: Path,
                    user_id: int) -> tuple[str, Path]:
    """取指定用户头像文件（成员表格需要展示他人头像，故登录后可读任意成员头像）。"""
    row = get_user(conn, user_id)
    rel = row.get("avatar_path", "") or ""
    if not rel:
        raise AppError(4004, "该用户未设置头像")
    root = _avatar_root(upload_dir).resolve()
    full = (root / rel).resolve()
    if not str(full).startswith(str(root) + "/"):
        raise AppError(4004, "头像路径不合法")
    if not full.is_file():
        raise AppError(4004, "头像文件已丢失")
    ext = full.suffix.lstrip(".").lower()
    return AVATAR_MEDIA_TYPES.get(ext, "application/octet-stream"), full


def delete_avatar(conn: sqlite3.Connection, upload_dir: Path, user_id: int) -> None:
    """删除本人头像，恢复前端默认首字头像。"""
    row = get_user(conn, user_id)
    rel = row.get("avatar_path", "") or ""
    root = _avatar_root(upload_dir).resolve()
    if rel:
        full = (root / rel).resolve()
        if str(full).startswith(str(root) + "/"):
            full.unlink(missing_ok=True)
    Database.execute(
        conn, "UPDATE users SET avatar_path = '', updated_at = ? WHERE id = ?",
        (_fmt(_now()), user_id),
    )
