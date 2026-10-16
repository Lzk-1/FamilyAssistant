"""M4 多用户模块测试：登录/会话生命周期/哈希透明升级/强制改密/铁律/CSRF/共享审计。

auth_enabled=True 独立 app 实例；现有 47 个测试走 auth_enabled=false 旁路，零改动回归。
"""

import sqlite3
import tempfile
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.config import Settings
from main import create_app

CSRF = {"X-Requested-With": "XMLHttpRequest"}
LOGIN_ADMIN = {"username": "admin", "password": "admin123"}


def make_auth_app() -> tuple[FastAPI, Path]:
    tmp = Path(tempfile.mkdtemp(prefix="fa-auth-"))
    app = create_app(Settings(data_dir=tmp, auth_enabled=True))
    app.state.database.run_migrations()  # 显式跑迁移：client 无需 with 触发 lifespan
    return app, tmp


def client_for(app: FastAPI) -> TestClient:
    """同一 app 的独立 client：各自维护 cookie jar（模拟不同浏览器/用户）。"""
    return TestClient(app)


def login(client: TestClient, username: str, password: str):
    return client.post("/api/v1/auth/login", json={"username": username, "password": password})


def db_query(tmp: Path, sql: str, params=()) -> list[dict]:
    conn = sqlite3.connect(tmp / "family_assistant.db")
    conn.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in conn.execute(sql, params).fetchall()]
    finally:
        conn.close()


def create_member(app: FastAPI, username: str, password: str, role: str = "member") -> dict:
    """admin 登录并建 member；返回 {admin_client, user}。"""
    admin = client_for(app)
    login(admin, **LOGIN_ADMIN)
    resp = admin.post("/api/v1/auth/users", json={
        "username": username, "password": password, "display_name": username, "role": role,
    }, headers=CSRF)
    assert resp.status_code == 200, resp.text
    return {"admin_client": admin, "user": resp.json()["data"]}


# ============================================================
# 登录与会话
# ============================================================

def test_login_success_sets_session() -> None:
    app, _ = make_auth_app()
    c = client_for(app)
    # 未登录：401
    assert c.get("/api/v1/auth/me").status_code == 401
    resp = login(c, **LOGIN_ADMIN)
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["user"]["username"] == "admin"
    assert data["must_change_password"] is True  # 005 迁移标记内置弱口令
    # 会话生效
    me = c.get("/api/v1/auth/me").json()["data"]
    assert me["user"]["role"] == "admin"
    assert me["single_user_mode"] is False


def test_login_failure_prevents_user_enumeration() -> None:
    app, _ = make_auth_app()
    c = client_for(app)
    wrong = login(c, "admin", "wrong-password")
    missing = login(c, "nobody", "whatever-pass")
    assert wrong.status_code == 401 and missing.status_code == 401
    assert wrong.json()["message"] == missing.json()["message"]


def test_legacy_hash_transparent_upgrade() -> None:
    """内置 260k 三段式哈希登录成功后应升级为 600k 四段式。"""
    app, tmp = make_auth_app()
    before = db_query(tmp, "SELECT password_hash FROM users WHERE id = 1")[0]["password_hash"]
    assert before.count("$") == 2  # 三段式
    c = client_for(app)
    login(c, **LOGIN_ADMIN)
    after = db_query(tmp, "SELECT password_hash FROM users WHERE id = 1")[0]["password_hash"]
    parts = after.split("$")
    assert len(parts) == 4 and parts[1] == "600000"


def test_logout_revokes_session() -> None:
    app, _ = make_auth_app()
    c = client_for(app)
    login(c, **LOGIN_ADMIN)
    assert c.get("/api/v1/auth/me").status_code == 200
    assert c.post("/api/v1/auth/logout", headers=CSRF).status_code == 200
    assert c.get("/api/v1/auth/me").status_code == 401


def test_csrf_header_required_for_writes() -> None:
    app, _ = make_auth_app()
    c = client_for(app)
    login(c, **LOGIN_ADMIN)
    # 缺 X-Requested-With → 403
    resp = c.post("/api/v1/car/candidates", json={"brand": "比亚迪", "model": "汉"})
    assert resp.status_code == 403
    assert resp.json()["code"] == 4003
    # 带头 → 正常；GET 无需头
    resp = c.post("/api/v1/car/candidates", json={
        "brand": "比亚迪", "model": "汉", "guide_price_cents": 200000000,
    }, headers=CSRF)
    assert resp.status_code == 200, resp.text
    assert c.get("/api/v1/car/candidates").status_code == 200


# ============================================================
# 强制改密与改密
# ============================================================

def test_must_change_password_flow() -> None:
    app, _ = make_auth_app()
    c = client_for(app)
    login(c, **LOGIN_ADMIN)
    # 强制改密态：会话已由登录接口校验过凭据，豁免旧密码（即使传错/不传也放行）
    resp = c.put("/api/v1/auth/password", json={
        "old_password": "wrong-old-pass", "new_password": "new-strong-pass-1",
    }, headers=CSRF)
    assert resp.status_code == 200
    assert resp.json()["data"]["must_change_password"] is False
    # 弱口令已失效：旧密码无法再登录
    assert login(client_for(app), **LOGIN_ADMIN).status_code == 401
    # 标记清除后的自助改密：旧密码错误 → 401
    resp = c.put("/api/v1/auth/password", json={
        "old_password": "wrong-old-pass", "new_password": "another-pass-99",
    }, headers=CSRF)
    assert resp.status_code == 401
    # 旧密码正确 → 成功
    resp = c.put("/api/v1/auth/password", json={
        "old_password": "new-strong-pass-1", "new_password": "another-pass-99",
    }, headers=CSRF)
    assert resp.status_code == 200
    assert resp.json()["data"]["must_change_password"] is False


def test_change_password_revokes_other_sessions() -> None:
    app, _ = make_auth_app()
    c1 = client_for(app)
    c2 = client_for(app)
    login(c1, **LOGIN_ADMIN)
    login(c2, **LOGIN_ADMIN)
    c1.put("/api/v1/auth/password", json={
        "old_password": "admin123", "new_password": "another-pass-99",
    }, headers=CSRF)
    assert c2.get("/api/v1/auth/me").status_code == 401  # 其他会话被吊销
    assert c1.get("/api/v1/auth/me").status_code == 200  # 当前会话保留


# ============================================================
# 成员管理与铁律
# ============================================================

def test_member_cannot_manage_users() -> None:
    app, _ = make_auth_app()
    create_member(app, "alice", "alice-pass-123")
    c = client_for(app)
    login(c, "alice", "alice-pass-123")
    assert c.get("/api/v1/auth/users").status_code == 403
    resp = c.post("/api/v1/auth/users", json={
        "username": "eve", "password": "eve-pass-12345",
    }, headers=CSRF)
    assert resp.status_code == 403


def test_create_user_validation() -> None:
    app, _ = make_auth_app()
    admin = client_for(app)
    login(admin, **LOGIN_ADMIN)
    base = "/api/v1/auth/users"
    # 短密码 / 角色白名单 / 密码同用户名（≥8 位）/ 用户名重复
    assert admin.post(base, json={"username": "bob", "password": "short"},
                      headers=CSRF).status_code == 400
    assert admin.post(base, json={"username": "bob", "password": "bob-pass-12345",
                                  "role": "owner"}, headers=CSRF).status_code == 400
    assert admin.post(base, json={"username": "longusername", "password": "longusername"},
                      headers=CSRF).status_code == 400
    assert admin.post(base, json={"username": "bob", "password": "bob-pass-12345"},
                      headers=CSRF).status_code == 200
    assert admin.post(base, json={"username": "bob", "password": "bob-pass-6789"},
                      headers=CSRF).status_code == 400


def test_created_member_first_login_forces_password_change() -> None:
    app, _ = make_auth_app()
    create_member(app, "carol", "carol-pass-123")
    c = client_for(app)
    data = login(c, "carol", "carol-pass-123").json()["data"]
    # admin 建号设置的初始密码：首登必须强制改密（design §5.2/D7）
    assert data["user"]["must_change_password"] is True
    assert data["must_change_password"] is True


def test_guard_first_admin_irons() -> None:
    app, _ = make_auth_app()
    admin = client_for(app)
    login(admin, **LOGIN_ADMIN)
    # 铁律 1：id=1 不可禁用、不可降级
    assert admin.put("/api/v1/auth/users/1", json={"is_active": False},
                     headers=CSRF).status_code == 400
    assert admin.put("/api/v1/auth/users/1", json={"role": "member"},
                     headers=CSRF).status_code == 400
    # 显示名可改
    assert admin.put("/api/v1/auth/users/1", json={"display_name": "户主"},
                     headers=CSRF).status_code == 200


def test_guard_last_active_admin() -> None:
    """深度防御：手工禁用 id=1 后（直连库），最后一个活跃 admin 不可降级/禁用。"""
    app, tmp = make_auth_app()
    create_member(app, "admin2", "admin2-pass-12", role="admin")
    conn = sqlite3.connect(tmp / "family_assistant.db")
    conn.execute("UPDATE users SET is_active = 0 WHERE id = 1")
    conn.commit()
    conn.close()
    c = client_for(app)
    login(c, "admin2", "admin2-pass-12")
    assert c.put("/api/v1/auth/users/2", json={"role": "member"}, headers=CSRF).status_code == 400
    assert c.put("/api/v1/auth/users/2", json={"is_active": False}, headers=CSRF).status_code == 400


def test_disable_member_revokes_sessions_and_blocks_login() -> None:
    app, _ = make_auth_app()
    created = create_member(app, "bob", "bob-pass-12345")
    bob = client_for(app)
    login(bob, "bob", "bob-pass-12345")
    assert bob.get("/api/v1/auth/me").status_code == 200
    # admin 禁用 bob → bob 会话即时吊销
    admin = created["admin_client"]
    resp = admin.put(f"/api/v1/auth/users/{created['user']['id']}",
                     json={"is_active": False}, headers=CSRF)
    assert resp.status_code == 200
    assert bob.get("/api/v1/auth/me").status_code == 401
    # 被禁用户无法再登录
    assert login(client_for(app), "bob", "bob-pass-12345").status_code == 403


def test_reset_member_password() -> None:
    app, _ = make_auth_app()
    created = create_member(app, "carol", "carol-pass-123")
    carol = client_for(app)
    login(carol, "carol", "carol-pass-123")
    # admin 重置 carol 密码
    admin = created["admin_client"]
    resp = admin.put(f"/api/v1/auth/users/{created['user']['id']}/password",
                     json={"password": "carol-new-45678"}, headers=CSRF)
    assert resp.status_code == 200
    assert carol.get("/api/v1/auth/me").status_code == 401  # 旧会话全部吊销
    resp = login(client_for(app), "carol", "carol-new-45678")
    assert resp.json()["data"]["must_change_password"] is True  # 强制下次改密


# ============================================================
# 全家庭共享 + 审计 + 权重隔离（design §4.3）
# ============================================================

def test_shared_data_with_creator_audit() -> None:
    app, _ = make_auth_app()
    created = create_member(app, "alice", "alice-pass-123")
    alice_id = created["user"]["id"]
    alice = client_for(app)
    login(alice, "alice", "alice-pass-123")
    # alice 创建车型：user_id 落 alice 的 id（创建者审计）
    resp = alice.post("/api/v1/car/candidates", json={
        "brand": "长安", "model": "阿维塔07", "guide_price_cents": 220000000,
    }, headers=CSRF)
    assert resp.status_code == 200
    candidate = resp.json()["data"]
    assert candidate["user_id"] == alice_id
    # admin（未参与创建）同样可见可读（全家庭共享）
    admin = created["admin_client"]
    listing = admin.get("/api/v1/car/candidates").json()["data"]
    assert [c["id"] for c in listing] == [candidate["id"]]
    assert admin.get(f"/api/v1/car/candidates/{candidate['id']}").status_code == 200


def test_scoring_config_isolated_per_user() -> None:
    app, _ = make_auth_app()
    created = create_member(app, "alice", "alice-pass-123")
    alice = client_for(app)
    login(alice, "alice", "alice-pass-123")
    weights = {"location": 40, "facilities": 20, "price": 20,
               "layout": 10, "quality": 5, "liquidity": 5}
    resp = alice.put("/api/v1/house/scoring-config", json={"weights": weights}, headers=CSRF)
    assert resp.status_code == 200
    assert resp.json()["data"]["is_default"] is False
    # admin 视角：默认权重不受 alice 配置影响（个人偏好隔离）
    admin = created["admin_client"]
    admin_cfg = admin.get("/api/v1/house/scoring-config").json()["data"]
    assert admin_cfg["is_default"] is True
    assert admin_cfg["weights"]["location"] == 25


# ============================================================
# 理财模块权限（M4.1）：读全员可用，写仅 admin
# ============================================================

def _finance_asset_payload() -> dict:
    return {
        "name": "测试资产", "direction": "asset", "category": "demand",
        "holder_member_id": 1, "institution": "工商银行", "amount_cents": 1_000_000,
        "start_date": None, "end_date": None, "annual_rate": None, "extra": {},
    }


def test_finance_read_open_write_admin_only() -> None:
    app, _ = make_auth_app()
    created = create_member(app, "alice", "alice-pass-123")
    admin = created["admin_client"]
    alice = client_for(app)
    login(alice, "alice", "alice-pass-123")

    # 读接口：成员可用（台账 / 详情字段 / 总览 / 导出）
    assert alice.get("/api/v1/finance/assets").status_code == 200
    assert alice.get("/api/v1/finance/overview").status_code == 200
    assert alice.get("/api/v1/finance/members").status_code == 200
    assert alice.get("/api/v1/finance/export").status_code == 200

    # admin 建一笔资产供 alice 操作
    asset = admin.post("/api/v1/finance/assets", json=_finance_asset_payload(),
                       headers=CSRF).json()["data"]
    aid = asset["id"]

    # 写接口：member 全部 403（资产 CRUD / 批量删 / 流转 / 市值 / 收益 / 字典维护）
    assert alice.post("/api/v1/finance/assets", json=_finance_asset_payload(),
                      headers=CSRF).status_code == 403
    assert alice.put(f"/api/v1/finance/assets/{aid}", json={"note": "x"},
                     headers=CSRF).status_code == 403
    assert alice.delete(f"/api/v1/finance/assets/{aid}", headers=CSRF).status_code == 403
    assert alice.post("/api/v1/finance/assets/batch-delete", json={"ids": [aid]},
                      headers=CSRF).status_code == 403
    assert alice.post(f"/api/v1/finance/assets/{aid}/settle", json={"action": "clear"},
                      headers=CSRF).status_code == 403
    assert alice.post(f"/api/v1/finance/assets/{aid}/values",
                      json={"value_cents": 100, "value_date": "2026-01-01"},
                      headers=CSRF).status_code == 403
    assert alice.delete(f"/api/v1/finance/assets/{aid}/values/1", headers=CSRF).status_code == 403
    assert alice.post(f"/api/v1/finance/assets/{aid}/interest",
                      json={"interest_cents": 100, "value_date": "2026-01-01"},
                      headers=CSRF).status_code == 403
    assert alice.post(f"/api/v1/finance/assets/{aid}/attachments",
                      files={"upload": ("a.png", PNG_1X1, "image/png")},
                      headers=CSRF).status_code == 403
    assert alice.post("/api/v1/finance/members", json={"name": "李四"},
                      headers=CSRF).status_code == 403
    assert alice.put("/api/v1/finance/members/1", json={"is_active": True},
                     headers=CSRF).status_code == 403

    # admin 写操作不受影响：批量删除 + 市值删除链路在认证模式下可用
    assert admin.post("/api/v1/finance/assets/batch-delete", json={"ids": [aid]},
                      headers=CSRF).json()["data"]["deleted"] == 1


def test_finance_import_requires_admin() -> None:
    app, _ = make_auth_app()
    create_member(app, "alice", "alice-pass-123")
    alice = client_for(app)
    login(alice, "alice", "alice-pass-123")
    backup = (b'{"version": 1, "exported_at": "2026-01-01T00:00:00", "categories": [], '
              b'"members": [], "assets": [], "values": [], "events": [], "attachments": []}')
    resp = alice.post("/api/v1/finance/import",
                      files={"upload": ("backup.json", backup, "application/json")},
                      data={"mode": "merge"}, headers=CSRF)
    assert resp.status_code == 403


# ============================================================
# 单机免登录旁路回归
# ============================================================

def test_single_user_mode_bypass_unchanged() -> None:
    tmp = Path(tempfile.mkdtemp(prefix="fa-bypass-"))
    app = create_app(Settings(data_dir=tmp))  # auth_enabled 默认 False
    app.state.database.run_migrations()
    with TestClient(app) as c:
        me = c.get("/api/v1/auth/me").json()["data"]
        assert me["single_user_mode"] is True
        assert me["user"]["username"] == "admin"
        assert me["user"]["avatar_path"] == ""  # 006 迁移默认空串
        # 业务接口无需登录、无需 CSRF 头（与 M0 行为完全一致）
        assert c.get("/api/v1/car/candidates").status_code == 200
        resp = c.post("/api/v1/car/candidates", json={
            "brand": "比亚迪", "model": "海豹", "guide_price_cents": 180000000,
        })
        assert resp.status_code == 200
        assert resp.json()["data"]["user_id"] == 1  # 内置 admin 审计


# ============================================================
# 本人资料 + 头像（M4.1）
# ============================================================

# 1x1 最小合法 PNG（含完整签名/IHDR/IDAT/IEND）
PNG_1X1 = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082"
)


def _login_admin(app: FastAPI) -> TestClient:
    c = client_for(app)
    login(c, **LOGIN_ADMIN)
    return c


def test_avatar_upload_read_replace_delete() -> None:
    app, tmp = make_auth_app()
    admin = _login_admin(app)

    # 初始无头像
    assert admin.get("/api/v1/auth/users/1/avatar").status_code == 404

    # 上传
    resp = admin.post(
        "/api/v1/auth/avatar",
        files={"upload": ("a.png", PNG_1X1, "image/png")},
        headers=CSRF,
    )
    assert resp.status_code == 200, resp.text
    rel = resp.json()["data"]["avatar_path"]
    assert rel.startswith("1/") and rel.endswith(".png")
    # 落盘到 data/uploads/avatars/
    assert (tmp / "uploads" / "avatars" / rel).is_file()
    # /me 与文件读取
    me = admin.get("/api/v1/auth/me").json()["data"]["user"]
    assert me["avatar_path"] == rel
    raw = admin.get("/api/v1/auth/users/1/avatar")
    assert raw.status_code == 200
    assert raw.headers["content-type"] == "image/png"
    assert raw.content[:8] == b"\x89PNG\r\n\x1a\n"

    # 替换上传：新路径生效，旧文件删除
    resp2 = admin.post(
        "/api/v1/auth/avatar",
        files={"upload": ("b.png", PNG_1X1, "image/png")},
        headers=CSRF,
    )
    rel2 = resp2.json()["data"]["avatar_path"]
    assert rel2 != rel
    assert not (tmp / "uploads" / "avatars" / rel).exists()

    # 删除：恢复默认
    deleted = admin.delete("/api/v1/auth/avatar", headers=CSRF)
    assert deleted.status_code == 200
    assert admin.get("/api/v1/auth/users/1/avatar").status_code == 404
    assert not (tmp / "uploads" / "avatars" / rel2).exists()


def test_avatar_rejects_non_image_and_oversize() -> None:
    app, _ = make_auth_app()
    admin = _login_admin(app)
    # 扩展名白名单
    resp = admin.post(
        "/api/v1/auth/avatar",
        files={"upload": ("evil.txt", b"hello", "text/plain")},
        headers=CSRF,
    )
    assert resp.status_code == 400
    assert any("jpg" in e for e in resp.json()["data"]["errors"])
    # 扩展名伪装但魔数不符
    resp2 = admin.post(
        "/api/v1/auth/avatar",
        files={"upload": ("fake.png", b"not-a-png", "image/png")},
        headers=CSRF,
    )
    assert resp2.status_code == 400


def test_avatar_requires_auth_and_member_can_read_others() -> None:
    app, _ = make_auth_app()
    anon = client_for(app)
    assert anon.get("/api/v1/auth/users/1/avatar").status_code == 401
    # 未登录写操作：会话校验先于 CSRF 校验，返回 401
    assert anon.post("/api/v1/auth/avatar",
                     files={"upload": ("a.png", PNG_1X1, "image/png")}).status_code == 401
    # 成员可读 admin 头像（成员表格展示），但不能替 admin 操作（无该路由）
    created = create_member(app, "bob", "bob-pass-123")
    admin = created["admin_client"]
    admin.post("/api/v1/auth/avatar",
               files={"upload": ("a.png", PNG_1X1, "image/png")}, headers=CSRF)
    bob = client_for(app)
    login(bob, "bob", "bob-pass-123")
    assert bob.get("/api/v1/auth/users/1/avatar").status_code == 200


def test_profile_update_display_name() -> None:
    app, _ = make_auth_app()
    admin = _login_admin(app)
    resp = admin.put("/api/v1/auth/profile",
                     json={"display_name": " 户主大人 "}, headers=CSRF)
    assert resp.status_code == 200
    assert resp.json()["data"]["display_name"] == "户主大人"
    # 敏感字段不被本接口接受（role 出现在 payload 也无效）
    admin.put("/api/v1/auth/profile", json={"display_name": "x", "role": "member"}, headers=CSRF)
    me = admin.get("/api/v1/auth/me").json()["data"]["user"]
    assert me["role"] == "admin"  # profile 接口只接受 display_name，role 被忽略
    # 空显示名拒绝
    bad = admin.put("/api/v1/auth/profile", json={"display_name": "  "}, headers=CSRF)
    assert bad.status_code == 400
