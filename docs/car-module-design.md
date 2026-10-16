# 选车模块设计（FamilyAssistant · car）

| 项目 | 内容 |
| --- | --- |
| 版本 | v1.0（实施完成，决策点已全部确认） |
| 日期 | 2026-10-15 |
| 上游输入 | [architecture.md](architecture.md) M3 定位、[ui-design.md](ui-design.md) 全局规范、[finance-module-design.md](finance-module-design.md) 模块设计模式 |
| 状态 | 已全量交付（v0.7.0，实施状态见 §6） |

---

## 1. 模块定位与调研结论

**定位**：家庭购车决策工具——候选车型档案、4S 店报价与落地价测算、跨车型/跨门店双维度对比、实车照片归档。

**业界调研**（汽车之家 / 懂车帝 / 易车）：
- **车型对比**：多车型并排参数矩阵（≤5 款），按"基础信息/动力/配置/安全"分组行头，**差异项高亮**是通用交互；价格体系分"官方指导价 / 经销商报价 / 车主成交价"三层
- **落地价拆解**：业界统一口径 = 裸车价 + 购置税 + 保险（交强+商业）+ 上牌费 + 其他费用（服务费/加装）− 补贴；捆绑收费单列识别
- **购置税规则**（2026 年政策）：计税价格 = 发票价 ÷ 1.13；燃油车税率 10%；新能源车 2026-01-01~2027-12-31 减半征收（**每辆减税额 ≤ 1.5 万元**，即计税价格 > 30 万元时实缴 = 计税 × 10% − 15000）
- **多店比价**：同一城市同车型多门店报价集中展示、优惠幅度与附加条件并排可对比

**开源调研**：
- `buyingacar`（购车谈判方法论）：核心是**多经销商相互竞价**、警惕隐藏费用、报价书面化——支撑"同车型多 4S 报价"的领域模型与联系人字段
- `car-advisor`（AI 对比 Skill）：对比维度分层模板（基础/动力/舒适配置/智驾/安全）与"一句话结论 + 各维度胜出 + 建议"的结论结构可借鉴

**结论**：本模块不追求车型库（零依赖离线约束），聚焦**用户自录候选车的档案与真实报价**，落地价计算口径与业界一致。

---

## 2. 领域模型（migrations/003_car_module.sql）

### 2.1 car_candidates（扩展 M0 现有表）

```sql
ALTER TABLE car_candidates ADD COLUMN guide_price_cents INTEGER;          -- 厂商指导价（分）
ALTER TABLE car_candidates ADD COLUMN features TEXT NOT NULL DEFAULT '[]'; -- 配置特点标签 JSON

-- M0 遗留 price（万元 REAL）一次性迁移后弃用
UPDATE car_candidates
   SET guide_price_cents = CAST(ROUND(price * 1000000) AS INTEGER)
 WHERE price IS NOT NULL AND guide_price_cents IS NULL;
```

保留沿用 M0 列：brand / model / version / year / energy(fuel·ev·hybrid) / mileage / status(watching·test_driving·comparing·dropped·chosen) / score(0~5 一位小数) / pros / cons / notes。

`features` JSON 数组结构（预置常用标签一键添加 + 自定义行）：

```json
[
  {"label": "座位数", "value": "5座"},
  {"label": "抬头显示", "value": "有"},
  {"label": "智驾", "value": "城市NOA"},
  {"label": "零重力按摩座椅", "value": "有"},
  {"label": "空气悬架", "value": "无"}
]
```

### 2.2 car_offers（4S 店报价单，一车型多报价）

```sql
CREATE TABLE IF NOT EXISTS car_offers (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id   INTEGER NOT NULL,
    dealer_name    TEXT    NOT NULL,            -- 4S 店名称
    city           TEXT    NOT NULL DEFAULT '', -- 可选：城市（跨城比价）
    contact        TEXT    NOT NULL DEFAULT '', -- 可选：销售/电话
    offer_date     TEXT    NOT NULL,            -- 报价日期
    discount_items TEXT    NOT NULL DEFAULT '[]', -- 优惠 JSON [{label, amount_cents}]
    fee_items      TEXT    NOT NULL DEFAULT '[]', -- 费用 JSON [{label, amount_cents}]（购置税/保险/上牌/服务费/加装）
    gift_items     TEXT    NOT NULL DEFAULT '[]', -- 赠品 JSON [{label, note}]
    notes          TEXT    NOT NULL DEFAULT '',
    created_at     TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at     TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (candidate_id) REFERENCES car_candidates (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_car_offers_candidate ON car_offers (candidate_id);
```

条目存 JSON 而非子表：条目数量少（单报价 3~10 项）、无跨报价 SQL 聚合需求（落地价在服务层计算）、与理财 `extra` JSON 校验模式一致（白名单 + 类型校验防注入）。

### 2.3 car_photos（实车照片）

```sql
CREATE TABLE IF NOT EXISTS car_photos (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id  INTEGER NOT NULL,
    kind          TEXT    NOT NULL DEFAULT 'other', -- exterior / interior / other
    file_name     TEXT    NOT NULL,
    file_path     TEXT    NOT NULL,                 -- uploads/car/{id}/{uuid}.{ext}
    file_size     INTEGER NOT NULL,
    file_type     TEXT    NOT NULL,                 -- jpg/jpeg/png/webp/heic
    remark        TEXT    NOT NULL DEFAULT '',
    created_at    TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (candidate_id) REFERENCES car_candidates (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_car_photos_candidate ON car_photos (candidate_id);
```

遵循架构硬约束：文件体存本地文件系统（`uploads/car/`），仅元数据入库；类型白名单与大小上限（10MB）沿用理财附件标准；删除车型/照片时级联清理物理文件。

---

## 3. 价格计算规则（服务层统一口径）

| 项 | 规则 |
| --- | --- |
| 优惠合计 | `discount_total_cents = Σ discount_items.amount_cents` |
| 裸车价 | `bare_price_cents = guide_price_cents − discount_total_cents` |
| 费用合计 | `fee_total_cents = Σ fee_items.amount_cents` |
| **落地价** | `total_cents = bare_price_cents + fee_total_cents` |
| 赠品 | 不折价（列表展示，可填备注）；不参与落地价 |
| 最低落地 | 车型维度 `best_total_cents = min(各报价 total_cents)`，无报价时为 null |
| **购置税推算** | `计税 = bare ÷ 1.13`；燃油：`计税 × 10%`；新能源（ev/hybrid）：`计税 × 10% − min(计税 × 5%, 15000)`。仅作**预填参考**（决策点 D1），以 4S 实际报价为准 |

购置税推算随报价返回 `tax_hint_cents`，前端在新增报价时自动预填购置税费用条目，用户可改可删。

---

## 4. 页面与交互（遵循 ui-design.md 组件规范）

### 4.1 车型档案页 `#/car`
- 表格列：品牌 / 车型 / 配置版本 / 能源 / 指导价 / 最低落地价 / 报价数 / 照片数 / 评分 / 状态
- 工具栏：状态筛选、**新增车型**、**加入对比**（复用理财对比篮子模式：行内勾选 + 工具栏计数）
- 行点击 → 详情页；无数据时 placeholderCard

### 4.2 车型详情页 `#/car/detail/:id`（实现采用路径式路由，与查询参数式等效）
- **关键数字**：指导价 / 最低落地价（含"共 N 家报价"）/ 优惠力度最大报价 / 评分 / 平均落地价（有报价时）
- **基本信息**：品牌/车型/版本/年款/能源/里程/状态/备注；优缺点分"优点 / 缺点"两段标签
- **配置特点**：features 标签流展示（label: value）
- **实车照片**：照片墙（按 外观/内饰/其他 分组缩略图），上传弹窗（多选 + 分类 + 备注），点击缩略图 → **lightbox 大图预览**（全屏遮罩、左右翻页、Esc 关闭；ui.js 新增通用 `lightbox(images, index)` 组件，对齐 ui-design.md 文件存档模块"图片直显"预览规范）
- **4S 报价对比**：表（4S 店 / 城市 / 报价日 / 优惠合计 / 裸车价 / 费用合计 / 落地价 / 赠品数 / 备注），**落地价最低行"最优"高亮**；行内编辑/删除；「新增报价」弹窗：动态优惠/费用/赠品条目列表（增删行）、费用条目自动预填购置税推算值
- 操作：编辑车型 / 删除车型（confirmModal，联动清理照片文件）

### 4.3 车型对比页 `#/car/compare`
- 对比篮子（2~6 个车型）→ 服务端组装矩阵（跟随理财 `GET /assets/compare` 模式）
- 矩阵分组行（复用 `compare-matrix` 样式与分组行头）：
  - **基本信息**：品牌/车型/版本/能源/指导价/状态/评分
  - **配置特点**：所选车型 features 标签**并集为行**，各车型列展示值（缺省 `—`），**某车型独有标签整行高亮**（决策点 D3）
  - **费用价格**：最低落地价 / 平均落地价 / 最大优惠 / 报价数
  - **主观评价**：优点 / 缺点
- 矩阵下方"一句话结论"区：最低落地、独有配置差异的自动摘要

### 4.4 状态机
沿用 M0 枚举：`watching → test_driving → comparing → chosen / dropped`，列表可筛选；状态着色沿用理财 statusVariant 模式。

---

## 5. API 清单（/api/v1/car 前缀，统一响应包）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/candidates` | 列表（含 computed：best_total_cents/offer_count/photo_count）；保持 M0 数组响应兼容 |
| POST | `/candidates` | 新增（features JSON 白名单校验） |
| GET | `/candidates/{id}` | 详情（features 解析 + offers 列表 computed + photos 分组） |
| PUT | `/candidates/{id}` | 编辑 |
| DELETE | `/candidates/{id}` | 删除（级联 offers/photos + 清理照片文件） |
| GET | `/candidates/compare?ids=` | 对比矩阵数据（features 并集行服务端组装） |
| POST | `/candidates/{id}/offers` | 新增报价 |
| PUT | `/offers/{offer_id}` | 编辑报价 |
| DELETE | `/offers/{offer_id}` | 删除报价 |
| POST | `/candidates/{id}/photos` | 上传照片（multipart，单文件字段 `upload` + `kind` 独立表单域；前端多选后循环逐张上传） |
| GET | `/photos/{photo_id}/download` | 照片原图（预览/下载共用） |
| DELETE | `/photos/{photo_id}` | 删除照片（含物理文件） |

服务层校验沿用理财模式：金额正整数（分）、枚举白名单、条目 JSON 的 label 长度与金额上限。

---

## 6. 实施切分（单次迭代全量交付）

| 里程碑 | 内容 | 状态 |
| --- | --- | --- |
| **M-car1** | 后端：003 迁移、服务层（CRUD/价格计算/照片文件管理/对比组装）、API、pytest | ✅ 已交付（pytest 41/41 全绿） |
| **M-car2** | 前端：档案页改造、详情页、报价弹窗、对比页、lightbox 组件、icons（star/car 类） | ✅ 已交付（浏览器实测通过） |
| **验证** | pytest 全量 + 浏览器 UI 实测 + 文档更新 + 版本升级（0.6.0 → 0.7.0） | ✅ 完成（v0.7.0） |

---

## 7. 与既有模块的复用

| 复用项 | 来源 |
| --- | --- |
| 附件存储/白名单/大小上限模式 | 理财 finance_attachments |
| 对比篮子交互（勾选/计数/跳转） | 理财台账对比 |
| 对比矩阵分组行头样式 | 理财 compare-matrix |
| 弹窗/表单/表格/toast 组件 | ui.js 全套 |
| 上传（含 fields 扩展） | api.js apiUpload |
| 图片预览降级规范 | ui-design.md 文件存档模块（图片直显） |

---

## 8. 决策点（已全部确认，实现与设计一致）

1. **D1 购置税录入 → 采用 A**：新增报价时按能源类型自动推算并预填购置税条目（可改/可删；优惠变动且预填行未被手改时自动联动刷新）
2. **D2 M0 遗留 price 列（万元 REAL）→ 采用 A**：003 迁移已执行——新增 guide_price_cents 并将旧 price 一次性换算回填（`ROUND(price×1000000)`），新代码不再读写旧列
3. **D3 配置特点对比行 → 采用 A**：全标签并集展示 + 某车型独有行高亮

---

## 9. 缓存与版本化发布策略（v0.7.0 引入）

零构建原生 ESM 前端依赖浏览器 HTTP 缓存，开发中曾出现旧模块文件被长期缓存的问题（M0 占位版 car.js 在浏览器缓存中长期不失效）。本版本起采用两层策略：

1. **入口版本参数**：`index.html` 的 CSS/JS 引用与 `app.js` 的模块导入统一带 `?v=0.7.0`，发布时同步递增，击穿浏览器对旧文件的缓存。
2. **服务端协商缓存**：`main.py` 新增 `static_no_cache` 中间件——非 `/api/` 响应统一输出 `Cache-Control: no-cache`，强制走 ETag 协商（未变更 304 / 已变更即时生效），后续前端文件更新无需用户手动刷新。

> 本次升级用户浏览器需一次硬刷新（Ctrl+F5）加载新入口文件；此后更新自动生效。
