"""认证与安全基础设施（Python 标准库实现，无第三方依赖）。

- 密码散列格式：pbkdf2_sha256$<salt_hex>$<hash_hex>（hashlib.pbkdf2_hmac，26 万轮）
- 令牌签发：secrets.token_urlsafe（M4 接入 api_tokens 表完成校验闭环）

M0 单机免登录模式下本模块仅作为基础设施就位；FA_AUTH_ENABLED=true 后启用。
"""

from __future__ import annotations

import hashlib
import secrets

_ITERATIONS = 260_000


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), _ITERATIONS).hex()
    return f"pbkdf2_sha256${salt}${digest}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _algo, salt, digest = stored.split("$", 2)
    except ValueError:
        return False
    calc = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), _ITERATIONS).hex()
    return secrets.compare_digest(calc, digest)


def issue_token() -> str:
    """生成随机访问令牌（M4：入库并与用户绑定，请求时校验）。"""
    return secrets.token_urlsafe(32)
