# 选房模块设计（FamilyAssistant · house）

| 项目 | 内容 |
| --- | --- |
| 版本 | v1.0（已实施交付，决策点已全部确认） |
| 日期 | 2026-10-16 |
| 上游输入 | [architecture.md](architecture.md) M3 定位、[ui-design.md](ui-design.md) 全局规范、[car-module-design.md](car-module-design.md) 模块设计模式 |
| 状态 | 已全量交付（v0.8.0，实施状态见 §6） |

---

## 1. 模块定位与调研结论

### 1.1 模块定位

选房模块是 FamilyAssistant 的第三个业务模块（M3 迭代），用于家庭购房决策辅助。核心价值：候选房源档案管理 + 多房综合对比 + 照片归档，帮助家庭在多个候选房源中做出系统化、可追溯的决策。

### 1.2 调研结论摘要

详见调研报告，核心结论：

- **主流平台**（贝壳/安居客/房天下）普遍只有表格对比（贝壳限 4 套并排），缺少综合评分和可视化。
- **开源项目**：无可直接复用的"选房对比"开源项目（现有项目聚焦租房管理）。自研，复用选车模块已验证的架构模式。
- **业界权重共识**：位置交通权重最高（0.25），配套资源次之（0.20），学区是配套中最重要的稀缺资源。
- **评分方法**：学术界主推 AHP 层次分析法，但太重不适合离线家庭助手。采用简化版多因素加权评分（0~5 分制，与选车一致）。
- **配套设施**：采用"文本标注 + 量化距离"结合（学区梯队枚举、地铁步行分钟数自动评级、商场/医院名称+距离）。不做自动 POI 查询（离线约束）。

---

## 2. 领域模型（migrations/004_house_module.sql）

### 2.1 house_candidates（扩展 M0 现有表）

```sql
-- 价格统一为分（与全平台口径一致，决策点 D2）
ALTER TABLE house_candidates ADD COLUMN total_price_cents INTEGER;   -- 总价（分）
ALTER TABLE house_candidates ADD COLUMN unit_price_cents  INTEGER;   -- 单价（分/㎡）
ALTER TABLE house_candidates ADD COLUMN features   TEXT NOT NULL DEFAULT '[]'; -- 配套设施标签 JSON
ALTER TABLE house_candidates ADD COLUMN dim_scores TEXT NOT NULL DEFAULT '{}'; -- 六维度评分 JSON（决策点 D5）

-- M0 遗留 total_price/unit_price（REAL 万元/元/㎡）一次性换算迁移后弃用
UPDATE house_candidates
   SET total_price_cents = CAST(ROUND(total_price * 1000000) AS INTEGER)
 WHERE total_price IS NOT NULL AND total_price_cents IS NULL;
UPDATE house_candidates
   SET unit_price_cents = CAST(ROUND(unit_price * 100) AS INTEGER)
 WHERE unit_price IS NOT NULL AND unit_price_cents IS NULL;
```

保留沿用 M0 列：title / community / city / district / area(㎡) / layout(户型) / floor_info / orientation / build_year / metro / status(watching·visiting·comparing·dropped·chosen) / score(0~5 一位小数，手动兜底) / pros / cons / notes。

`dim_scores` JSON——六维度评分（决策点 D5，键限 6 维度、值 0~5 整数、允许部分评分）：

```json
{"location": 4, "facilities": 5, "price": 3, "layout": 4, "quality": 3, "liquidity": 4}
```

新增 `features` JSON 数组——配套设施标签（预置常用标签一键添加 + 自定义行）：

```json
[
  {"label": "学区", "value": "对口实验小学（一梯队）"},
  {"label": "地铁", "value": "步行 8 分钟"},
  {"label": "商场", "value": "万达广场 1.2km"},
  {"label": "医院", "value": "三甲 15 分钟车程"},
  {"label": "南北通透", "value": ""},
  {"label": "满五唯一", "value": ""}
]
```

> **设计决策**：配套设施统一用 `features` JSON 标签管理（与选车模块一致），而非拆成独立列。理由：① 标签数量可变、用户自定义灵活；② 对比矩阵直接用标签并集做行、与选车对比逻辑完全复用；③ 避免大量稀疏列。价格/面积/楼层/朝向/户型等结构化字段保留独立列（用于排序和筛选）。

### 2.2 house_photos（房源照片）

```sql
CREATE TABLE IF NOT EXISTS house_photos (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id  INTEGER NOT NULL,
    kind          TEXT    NOT NULL DEFAULT 'other',   -- exterior / interior / layout / other
    file_name     TEXT    NOT NULL,
    file_path     TEXT    NOT NULL,                    -- uploads/house/{id}/{uuid}.{ext}
    file_size     INTEGER NOT NULL,
    file_type     TEXT    NOT NULL,                     -- jpg/jpeg/png/webp/heic
    remark        TEXT    NOT NULL DEFAULT '',
    created_at    TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (candidate_id) REFERENCES house_candidates (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_house_photos_candidate ON house_photos (candidate_id);
```

`kind` 枚举：`exterior`（外观/小区环境）/ `interior`（室内实拍）/ `layout`（户型图）/ `other`。

文件体存本地 `uploads/house/{candidate_id}/`，仅元数据入库（架构硬约束）。图片白名单 + 内容特征双校验 + 10MB 上限 + 24 张/房源上限（沿用选车模块标准）。

> **不设看房记录子表**：调研显示看房记录的"带看人/印象评分"等功能使用频率低、且 `notes` + `pros`/`cons` + `score` 字段已覆盖主观评价需求。保持模型精简，后续有需求时再扩展。

### 2.3 house_scoring_config（评分权重配置，决策点 D5）

```sql
CREATE TABLE IF NOT EXISTS house_scoring_config (
    user_id    INTEGER PRIMARY KEY,
    weights    TEXT    NOT NULL,   -- JSON {location:25, facilities:20, ...}，合计 100
    updated_at TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);
```

默认权重（业界共识，未配置时的兜底值）：区位交通 25 / 配套资源 20 / 价格性价比 20 / 户型产品 15 / 楼盘品质 10 / 流通性 10。

---

## 3. 价格计算规则（服务层统一口径）

| 项目 | 口径 |
| --- | --- |
| 总价 | 用户录入万元，转分存储（×1,000,000） |
| 单价 | 用户录入元/㎡，转分存储（×100） |
| 面积 | ㎡ 直接 REAL 存储（非金额，不转分） |
| 单价推算 | 若用户只填总价和面积，`unit_price_cents = round(total_price_cents / area)`，可手改 |
| 总价推算 | 若用户只填单价和面积，`total_price_cents = round(unit_price_cents × area)`，可手改 |
| 对比展示 | 万元为单位展示总价（÷10,000），元/㎡ 展示单价（÷100） |

---

## 4. 页面与交互（遵循 ui-design.md 组件规范）

### 4.1 房源档案页 `#/house`

- 表格列：小区 / 城市·区域 / 户型 / 面积 / 楼层 / 朝向 / 总价(万) / 单价(元/㎡) / 照片数 / 评分 / 状态
- 工具栏：状态筛选、**新增房源**、**加入对比**（复用选车对比篮子模式：行内勾选 + 工具栏计数）
- 行点击 → 详情页；无数据时 placeholderCard

### 4.2 房源详情页 `#/house/detail/:id`

- **关键数字**：总价(万) / 单价(元/㎡) / 面积(㎡) / 评分
- **基本信息**：小区/城市/区域/户型/面积/楼层/朝向/建筑年代/状态/备注；优缺点分"优势 / 劣势"两段标签
- **配套设施**：features 标签流展示（label: value）
- **房源照片**：照片墙（按 外观/室内/户型图/其他 分组缩略图），上传弹窗（多选 + 分类 + 备注），点击缩略图 → **lightbox 大图预览**（复用 ui.js `lightbox` 组件）
- **操作**：编辑房源 / 删除房源（confirmModal，联动清理照片文件）

### 4.3 房源对比页 `#/house/compare`

- 对比篮子（2~6 个房源）→ 服务端组装矩阵
- 矩阵分组行（复用 `compare-matrix` 样式与分组行头）：
  - **基本信息**：小区/城市/区域/户型/面积/楼层/朝向/建筑年代/状态/评分
  - **价格信息**：总价(万) / 单价(元/㎡)
  - **配套设施**：所选房源 features 标签**并集为行**，各房源列展示值（缺省 `—`），**某房源独有标签整行高亮**（决策点 D3）
  - **主观评价**：优势 / 劣势
- 矩阵下方"一句话结论"区：最低总价、最低单价、独有配置差异的自动摘要

### 4.4 状态机

沿用 M0 枚举：`watching → visiting → comparing → chosen / dropped`，列表可筛选；状态着色沿用 statusVariant 模式。

---

## 5. API 清单（/api/v1/house 前缀，统一响应包）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/candidates` | 列表（含 computed：photo_count）；保持 M0 数组响应兼容 |
| POST | `/candidates` | 新增（features JSON 白名单校验） |
| GET | `/candidates/{id}` | 详情（features 解析 + photos 分组 computed） |
| PUT | `/candidates/{id}` | 编辑 |
| DELETE | `/candidates/{id}` | 删除（级联 photos + 清理照片文件） |
| GET | `/candidates/compare?ids=` | 对比矩阵数据（features 并集行服务端组装） |
| POST | `/candidates/{id}/photos` | 上传照片（multipart，单文件字段 `upload` + `kind` 独立表单域；前端多选后循环逐张上传） |
| GET | `/photos/{photo_id}/download` | 照片原图（预览/下载共用） |
| DELETE | `/photos/{photo_id}` | 删除照片（含物理文件） |
| GET | `/scoring-config` | 读取评分权重（未配置时返回默认值 + is_default 标记） |
| PUT | `/scoring-config` | 保存权重（6 维度键齐全、值 0~100 整数、合计 100，决策点 D5） |

服务层校验沿用理财/选车模式：金额正整数（分）、枚举白名单、条目 JSON 的 label 长度与金额上限。

---

## 6. 实施切分（单次迭代全量交付）

| 里程碑 | 内容 | 状态 |
| --- | --- | --- |
| **M-house1** | 后端：004 迁移、服务层（CRUD/价格换算/照片文件管理/对比组装/加权评分/权重配置）、API、pytest | ✅ 已交付（47/47） |
| **M-house2** | 前端：档案页改造、详情页、对比页、权重设置弹窗、lightbox 复用、icons（sliders） | ✅ 已交付 |
| **验证** | pytest 全量 + 浏览器 UI 实测 + 文档更新 + 版本升级（0.7.0 → 0.8.0） | ✅ v0.8.0 |

---

## 7. 与既有模块的复用

| 复用项 | 来源 |
| --- | --- |
| 候选档案 + 对比篮子交互 | 选车模块 car（勾选/计数/跳转/清除） |
| 对比矩阵分组行头样式 | 选车/理财 compare-matrix |
| features 标签弹窗（预置 + 自定义行） | 选车模块 dialog.js |
| 照片上传/预览/lightbox | 选车模块 detail.js + ui.js lightbox |
| 弹窗底部动作条 `.fa-dialog-actions` | 选车模块本会话修复 |
| 图片白名单/大小上限/路径安全 | 理财 finance_attachments |
| 上传 apiUpload | api.js |
| 按钮 variant 选用规范 | ui-button-flex-spacing 技能 |

---

## 8. 决策点

1. **D1 配套设施存储方式**：A. 统一用 `features` JSON 标签管理（与选车一致，对比矩阵直接复用并集逻辑）【推荐】；B. 拆成独立列（学区/地铁/商场/医院各自一列）
2. **D2 M0 遗留价格列（REAL 万元/元㎡）**：A. 一次性迁移到 `total_price_cents`/`unit_price_cents`（分）后弃用旧列【推荐，与全平台"分"口径一致】；B. 保留 REAL 口径双轨
3. **D3 配套设施对比行**：A. 全标签并集展示 + 某房源独有行高亮【推荐，与选车一致，信息完整】；B. 仅展示差异行（更紧凑）
4. **D4 看房记录子表**：A. 不设子表，主观评价用 `pros`/`cons`/`score`/`notes` 字段覆盖【推荐，模型精简】；B. 新增 `house_visits` 子表记录每次看房时间线
5. **D5 评分体系**：A. 暂不实现自动加权评分，用户手动打总分（0~5 分，与选车一致）；B. 实现多维度加权评分 + **用户可自定义权重**（预设业界权重默认值 + 权重设置 UI）

> D1~D4 按推荐方案实施。**D5 经用户确认选择 B**——实现六维度加权评分，权重支持用户手动调整（对比页「权重设置」弹窗，合计 100 校验）。
>
> **评分模型**（已交付）：
> - 六维度：区位交通 25 / 配套资源 20 / 价格性价比 20 / 户型产品 15 / 楼盘品质 10 / 流通性 10（默认权重 = 业界共识）
> - 输入侧：编辑房源时按维度打分（0~5 整数，可部分评分）
> - 计算口径：加权总分 = Σ(维度得分 × 权重) ÷ **已评维度权重之和**（部分维度未评时权重归一化，避免未评维度拉低总分），一位小数
> - 权重存储：`house_scoring_config` 表（每用户一行 JSON），PUT 校验 6 键齐全、0~100 整数、合计 100
> - 展示侧：详情页维度评分卡片（含各维权重）+ 对比页维度评分分组行（label 附权重%）+ 加权总分行（最高标「最优」）
> - 手动 `score` 字段保留为兜底展示（无维度评分时显示手动分）

---

## 9. 预置配套设施标签

参考业界调研结论，预置以下常用标签（弹窗一键添加，支持自定义行）：

| 标签 | 建议填写内容 | 调研依据 |
| --- | --- | --- |
| 学区 | 对口学校名称 + 梯队（如"实验小学 一梯队"） | 配套最重要稀缺资源 |
| 地铁 | 步行分钟数（如"步行 8 分钟"） | ≤10分钟优秀，刚需核心指标 |
| 商场 | 名称 + 距离（如"万达广场 1.2km"） | 3km 内大型综合体 |
| 医院 | 名称 + 车程（如"市三甲 15 分钟车程"） | 10-15 分钟黄金距离 |
| 幼儿园 | 距离（如"步行 5 分钟"） | 有娃家庭权重高 |
| 南北通透 | 留空表示"有" | 户型核心指标 |
| 满五唯一 | 留空表示"是" | 交易税费相关 |
| 电梯 | 留空表示"有" | 楼层相关配套 |
| 车位 | 留空表示"有" | 改善型需求 |

---

## 10. 调研来源

- 贝壳找房/安居客/房天下平台对比功能调研
- 克而瑞「保值力」测评体系（2026 年中国住宅项目保值力研究报告）
- "好房子"评测七大核心维度（地产爱网站）
- "5+1 要素"房产价值公式（城市更新局）
- "12 指标"通用评估体系（七七说数据）
- AHP 层次分析法在购房决策中的应用（杨波 2008、邓泽喜 2009、舒孝珍 2023）
- 开源项目：房适 Right-House / real-estate-management / findHouses
