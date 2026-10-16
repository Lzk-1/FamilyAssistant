"""选车模块测试（design：docs/car-module-design.md）。

覆盖：车型档案 CRUD 与校验 / 配置特点标签 / 4S 报价落地价计算 /
购置税推算（2026 新能源减半口径）/ 多店对比 / 照片上传下载删除与安全 /
对比矩阵（标签并集 + 独有高亮）/ 删除级联。
"""

import sqlite3
import tempfile
from datetime import date
from pathlib import Path

from fastapi.testclient import TestClient

from app.core.config import Settings
from main import create_app

PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16


def make_client(data_dir: Path | None = None) -> tuple[TestClient, Path]:
    tmp = data_dir or Path(tempfile.mkdtemp(prefix="fa-car-test-"))
    app = create_app(Settings(data_dir=tmp))
    return TestClient(app), tmp


def candidate_payload(**overrides) -> dict:
    payload = {
        "brand": "测试品牌", "model": "测试车型", "version": "Pro", "year": 2026,
        "energy": "ev", "mileage": None, "guide_price_cents": 20_680_000,
        "status": "watching", "score": None, "pros": "", "cons": "", "notes": "",
        "features": [],
    }
    payload.update(overrides)
    return payload


def create_candidate(client: TestClient, **overrides) -> dict:
    resp = client.post("/api/v1/car/candidates", json=candidate_payload(**overrides))
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]


def create_offer(client: TestClient, candidate_id: int, **overrides) -> dict:
    payload = {
        "candidate_id": candidate_id,
        "dealer_name": "测试 4S 店",
        "city": "", "contact": "",
        "offer_date": date.today().isoformat(),
        "discount_items": [{"label": "现金优惠", "amount_cents": 2_000_000}],
        "fee_items": [
            {"label": "购置税", "amount_cents": 830_000},
            {"label": "保险", "amount_cents": 600_000},
        ],
        "gift_items": [{"label": "贴膜", "note": ""}],
        "notes": "",
    }
    payload.update(overrides)
    resp = client.post("/api/v1/car/offers", json=payload)
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]


def test_candidate_crud_and_validation() -> None:
    """档案 CRUD：创建/查询/编辑/删除 + 字段级校验 + features 标签去重。"""
    with make_client()[0] as client:
        # 创建：含配置特点标签
        c = create_candidate(
            client, features=[
                {"label": "座位数", "value": "5座"},
                {"label": "零重力按摩座椅", "value": "有"},
            ])
        assert c["id"] > 0
        assert c["features"] == [
            {"label": "座位数", "value": "5座"},
            {"label": "零重力按摩座椅", "value": "有"},
        ]

        # 列表
        items = client.get("/api/v1/car/candidates").json()["data"]
        assert len(items) == 1
        assert items[0]["computed"]["offer_count"] == 0

        # 编辑：改评分与状态
        resp = client.put(f"/api/v1/car/candidates/{c['id']}",
                           json=candidate_payload(score=4.5, status="test_driving"))
        assert resp.status_code == 200
        assert resp.json()["data"]["score"] == 4.5
        assert resp.json()["data"]["status"] == "test_driving"

        # 校验失败：字段级错误清单（brand 空 + features 重复标签）
        resp = client.post("/api/v1/car/candidates",
                           json=candidate_payload(brand="", features=[
                               {"label": "HUD", "value": "有"}, {"label": "HUD", "value": "无"}]))
        assert resp.status_code == 400
        errors = resp.json()["data"]["errors"]
        assert any("brand" in e for e in errors)
        assert any("重复" in e for e in errors)

        # 删除后 404
        resp = client.delete(f"/api/v1/car/candidates/{c['id']}")
        assert resp.status_code == 200
        assert client.get(f"/api/v1/car/candidates/{c['id']}").status_code == 404


def test_offer_price_compute_and_tax_hint() -> None:
    """报价落地价：裸车=指导价−Σ优惠；落地=裸车+Σ费用；购置税推算按能源类型差异化。"""
    with make_client()[0] as client:
        c = create_candidate(client)  # ev，指导价 20.68 万
        offer = create_offer(client, c["id"])  # 优惠 2 万；购置税 8300 + 保险 6000
        comp = offer["computed"]
        assert comp["discount_total_cents"] == 2_000_000
        assert comp["bare_price_cents"] == 20_680_000 - 2_000_000  # 18.68 万
        assert comp["fee_total_cents"] == 1_430_000
        assert comp["total_cents"] == 18_680_000 + 1_430_000
        assert offer["gift_items"][0]["label"] == "贴膜"  # 赠品不折价

        # 购置税推算（ev，裸车 18.68 万）：
        # 计税 = 1,868,000,000//113 = 16,530,973 分；全额 10% = 1,653,097；
        # 减半 826,548 < 上限 1,500,000 → 实缴 826,549 分 = 8265.49 元（真实口径 8265.487）
        assert offer["computed"]["bare_price_cents"] == 18_680_000
        assert offer["tax_hint_cents"] == 826_549

        # 燃油口径（裸车 9.3 万）：计税 = 930,000,000//113 = 8,230,088 分 → 10% = 823,008 分
        c2 = create_candidate(client, energy="fuel", guide_price_cents=11_300_000)
        o2 = create_offer(client, c2["id"])
        assert o2["computed"]["bare_price_cents"] == 9_300_000
        assert o2["tax_hint_cents"] == 823_008

        # 无优惠无费用：total = 指导价
        c3 = create_candidate(client, guide_price_cents=10_000_000)
        resp = client.post("/api/v1/car/offers", json={
            "candidate_id": c3["id"], "dealer_name": "店", "offer_date": date.today().isoformat(),
            "discount_items": [], "fee_items": [], "gift_items": [], "notes": "",
        })
        assert resp.json()["data"]["computed"]["total_cents"] == 10_000_000


def test_multi_offers_best_and_update() -> None:
    """多店报价：best/avg 聚合、报价编辑与删除、车型 computed 联动。"""
    with make_client()[0] as client:
        c = create_candidate(client, guide_price_cents=10_000_000)
        o1 = create_offer(client, c["id"], dealer_name="A 店",
                          discount_items=[],
                          fee_items=[{"label": "保险", "amount_cents": 500_000}])
        o2 = create_offer(client, c["id"], dealer_name="B 店",
                          discount_items=[{"label": "现金优惠", "amount_cents": 1_000_000}],
                          fee_items=[{"label": "保险", "amount_cents": 400_000}])
        assert o1["computed"]["total_cents"] == 10_500_000
        assert o2["computed"]["total_cents"] == 9_400_000

        detail = client.get(f"/api/v1/car/candidates/{c['id']}").json()["data"]
        comp = detail["computed"]
        assert comp["offer_count"] == 2
        assert comp["best_total_cents"] == 9_400_000
        assert comp["avg_total_cents"] == (10_500_000 + 9_400_000) // 2

        # 编辑报价：优惠清零后落地价回升
        resp = client.put(f"/api/v1/car/offers/{o2['id']}", json={
            "discount_items": [], "fee_items": [{"label": "保险", "amount_cents": 400_000}],
        })
        assert resp.status_code == 200
        assert resp.json()["data"]["computed"]["total_cents"] == 10_400_000

        # 部分更新：未提供的条目沿用原值
        resp = client.put(f"/api/v1/car/offers/{o2['id']}", json={"dealer_name": "B 店旗舰店"})
        assert resp.json()["data"]["computed"]["fee_total_cents"] == 400_000

        # 删除报价
        assert client.delete(f"/api/v1/car/offers/{o1['id']}").status_code == 200
        detail = client.get(f"/api/v1/car/candidates/{c['id']}").json()["data"]
        assert detail["computed"]["offer_count"] == 1


def test_photo_upload_download_delete_and_safety() -> None:
    """照片：上传/下载/删除 + 类型白名单 + magic bytes 校验 + 上限 + 级联清理。"""
    client, tmp = make_client()
    with client:
        c = create_candidate(client)

        # 上传两张（外观/内饰）
        r1 = client.post(f"/api/v1/car/candidates/{c['id']}/photos",
                         files={"upload": ("front.png", PNG_BYTES, "image/png")},
                         data={"kind": "exterior"})
        r2 = client.post(f"/api/v1/car/candidates/{c['id']}/photos",
                         files={"upload": ("seat.png", PNG_BYTES, "image/png")},
                         data={"kind": "interior"})
        assert r1.status_code == 200 and r2.status_code == 200
        p1 = r1.json()["data"]
        assert p1["kind"] == "exterior"

        # 详情分组返回
        photos = client.get(f"/api/v1/car/candidates/{c['id']}").json()["data"]["photos"]
        assert {p["kind"] for p in photos} == {"exterior", "interior"}

        # 下载内容一致
        dl = client.get(f"/api/v1/car/photos/{p1['id']}/download")
        assert dl.status_code == 200
        assert dl.content == PNG_BYTES
        physical = tmp / "uploads" / "car" / str(c["id"])
        assert len(list(physical.glob("*.png"))) == 2

        # 非图片后缀拒绝 + magic bytes 不符拒绝
        r3 = client.post(f"/api/v1/car/candidates/{c['id']}/photos",
                         files={"upload": ("a.txt", b"hello", "text/plain")})
        assert r3.status_code == 400
        r4 = client.post(f"/api/v1/car/candidates/{c['id']}/photos",
                         files={"upload": ("fake.png", b"NOT_PNG_BYTES", "image/png")})
        assert r4.status_code == 400
        assert any("格式不符" in e for e in r4.json()["data"]["errors"])

        # kind 白名单
        r5 = client.post(f"/api/v1/car/candidates/{c['id']}/photos",
                         files={"upload": ("x.png", PNG_BYTES, "image/png")},
                         data={"kind": "bad"})
        assert r5.status_code == 400

        # 删除照片：物理文件同步清理
        assert client.delete(f"/api/v1/car/photos/{p1['id']}").status_code == 200
        assert len(list(physical.glob("*.png"))) == 1

        # 删除车型：剩余照片文件级联清理 + 报价级联删除
        create_offer(client, c["id"])
        assert client.delete(f"/api/v1/car/candidates/{c['id']}").status_code == 200
        assert len(list(physical.glob("*.png"))) == 0
        items = client.get("/api/v1/car/candidates").json()["data"]
        assert items == []


def test_compare_matrix_features_union_and_highlight() -> None:
    """对比矩阵：全标签并集为行、独有标签 unique 标记、2~6 个车型约束。"""
    with make_client()[0] as client:
        c1 = create_candidate(client, brand="品牌A", model="车型A",
                              features=[{"label": "座位数", "value": "5座"},
                                        {"label": "抬头显示", "value": "有"}])
        c2 = create_candidate(client, brand="品牌B", model="车型B",
                              features=[{"label": "座位数", "value": "7座"},
                                        {"label": "零重力按摩座椅", "value": "有"}])
        create_offer(client, c1["id"], fee_items=[{"label": "保险", "amount_cents": 500_000}])
        create_offer(client, c2["id"], fee_items=[{"label": "保险", "amount_cents": 400_000}])

        resp = client.get(f"/api/v1/car/candidates/compare?ids={c1['id']},{c2['id']}")
        assert resp.status_code == 200
        data = resp.json()["data"]
        assert len(data["candidates"]) == 2

        rows = {r["label"]: r for r in data["feature_rows"]}
        assert set(rows) == {"座位数", "抬头显示", "零重力按摩座椅"}  # 并集
        assert rows["座位数"]["values"] == {str(c1["id"]): "5座", str(c2["id"]): "7座"}
        assert rows["座位数"]["unique"] is False        # 两车都有 → 不高亮
        assert rows["抬头显示"]["unique"] is True        # 仅 A 有 → 独有高亮
        assert rows["抬头显示"]["values"][str(c2["id"])] is None

        # 费用对比数据就绪
        by_id = {c["id"]: c for c in data["candidates"]}
        assert by_id[c1["id"]]["computed"]["best_total_cents"] is not None

        # 少于 2 个 / 多于 6 个 / 非法 id
        assert client.get(f"/api/v1/car/candidates/compare?ids={c1['id']}").status_code == 400
        assert client.get(f"/api/v1/car/candidates/compare?ids=1,2,3,4,5,6,7").status_code == 400
        assert client.get(f"/api/v1/car/candidates/compare?ids=a,b").status_code == 400


def test_compare_blank_feature_value_treated_as_present() -> None:
    """对比矩阵：仅有标签名、value 留空 = 具备但未注明参数，应显示「有」而非 —，
    且独有判定按标签存在性而非值真假（阿维塔07L 场景回归）。"""
    with make_client()[0] as client:
        c1 = create_candidate(client, brand="品牌A", model="车型A",
                              features=[{"label": "激光雷达", "value": ""}])
        c2 = create_candidate(client, brand="品牌B", model="车型B",
                              features=[{"label": "激光雷达", "value": "有"},
                                        {"label": "抬头显示", "value": ""}])

        data = client.get(
            f"/api/v1/car/candidates/compare?ids={c1['id']},{c2['id']}"
        ).json()["data"]
        rows = {r["label"]: r for r in data["feature_rows"]}

        # 空值规范化为「有」；双方都有激光雷达 → 非独有
        assert rows["激光雷达"]["values"][str(c1["id"])] == "有"
        assert rows["激光雷达"]["values"][str(c2["id"])] == "有"
        assert rows["激光雷达"]["unique"] is False

        # 仅 B 有抬头显示（且 B 该值留空）→ 仍应判定为独有，A 列为 None（—）
        assert rows["抬头显示"]["unique"] is True
        assert rows["抬头显示"]["values"][str(c1["id"])] is None
        assert rows["抬头显示"]["values"][str(c2["id"])] == "有"


def test_migration_from_m0_price_column() -> None:
    """迁移：M0 遗留 price（万元 REAL）换算到 guide_price_cents 后弃用（决策点 D2）。

    构造 001/002 已应用、含旧数据、尚未应用 003 的库，create_app 触发 003 后验证换算。
    """
    tmp = Path(tempfile.mkdtemp(prefix="fa-car-mig-"))
    migrations_dir = Path(__file__).resolve().parents[1] / "migrations"
    conn = sqlite3.connect(tmp / "family_assistant.db")
    for name in ("001_init.sql", "002_finance.sql"):
        conn.executescript((migrations_dir / name).read_text(encoding="utf-8"))
    conn.execute("PRAGMA user_version = 2")
    conn.execute(
        "INSERT INTO car_candidates (user_id, brand, model, price) VALUES (1, '旧品牌', '旧车型', 15.5)")
    conn.commit()
    conn.close()

    app = create_app(Settings(data_dir=tmp))  # 应用 003：含 UPDATE 换算
    with TestClient(app) as client:
        items = client.get("/api/v1/car/candidates").json()["data"]
        assert items[0]["guide_price_cents"] == 15_500_000  # 15.5 万 → 1,550,000 元
        assert items[0]["brand"] == "旧品牌"
