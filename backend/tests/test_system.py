"""系统接口冒烟测试：健康检查 / 模块注册表 / 业务模块列表占位 / 统一错误包。"""

import tempfile
from pathlib import Path

from fastapi.testclient import TestClient

from app.core.config import Settings
from main import create_app


def make_client() -> TestClient:
    """使用临时数据目录构建应用，避免污染仓库 data/。"""
    tmp = tempfile.mkdtemp(prefix="fa-test-")
    app = create_app(Settings(data_dir=Path(tmp)))
    return TestClient(app)


def test_health() -> None:
    with make_client() as client:
        resp = client.get("/api/v1/system/health")
        assert resp.status_code == 200
        body = resp.json()
        assert body["code"] == 0
        assert body["data"]["status"] == "ok"
        assert body["data"]["modules"] == 5


def test_module_registry_order() -> None:
    with make_client() as client:
        resp = client.get("/api/v1/system/modules")
        assert resp.status_code == 200
        keys = [m["key"] for m in resp.json()["data"]]
        assert keys == ["finance", "house", "car", "memo", "files"]


def test_module_list_endpoints_return_empty() -> None:
    with make_client() as client:
        for path in ("/house/candidates", "/car/candidates", "/memo/memos", "/files/records"):
            resp = client.get(f"/api/v1{path}")
            assert resp.status_code == 200, path
            assert resp.json() == {"code": 0, "message": "ok", "data": []}


def test_write_stub_returns_501_envelope() -> None:
    with make_client() as client:
        resp = client.post("/api/v1/memo/memos")
        assert resp.status_code == 501
        body = resp.json()
        assert body["code"] == 5011
        assert body["data"] is None
