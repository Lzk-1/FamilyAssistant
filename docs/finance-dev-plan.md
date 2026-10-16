# 理财模块 · 开发方案

> 依据：[finance-module-design.md](finance-module-design.md)（已确认的设计）、[architecture.md](architecture.md)（整体架构与迁移机制）、[ui-design.md](ui-design.md)（设计规范）。
> 配套需求：[finance-requirements.md](finance-requirements.md)（FR 编号在本文中引用）。
> 范围：M2a + M2b（见第 10 章实施步骤）；M3（收益分析/导入导出）不在本方案内。
> 状态：**已交付（2026-10-14，v0.2.0）** —— M2a 后端 18 端点 + 18 测试全绿；M2b 前端总览/台账/详情/日历/弹窗/成员管理已交付并通过浏览器端到端验证。

---

## 1. 目标与约束

- 交付"家庭资产台账"能力：成员字典、12 类预置分类的资产/负债登记、总览图表、到期管理、附件归档。
- **零外部依赖**：Python 标准库 + FastAPI + SQLite + 原生前端，不新增任何第三方依赖。
- 兼容约束：沿用统一响应包 `{ok, data}`、错误码规范（4001 参数/4004 资源不存在）、`user_id` 行级预留（M4 再加 `group_id`）。
- 金额一律以**分（integer cents）**存储与传输，前端负责格式化；利率/比例为 REAL 百分数。

## 2. 数据库设计（migrations/002_finance.sql）

迁移机制沿用 `PRAGMA user_version` 版本化执行（M0 已应用到 v1，本迁移为 **v2**）。

```sql
PRAGMA foreign_keys = ON;

-- 清理 M0 占位表（尚无数据，直接删除）
DROP TABLE IF EXISTS finance_accounts;
DROP TABLE IF EXISTS finance_transactions;

-- 家庭成员字典（归属人；M4 时可经 user_id 关联系统账号）
CREATE TABLE IF NOT EXISTS finance_members (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    note       TEXT    NOT NULL DEFAULT '',
    user_id    INTEGER,                          -- 预留：M4 关联 users.id
    is_active  INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 预置资产分类（仅允许停用，不允许新建/改名）
CREATE TABLE IF NOT EXISTS finance_categories (
    code       TEXT PRIMARY KEY,   -- 见 §2.1 编码表
    name       TEXT NOT NULL,
    direction  TEXT NOT NULL,     -- asset / liability
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active  INTEGER NOT NULL DEFAULT 1
);

-- 资产/负债台账（核心实体）
CREATE TABLE IF NOT EXISTS finance_assets (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL,
    direction        TEXT    NOT NULL,               -- asset / liability
    category         TEXT    NOT NULL,               -- 引用 finance_categories.code
    holder_member_id INTEGER NOT NULL,
    institution      TEXT    NOT NULL DEFAULT '',    -- 银行/发行机构/借款人/债权人（交易对手）
    amount_cents     INTEGER NOT NULL,               -- 本金/初始金额（负债为借款总额）
    start_date       TEXT,                           -- YYYY-MM-DD，可空
    end_date         TEXT,                           -- 到期/约定归还日，可空
    annual_rate      REAL,                           -- 年利率 %（NULL = 无息/不适用）
    status           TEXT    NOT NULL DEFAULT 'holding',  -- holding / settled
    settle_action    TEXT,                           -- withdraw / renew / repay / clear
    settled_at       TEXT,
    extra            TEXT    NOT NULL DEFAULT '{}',   -- 分类专属字段 JSON（§2.2）
    note             TEXT    NOT NULL DEFAULT '',
    is_deleted       INTEGER NOT NULL DEFAULT 0,      -- 软删除
    user_id          INTEGER NOT NULL,
    created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (holder_member_id) REFERENCES finance_members (id),
    FOREIGN KEY (user_id)          REFERENCES users (id)
);

-- 价值/市值历史（趋势图与"手动更新市值"数据源）
CREATE TABLE IF NOT EXISTS finance_asset_values (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id    INTEGER NOT NULL,
    value_date  TEXT    NOT NULL,                -- YYYY-MM-DD
    value_cents INTEGER NOT NULL,
    note        TEXT    NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (asset_id) REFERENCES finance_assets (id) ON DELETE CASCADE
);

-- 附件（借据/存单/合同扫描件）
CREATE TABLE IF NOT EXISTS finance_attachments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id   INTEGER NOT NULL,
    file_name  TEXT    NOT NULL,                 -- 展示用原始文件名
    file_path  TEXT    NOT NULL,                 -- 相对 data/uploads/finance 的路径
    file_type  TEXT    NOT NULL,                  -- 扩展名（白名单校验）
    file_size  INTEGER NOT NULL,                 -- 字节
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (asset_id) REFERENCES finance_assets (id) ON DELETE CASCADE
);

-- 操作日志 + 还款记录（event_type=repay 的记录即还款流水）
CREATE TABLE IF NOT EXISTS finance_asset_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id   INTEGER NOT NULL,
    event_type TEXT    NOT NULL,                 -- create / update / value / attachment / settle / repay
    detail     TEXT    NOT NULL DEFAULT '{}',    -- JSON（repay 含 amount_cents / date）
    user_id    INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (asset_id) REFERENCES finance_assets (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_fa_category ON finance_assets (category);
CREATE INDEX IF NOT EXISTS idx_fa_holder   ON finance_assets (holder_member_id);
CREATE INDEX IF NOT EXISTS idx_fa_end_date ON finance_assets (end_date);
CREATE INDEX IF NOT EXISTS idx_fa_deleted  ON finance_assets (is_deleted);
CREATE INDEX IF NOT EXISTS idx_fav_asset   ON finance_asset_values (asset_id, value_date);
CREATE INDEX IF NOT EXISTS idx_fae_asset   ON finance_asset_events (asset_id, created_at);

-- 预置分类种子
INSERT OR IGNORE INTO finance_categories (code, name, direction, sort_order) VALUES
 ('fixed_deposit','银行定期','asset',1),  ('demand','银行活期','asset',2),
 ('wealth','理财产品','asset',3),        ('metal','贵金属','asset',4),
 ('stock','股票基金','asset',5),         ('loan_out','外借（债权）','asset',6),
 ('bond_insurance','国债保险','asset',7),('asset_other','其他资产','asset',8),
 ('mortgage','房贷','liability',9),      ('loan_in','外债（欠款）','liability',10),
 ('credit_card','信用卡/消费贷','liability',11), ('liability_other','其他负债','liability',12);

-- 默认家庭成员
INSERT OR IGNORE INTO finance_members (name, note) VALUES ('本人', '默认成员');
```

### 2.1 分类编码表（前后端共享）

| code | 名称 | direction | 模板 |
| --- | --- | --- | --- |
| fixed_deposit | 银行定期 | asset | §2.2-a |
| demand | 银行活期 | asset | §2.2-b |
| wealth | 理财产品 | asset | §2.2-c |
| metal | 贵金属 | asset | §2.2-d |
| stock | 股票基金 | asset | §2.2-e |
| loan_out | 外借（债权） | asset | §2.2-f |
| bond_insurance | 国债保险 | asset | §2.2-g |
| asset_other | 其他资产 | asset | §2.2-h |
| mortgage | 房贷 | liability | §2.2-i |
| loan_in | 外债（欠款） | liability | §2.2-j |
| credit_card | 信用卡/消费贷 | liability | §2.2-k |
| liability_other | 其他负债 | liability | §2.2-l |

### 2.2 `extra` JSON 键位（按分类模板，后端校验必填项）

| 模板 | extra 键 | 类型 | 说明 |
| --- | --- | --- | --- |
| a 定期 | `deposit_no` `auto_renew`(0/1) | str/int | 存单号、自动转存 |
| b 活期 | `last_update_date` | str | 余额更新日期（amount_cents=当前余额） |
| c 理财 | `risk_level`(R1~R5) `base_rate` | str/real | 风险等级；annual_rate 存业绩基准 |
| d 贵金属 | `variety`(gold/silver/platinum) `form`(physical/paper/accumulate) `quantity` `cost_price_cents` `current_price_cents` | str/str/real/int/int | amount_cents=当前市值 |
| e 股票基金 | `code` `market` `quantity` `cost_cents` | str/str/real/int | amount_cents=当前市值 |
| f 外借 | `repay_method`(once/installment) `relation` | str/str | institution=借款人；还款记录见 events |
| g 国债保险 | （预留空模板） | — | — |
| h 其他资产 | — | — | — |
| i 房贷 | `total_cents` `monthly_payment_cents` `pay_day` | int/int/int(1~28) | amount_cents=剩余本金 |
| j 外债 | `repay_method` `relation` | str/str | institution=债权人 |
| k 信用卡 | `bill_day` `repay_day` `installment`(0/1) | int/int/int | amount_cents=当前欠款 |
| l 其他负债 | — | — | — |

> 已还金额**不落** extra，由 `finance_asset_events` 中 `event_type='repay'` 的记录汇总得出（还款留痕，见 §4.4）。

## 3. 领域计算与状态推导（服务层与前端镜像实现）

### 3.1 有效状态（effective_status，读取时派生，不落库）

```
status = settled            → 已支取/已续存/已还清/已结清（按 settle_action）
status = holding 且无 end_date                    → holding（持有中）
status = holding 且有 end_date：
    借贷类（loan_out/loan_in/credit_card）：end_date < 今天 → overdue（逾期）
    其他：end_date < 今天 → matured（已到期待处理）
    0 < 距到期 ≤ 7 天  → urgent（紧急，橙）
    7 < 距到期 ≤ 30 天 → soon（预告，黄）
    其余 → holding
```

### 3.2 分类计算公式（§2.2 模板对应的展示型"关键数字"）

| 分类 | 公式 |
| --- | --- |
| 定期 | 期限月数 = end_date 与 start_date 的月份差；到期利息 = amount × rate% × 月数/12（四舍五入到分）；到期本息 = amount + 利息 |
| 理财 | 预计收益 = amount × rate% × 持有天数/365；持有天数 = end_date − start_date |
| 贵金属 | 当前市值 = quantity × current_price；浮动盈亏 = 市值 − quantity × cost_price |
| 股票基金 | 浮动盈亏 = amount_cents(市值) − cost_cents；成本单价 = cost_cents / quantity |
| 外借/外债 | 已还 = Σ(repay events)；未还 = amount − 已还；未还=0 时派生"已还清"提示 |
| 房贷 | 剩余期数 ≈ amount_cents(剩余本金) / monthly_payment_cents（展示估算） |

前端弹窗做**同公式的实时预览**；服务端在 detail/overview 接口返回计算结果（`computed` 字段），前端不做台账列表级二次计算。

## 4. API 设计（`/api/v1/finance/*`，挂载于既有 v1 路由）

统一响应包与错误码沿用 core 规范。所有写接口在多用户前（M0 模式）绑定当前 `user_id`。

### 4.1 端点总表（权限：读全员可用，写仅 admin——M4.1，v0.9.2）

| 方法 | 路径 | 说明 | 需求 |
| --- | --- | --- | --- |
| GET | `/finance/categories` | 分类列表（含启用状态） | FR-02 |
| GET | `/finance/members` | 成员列表 | FR-01 |
| POST | `/finance/members` | 新建成员 `{name, note?}` | FR-01 |
| PUT | `/finance/members/{id}` | 改名/备注/停用 | FR-01 |
| GET | `/finance/assets` | 台账列表，筛选：`direction, category, holder_id, status(有效状态), q, group=category`；返回分组小计 | FR-03 |
| POST | `/finance/assets` | 新增（按分类模板校验） | FR-02 |
| GET | `/finance/assets/{id}` | 详情：资产 + computed + values + attachments + events | FR-04 |
| PUT | `/finance/assets/{id}` | 编辑 | FR-02 |
| DELETE | `/finance/assets/{id}` | 软删除（is_deleted=1，events 记录） | FR-03 |
| POST | `/finance/assets/{id}/settle` | 状态流转 `{action: withdraw\|renew\|repay\|clear, amount_cents?, date?, note?}`；repay 追加还款记录 | FR-09 |
| GET | `/finance/assets/{id}/values` | 市值历史 | FR-10 |
| POST | `/finance/assets/{id}/values` | 手动记录市值 `{value_cents, value_date, note?}`（同时写 events） | FR-10 |
| DELETE | `/finance/assets/{id}/values/{vid}` | 删除市值记录（v0.9.2；删最新一条自动回退当前金额，events 留痕） | FR-10 |
| POST | `/finance/assets/batch-delete` | 批量软删除 `{ids: [1..100]}`（v0.9.2；返回 `{deleted, missing}`，逐条 events 留痕） | FR-03 |
| POST | `/finance/assets/{id}/attachments` | 上传附件（multipart/form-data） | FR-05 |
| GET | `/finance/attachments/{id}/download` | 下载（二进制流，`Content-Disposition`） | FR-05 |
| DELETE | `/finance/attachments/{id}` | 删除附件（文件+记录） | FR-05 |
| GET | `/finance/overview` | 总览聚合：totals、by_category、by_member、upcoming(30天)、recent_events | FR-08 |
| GET | `/finance/trend` | 净资产趋势 `?months=12`，按月取各资产月末价值合计 | FR-08 |
| GET | `/finance/calendar` | 到期清单 `?from=&to=`，按三级提醒分组返回 | FR-06/07 |

### 4.2 关键响应示例

`GET /finance/overview`：

```json
{ "ok": true, "data": {
  "totals": { "assets_cents": 123456700, "liabilities_cents": 45000000, "net_cents": 78456700 },
  "by_category": [{ "code": "fixed_deposit", "name": "银行定期", "amount_cents": 61000000, "count": 5 }, "..."],
  "by_member":  [{ "member_id": 1, "name": "本人", "amount_cents": 60000000 }, "..."],
  "upcoming":   [{ "asset_id": 3, "name": "工商银行·3年定期", "category": "fixed_deposit",
                   "end_date": "2026-10-21", "level": "urgent", "amount_cents": 5390000 }],
  "recent_events": [{ "type": "value", "asset_name": "招商银行活期", "summary": "更新余额 ¥12,000", "at": "..." }]
}}
```

`GET /finance/assets/{id}` 中 `computed`：`{ "effective_status": "urgent", "months": 36, "interest_cents": 390000, "maturity_cents": 5390000, "repaid_cents": 0, "remaining_cents": 2000000, "days_to_end": 4 }`（按分类输出适用项）。

### 4.3 校验规则（服务层，`app/services/finance.py`）

- 必填：direction ∈ {asset, liability}、category ∈ 预置且 is_active=1、name 非空 ≤100 字、amount_cents > 0 且 ≤ 10^13、holder_member_id 存在且启用。
- direction 与分类 direction 必须一致；日期格式 `YYYY-MM-DD`，end_date ≥ start_date。
- 各模板必填项按 §2.2（如 fixed_deposit 必须 start_date+end_date+annual_rate；repay_method ∈ {once, installment}）。
- 违规一律 4001，`data.errors` 给出字段级错误列表。

### 4.4 事件与还款留痕

- create/update/settle/repay/value/attachment 六类事件统一写 `finance_asset_events`（detail JSON 摘要），详情页"操作日志"直接读该表。
- `repay`：`settle` 接口 `action=repay` → 校验 amount_cents ≤ 未还金额 → 写 repay 事件 → 若累计已还=本金则提示可 `clear` 结清。
- 软删除保留 events；附件文件随资产删除时**不物理清理**（保守策略，v1 记录在案即可）。

## 5. 附件安全（服务层）

| 项 | 规则 |
| --- | --- |
| 白名单 | jpg / jpeg / png / webp / heic / pdf（按扩展名 + magic bytes 双校验） |
| 大小 | 单文件 ≤ 10 MB；单资产 ≤ 20 个附件 |
| 存储 | `data/uploads/finance/{asset_id}/{uuid4}.{ext}`——文件名服务端生成，杜绝路径穿越 |
| 下载 | 按记录查 file_path，规范化后必须位于 uploads 根内；`file_name` 仅用于展示（`Content-Disposition` 转义） |
| 删除 | 物理删文件 + 删记录，events 留痕 |

## 6. 前端实现

### 6.1 文件布局（沿用零构建 ESM 结构）

```
frontend/assets/js/
├── charts.js                 # 新增：donut()/line()/bar() 原生 SVG 渲染器（ui-design §4.10）
├── ui.js                      # 复用：StatCard/表格/弹窗/标签/Toast/EmptyState
└── pages/finance/
    ├── index.js               # 子路由分发：#/finance|assets|assets/:id|calendar|analytics + 二级 Tab
    ├── overview.js            # 总览（四卡 + donut 双维度 + 趋势线 + 到期/动态列表）
    ├── ledger.js              # 台账（分类侧栏 + 分组表格 + 筛选 + 成员管理入口）
    ├── detail.js              # 详情（关键数字 + 信息 + 市值历史 + 附件 + 日志 + 流转按钮）
    ├── calendar.js            # 到期日历（列表/月历切换 + 行内操作）
    ├── dialog.js              # 新增/编辑弹窗（分类动态模板 + 实时计算预览）
    ├── members.js             # 成员管理弹窗（小号）
    └── common.js              # 分类编码表镜像、金额格式化、三级提醒着色、状态文案
```

### 6.2 路由与交互要点

- 二级导航为模块内 Tab（总览 / 资产台账 / 到期日历 / 收益分析），`#/finance/*` 前缀，与主路由 `#/module/:section` 约定对齐。
- donut 扇区点击携带筛选参数跳转 `#/finance/assets?category=...`（按成员视图带 `holder_id`）。
- 弹窗实时计算：input 事件触发 §3.2 同公式预览（common.js 提供 `computePreview(category, form)`）。
- 附件上传：`XMLHttpRequest`（带进度条 ui 组件）；失败 Toast 展示服务端 `errors`。
- 图表配色：资产类用模块色阶（`--m-finance` 派生 8 阶），负债统一灰色系（ui-design §5.1 约定）。
- 收益分析 Tab v1 渲染占位卡。

## 7. 测试方案

### 7.1 pytest（`tests/test_finance_*.py`）

| 用例组 | 覆盖 |
| --- | --- |
| test_finance_calc | §3.1 状态推导矩阵（overdue/matured/urgent/soon 边界，含 0/7/30 天）；§3.2 公式精度（分四舍五入） |
| test_finance_members | 增改停用；被停用成员不可作为新资产归属人 |
| test_finance_assets | 新增全 12 类模板各 1 例；校验失败 4001 字段级错误；软删除后列表不可见但 detail 4004 |
| test_finance_settle | repay 追加事件与已还汇总；clear 结清后 effective 状态；续存/支取流转 |
| test_finance_overview | totals/by_category/by_member 聚合正确；upcoming 分级；trend 月度序列 |
| test_finance_attachments | 白名单拒绝 exe/超大小；路径穿越防护（构造非法 file_path 访问 4004）；上传-下载-删除闭环 |
| 冒烟回归 | M0 既有用例（system/模块列表/静态）不回归失败 |

### 7.2 手工验收

按 [finance-requirements.md](finance-requirements.md) 第 5 章验收清单逐条走查；浏览器实测总览图表渲染、弹窗实时计算、上传进度与三级提醒着色。

## 8. 配置与部署影响

- 无新增环境变量与第三方依赖；`data/uploads/finance/` 目录随首次上传自动创建，备份边界仍是 `./data` 单目录。
- Docker/compose 无需改动；`start.sh` 无需改动。

## 9. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 金额浮点误差 | 全链路整数分；公式计算统一 `round(x)` 到分 |
| SQLite JSON 无查询能力 | 家庭量级（<10k 行）在服务层逐行 `json.loads`，量级可控 |
| 前端公式与服务端不一致 | 公式集中在 common.js `computePreview` 与服务层 `computed`，测试用同一组数值断言两侧一致 |
| 附件内容安全 | 白名单 + magic bytes + 服务端随机文件名 + 路径规范化校验 |
| 模板字段演化 | extra JSON 向后兼容（新增键不校验旧数据），模板校验仅约束写入时点 |

## 10. 实施步骤（两步交付）

**M2a（首个可用版）**
1. 002 迁移 + models + categories/members API + 测试
2. assets CRUD（含模板校验、computed、软删除）+ 台账页（筛选/分组/成员管理）
3. 新增/编辑弹窗（动态模板 + 实时预览）
4. overview/trend API + 总览页（卡片 + donut 双维度 + 折线图 + charts.js）

**M2b（完整版）**
5. values 市值历史 + 附件上传下载删除 + 详情页
6. calendar + settle 状态流转（续存/支取/登记还款/结清）+ 三级提醒着色
7. 全量测试补齐 + 两份文档状态更新 + README 版本号
