# 家庭助手 FamilyAssistant — 整体框架方案设计文档

| 项目 | 内容 |
| --- | --- |
| 版本 | v0.1（M0 框架阶段） |
| 日期 | 2026-10-14 |
| 状态 | 已评审 / 实施中 |
| 技术栈 | Python 3 + FastAPI + SQLite + 原生 HTML/JS |
| 部署形态 | 单机（默认）/ Docker / 云服务器（预留） |

---

## 1. 项目背景与目标

面向个人或小团队的"家庭事务一站式管理"平台，覆盖五个高频家庭场景：

1. **理财** —— 家庭资产、收支流水、预算与储蓄目标
2. **选房** —— 候选房源档案、看房记录、多维度对比评估
3. **选车** —— 候选车型档案、参数对比、持有成本评估
4. **备忘录** —— 家庭待办、提醒与共享笔记
5. **文件存档** —— 家庭证件、合同、票据等文件的集中归档

### 1.1 核心目标

| 目标 | 含义 |
| --- | --- |
| **单机部署** | 一条命令启动，一个进程承载全部功能，无任何外部基础设施 |
| **零外部依赖** | 不依赖 MySQL/Redis/消息队列/对象存储等外部服务；数据库内嵌（SQLite）、文件本地化存储 |
| **跨平台运行** | Windows / macOS / Linux 原生运行（纯 Python，路径全部使用 `pathlib`），同时提供容器化运行方式 |
| **预留多团队协作** | 数据模型自第一天起携带 `user_id`、角色与令牌表结构，认证开关可切换 |
| **预留云服务器部署** | 配置遵循 12-Factor（环境变量注入）、无状态代码 + 数据卷分离、提供 Dockerfile，可平滑迁移上云 |

### 1.2 "零外部依赖"的边界定义

- **基础设施层面零依赖**：不安装任何独立数据库/缓存/存储/队列服务，`data/` 目录即全部状态（可整目录备份/迁移）。
- **Python 包层面最小依赖**：仅 `fastapi`、`uvicorn`、`python-multipart` 三个运行时包（文件上传所需）。密码散列使用标准库 `hashlib.pbkdf2_hmac`，不引入 passlib；数据访问使用标准库 `sqlite3`，不引入 ORM。
- 若未来需要"纯标准库"运行形态，Web 层是唯一薄适配层（`api/` 路由层），可按分层契约整体替换。

---

## 2. 设计原则

1. **单机优先，云端预留**：所有默认值面向"下载即用"；云端差异仅通过配置与环境变量体现，不改代码。
2. **模块化与注册表机制**：五个业务模块相互独立，通过"模块注册表"登记；新增模块 = 建表 + service + router + 注册 + 前端页面，五步接入。
3. **分层清晰**：路由层（协议适配）→ 服务层（业务逻辑）→ 存储层（SQLite/文件），单向依赖，便于测试与替换。
4. **约定优于配置**：统一响应包、统一错误码、统一表结构约定（`id`/`user_id`/`created_at`/`updated_at`）。
5. **演进式架构**：M0 只搭框架不做业务细节，每个模块按路线图迭代填充，接口契约保持向后兼容（`/api/v1` 版本化）。

---

## 3. 技术选型

### 3.1 后端框架对比

| 方案 | 优势 | 劣势 | 结论 |
| --- | --- | --- | --- |
| **FastAPI + uvicorn**（选定） | 业界主流、类型安全、自动生成 OpenAPI 文档（利于未来团队协作）、原生异步、云端部署路径成熟（uvicorn/gunicorn/Docker） | 需 pip 安装 | **选定**：生态与"云端预留"目标最匹配 |
| Flask + waitress | 简单 | 无自动文档、异步弱、Blueprint 组织力一般 | 备选 |
| Django | 全家桶 | 依赖重、与"轻量单机"目标冲突 | 排除 |
| 纯标准库 http.server | 真零包依赖 | 非主流实践、生产化能力弱、开发效率低 | 仅作为极端降级方案保留在分层设计里 |

### 3.2 数据库选型

- **选定 SQLite（标准库 `sqlite3`）**：单文件、零运维、跨平台、随 Python 附带。
- 开启 **WAL 模式**提升并发读性能；每请求独立短连接，规避多线程问题。
- **约束与迁移路径**：SQLite 单写者特性限制多实例水平扩展。上云初期采用"单实例 + 数据卷"即可满足家庭/小团队规模；当需要多实例时，按存储层契约将 SQLite 替换为 PostgreSQL（表结构与 SQL 高度兼容，迁移成本低）。

### 3.3 前端形态选型

- **选定：无构建步骤的原生 SPA**（HTML + 原生 ES Module JS + 手写 CSS）。
- 理由：与"零外部依赖、跨平台"强一致——无需 Node.js/npm 工具链；后端 `StaticFiles` 直接托管，单进程即全栈。
- 参考业界自托管开源项目（Meali、Grocy、Trilium Notes）的演进路径：M0~M2 保持无构建；若模块交互复杂度显著上升，再引入 Vue 3 + Vite 的构建方案，前后端通过已定型的 `/api/v1` 契约解耦，互不影响。

### 3.4 参考的开源实践

- **Meali / Grocy**：单机自托管、SQLite 默认、Docker 可选的部署形态。
- **Firefly III**：理财域建模（账户/交易/分类）与预算管理思路。
- **Trilium Notes**：单进程承载 API + 静态前端、数据目录整体备份的运维思路。

---

## 4. 总体架构

### 4.1 架构图

```
┌─────────────────────────────────────────────────────────────┐
│                        浏览器（跨平台）                        │
│   原生 SPA：路由壳 + 模块页面（理财/选房/选车/备忘录/文件存档）   │
└───────────────────────────┬─────────────────────────────────┘
                            │  HTTP (同源，JSON 统一响应包)
┌───────────────────────────▼─────────────────────────────────┐
│              单进程 FastAPI（uvicorn，默认 127.0.0.1:8300）      │
│                                                             │
│  ┌────────────── API 层 /api/v1 ──────────────┐             │
│  │ system │ finance │ house │ car │ memo │ files │  ← 模块注册表│
│  └─────┬────────────────────────────────┬─────┘             │
│        │          服务层（业务逻辑）         │                   │
│        │  统一鉴权(deps) · 错误处理 · 配置(core) │              │
│  ┌─────▼────────────────────────────────▼─────┐             │
│  │               存储层（core.database）          │             │
│  └─────┬────────────────────────────────┬─────┘             │
└────────┼────────────────────────────────┼───────────────────┘
         ▼                                ▼
   data/family_assistant.db         data/uploads/
   （SQLite，WAL 模式）              （文件存档，按模块子目录）
   data/ 即全部状态 → 整目录备份/迁移即完成数据安全
```

### 4.2 分层职责

| 层 | 位置 | 职责 | 规则 |
| --- | --- | --- | --- |
| 前端展示层 | `frontend/` | 导航、页面渲染、API 调用 | 不含业务规则 |
| API 路由层 | `backend/app/api/v1/` | 参数解析、调用服务、组装响应 | 不写 SQL |
| 业务服务层 | `backend/app/services/` | 业务规则、数据读写编排 | 不感知 HTTP |
| 核心基础设施 | `backend/app/core/` | 配置、数据库/迁移、认证、错误、模块注册 | 横切关注点 |
| 存储层 | `data/`（SQLite + 文件目录） | 持久化 | 运行时生成，不入库 |

### 4.3 请求流程（以"备忘录列表"为例）

```
浏览器 hash 路由 #/memo
  → modules/memo.js 调用 apiGet('/memo/memos')
  → FastAPI router: GET /api/v1/memo/memos
  → deps: 打开 SQLite 连接 → get_current_user（M0 返回默认 admin）
  → services/memo.list_memos(conn)
  → 统一响应包 {code:0, message:"ok", data:[...]}
  → 前端渲染表格 / 空状态
```

### 4.4 静态资源缓存策略（v0.7.0 引入）

零构建前端依赖浏览器 HTTP 缓存，采用「入口版本参数 + 服务端协商缓存」两层策略（详见 docs/car-module-design.md §9）：

- `main.py` `static_no_cache` 中间件：非 `/api/` 响应统一输出 `Cache-Control: no-cache`，走 ETag 协商（未变更 304 / 已变更即时生效）。
- 入口引用带版本参数（`?v=0.7.0`，发布时递增）：`index.html` 的 CSS/JS 与 `app.js` 的模块导入。
- 首次升级需一次硬刷新（Ctrl+F5）；此后前端文件更新无需用户手动刷新。

---

## 5. 模块设计

### 5.1 模块注册表（可扩展机制）

`backend/app/core/registry.py` 维护模块清单（key/名称/路径/描述），`GET /api/v1/system/modules` 对外暴露，**前端导航由该接口动态驱动**。新增模块只需登记一条记录，前后端自动感知。

### 5.2 五个业务模块概要

| 模块 | 定位 | 核心实体（M0 已建表） | 计划 API 前缀 | M0 状态 |
| --- | --- | --- | --- | --- |
| 理财 finance | 家庭资产与收支全景 | `finance_accounts` 账户、`finance_transactions` 流水 | `/api/v1/finance` | 列表接口通、写接口占位 |
| 选房 house | 房源档案与对比决策 | `house_candidates` 候选房源（价格分制/面积/户型/朝向/配套标签/六维度评分/优劣势/状态）+ `house_photos` 房源照片（户型图/外观/室内，004 扩展）+ `house_scoring_config` 加权评分权重配置 | `/api/v1/house` | 已全量交付（v0.8.0） |
| 选车 car | 车型档案与对比决策 | `car_candidates` 候选车型（品牌/能源/指导价/配置特点/里程/评分/状态）+ `car_offers` 4S 报价 + `car_photos` 实车照片（003 扩展） | `/api/v1/car` | 已全量交付（v0.7.0） |
| 备忘录 memo | 家庭待办与提醒 | `memos`（优先级/状态/截止时间/标签/置顶） | `/api/v1/memo` | 同上 |
| 文件存档 files | 家庭文件集中归档 | `file_records`（原名/存储路径/大小/类型/SHA256/分类） | `/api/v1/files` | 同上（上传依赖 python-multipart 已就绪） |

每个模块的详细领域模型（字段字典、枚举值、页面布局、计算规则）在各自迭代（M1~M3）时以附录文档补充，M0 仅固化表结构与模块边界。

### 5.3 系统模块 system

- `GET /api/v1/system/health`：健康检查（状态/版本/模块数）
- `GET /api/v1/system/modules`：模块注册表
- `GET /api/v1/system/stats`：数据统计（M1+，逐表计数）

---

## 6. 数据库设计

### 6.1 表清单（001 初始化；002 理财；003 选车；004 选房；005 多用户，扩展行内标注）

| 表 | 用途 | 关键字段 |
| --- | --- | --- |
| `users` | 登录账号（005 增列 must_change_password） | username、password_hash、display_name、role(admin/member)、is_active、must_change_password |
| `sessions` | 登录会话（005 新增，只存 token 的 SHA-256 哈希） | token_hash、user_id、expires_at（绝对 30 天）、last_active_at（滑动 14 天）、user_agent |
| `finance_accounts` | 理财账户 | user_id、name、type、currency、initial_balance |
| `finance_transactions` | 收支流水 | account_id、kind(income/expense/transfer)、category、amount、occurred_at |
| `house_candidates` | 候选房源 | title、community、city、district、area(㎡)、layout、floor_info、orientation、build_year、total_price_cents/unit_price_cents(004 分制)、features(004 配套标签 JSON)、dim_scores(004 六维评分 JSON)、status、score、pros/cons |
| `house_photos` | 房源照片元数据（004 新增，文件体存 `uploads/house/`） | candidate_id、kind(exterior/interior/layout/other)、file_path、file_size、file_type、remark |
| `house_scoring_config` | 加权评分权重配置（004 新增，每用户一行） | user_id、weights(JSON：6 维度 0~100 合计 100) |
| `car_candidates` | 候选车型 | brand、model、energy(fuel/ev/hybrid)、guide_price_cents(分)、features(003)、mileage、status、score |
| `car_offers` | 4S 店报价单（003 新增） | candidate_id、dealer_name、city、offer_date、discount_items/fee_items/gift_items(JSON) |
| `car_photos` | 实车照片元数据（003 新增，文件体存 `uploads/car/`） | candidate_id、kind(exterior/interior/other)、file_path、file_size、file_type、remark |
| `memos` | 备忘录 | title、content、priority、status、due_at、tags、pinned |
| `file_records` | 文件元数据 | original_name、stored_path、size、mime_type、sha256、category |

**通用约定**：`id` 自增主键；`user_id` 记录创建者（M4 起写入真实操作者，用于审计；数据归属为全家庭共享，见 §8.4）；`created_at`/`updated_at` ISO 时间戳；命名蛇形复数；金额统一 REAL + CNY（M1 引入精度处理策略）。

### 6.2 迁移机制

- 采用 **版本化 SQL 文件** `backend/migrations/NNN_desc.sql` + SQLite 原生 `PRAGMA user_version` 记录已应用版本。
- 应用启动时由 `core.database` 自动比对并顺序执行未应用的迁移（幂等，`CREATE TABLE IF NOT EXISTS`）。
- 新迁移文件在 `migrations/` 中追加，禁止修改历史迁移。

---

## 7. 接口规范

- 风格：REST + JSON；前缀 `/api/v1`（向后兼容靠版本升级）。
- **统一成功响应包**：`{"code": 0, "message": "ok", "data": ...}`
- **统一错误响应包**：`{"code": <业务错误码>, "message": "<可读信息>", "data": null}`
- 错误码段：`0` 成功；`4xxx` 客户端错误（4001 参数/4004 不存在）；`5xxx` 服务端错误；`5011` 模块建设中（M0 写接口占位）。
- 文件上传：`multipart/form-data`（python-multipart）。

---

## 8. 认证与多用户设计（M4 已交付，v0.9.0）

完整设计（决策点 D1~D7、API 清单、测试要点）见 `docs/multi-user-module-design.md`。

### 8.1 两种形态

| 形态 | 触发条件 | 行为 |
| --- | --- | --- |
| **单机免登录（默认）** | `FA_AUTH_ENABLED=false` | `get_current_user` 旁路返回内置 admin，接口无需登录与 CSRF 头，与 M0 行为完全一致（回归零风险） |
| **多用户认证** | `FA_AUTH_ENABLED=true` | Cookie 会话认证 + admin/member 两档角色 + 全家庭共享数据 |

内置账号 `admin / admin123`（001 占位弱口令）：启用认证后首登**强制改密**——005 迁移按弱口令哈希指纹精确匹配置 `must_change_password=1`，前端渲染不可跳过的改密视图；admin 建号/重置密码的初始密码同样要求首登改密。

### 8.2 会话机制（005_multi_user.sql）

- **opaque token**（`secrets.token_urlsafe(32)`，256bit 熵）→ HttpOnly Cookie `fa_session`（SameSite=Lax、Path=/；HTTPS 部署附加 Secure；Max-Age 30 天）
- `sessions` 表**只存 token 的 SHA-256 哈希**（泄库不可逆推）；登录签发新 token（会话固定防护）
- **双限过期（OWASP）**：空闲 14 天滑动续期（`last_active_at`，1 小时节流避免每请求写库）+ 绝对 30 天上限（`expires_at` 不可续）
- **CSRF 双保险**：SameSite=Lax + 写方法强制 `X-Requested-With: XMLHttpRequest`（缺失 → 403；GET 无副作用不校验；`/auth/login` 豁免）

### 8.3 密码哈希与弱口令治理

- 现行格式 `pbkdf2_sha256$600000$salt$hash`（OWASP 现行轮数）；旧 260k 三段式登录时**透明升级**（verify 返回 needs_rehash，Django 同款机制）
- 本人改密吊销其他设备会话；admin 重置密码吊销目标成员全部会话
- **三条铁律**：① id=1 首管理员不可禁用/降级；② 最后一个活跃 admin 不可禁用/降级（深度防御）；③ 成员只软禁用（`is_active=0`，会话即时吊销）不物理删除——保护业务表 `user_id` 外键引用

### 8.4 数据归属与权限

- **D1 全家庭共享**：读查询不做 `user_id` 过滤（全员可见可编辑）；写入记录真实操作者 `user_id`（审计）；例外：`house_scoring_config` 评分权重按用户隔离（个人偏好）
- 两档固定角色（无自定义 RBAC）：admin 管成员（建号/编辑/禁用/重置密码），member 仅业务功能；成员管理接口越权一律 403
- 认证模式错误码：`4001` 未认证（401）、`4003` 权限不足/CSRF 拦截（403）；前端 401 钩子统一回登录视图

---
## 9. 配置管理

单机**零配置可启动**（全部有默认值）；云端通过 `FA_` 前缀环境变量覆盖（12-Factor）：

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `FA_HOST` | `127.0.0.1` | 监听地址（云部署改 `0.0.0.0`） |
| `FA_PORT` | `8300` | 监听端口 |
| `FA_DEBUG` | `false` | 调试模式 |
| `FA_DATA_DIR` | `<项目>/data` | 数据目录（DB + 上传文件） |
| `FA_AUTH_ENABLED` | `false` | 认证开关：`false` 单机免登录（默认，行为与 M0 一致）；`true` 启用 Cookie 会话认证（内置 admin 首登强制改密，见第 8 节） |
| `FA_SECRET_KEY` | 占位值 | 预留密钥（会话为服务端 opaque 存储，未参与签名；生产环境仍建议修改） |
| `FA_CORS_ORIGINS` | 空 | 跨域白名单（前后端分离部署时使用） |

---

## 10. 部署形态

| 形态 | 方式 | 说明 |
| --- | --- | --- |
| 本机直接运行 | `scripts/start.sh` / `start.bat` | 自动建 venv、装依赖、启动；日常使用推荐 |
| 开发模式 | `uvicorn main:app --reload --app-dir backend` | 热重载 |
| 容器化 | `docker compose up -d` | 提供 Dockerfile/compose；`./data` 挂载为卷，即全部持久化状态 |
| 云服务器 | Docker 或 systemd + uvicorn | `FA_HOST=0.0.0.0` + HTTPS 反代（Nginx/Caddy）+ 数据卷快照备份 |
| 未来多实例 | 存储层切换 PostgreSQL | SQLite 单写者限制多实例；分层契约保证替换成本集中在 `core.database` |

**备份策略**：`data/` 目录 = 完整状态。停止进程后整目录复制即完成备份（SQLite 单文件 + 上传目录）。

---

## 11. 目录结构

```
FamilyAssistant/
├── docs/
│   └── architecture.md            # 本设计文档
├── backend/
│   ├── main.py                    # 入口：create_app 工厂 + uvicorn 启动
│   ├── requirements.txt           # 运行时依赖（仅 3 个包）
│   ├── requirements-dev.txt       # 测试依赖
│   ├── migrations/
│   │   └── 001_init.sql           # 初始 schema（PRAGMA user_version 版本化）
│   ├── app/
│   │   ├── core/                  # 配置 / 数据库与迁移 / 错误 / 安全 / 模块注册 / 响应包
│   │   ├── api/
│   │   │   ├── deps.py            # 请求级依赖：DB 连接、当前用户
│   │   │   └── v1/                # system + 5 个业务模块路由（写接口 501 占位）
│   │   └── services/              # 5 个业务模块服务层（M0 提供列表查询，业务逻辑迭代补充）
│   └── tests/
│       └── test_system.py        # 健康检查与模块注册表接口测试
├── frontend/
│   ├── index.html                 # SPA 壳（侧边导航 + 视图容器）
│   └── assets/
│       ├── css/main.css
│       └── js/
│           ├── app.js             # hash 路由 + 导航装配
│           ├── api.js             # 统一 API 客户端（解包响应包）
│           ├── ui.js              # DOM/表格/空状态工具
│           └── modules/           # finance/house/car/memo/files 五个页面模块
├── scripts/
│   ├── start.sh                   # Linux/macOS 启动
│   └── start.bat                  # Windows 启动
├── data/                          # 运行时状态（git 忽略）：SQLite + uploads/
├── Dockerfile / docker-compose.yml / .dockerignore
├── .gitignore
└── README.md
```

---

## 12. 实施路线图

| 里程碑 | 内容 | 交付 |
| --- | --- | --- |
| **M0 框架（本次）** | 分层骨架、DB 与迁移机制、模块注册表、统一响应包、SPA 壳与五模块占位页、启动脚本与 Docker、健康检查测试 | 可运行的整体框架 |
| **M1** | 备忘录 MVP（CRUD+提醒）、文件存档 MVP（上传/下载/分类） | 两个可用模块 |
| **M2** | 理财模块（M2a 资产/负债台账+成员+附件后端，M2b 总览/台账/详情/日历前端，M2c 产品对比分析，M2d 理财实际收益录入与轨迹，M3a 收益分析：月度趋势/分类与成员贡献/明细，M3b 数据导入导出：JSON/ZIP 备份与 CSV 导出、merge/restore 导入 + 负债分类增强：房贷预计结清月/已还本金/下次扣款日、信用卡下一还款日/距还款日） | 理财可用 |
| **M3** | 选车模块全量交付：车型档案 + 详情（关键数字/配置特点/照片 lightbox）+ 4S 报价对比（含购置税预填推算）+ 跨车型对比矩阵，v0.7.0；选房模块全量交付：房源档案 + 详情（关键数字/配套设施/维度评分/照片 lightbox 含户型图）+ 跨房源对比矩阵 + 六维度加权评分（用户可自定义权重），v0.8.0 | 选车可用、选房可用 |
| **M4** | 多用户认证（**已交付 v0.9.0**）：Cookie 会话（opaque token 双限过期）+ admin/member 角色 + 全家庭共享 + 首登强制改密 + 成员管理（实施依据见第 8 节与 multi-user-module-design.md） | 协作能力 |
| **M5** | 云端部署增强（PostgreSQL 可选、HTTPS、备份脚本、监控） | 生产化 |

---

## 13. 风险与约束

| 风险 | 应对 |
| --- | --- |
| SQLite 并发写限制 | WAL + 单实例部署；多实例需求出现时按预案切 PostgreSQL |
| 无 ORM 的 SQL 维护成本 | 语句集中在服务层、表结构强约定；复杂查询出现时再评估引入 SQLAlchemy |
| 原生前端复杂度上限 | 以 `/api/v1` 契约为界，必要时整体替换为 Vue/Vite 构建版，后端零改动 |
| admin 默认口令 | M4 已实现首登强制改密（005 迁移按弱口令指纹标记）；compose 默认关闭公网暴露 |
| 数据丢失 | `data/` 目录整体备份策略 + M5 自动快照 |

---

## 14. 扩展指南：新增一个业务模块（三步）

1. **建表**：`migrations/00N_xxx.sql` 新增表（遵循通用约定）；
2. **后端**：`services/xxx.py` 业务函数 + `api/v1/xxx.py` 路由 + `router.py` 挂载 + `registry.py` 登记；
3. **前端**：`frontend/assets/js/modules/xxx.js` 渲染函数 + `app.js` 注册 key。

导航、模块接口、健康检查自动纳入新模块，无需改动框架代码。
