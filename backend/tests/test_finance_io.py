"""理财导入导出测试（M3b · finance-module-design.md §5.7）。

覆盖：JSON 备份结构 / CSV 格式 / merge 幂等与恢复 / restore 全量恢复 /
ZIP 附件往返 / 格式校验与行级跳过 / zip slip 防护。
"""

import io
import json
import tempfile
import zipfile
from datetime import date, timedelta
from pathlib import Path

from fastapi.testclient import TestClient

from app.core.config import Settings
from main import create_app

PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16


def make_client(data_dir: Path | None = None) -> tuple[TestClient, Path]:
    tmp = data_dir or Path(tempfile.mkdtemp(prefix="fa-io-test-"))
    return TestClient(create_app(Settings(data_dir=tmp))), tmp


def day(offset: int) -> str:
    return (date.today() + timedelta(days=offset)).isoformat()


def create_asset(client: TestClient, **overrides) -> dict:
    payload = {
        "name": "测试资产", "direction": "asset", "category": "demand",
        "holder_member_id": 1, "institution": "工商银行", "amount_cents": 1_000_000,
        "start_date": None, "end_date": None, "annual_rate": None, "extra": {},
    }
    payload.update(overrides)
    resp = client.post("/api/v1/finance/assets", json=payload)
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]


def export_json(client: TestClient) -> dict:
    r = client.get("/api/v1/finance/export")
    assert r.status_code == 200
    assert "attachment" in r.headers["content-disposition"]
    return json.loads(r.content)


# ============ 导出 ============

def test_export_json_structure() -> None:
    with make_client()[0] as client:
        client.post("/api/v1/finance/members", json={"name": "配偶"})
        a1 = create_asset(client, name="工行定期", category="fixed_deposit",
                          start_date=day(-100), end_date=day(260), annual_rate=2.0)
        w = create_asset(client, name="招行理财", category="wealth",
                         start_date=day(-60), end_date=day(60))
        client.post(f"/api/v1/finance/assets/{w['id']}/interest",
                    json={"interest_cents": 5_000, "value_date": day(-5)})
        create_asset(client, name="已删除的活期", category="demand")
        client.delete(f"/api/v1/finance/assets/{a1['id']}")  # 软删除 → 备份必须包含

        backup = export_json(client)
        assert backup["format"] == "familyassistant.finance.backup"
        assert backup["version"] == 1
        assert backup["app_version"]
        data = backup["data"]
        # 字典 + 3 笔资产（含软删除）+ 快照/事件
        assert len(data["finance_members"]) == 2
        assert len(data["finance_assets"]) == 3
        assert len(data["finance_asset_values"]) == 1
        assert any(e["event_type"] == "interest" for e in data["finance_asset_events"])
        deleted = [a for a in data["finance_assets"] if a["id"] == a1["id"]]
        assert deleted and deleted[0]["is_deleted"] == 1


def test_export_csv() -> None:
    with make_client()[0] as client:
        create_asset(client, name="工行定期", category="fixed_deposit",
                     start_date=day(-100), end_date=day(260), annual_rate=2.0)
        create_asset(client, name="房贷", direction="liability", category="mortgage",
                     amount_cents=5_000_000, extra={"monthly_payment_cents": 30_000})
        r = client.get("/api/v1/finance/export?format=csv")
        assert r.status_code == 200
        text = r.content.decode("utf-8")
        # UTF-8 BOM + 表头 + 两行数据（金额元、方向/分类友好文案）
        assert text.startswith("\ufeff")
        assert "ID,名称,方向,分类,归属人,机构,金额(元),起始日,到期日,年利率(%),状态,备注" in text
        assert "工行定期" in text and "资产" in text and "银行定期" in text and "10000.00" in text
        assert "房贷" in text and "负债" in text and "2.0" in text


# ============ 导入：merge / restore / zip ============

def test_import_merge_restores_deleted_and_idempotent() -> None:
    client, _tmp = make_client()
    with client:
        a1 = create_asset(client, name="活期A", category="demand")
        backup = export_json(client)

        # 导出后继续变更：软删除 a1 → merge 应恢复
        client.delete(f"/api/v1/finance/assets/{a1['id']}")
        assert client.get("/api/v1/finance/assets").json()["data"]["items"] == []

        r = client.post("/api/v1/finance/import",
                        files={"upload": ("b.json", json.dumps(backup).encode(), "application/json")},
                        data={"mode": "merge"})
        assert r.status_code == 200, r.text
        result = r.json()["data"]
        assert result["mode"] == "merge"
        assert result["imported"]["finance_assets"] == 1
        assert result["skipped"] == []
        # 软删除行被备份覆盖恢复
        items = client.get("/api/v1/finance/assets").json()["data"]["items"]
        assert [i["name"] for i in items] == ["活期A"]

        # 幂等：再导入一次结果一致
        r2 = client.post("/api/v1/finance/import",
                         files={"upload": ("b.json", json.dumps(backup).encode(), "application/json")},
                         data={"mode": "merge"})
        assert r2.json()["data"]["imported"] == result["imported"]
        assert r2.json()["data"]["skipped"] == []


def test_import_restore_replaces_all() -> None:
    client, _tmp = make_client()
    with client:
        create_asset(client, name="备份内资产A", category="demand", amount_cents=1_500_000)
        backup = export_json(client)

        # 备份后造干扰数据 B
        create_asset(client, name="备份后新增B", category="demand")
        client.post("/api/v1/finance/members", json={"name": "备份后成员"})

        r = client.post("/api/v1/finance/import",
                        files={"upload": ("b.json", json.dumps(backup).encode(), "application/json")},
                        data={"mode": "restore"})
        assert r.status_code == 200, r.text
        assert r.json()["data"]["mode"] == "restore"

        # B 数据消失，备份点完整恢复
        names = [i["name"] for i in client.get("/api/v1/finance/assets").json()["data"]["items"]]
        assert names == ["备份内资产A"]
        assert "备份后新增B" not in names
        member_names = [m["name"] for m in client.get("/api/v1/finance/members").json()["data"]]
        assert member_names == ["本人"]  # 备份时只有默认成员

        # 再导出 → 数据与备份点一致
        again = export_json(client)
        assert again["data"] == backup["data"]


def test_import_zip_attachments_roundtrip() -> None:
    client, _tmp = make_client()
    with client:
        a1 = create_asset(client, name="定期带附件", category="fixed_deposit",
                          start_date=day(-100), end_date=day(260), annual_rate=2.0)
        att = client.post(f"/api/v1/finance/assets/{a1['id']}/attachments",
                          files={"upload": ("存单.png", PNG_BYTES, "image/png")}).json()["data"]
        r = client.get("/api/v1/finance/export?attachments=1")
        assert r.status_code == 200
        zf = zipfile.ZipFile(io.BytesIO(r.content))
        assert "manifest.json" in zf.namelist()
        assert any(n.startswith("attachments/") for n in zf.namelist())

        # restore 导入 zip → 元数据 + 物理文件 + 可下载
        r2 = client.post("/api/v1/finance/import",
                        files={"upload": ("b.zip", r.content, "application/zip")},
                        data={"mode": "restore"})
        assert r2.status_code == 200, r2.text
        result = r2.json()["data"]
        assert result["files_restored"] >= 1
        assert result["imported"]["finance_attachments"] == 1
        dl = client.get(f"/api/v1/finance/attachments/{att['id']}/download")
        assert dl.status_code == 200 and dl.content == PNG_BYTES


# ============ 校验与防护 ============

def test_import_rejects_invalid_backup_and_mode() -> None:
    with make_client()[0] as client:
        # 非备份 JSON
        r = client.post("/api/v1/finance/import",
                        files={"upload": ("x.json", b'{"foo": 1}', "application/json")},
                        data={"mode": "merge"})
        assert r.status_code == 400
        assert "不是有效的理财数据备份文件" in r.json()["message"]
        # mode 非法
        backup = export_json(client)
        r = client.post("/api/v1/finance/import",
                        files={"upload": ("b.json", json.dumps(backup).encode(), "application/json")},
                        data={"mode": "xxx"})
        assert r.status_code == 400
        assert "merge/restore" in r.json()["message"]
        # 损坏文件
        r = client.post("/api/v1/finance/import",
                        files={"upload": ("x.json", b"not json", "application/json")},
                        data={"mode": "merge"})
        assert r.status_code == 400


def test_import_skips_rows_with_missing_references() -> None:
    with make_client()[0] as client:
        create_asset(client, name="正常资产", category="demand")
        backup = export_json(client)
        # 手改：追加引用不存在成员/分类的行 → 应跳过而不影响其他行
        backup["data"]["finance_assets"].append({
            "id": 99, "name": "坏行", "direction": "asset", "category": "not_exist",
            "holder_member_id": 99, "institution": "", "amount_cents": 100,
            "status": "holding", "extra": "{}", "note": "", "is_deleted": 0, "user_id": 1,
        })
        r = client.post("/api/v1/finance/import",
                        files={"upload": ("b.json", json.dumps(backup).encode(), "application/json")},
                        data={"mode": "merge"})
        assert r.status_code == 200, r.text
        result = r.json()["data"]
        assert result["skipped"] and result["skipped"][0]["id"] == 99
        assert "外键" in result["skipped"][0]["reason"]
        assert result["warnings"]
        names = [i["name"] for i in client.get("/api/v1/finance/assets").json()["data"]["items"]]
        assert "正常资产" in names and "坏行" not in names


def test_import_zip_slip_rejected() -> None:
    with make_client()[0] as client:
        backup = export_json(client)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("manifest.json", json.dumps(backup))
            zf.writestr("attachments/../../evil.txt", b"x")
        r = client.post("/api/v1/finance/import",
                        files={"upload": ("evil.zip", buf.getvalue(), "application/zip")},
                        data={"mode": "merge"})
        assert r.status_code == 400
        assert "路径不合法" in r.json()["message"]
