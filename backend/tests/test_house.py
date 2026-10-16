"""选房模块测试（design：docs/house-module-design.md）。

覆盖：房源档案 CRUD 与校验 / 配套设施标签 / 价格推算与 M0 迁移换算 /
加权评分（权重归一化 + 用户自定义权重）/ 评分权重配置 /
照片上传下载删除与安全（含户型图 kind）/ 对比矩阵（标签并集 + 独有高亮）/ 删除级联。
"""

import sqlite3
import tempfile
from pathlib import Path

from fastapi.testclient import TestClient

from app.core.config import Settings
from main import create_app

PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16


def make_client(data_dir: Path | None = None) -> tuple[TestClient, Path]:
    tmp = data_dir or Path(tempfile.mkdtemp(prefix="fa-house-test-"))
    app = create_app(Settings(data_dir=tmp))
    return TestClient(app), tmp


def candidate_payload(**overrides) -> dict:
    payload = {
        "title": "测试小区 3室2厅", "community": "测试小区", "city": "西安",
        "district": "高新", "area": 120.0, "layout": "3室2厅2卫",
        "floor_info": "中层/18层", "orientation": "南北", "build_year": 2015,
        "total_price_cents": 2_000_000_00, "unit_price_cents": None,
        "status": "watching", "score": None, "pros": "", "cons": "", "notes": "",
        "features": [], "dim_scores": {},
    }
    payload.update(overrides)
    return payload


def create_candidate(client: TestClient, **overrides) -> dict:
    resp = client.post("/api/v1/house/candidates", json=candidate_payload(**overrides))
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]


def put_scoring_config(client: TestClient, weights: dict) -> dict:
    resp = client.put("/api/v1/house/scoring-config", json={"weights": weights})
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]


def test_candidate_crud_and_validation() -> None:
    """档案 CRUD：创建/查询/编辑/删除 + 字段级校验 + features 去重 + dim_scores 白名单。"""
    with make_client()[0] as client:
        c = create_candidate(
            client,
            features=[{"label": "学区", "value": "对口实验小学 一梯队"},
                      {"label": "南北通透", "value": ""}],
            dim_scores={"location": 4, "facilities": 5},
        )
        assert c["id"] > 0
        assert c["features"][1] == {"label": "南北通透", "value": ""}
        assert c["dim_scores"] == {"location": 4, "facilities": 5}

        # 列表
        items = client.get("/api/v1/house/candidates").json()["data"]
        assert len(items) == 1
        assert items[0]["computed"]["photo_count"] == 0

        # 编辑：改状态与标签（dim_scores 未随 payload 重置，部分维度未评 → 权重归一化）
        resp = client.put(f"/api/v1/house/candidates/{c['id']}",
                          json=candidate_payload(status="visiting",
                                                 features=[{"label": "地铁", "value": "步行 8 分钟"}],
                                                 dim_scores={"location": 4, "facilities": 5}))
        assert resp.status_code == 200
        assert resp.json()["data"]["status"] == "visiting"
        assert resp.json()["data"]["computed"]["weighted_score"] == 4.4
        # (4×25 + 5×20) ÷ 45 = 4.444 → 4.4（未评维度权重不计入分母）

        # 校验失败清单：title 空 + features 重复 + dim_scores 非法键/越界值
        resp = client.post("/api/v1/house/candidates", json=candidate_payload(
            title="", features=[{"label": "学区", "value": "A"}, {"label": "学区", "value": "B"}],
            dim_scores={"unknown": 3, "location": 9}))
        assert resp.status_code == 400
        errors = resp.json()["data"]["errors"]
        assert any("title" in e for e in errors)
        assert any("重复" in e for e in errors)
        assert any("未知维度" in e for e in errors)
        assert any("0~5" in e for e in errors)

        # 删除后 404
        resp = client.delete(f"/api/v1/house/candidates/{c['id']}")
        assert resp.status_code == 200
        assert client.get(f"/api/v1/house/candidates/{c['id']}").status_code == 404


def test_price_derivation_and_migration() -> None:
    """价格推算：缺总价时 单价×面积；缺单价时 总价÷面积；M0 REAL 列迁移换算（决策点 D2）。"""
    # 推算 1：只填单价（16666 元/㎡ × 120 ㎡ → 200 万 → 2,000,000 元 = 200,000,000 分）
    with make_client()[0] as client:
        c1 = create_candidate(client, total_price_cents=None, unit_price_cents=1_666_600,
                              area=120.0)
        assert c1["total_price_cents"] == 199_992_000  # round(1,666,600 × 120)
        assert c1["unit_price_cents"] == 1_666_600

        # 推算 2：只填总价（200 万元 = 200,000,000 分 × 100 ㎡ → 单价 20,000 元/㎡ = 2,000,000 分）
        c2 = create_candidate(client, total_price_cents=200_000_000, unit_price_cents=None,
                              area=100.0)
        assert c2["unit_price_cents"] == 2_000_000
        # 编辑改面积 → 单价按新面积重推
        resp = client.put(f"/api/v1/house/candidates/{c2['id']}",
                          json=candidate_payload(area=80.0))
        assert resp.json()["data"]["unit_price_cents"] == 2_500_000

    # 迁移：构造 001~003 已应用、含 M0 旧数据（REAL 万元 / 元㎡）的库，create_app 触发 004
    tmp = Path(tempfile.mkdtemp(prefix="fa-house-mig-"))
    migrations_dir = Path(__file__).resolve().parents[1] / "migrations"
    conn = sqlite3.connect(tmp / "family_assistant.db")
    for name in ("001_init.sql", "002_finance.sql", "003_car_module.sql"):
        conn.executescript((migrations_dir / name).read_text(encoding="utf-8"))
    conn.execute("PRAGMA user_version = 3")
    conn.execute(
        "INSERT INTO house_candidates (user_id, title, community, city, district, area, "
        "total_price, unit_price) VALUES (1, '旧房源', '旧小区', '西安', '高新', 89.5, 200.5, 22402.2)")
    conn.commit()
    conn.close()

    app = create_app(Settings(data_dir=tmp))  # 应用 004：含 UPDATE 换算
    with TestClient(app) as client:
        items = client.get("/api/v1/house/candidates").json()["data"]
        assert items[0]["total_price_cents"] == 200_500_000  # 200.5 万 → 2,005,000 元
        assert items[0]["unit_price_cents"] == 2_240_220    # 22402.2 元/㎡ → 分/㎡
        assert items[0]["title"] == "旧房源"


def test_scoring_config_and_weighted_score() -> None:
    """评分权重配置（决策点 D5）：默认值读取 / 自定义保存 / 合计校验 / 加权评分联动。"""
    with make_client()[0] as client:
        # 默认配置
        default_cfg = client.get("/api/v1/house/scoring-config").json()["data"]
        assert default_cfg["is_default"] is True
        assert default_cfg["weights"] == {
            "location": 25, "facilities": 20, "price": 20,
            "layout": 15, "quality": 10, "liquidity": 10,
        }

        # 全维度评分：加权 = (4×25 + 5×20 + 3×20 + 4×15 + 3×10 + 4×10) ÷ 100 = 3.9
        c = create_candidate(client, dim_scores={"location": 4, "facilities": 5, "price": 3,
                                                  "layout": 4, "quality": 3, "liquidity": 4})
        assert c["computed"]["weighted_score"] == 3.9

        # 自定义权重：location 100 → 加权 = 4×100 ÷ 100 = 4.0
        put_scoring_config(client, {"location": 100, "facilities": 0, "price": 0,
                                    "layout": 0, "quality": 0, "liquidity": 0})
        cfg = client.get("/api/v1/house/scoring-config").json()["data"]
        assert cfg["is_default"] is False and cfg["weights"]["location"] == 100
        detail = client.get(f"/api/v1/house/candidates/{c['id']}").json()["data"]
        assert detail["computed"]["weighted_score"] == 4.0

        # 合计≠100 / 越界 / 缺维度 → 400
        resp = client.put("/api/v1/house/scoring-config",
                          json={"weights": {"location": 50, "facilities": 20, "price": 20,
                                           "layout": 15, "quality": 10, "liquidity": 10}})
        assert resp.status_code == 400
        assert any("合计应为 100" in e for e in resp.json()["data"]["errors"])

        resp = client.put("/api/v1/house/scoring-config",
                          json={"weights": {"location": 101, "facilities": -1, "price": 20,
                                           "layout": 15, "quality": 10, "liquidity": 10}})
        assert resp.status_code == 400
        assert sum(1 for e in resp.json()["data"]["errors"] if "0~100" in e) == 2

        resp = client.put("/api/v1/house/scoring-config", json={"weights": {"location": 100}})
        assert resp.status_code == 400
        assert any("全部 6 个维度" in e for e in resp.json()["data"]["errors"])

        # 无维度评分 → weighted_score = None
        c2 = create_candidate(client, dim_scores={})
        assert c2["computed"]["weighted_score"] is None


def test_photo_upload_download_delete() -> None:
    """照片：四类 kind（含户型图）/ 下载回读 / 校验拒绝 / 删除 / 候选删除级联清理文件。"""
    client, tmp = make_client()
    with client:
        c = create_candidate(client)

        def upload(name: str = "a.png", kind: str = "exterior", data: bytes = PNG_BYTES):
            return client.post(f"/api/v1/house/candidates/{c['id']}/photos",
                               files={"upload": (name, data, "image/png")},
                               data={"kind": kind})

        p1 = upload(kind="layout")  # 户型图
        assert p1.status_code == 200, p1.text
        assert p1.json()["data"]["kind"] == "layout"
        upload(kind="interior")

        detail = client.get(f"/api/v1/house/candidates/{c['id']}").json()["data"]
        assert detail["computed"]["photo_count"] == 2
        assert {p["kind"] for p in detail["photos"]} == {"layout", "interior"}

        # 下载回读：内容一致 + 媒体类型正确
        photo_id = p1.json()["data"]["id"]
        dl = client.get(f"/api/v1/house/photos/{photo_id}/download")
        assert dl.status_code == 200 and dl.content == PNG_BYTES
        assert dl.headers["content-type"] == "image/png"

        # 校验拒绝：非法 kind / 伪造扩展名（内容特征不符）/ 不存在的房源
        assert upload(kind="bad").status_code == 400
        assert upload(name="fake.png", data=b"not-a-png").status_code == 400
        assert upload(name="evil.txt", data=b"x").status_code == 400
        assert client.post("/api/v1/house/candidates/999/photos",
                           files={"upload": ("a.png", PNG_BYTES, "image/png")},
                           data={"kind": "other"}).status_code == 404

        # 删除照片
        assert client.delete(f"/api/v1/house/photos/{photo_id}").status_code == 200
        assert client.get(f"/api/v1/house/photos/{photo_id}/download").status_code == 404

        # 删除房源：级联删行 + 物理文件清理
        other = upload()
        assert other.status_code == 200
        photo_dir = tmp / "uploads" / "house" / str(c["id"])
        assert photo_dir.exists()
        assert client.delete(f"/api/v1/house/candidates/{c['id']}").status_code == 200
        assert not photo_dir.exists() or not any(photo_dir.iterdir())  # 物理文件已清
        assert client.get(f"/api/v1/house/photos/{other.json()['data']['id']}/download").status_code == 404


def test_compare_matrix() -> None:
    """对比矩阵：2~6 个约束 / 标签并集 / 空值→「有」/ 独有高亮按标签存在性 / 附带当前权重。"""
    with make_client()[0] as client:
        c1 = create_candidate(client, title="房源A", total_price_cents=15_000_000_00,
                              features=[{"label": "学区", "value": "一梯队"},
                                        {"label": "南北通透", "value": ""}],
                              dim_scores={"location": 5})
        c2 = create_candidate(client, title="房源B", total_price_cents=18_000_000_00,
                              features=[{"label": "南北通透", "value": "有"},
                                        {"label": "地铁", "value": "步行 8 分钟"}])

        def compare(ids: str):
            return client.get(f"/api/v1/house/candidates/compare?ids={ids}")

        data = compare(f"{c1['id']},{c2['id']}").json()["data"]
        rows = {r["label"]: r for r in data["feature_rows"]}

        # 标签并集 + 空值规范化为「有」+ 独有判定按标签存在性（选车同口径）
        assert rows["南北通透"]["values"][str(c1["id"])] == "有"
        assert rows["南北通透"]["values"][str(c2["id"])] == "有"
        assert rows["南北通透"]["unique"] is False
        assert rows["学区"]["unique"] is True
        assert rows["学区"]["values"][str(c2["id"])] is None
        assert rows["地铁"]["unique"] is True

        # 响应附当前权重 + 加权评分（房源A 只评 location=5 → 5.0）
        assert data["weights"]["location"] == 25
        scored = {c["id"]: c["computed"]["weighted_score"] for c in data["candidates"]}
        assert scored[c1["id"]] == 5.0
        assert scored[c2["id"]] is None

        # 约束：少于 2 个 / 非法 id / 不存在
        assert compare(str(c1["id"])).status_code == 400
        assert compare("a,b").status_code == 400
        assert compare(f"{c1['id']},999").status_code == 404
