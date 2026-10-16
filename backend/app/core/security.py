"""认证与安全基础设施（Python 标准库实现，无第三方依赖）。

- 密码散列格式：pbkdf2_sha256$<iterations>$<salt_hex>$<hash_hex>（四段式，轮数自带）
- 兼容 M0 三段式（pbkdf2_sha256$<salt>$<hash>，按 260k 轮解析）
- 轮数基准：600_000（OWASP Password Storage Cheat Sheet 现行标准，D6）
- 透明升级：verify_password 返回 needs_rehash 标记，登录成功后由 auth 服务重哈希
- 令牌签发：secrets.token_urlsafe(32)（256bit 熵）；入库只存 SHA-256 哈希

M0 单机免登录模式下本模块仅作为基础设施就位；FA_AUTH_ENABLED=true 后启用。
"""

from __future__ import annotations

import hashlib
import secrets

_ITERATIONS = 600_000
_LEGACY_ITERATIONS = 260_000  # M0 三段式格式的历史轮数


def hash_password(password: str) -> str:
    """按现行标准（600k 轮）生成四段式哈希。"""
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), _ITERATIONS).hex()
    return f"pbkdf2_sha256${_ITERATIONS}${salt}${digest}"


def verify_password(password: str, stored: str) -> tuple[bool, bool]:
    """校验密码，返回 (是否匹配, 是否需要重哈希升级)。

    四段式按自带轮数校验；三段式（M0 遗留）按 260k 校验。
    匹配且轮数低于现行标准时 needs_rehash=True，调用方应在登录成功后透明升级。
    """
    try:
        parts = stored.split("$")
        if len(parts) == 3:
            _, salt, digest = parts
            iterations = _LEGACY_ITERATIONS
        elif len(parts) == 4:
            _, iterations_str, salt, digest = parts
            iterations = int(iterations_str)
        else:
            return False, False
    except ValueError:
        return False, False
    calc = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), iterations).hex()
    valid = secrets.compare_digest(calc, digest)
    return valid, valid and iterations < _ITERATIONS


def issue_token() -> str:
    """生成随机访问令牌（256bit 熵，会话表存其 SHA-256 哈希）。"""
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    """会话令牌的存储哈希（token 为高熵随机值，用普通 SHA-256 即可，无需慢哈希）。"""
    return hashlib.sha256(token.encode()).hexdigest()
