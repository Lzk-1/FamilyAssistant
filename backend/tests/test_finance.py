"""理财模块测试（dev-plan §7.1）。

覆盖：分类预置 / 成员规则 / 状态推导矩阵 / 公式精度 / 12 类模板 /
字段级校验 / 筛选 / 编辑与软删除 / 状态流转 / 市值历史 / 聚合 / 附件安全。
"""

import sqlite3
import tempfile
from datetime import date, timedelta
from pathlib import Path

from fastapi.testclient import TestClient

from app.core.config import Settings
from main import create_app

PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16


def make_client() -> tuple[TestClient, Path]:
    tmp = tempfile.mkdtemp(prefix="fa-finance-test-")
    app = create_app(Settings(data_dir=Path(tmp)))
    return TestClient(app), Path(tmp)


def day(offset: int) -> str:
    return (date.today() + timedelta(days=offset)).isoformat()


def asset_payload(**overrides) -> dict:
    payload = {
        "name": "测试资产", "direction": "asset", "category": "demand",
        "holder_member_id": 1, "institution": "工商银行", "amount_cents": 1_000_000,
        "start_date": None, "end_date": None, "annual_rate": None, "extra": {},
    }
    payload.update(overrides)
    return payload


def create_asset(client: TestClient, **overrides) -> dict:
    resp = client.post("/api/v1/finance/assets", json=asset_payload(**overrides))
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]


def upload(client: TestClient, asset_id: int, name: str, content: bytes):
    return client.post(
        f"/api/v1/finance/assets/{asset_id}/attachments",
        files={"upload": (name, content, "application/octet-stream")},
    )


# ============ 字典：分类 / 成员 ============

def test_categories_preset() -> None:
    with make_client()[0] as client:
        data = client.get("/api/v1/finance/categories").json()["data"]
        assert len(data) == 12
        assert data[0]["code"] == "fixed_deposit"
        assert {c["code"] for c in data} == {
            "fixed_deposit", "demand", "wealth", "metal", "stock", "loan_out",
            "bond_insurance", "asset_other", "mortgage", "loan_in",
            "credit_card", "liability_other",
        }


def test_members_crud_rules() -> None:
    with make_client()[0] as client:
        data = client.get("/api/v1/finance/members").json()["data"]
        assert data[0]["name"] == "本人"
        # 新建
        data = client.post("/api/v1/finance/members", json={"name": "配偶", "note": "另一半"}).json()["data"]
        assert data["name"] == "配偶" and data["id"] == 2
        # 空名 / 重名拒绝
        assert client.post("/api/v1/finance/members", json={"name": ""}).status_code == 400
        resp = client.post("/api/v1/finance/members", json={"name": "配偶"})
        assert resp.status_code == 400
        assert any("已存在" in e for e in resp.json()["data"]["errors"])
        # 改名
        assert client.put("/api/v1/finance/members/2", json={"name": "爱人"}).json()["data"]["name"] == "爱人"
        # 默认成员不可改名 / 停用
        assert client.put("/api/v1/finance/members/1", json={"name": "我"}).status_code == 400
        assert client.put("/api/v1/finance/members/1", json={"is_active": False}).status_code == 400
        # 停用后不可作为归属人
        client.put("/api/v1/finance/members/2", json={"is_active": False})
        resp = client.post("/api/v1/finance/assets", json=asset_payload(holder_member_id=2))
        assert resp.status_code == 400
        assert any("holder_member_id" in e for e in resp.json()["data"]["errors"])
        # 恢复后可用
        client.put("/api/v1/finance/members/2", json={"is_active": True})
        assert create_asset(client, holder_member_id=2)["holder_name"] == "爱人"


# ============ 状态推导矩阵与公式精度（§3） ============

def test_status_matrix() -> None:
    with make_client()[0] as client:
        cases = [
            (0, "urgent", "fixed_deposit"),
            (7, "urgent", "fixed_deposit"),
            (8, "soon", "fixed_deposit"),
            (30, "soon", "fixed_deposit"),
            (31, "holding", "fixed_deposit"),
            (-1, "matured", "fixed_deposit"),
            (-1, "overdue", "loan_out"),
        ]
        for i, (offset, expected, category) in enumerate(cases):
            asset = create_asset(
                client, name=f"状态{i}", category=category,
                start_date="2025-01-01" if category == "fixed_deposit" else None,
                end_date=day(offset),
                annual_rate=2.0 if category == "fixed_deposit" else None,
                institution="张三" if category == "loan_out" else "工商银行",
            )
            assert asset["effective_status"] == expected, (offset, category, asset["effective_status"])
        # 无到期日 → 持有中
        assert create_asset(client)["effective_status"] == "holding"


def test_calc_formulas() -> None:
    with make_client()[0] as client:
        # 定期：12 个月年利率 1.5% → 利息 = 本金 × 1.5%
        fd = create_asset(client, category="fixed_deposit", amount_cents=12_000_000,
                          start_date="2026-01-01", end_date="2027-01-01", annual_rate=1.5)
        c = fd["computed"]
        assert c["months"] == 12
        assert c["interest_cents"] == 180_000
        assert c["maturity_cents"] == 12_180_000
        # 理财：365 天业绩基准 2% → 预计收益 = 本金 × 2%（基准存 extra.base_rate，非年利率）
        w = create_asset(client, category="wealth", amount_cents=36_500_000,
                         start_date="2025-01-01", end_date="2026-01-01",
                         extra={"base_rate": 2.0})
        c = w["computed"]
        assert c["days"] == 365
        assert c["est_interest_cents"] == 730_000
        assert c["maturity_cents"] == 37_230_000
        # 贵金属：市值 = 数量 × 现价；盈亏 = 市值 − 成本
        m = create_asset(client, category="metal", amount_cents=550_000,
                         extra={"variety": "gold", "form": "physical", "quantity": 10,
                                "cost_price_cents": 50_000, "current_price_cents": 55_000})
        assert m["computed"]["market_value_cents"] == 550_000
        assert m["computed"]["pnl_cents"] == 50_000
        # 股票：盈亏 = 市值 − 成本
        s = create_asset(client, category="stock", amount_cents=1_500_000,
                         extra={"code": "600519", "market": "A股", "quantity": 100,
                                "cost_cents": 1_200_000})
        assert s["computed"]["pnl_cents"] == 300_000
        # 房贷：剩余期数 ≈ 剩余本金 / 月供
        g = create_asset(client, category="mortgage", direction="liability", amount_cents=1_200_000,
                         extra={"monthly_payment_cents": 100_000, "pay_day": 20})
        assert g["computed"]["remaining_months"] == 12
        # 借贷：已还 / 未还（未还=0 时提示可结清）
        lo = create_asset(client, category="loan_out", institution="张三",
                          end_date=day(30), amount_cents=1_000_000)
        assert lo["computed"]["repaid_cents"] == 0
        assert lo["computed"]["remaining_cents"] == 1_000_000
        assert lo["computed"]["can_settle"] is False


def test_liability_compute_enhancements() -> None:
    """房贷/信用卡自动计算（M3b 负债增强）：预计结清月、已还本金、下次扣款日、距还款日。"""
    with make_client()[0] as client:
        t = date.today()

        # 房贷：剩余本金 10,000 元 ÷ 月供 1,000 元 → 整除 10 期；预计结清 = 当前月 + 10 期
        g = create_asset(client, name="房贷", category="mortgage", direction="liability",
                         amount_cents=1_000_000,
                         extra={"total_cents": 2_000_000, "monthly_payment_cents": 100_000,
                                "pay_day": 20})
        c = g["computed"]
        assert c["remaining_months"] == 10
        idx = t.year * 12 + t.month - 1 + 10
        assert c["payoff_month"] == f"{idx // 12}-{idx % 12 + 1:02d}"
        assert c["paid_principal_cents"] == 1_000_000  # 贷款总额 − 剩余本金
        # 下次扣款日：本月 20 日未过取本月，已过取下月；距今天数 0~31
        expected = (date(t.year, t.month, 20) if t.day <= 20
                    else date(t.year + (t.month == 12), t.month % 12 + 1, 20))
        assert c["next_pay_date"] == expected.isoformat()
        assert c["days_to_next_pay"] == (expected - t).days

        # 非整除向上取整：10,500 元 ÷ 1,000 元 → 11 期
        g2 = create_asset(client, name="房贷2", category="mortgage", direction="liability",
                          amount_cents=1_050_000, extra={"monthly_payment_cents": 100_000})
        assert g2["computed"]["remaining_months"] == 11
        assert "payoff_month" in g2["computed"]

        # 未填月供/总额 → 不输出推算字段（存量数据兼容）
        g3 = create_asset(client, name="房贷3", category="mortgage", direction="liability",
                          amount_cents=1_000_000, extra={})
        assert "remaining_months" not in g3["computed"]
        assert "payoff_month" not in g3["computed"]
        assert "paid_principal_cents" not in g3["computed"]
        assert "next_pay_date" not in g3["computed"]

        # 信用卡：下一还款日 = 本月 25 日未过取本月，已过取下月
        cc = create_asset(client, name="信用卡", category="credit_card", direction="liability",
                          amount_cents=50_000,
                          extra={"bill_day": 5, "repay_day": 25, "installment": 0})
        c = cc["computed"]
        assert c["remaining_cents"] == 50_000  # REPAYABLE 口径不受影响
        expected = (date(t.year, t.month, 25) if t.day <= 25
                    else date(t.year + (t.month == 12), t.month % 12 + 1, 25))
        assert c["next_repay_date"] == expected.isoformat()
        assert c["days_to_repay"] == (expected - t).days

        # 今天即还款日（还款日限 1~28；月末 29~31 无法用今日作还款日，跳过）
        if t.day <= 28:
            cc2 = create_asset(client, name="信用卡2", category="credit_card", direction="liability",
                               amount_cents=10_000, extra={"repay_day": t.day})
            c2 = cc2["computed"]
            assert c2["days_to_repay"] == 0
            assert c2["next_repay_date"] == t.isoformat()


# ============ 台账：模板 / 校验 / 筛选 / 编辑删除 ============

def test_create_all_twelve_categories() -> None:
    cases = [
        ("fixed_deposit", "asset",
         dict(start_date="2026-01-01", end_date="2026-12-31", annual_rate=2.0),
         {"deposit_no": "CD-001", "auto_renew": 1}),
        ("demand", "asset", {}, {}),
        ("wealth", "asset",
         dict(start_date="2026-01-01", end_date="2026-12-31"),
         {"risk_level": "R2", "base_rate": 2.8}),
        ("metal", "asset", {},
         {"variety": "gold", "form": "physical", "quantity": 10,
          "cost_price_cents": 50_000, "current_price_cents": 55_000}),
        ("stock", "asset", {},
         {"code": "600519", "market": "A股", "quantity": 100, "cost_cents": 1_200_000}),
        ("loan_out", "asset", dict(institution="张三", end_date=day(30)),
         {"relation": "朋友", "repay_method": "once"}),
        ("bond_insurance", "asset", {}, {}),
        ("asset_other", "asset", {}, {}),
        ("mortgage", "liability", dict(institution="工商银行"),
         {"total_cents": 20_000_000, "monthly_payment_cents": 500_000, "pay_day": 20}),
        ("loan_in", "liability", dict(institution="李四", end_date=day(60)),
         {"repay_method": "installment"}),
        ("credit_card", "liability", dict(institution="招行信用卡"),
         {"bill_day": 5, "repay_day": 25, "installment": 0}),
        ("liability_other", "liability", dict(institution="房租应付"), {}),
    ]
    with make_client()[0] as client:
        for code, direction, fields, extra in cases:
            asset = create_asset(client, name=code, category=code,
                                 direction=direction, extra=extra, **fields)
            assert asset["category"] == code
            assert asset["direction"] == direction
        data = client.get("/api/v1/finance/assets").json()["data"]
        assert len(data["items"]) == 12
        assert len(data["groups"]) == 12
        assert all(g["count"] == 1 for g in data["groups"])


def test_validation_field_errors() -> None:
    with make_client()[0] as client:
        resp = client.post("/api/v1/finance/assets", json={})
        assert resp.status_code == 400
        body = resp.json()
        assert body["code"] == 4001
        errs = " ".join(body["data"]["errors"])
        for kw in ("name:", "direction:", "category:", "amount_cents:", "holder_member_id:"):
            assert kw in errs, kw
        # 方向与分类不符
        resp = client.post("/api/v1/finance/assets", json=asset_payload(
            category="fixed_deposit", direction="liability",
            start_date="2026-01-01", end_date="2027-01-01", annual_rate=2.0))
        assert any("与分类方向不符" in e for e in resp.json()["data"]["errors"])
        # 金额越界
        assert client.post("/api/v1/finance/assets", json=asset_payload(amount_cents=0)).status_code == 400
        # end 早于 start
        resp = client.post("/api/v1/finance/assets", json=asset_payload(
            category="wealth", start_date="2026-06-01", end_date="2026-01-01"))
        assert any("end_date" in e for e in resp.json()["data"]["errors"])
        # 模板必填：定期缺利率
        resp = client.post("/api/v1/finance/assets", json=asset_payload(
            category="fixed_deposit", start_date="2026-01-01", end_date="2027-01-01"))
        assert any("annual_rate" in e for e in resp.json()["data"]["errors"])
        # extra 模板必填与取值：贵金属缺数量 / 风险等级越界
        resp = client.post("/api/v1/finance/assets", json=asset_payload(category="metal", extra={}))
        assert any("extra.quantity" in e for e in resp.json()["data"]["errors"])
        resp = client.post("/api/v1/finance/assets", json=asset_payload(
            category="wealth", start_date="2026-01-01", end_date="2026-12-31",
            extra={"risk_level": "R9"}))
        assert any("extra.risk_level" in e for e in resp.json()["data"]["errors"])


def test_list_filters() -> None:
    with make_client()[0] as client:
        create_asset(client, name="工行定期", category="fixed_deposit",
                     start_date=day(-30), end_date=day(340), annual_rate=2.0)
        create_asset(client, name="招行活期", category="demand", amount_cents=2_000_000)
        create_asset(client, name="房贷", category="mortgage", direction="liability",
                     amount_cents=3_000_000)
        data = client.get("/api/v1/finance/assets?direction=asset").json()["data"]
        assert len(data["items"]) == 2
        data = client.get("/api/v1/finance/assets?category=demand").json()["data"]
        assert [a["name"] for a in data["items"]] == ["招行活期"]
        data = client.get("/api/v1/finance/assets?q=招行").json()["data"]
        assert len(data["items"]) == 1
        data = client.get("/api/v1/finance/assets?status=holding").json()["data"]
        assert len(data["items"]) == 3
        data = client.get("/api/v1/finance/assets?direction=liability&holder_id=1").json()["data"]
        assert [a["name"] for a in data["items"]] == ["房贷"]


def test_update_and_soft_delete() -> None:
    with make_client()[0] as client:
        asset = create_asset(client)
        # 局部编辑：金额更新且其余字段保留
        data = client.put(f"/api/v1/finance/assets/{asset['id']}",
                          json={"amount_cents": 2_000_000}).json()["data"]
        assert data["amount_cents"] == 2_000_000
        assert data["name"] == "测试资产"
        # 编辑只改 direction → 与分类方向不符
        resp = client.put(f"/api/v1/finance/assets/{asset['id']}", json={"direction": "liability"})
        assert resp.status_code == 400
        assert any("与分类方向不符" in e for e in resp.json()["data"]["errors"])
        # 定期：编辑未传 extra 时保留原 extra（回归：JSON 字符串归一化）
        fd = create_asset(client, category="fixed_deposit", start_date="2026-01-01",
                          end_date="2027-01-01", annual_rate=2.0,
                          extra={"deposit_no": "CD-1", "auto_renew": 0})
        data = client.put(f"/api/v1/finance/assets/{fd['id']}", json={"note": "补录存单号"}).json()["data"]
        assert data["extra_data"]["deposit_no"] == "CD-1"
        assert data["note"] == "补录存单号"
        # 软删除：详情 404、列表不可见
        assert client.delete(f"/api/v1/finance/assets/{asset['id']}").json()["data"]["deleted"] is True
        assert client.get(f"/api/v1/finance/assets/{asset['id']}").status_code == 404
        ids = [a["id"] for a in client.get("/api/v1/finance/assets").json()["data"]["items"]]
        assert asset["id"] not in ids


# ============ 状态流转（FR-09） ============

def test_settle_flows() -> None:
    with make_client()[0] as client:
        # --- 借贷：登记还款 → 结清 ---
        loan = create_asset(client, name="借给张三", category="loan_out", institution="张三",
                            end_date=day(30), amount_cents=1_000_000)
        r = client.post(f"/api/v1/finance/assets/{loan['id']}/settle",
                        json={"action": "repay", "amount_cents": 400_000})
        assert r.json()["data"] == {"repaid_cents": 400_000, "remaining_cents": 600_000, "can_settle": False}
        # 超过未还余额 → 拒绝
        r = client.post(f"/api/v1/finance/assets/{loan['id']}/settle",
                        json={"action": "repay", "amount_cents": 700_000})
        assert r.status_code == 400
        # 还清剩余 → 可结清
        r = client.post(f"/api/v1/finance/assets/{loan['id']}/settle",
                        json={"action": "repay", "amount_cents": 600_000})
        assert r.json()["data"]["can_settle"] is True
        data = client.get(f"/api/v1/finance/assets/{loan['id']}").json()["data"]
        assert data["computed"]["repaid_cents"] == 1_000_000
        assert data["computed"]["remaining_cents"] == 0
        # 结清 → settled_clear，不可编辑、不可重复流转
        assert client.post(f"/api/v1/finance/assets/{loan['id']}/settle",
                           json={"action": "clear"}).json()["data"]["settled"] is True
        data = client.get(f"/api/v1/finance/assets/{loan['id']}").json()["data"]
        assert data["effective_status"] == "settled_clear"
        assert data["status_label"] == "已结清"
        assert client.put(f"/api/v1/finance/assets/{loan['id']}", json={"note": "x"}).status_code == 400
        assert client.post(f"/api/v1/finance/assets/{loan['id']}/settle",
                           json={"action": "clear"}).status_code == 400
        # 非借贷类不支持登记还款
        d = create_asset(client, name="活期", category="demand")
        assert client.post(f"/api/v1/finance/assets/{d['id']}/settle",
                           json={"action": "repay", "amount_cents": 1}).status_code == 400
        # 非定期不支持续存
        assert client.post(f"/api/v1/finance/assets/{d['id']}/settle",
                           json={"action": "renew"}).status_code == 400
        # 不存在的资产
        assert client.post("/api/v1/finance/assets/99999/settle",
                           json={"action": "clear"}).status_code == 404

        # --- 定期：续存生成新记录 ---
        fd = create_asset(client, name="中行定期", category="fixed_deposit", amount_cents=5_000_000,
                          start_date="2026-01-01", end_date="2027-01-01", annual_rate=2.0,
                          extra={"deposit_no": "CD-9", "auto_renew": 0})
        r = client.post(f"/api/v1/finance/assets/{fd['id']}/settle", json={"action": "renew"})
        result = r.json()["data"]
        assert result["settled"] is True and result["new_asset_id"]
        new = client.get(f"/api/v1/finance/assets/{result['new_asset_id']}").json()["data"]
        assert new["start_date"] == "2027-01-01"
        assert new["end_date"] == "2028-01-01"
        assert new["amount_cents"] == 5_000_000
        assert new["annual_rate"] == 2.0
        assert new["extra_data"]["deposit_no"] == "CD-9"
        assert new["effective_status"] == "holding"
        old = client.get(f"/api/v1/finance/assets/{fd['id']}").json()["data"]
        assert old["effective_status"] == "settled_renew"

        # --- 定期：支取 ---
        fd2 = create_asset(client, category="fixed_deposit", start_date="2026-01-01",
                           end_date="2027-01-01", annual_rate=2.0)
        r = client.post(f"/api/v1/finance/assets/{fd2['id']}/settle",
                        json={"action": "withdraw", "amount_cents": 4_900_000})
        assert r.json()["data"]["settled"] is True
        data = client.get(f"/api/v1/finance/assets/{fd2['id']}").json()["data"]
        assert data["effective_status"] == "settled_withdraw"


# ============ 市值历史（FR-10） ============

def test_values_history() -> None:
    with make_client()[0] as client:
        asset = create_asset(client, category="metal", amount_cents=1_000_000,
                             extra={"variety": "gold", "form": "physical", "quantity": 10,
                                    "cost_price_cents": 100_000, "current_price_cents": 100_000})
        r = client.post(f"/api/v1/finance/assets/{asset['id']}/values",
                        json={"value_cents": 1_100_000, "value_date": day(0), "note": "金价更新"})
        assert r.json()["data"]["value_cents"] == 1_100_000
        # 手动市值同时刷新当前金额
        data = client.get(f"/api/v1/finance/assets/{asset['id']}").json()["data"]
        assert data["amount_cents"] == 1_100_000
        assert len(data["values"]) == 1
        assert data["events"][0]["event_type"] == "value"
        # 历史列表
        values = client.get(f"/api/v1/finance/assets/{asset['id']}/values").json()["data"]
        assert values[0]["value_cents"] == 1_100_000
        # 非法值与日期
        assert client.post(f"/api/v1/finance/assets/{asset['id']}/values",
                           json={"value_cents": -5, "value_date": "bad"}).status_code == 400
        # 不存在的资产
        assert client.get("/api/v1/finance/assets/99999/values").status_code == 404


# ============ 实际收益录入（M2d，仅理财） ============

def test_interest_recording() -> None:
    with make_client()[0] as client:
        # 本金 1 万、业绩基准 2.5%、持有整 365 天
        asset = create_asset(client, name="招行季季享", category="wealth", amount_cents=1_000_000,
                             start_date=day(-365), end_date=day(30),
                             extra={"risk_level": "R2", "base_rate": 2.5})
        r = client.post(f"/api/v1/finance/assets/{asset['id']}/interest",
                        json={"interest_cents": 28_000, "value_date": day(0), "note": "银行App抄录"})
        data = r.json()["data"]
        assert data["interest_cents"] == 28_000
        assert data["value_cents"] == 1_028_000  # 市值 = 本金 + 累计收益

        detail = client.get(f"/api/v1/finance/assets/{asset['id']}").json()["data"]
        # 本金语义不被刷新（与 add_value 的市值语义区分）
        assert detail["amount_cents"] == 1_000_000
        # 快照轨迹 + 事件
        assert detail["values"][-1]["value_cents"] == 1_028_000
        assert detail["events"][0]["event_type"] == "interest"
        # computed：实际收益 + 实际年化（28,000 / 1,000,000 × 365/365 = 2.8%）
        comp = detail["computed"]
        assert comp["actual_interest_cents"] == 28_000
        assert comp["actual_annualized_rate"] == 2.8
        # 预计收益按基准（2.5% × 395 天持有期 = 27,055），实际略跑赢基准
        assert comp["est_interest_cents"] == 27_055

        # 二次录入：最新一条生效（累计口径）
        client.post(f"/api/v1/finance/assets/{asset['id']}/interest",
                    json={"interest_cents": 30_000, "value_date": day(0)})
        comp = client.get(f"/api/v1/finance/assets/{asset['id']}").json()["data"]["computed"]
        assert comp["actual_interest_cents"] == 30_000

        # 非 wealth 分类拒绝
        dep = create_asset(client, name="工行定期", category="fixed_deposit", amount_cents=1_000_000,
                           start_date=day(-30), end_date=day(330), annual_rate=2.0)
        resp = client.post(f"/api/v1/finance/assets/{dep['id']}/interest",
                           json={"interest_cents": 5_000})
        assert resp.status_code == 400
        assert "仅理财" in resp.json()["message"]

        # 非法值拒绝
        assert client.post(f"/api/v1/finance/assets/{asset['id']}/interest",
                           json={"interest_cents": -1}).status_code == 400
        assert client.post(f"/api/v1/finance/assets/{asset['id']}/interest",
                           json={"interest_cents": "abc"}).status_code == 400
        # 不存在的资产
        assert client.post("/api/v1/finance/assets/99999/interest",
                           json={"interest_cents": 100}).status_code == 404


# ============ 聚合：总览 / 趋势 / 日历 ============

def test_overview_aggregation() -> None:
    with make_client()[0] as client:
        client.post("/api/v1/finance/members", json={"name": "配偶"})
        create_asset(client, name="工行定期", category="fixed_deposit", amount_cents=10_000_000,
                     start_date=day(-60), end_date=day(40), annual_rate=2.0)
        create_asset(client, name="招行活期", category="demand", amount_cents=2_000_000)
        create_asset(client, name="房贷", category="mortgage", direction="liability",
                     amount_cents=8_000_000, extra={"monthly_payment_cents": 50_000})
        loan = create_asset(client, name="借给张三", category="loan_out", institution="张三",
                            end_date=day(10), amount_cents=1_000_000, holder_member_id=2)
        data = client.get("/api/v1/finance/overview").json()["data"]
        assert data["totals"] == {"assets_cents": 13_000_000, "liabilities_cents": 8_000_000,
                                  "net_cents": 5_000_000}
        cats = {c["code"]: c for c in data["by_category"]}
        assert cats["fixed_deposit"] == {"code": "fixed_deposit", "name": "银行定期",
                                         "direction": "asset", "count": 1, "amount_cents": 10_000_000}
        members = {m["member_id"]: m for m in data["by_member"]}
        assert members[1]["amount_cents"] == 12_000_000
        assert members[2]["name"] == "配偶" and members[2]["amount_cents"] == 1_000_000
        # 机构维度（M2d+）：资产方向按机构聚合，负债不计入
        insts = data["by_institution"]
        assert [(i["name"], i["count"], i["amount_cents"]) for i in insts] == [
            ("工商银行", 2, 12_000_000), ("张三", 1, 1_000_000),
        ]
        assert len(data["upcoming"]) == 1
        assert data["upcoming"][0]["asset_id"] == loan["id"]
        assert data["upcoming"][0]["level"] == "soon"
        assert data["upcoming"][0]["amount_cents"] == 1_000_000
        assert len(data["recent_events"]) >= 4


def test_trend_series() -> None:
    with make_client()[0] as client:
        create_asset(client, name="招行活期", category="demand", amount_cents=2_000_000)
        create_asset(client, name="工行定期", category="fixed_deposit", amount_cents=10_000_000,
                     start_date=day(-400), end_date=day(200), annual_rate=2.0)
        series = client.get("/api/v1/finance/trend?months=12").json()["data"]
        assert len(series) == 12
        for s in series:
            assert set(s) == {"date", "assets_cents", "liabilities_cents", "net_cents"}
            assert s["net_cents"] == s["assets_cents"] - s["liabilities_cents"]
        # 定期逐月计息 → 净资产逐月增长；负债为 0
        assert series[-1]["assets_cents"] > series[0]["assets_cents"]
        assert series[-1]["liabilities_cents"] == 0
        assert len(client.get("/api/v1/finance/trend?months=1").json()["data"]) == 1


def test_calendar_groups() -> None:
    with make_client()[0] as client:
        create_asset(client, name="逾期外借", category="loan_out", institution="张三",
                     end_date=day(-3), amount_cents=500_000)
        create_asset(client, name="到期定存", category="fixed_deposit", amount_cents=1_000_000,
                     start_date=day(-370), end_date=day(-1), annual_rate=2.0)
        create_asset(client, name="临期理财", category="wealth", amount_cents=1_000_000,
                     start_date=day(-10), end_date=day(3), extra={"base_rate": 3.0})
        create_asset(client, name="预告外借", category="loan_out", institution="李四",
                     end_date=day(20), amount_cents=2_000_000)
        create_asset(client, name="无到期活期", category="demand", amount_cents=3_000_000)
        data = client.get("/api/v1/finance/calendar").json()["data"]
        assert [g["label"] for g in data["groups"]] == ["已逾期", "已到期", "即将到期", "30天内到期"]
        groups = {g["level"]: g for g in data["groups"]}
        assert [i["name"] for i in groups["overdue"]["items"]] == ["逾期外借"]
        assert [i["name"] for i in groups["matured"]["items"]] == ["到期定存"]
        assert [i["name"] for i in groups["urgent"]["items"]] == ["临期理财"]
        assert [i["name"] for i in groups["soon"]["items"]] == ["预告外借"]
        item = groups["urgent"]["items"][0]
        assert item["category_label"] == "理财产品"
        est = int(round(1_000_000 * 3.0 / 100 * 13 / 365))  # 13 天预计收益
        assert item["amount_cents"] == 1_000_000 + est
        # 窗口过滤：urgent 保留（0~10 天），soon 出窗
        data = client.get(f"/api/v1/finance/calendar?from={day(0)}&to={day(10)}").json()["data"]
        groups = {g["level"]: g for g in data["groups"]}
        assert [i["name"] for i in groups["urgent"]["items"]] == ["临期理财"]
        assert groups["soon"]["items"] == []


# ============ 附件（FR-05，dev-plan §5） ============

def test_attachments_lifecycle() -> None:
    client, tmp = make_client()
    with client:
        asset = create_asset(client)
        aid = asset["id"]
        # 白名单拒绝
        r = upload(client, aid, "a.exe", b"MZ\x90\x00")
        assert r.status_code == 400
        assert "仅支持" in r.json()["data"]["errors"][0]
        # 内容与扩展名不符（magic bytes）
        assert upload(client, aid, "a.png", b"not-a-png").status_code == 400
        # 超过 10 MB
        r = upload(client, aid, "big.png", PNG_BYTES + b"\x00" * (10 * 1024 * 1024))
        assert r.status_code == 400
        assert any("10 MB" in e for e in r.json()["data"]["errors"])
        # 正常上传
        r = upload(client, aid, "借据.png", PNG_BYTES)
        assert r.status_code == 200
        att = r.json()["data"]
        assert att["file_type"] == "png" and att["file_size"] == len(PNG_BYTES)
        # 下载回读
        r = client.get(f"/api/v1/finance/attachments/{att['id']}/download")
        assert r.status_code == 200
        assert r.content == PNG_BYTES
        assert "attachment" in r.headers["content-disposition"]
        # 详情可见 + 事件留痕
        data = client.get(f"/api/v1/finance/assets/{aid}").json()["data"]
        assert data["attachments"][0]["file_name"] == "借据.png"
        assert data["events"][0]["event_type"] == "attachment"
        # 单资产 20 个上限
        for i in range(19):
            assert upload(client, aid, f"f{i}.png", PNG_BYTES).status_code == 200
        assert upload(client, aid, "over.png", PNG_BYTES).status_code == 400
        # 删除 → 下载 404 → 可再补传
        assert client.delete(f"/api/v1/finance/attachments/{att['id']}").json()["data"]["deleted"] is True
        assert client.get(f"/api/v1/finance/attachments/{att['id']}/download").status_code == 404
        assert upload(client, aid, "again.png", PNG_BYTES).status_code == 200
    # 伪造 file_path（路径穿越）→ 规范化校验拒绝
    db = sqlite3.connect(tmp / "family_assistant.db")
    cur = db.execute(
        "INSERT INTO finance_attachments (asset_id, file_name, file_path, file_type, file_size) "
        "VALUES (?, ?, ?, ?, ?)",
        (aid, "evil.png", "../evil.png", "png", 4),
    )
    evil_id = cur.lastrowid
    db.commit()
    db.close()
    with client:
        assert client.get(f"/api/v1/finance/attachments/{evil_id}/download").status_code == 404


# ============ 对比分析（M2c · compare-design §5） ============

def test_compare_assets() -> None:
    with make_client()[0] as client:
        # 混合分类：定期（年利率）/ 理财（业绩基准）/ 活期、股票（浮动）/ 负债（应被过滤）
        fd = create_asset(client, name="一年定期", category="fixed_deposit", amount_cents=10_000_000,
                          start_date="2026-01-01", end_date="2027-01-01", annual_rate=3.5)
        wf = create_asset(client, name="季季享", category="wealth", amount_cents=5_000_000,
                          start_date="2026-01-01", end_date="2026-04-01",
                          extra={"risk_level": "R2", "base_rate": 2.8})
        dm = create_asset(client, name="活期零钱", category="demand", amount_cents=88_800)
        st = create_asset(client, name="沪深300ETF", category="stock", amount_cents=12_000_000,
                          extra={"quantity": 100})
        liab = create_asset(client, name="房贷", direction="liability",
                            category="mortgage", amount_cents=100_000_000)

        ids = f"{fd['id']},{wf['id']},{dm['id']},{st['id']},{liab['id']},99999"
        items = client.get("/api/v1/finance/assets/compare", params={"ids": ids}).json()["data"]["items"]
        by_id = {it["id"]: it for it in items}
        assert set(by_id) == {fd["id"], wf["id"], dm["id"], st["id"]}  # 负债过滤 + 失效 id 跳过

        f = by_id[fd["id"]]
        assert f["annualized_rate"] == 3.5 and f["annualized_note"] is None
        assert f["rate_label"] == "年利率 3.5%" and f["period_label"] == "12 个月"
        assert f["est_interest_cents"] == 350_000 and f["maturity_cents"] == 10_350_000
        assert f["risk_label"] is None and f["floating"] is False
        assert f["due_label"].endswith("天后到期") and f["status_label"] in ("持有中", "已到期")

        w = by_id[wf["id"]]
        assert w["annualized_rate"] == 2.8 and w["annualized_note"] == "业绩基准"
        assert w["rate_label"] == "业绩基准 2.8%" and w["risk_label"] == "R2 中低风险"
        assert w["actual_interest_cents"] is None and w["actual_annualized_rate"] is None

        # 实际收益透传（M2d）：录入后对比矩阵可显示实际年化（38,000 / 5,000,000 × 365/90）
        client.post(f"/api/v1/finance/assets/{wf['id']}/interest",
                    json={"interest_cents": 38_000, "value_date": "2026-04-01"})
        w2 = client.get("/api/v1/finance/assets/compare",
                        params={"ids": str(wf["id"])}).json()["data"]["items"][0]
        assert w2["actual_interest_cents"] == 38_000
        assert w2["actual_annualized_rate"] == 3.08

        assert by_id[dm["id"]]["annualized_rate"] is None and by_id[dm["id"]]["floating"] is True
        assert by_id[dm["id"]]["due_label"] == "—"  # 活期无到期日
        assert by_id[st["id"]]["annualized_rate"] is None and by_id[st["id"]]["floating"] is True

        # 上限 6：3 个额外资产后仅返回前 6
        more = [create_asset(client, category="bond_insurance", name=f"国债{i}")["id"] for i in range(3)]
        all_ids = [fd["id"], wf["id"], dm["id"], st["id"]] + more
        items = client.get("/api/v1/finance/assets/compare",
                           params={"ids": ",".join(map(str, all_ids))}).json()["data"]["items"]
        assert len(items) == 6
        assert items[0]["id"] == fd["id"]  # 超出部分按入参顺序截断

        # 附件计数
        assert upload(client, fd["id"], "存单.png", PNG_BYTES).status_code == 200
        f2 = client.get("/api/v1/finance/assets/compare",
                        params={"ids": str(fd["id"])}).json()["data"]["items"][0]
        assert f2["attachment_count"] == 1

        # ids 非数字 → 4001
        r = client.get("/api/v1/finance/assets/compare", params={"ids": "abc"})
        assert r.json()["code"] == 4001

        # 空 items 正常返回
        assert client.get("/api/v1/finance/assets/compare", params={"ids": "99999"}) \
            .json()["data"]["items"] == []


# ============ 收益分析（M3a · finance-module-design §5.6） ============

def analytics_data(client: TestClient, months: int = 12) -> dict:
    return client.get(f"/api/v1/finance/analytics?months={months}").json()["data"]


def test_analytics_empty() -> None:
    with make_client()[0] as client:
        data = client.get("/api/v1/finance/analytics").json()["data"]
        assert data["summary"] == {
            "realized_total_cents": 0, "realized_recent_cents": 0,
            "pending_estimated_cents": 0, "unrealized_pnl_cents": 0,
            "weighted_actual_rate": None,
        }
        assert len(data["monthly"]) == 12
        assert all(m["realized_cents"] == 0 for m in data["monthly"])
        assert data["monthly"][-1]["month"] == date.today().isoformat()[:7]
        assert data["by_category"] == [] and data["by_member"] == [] and data["details"] == []
        # months 参数范围：越界 422，下界 1
        assert client.get("/api/v1/finance/analytics?months=99").status_code == 422
        assert len(analytics_data(client, months=1)["monthly"]) == 1


def test_analytics_interest_spread_and_details() -> None:
    """理财收益录入：首录区间线性分摊（跨月守恒）+ 二次录入差值 + 明细原始事件。"""
    with make_client()[0] as client:
        w = create_asset(client, name="招行理财", category="wealth", amount_cents=1_000_000,
                         start_date=day(-90), end_date=day(60),
                         extra={"risk_level": "R2", "base_rate": 2.5})
        client.post(f"/api/v1/finance/assets/{w['id']}/interest",
                    json={"interest_cents": 6_000, "value_date": day(-30)})
        data = analytics_data(client)
        # 首录 6,000 分分摊在 day(-90)→day(-30) 共 60 天（跨 ≥2 个日历月），分摊和守恒
        assert data["summary"]["realized_total_cents"] == 6_000
        assert sum(m["realized_cents"] for m in data["monthly"]) == 6_000
        assert len([m for m in data["monthly"] if m["realized_cents"] > 0]) >= 2
        # 明细记录原始事件（非分摊值）
        assert len(data["details"]) == 1
        assert data["details"][0]["kind"] == "interest_input"
        assert data["details"][0]["kind_label"] == "收益录入"
        assert data["details"][0]["amount_cents"] == 6_000
        assert "累计" in data["details"][0]["note"]
        # 分类/成员聚合
        assert data["by_category"] == [{"code": "wealth", "label": "理财产品", "realized_cents": 6_000}]
        assert data["by_member"] == [{"member_id": 1, "name": "本人", "realized_cents": 6_000}]

        # 二次录入：差值 3,000 分摊 day(-30)→day(-10)
        client.post(f"/api/v1/finance/assets/{w['id']}/interest",
                    json={"interest_cents": 9_000, "value_date": day(-10)})
        data = analytics_data(client)
        assert data["summary"]["realized_total_cents"] == 9_000
        assert sum(m["realized_cents"] for m in data["monthly"]) == 9_000
        # 明细按日期倒序：最新事件在前
        assert [d["amount_cents"] for d in data["details"]] == [3_000, 6_000]


def test_analytics_interest_negative_delta() -> None:
    """理财收益回调：累计值下降产生负增量，总额与明细如实记录。"""
    with make_client()[0] as client:
        w = create_asset(client, category="wealth", amount_cents=1_000_000,
                         start_date=day(-40), end_date=day(60))
        client.post(f"/api/v1/finance/assets/{w['id']}/interest",
                    json={"interest_cents": 5_000, "value_date": day(-20)})
        client.post(f"/api/v1/finance/assets/{w['id']}/interest",
                    json={"interest_cents": 3_000, "value_date": day(-10)})
        data = analytics_data(client)
        # 全历史 = 5,000 - 2,000 = 3,000
        assert data["summary"]["realized_total_cents"] == 3_000
        assert sum(m["realized_cents"] for m in data["monthly"]) == 3_000
        neg = [d for d in data["details"] if d["amount_cents"] < 0]
        assert neg and neg[0]["amount_cents"] == -2_000
        assert "回调" in neg[0]["note"]


def test_analytics_fixed_deposit_maturity() -> None:
    """到期定期：全期利息按 end_date 所在月归集；未到期定期计入在途预计。"""
    with make_client()[0] as client:
        matured = create_asset(client, name="工行定期", category="fixed_deposit",
                               amount_cents=10_000_000, start_date=day(-400), end_date=day(-10),
                               annual_rate=2.0)
        pending = create_asset(client, name="中行定期", category="fixed_deposit",
                               amount_cents=10_000_000, start_date=day(-30), end_date=day(330),
                               annual_rate=3.0)
        # 期望值与创建后 computed 的到期利息一致（公式口径复用）
        expected = client.get(f"/api/v1/finance/assets/{matured['id']}") \
            .json()["data"]["computed"]["interest_cents"]
        exp_pending = client.get(f"/api/v1/finance/assets/{pending['id']}") \
            .json()["data"]["computed"]["interest_cents"]
        data = analytics_data(client)
        assert data["summary"]["realized_total_cents"] == expected
        assert data["summary"]["realized_recent_cents"] == expected
        month_map = {m["month"]: m["realized_cents"] for m in data["monthly"]}
        assert month_map[day(-10)[:7]] == expected  # 归集到 end_date 所在月
        assert data["summary"]["pending_estimated_cents"] == exp_pending
        assert data["details"][0]["kind"] == "maturity"
        assert data["details"][0]["asset_name"] == "工行定期"


def test_analytics_withdraw_gap() -> None:
    """定期提前支取带实际金额：差额归集；理财赎回差额扣除已录收益后并入。"""
    with make_client()[0] as client:
        dep = create_asset(client, category="fixed_deposit", amount_cents=1_000_000,
                           start_date=day(-120), end_date=day(120), annual_rate=2.0)
        r = client.post(f"/api/v1/finance/assets/{dep['id']}/settle",
                        json={"action": "withdraw", "amount_cents": 1_005_000})
        assert r.json()["data"]["settled"] is True
        data = analytics_data(client)
        assert data["summary"]["realized_total_cents"] == 5_000
        assert data["details"][0]["kind"] == "withdraw_gap"
        assert data["details"][0]["amount_cents"] == 5_000

        # 理财：先录入收益再赎回 → 差额 = 实际 - 本金 - 已录累计
        w = create_asset(client, name="理财", category="wealth", amount_cents=1_000_000,
                         start_date=day(-100), end_date=day(50))
        client.post(f"/api/v1/finance/assets/{w['id']}/interest",
                    json={"interest_cents": 8_000, "value_date": day(-5)})
        client.post(f"/api/v1/finance/assets/{w['id']}/settle",
                    json={"action": "withdraw", "amount_cents": 1_011_000})
        data = analytics_data(client)
        # 定期 5,000 + 理财录入 8,000 + 理财赎回差额 3,000 = 16,000
        assert data["summary"]["realized_total_cents"] == 16_000
        kinds = {d["kind"] for d in data["details"]}
        assert kinds == {"withdraw_gap", "interest_input"}


def test_analytics_floating_pnl_and_weighted_rate() -> None:
    """浮动盈亏独立展示（不混入已实现）；实际年化按本金加权。"""
    with make_client()[0] as client:
        # 贵金属：10 克 × (5,200-5,000) = +2,000 分
        create_asset(client, name="黄金积存", category="metal", amount_cents=50_000,
                     extra={"variety": "gold", "form": "accumulate", "quantity": 10,
                            "cost_price_cents": 5_000, "current_price_cents": 5_200})
        # 股票：市值 10,000 - 成本 11,000 = -1,000 分
        create_asset(client, name="沪深300ETF", category="stock", amount_cents=10_000,
                     extra={"code": "510300", "market": "sh", "quantity": 1000, "cost_cents": 11_000})
        # 理财 A：本金 1 万、持有一年录入 30,000 分（3%）/ 理财 B：本金 2 万录入 20,000 分（1%）
        wa = create_asset(client, name="理财A", category="wealth", amount_cents=1_000_000,
                          start_date=day(-365), end_date=day(30))
        client.post(f"/api/v1/finance/assets/{wa['id']}/interest",
                    json={"interest_cents": 30_000, "value_date": day(0)})
        wb = create_asset(client, name="理财B", category="wealth", amount_cents=2_000_000,
                          start_date=day(-365), end_date=day(30))
        client.post(f"/api/v1/finance/assets/{wb['id']}/interest",
                    json={"interest_cents": 20_000, "value_date": day(0)})
        data = analytics_data(client)
        assert data["summary"]["unrealized_pnl_cents"] == 1_000  # 2,000 - 1,000
        assert data["summary"]["realized_total_cents"] == 50_000  # 仅理财录入
        # 加权实际年化 (3%×100万 + 1%×200万) ÷ 300万 = 1.67%
        assert data["summary"]["weighted_actual_rate"] == 1.67
