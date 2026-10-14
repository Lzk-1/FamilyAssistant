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

---

## 5. 模块设计

### 5.1 模块注册表（可扩展机制）

`backend/app/core/registry.py` 维护模块清单（key/名称/路径/描述），`GET /api/v1/system/modules` 对外暴露，**前端导航由该接口动态驱动**。新增模块只需登记一条记录，前后端自动感知。

### 5.2 五个业务模块概要

| 模块 | 定位 | 核心实体（M0 已建表） | 计划 API 前缀 | M0 状态 |
| --- | --- | --- | --- | --- |
| 理财 finance | 家庭资产与收支全景 | `finance_accounts` 账户、`finance_transactions` 流水 | `/api/v1/finance` | 列表接口通、写接口占位 |
| 选房 house | 房源档案与对比决策 | `house_candidates` 候选房源（价格/面积/户型/楼龄/优劣势/评分/状态） | `/api/v1/house` | 同上 |
| 选车 car | 车型档案与对比决策 | `car_candidates` 候选车型（品牌/能源/价格/里程/评分/状态） | `/api/v1/car` | 同上 |
| 备忘录 memo | 家庭待办与提醒 | `memos`（优先级/状态/截止时间/标签/置顶） | `/api/v1/memo` | 同上 |
| 文件存档 files | 家庭文件集中归档 | `file_records`（原名/存储路径/大小/类型/SHA256/分类） | `/api/v1/files` | 同上（上传依赖 python-multipart 已就绪） |

每个模块的详细领域模型（字段字典、枚举值、页面布局、计算规则）在各自迭代（M1~M3）时以附录文档补充，M0 仅固化表结构与模块边界。

### 5.3 系统模块 system

- `GET /api/v1/system/health`：健康检查（状态/版本/模块数）
- `GET /api/v1/system/modules`：模块注册表
- `GET /api/v1/system/stats`：数据统计（M1+，逐表计数）

---

## 6. 数据库设计

### 6.1 表清单（migrations/001_init.sql）

| 表 | 用途 | 关键字段 |
| --- | --- | --- |
| `users` | 多用户预留；M0 内置 admin | username、password_hash、role(admin/member)、is_active |
| `finance_accounts` | 理财账户 | user_id、name、type、currency、initial_balance |
| `finance_transactions` | 收支流水 | account_id、kind(income/expense/transfer)、category、amount、occurred_at |
| `house_candidates` | 候选房源 | title、community、city、total_price、area、layout、status、score、pros/cons |
| `car_candidates` | 候选车型 | brand、model、energy(fuel/ev/hybrid)、price、mileage、status、score |
| `memos` | 备忘录 | title、content、priority、status、due_at、tags、pinned |
| `file_records` | 文件元数据 | original_name、stored_path、size、mime_type、sha256、category |

**通用约定**：`id` 自增主键；`user_id` 预留协作（M0 默认 1=admin）；`created_at`/`updated_at` ISO 时间戳；命名蛇形复数；金额统一 REAL + CNY（M1 引入精度处理策略）。

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

## 8. 认证与多用户预留设计

### 8.1 演进阶段

| 阶段 | 形态 | 实现 |
| --- | --- | --- |
| **M0（现在）** | 单机免登录模式 | `FA_AUTH_ENABLED=false`，依赖注入返回内置 admin；表结构与密码散列函数已就绪 |
| **M1~M3** | 单机多用户 | 打开开关 → 登录接口签发随机 Token（`secrets` 生成）→ `api_tokens` 表校验；密码 `pbkdf2_sha256$<salt>$<hash>` |
| **M4** | 多群组协作 | 在多用户之上叠加"家庭组"模型：`groups` / `group_members` 两表 + 业务表 `group_id` 列（实施依据见 8.2~8.5） |
| **云部署（预留）** | 团队协作 | 同 Token 方案 + HTTPS 反向代理；角色模型与行级过滤已在所有列表 SQL 中预留 |

内置账号：`admin / admin123`（占位，启用认证前必须修改，见 001_init.sql 注释）。

### 8.2 多群组表结构（migrations/002_groups.sql）

新增三张表：

```sql
-- 访问令牌（M4.1）
CREATE TABLE IF NOT EXISTS api_tokens (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL,
    token_hash   TEXT    NOT NULL UNIQUE,    -- SHA256(token)，不落明文
    name         TEXT    NOT NULL DEFAULT '', -- 设备/来源备注
    expires_at   TEXT,                       -- 默认签发后 30 天
    last_used_at TEXT,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (user_id) REFERENCES users (id)
);

-- 家庭组
CREATE TABLE IF NOT EXISTS groups (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    owner_id    INTEGER NOT NULL,           -- 组长（组内唯一 owner）
    invite_code TEXT    NOT NULL UNIQUE,    -- 邀请码（secrets 生成，可重置）
    is_default  INTEGER NOT NULL DEFAULT 0,  -- 单机模式回填的默认组（id=1）
    created_at  TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (owner_id) REFERENCES users (id)
);

-- 组成员（组内角色载体）
CREATE TABLE IF NOT EXISTS group_members (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id  INTEGER NOT NULL,
    user_id   INTEGER NOT NULL,
    role      TEXT    NOT NULL DEFAULT 'member',  -- owner / admin / member
    joined_at TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
    UNIQUE (group_id, user_id),
    FOREIGN KEY (group_id) REFERENCES groups (id),
    FOREIGN KEY (user_id)  REFERENCES users (id)
);
```

存量六张业务表统一补 `group_id`（同一迁移内完成回填）：

```sql
ALTER TABLE finance_accounts     ADD COLUMN group_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE finance_transactions  ADD COLUMN group_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE house_candidates     ADD COLUMN group_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE car_candidates       ADD COLUMN group_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE memos                ADD COLUMN group_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE file_records         ADD COLUMN group_id INTEGER NOT NULL DEFAULT 1;
```

**回填策略**：迁移内创建"默认家庭组"（`groups` id=1，`is_default=1`，owner=admin），全部存量行 `group_id` 置 1——单机用户升级到 M4 后数据无缝进入默认组，无需手工处理。

### 8.3 角色模型（两级分离）

| 层级 | 字段 | 取值 | 说明 |
| --- | --- | --- | --- |
| 系统角色 | `users.role` | admin / member | 平台级：admin 可管理用户与全部组；member 仅能操作自己所在的组 |
| 组内角色 | `group_members.role` | owner / admin / member | 组级：owner 组长（唯一，可转让）；admin 组管理员；member 普通成员 |

**权限矩阵（组内）**：

| 操作 | owner | admin | member |
| --- | --- | --- | --- |
| 解散/设置组、转让 owner | 可 | 不可 | 不可 |
| 重置邀请码、邀请/移除成员 | 可 | 可 | 不可 |
| 查看组内共享数据 | 可 | 可 | 可 |
| 新增/修改组内数据 | 可 | 可 | 可 |
| 删除数据 | 可（任意） | 可（任意） | 仅限自己创建（`user_id` 匹配） |

管理边界：owner 不可被移除（仅可转让）；admin 不能变更 owner/admin 角色；两级角色互不覆盖。

### 8.4 数据可见性

1. **隔离边界 = `group_id`**：业务列表 SQL 由 `WHERE user_id = ?` 改写为 `WHERE group_id = ?`；写入时同时记录 `user_id`（创建者）与 `group_id`（归属）；跨组访问一律 4004。
2. **共享/私有两档**：业务表预留 `visibility` 列（`shared` 默认 / `private` 仅创建者可见）。家庭场景默认组内共享；特殊记录（个人账本、私密文件）可标记私有，查询时追加 `OR (visibility='private' AND user_id=当前用户)`。
3. **文件命名空间**：上传路径升级为 `data/uploads/<group_id>/...`，物理目录与行级过滤双重隔离。
4. **当前组上下文**：用户可属多组，登录后默认进入其默认组；切换组经 `POST /api/v1/groups/{id}/switch` 更新会话上下文（M4.2 后期增强，首版单组即可满足家庭场景）。

### 8.5 服务层与 API 改造点（向后兼容）

| 层 | 改动 | 影响范围 |
| --- | --- | --- |
| 依赖注入 `deps.py` | `get_current_user` 完成 Token 校验（`api_tokens`：SHA256 比对 + 过期检查 + 更新 `last_used_at`）；新增 `get_current_group` 返回组上下文 | 仅本文件 |
| 服务层 `services/*.py` | 过滤条件改为 `group_id`；创建行补写 `group_id` / `user_id` / `visibility` | 5 个模块文件 |
| 新增路由 | `POST /auth/login`、`POST /auth/logout`、`GET /auth/me`；`GET/POST /groups`、`GET /groups/{id}/members`、`POST /groups/join`（邀请码） | 新增 `api/v1/auth.py`、`api/v1/groups.py` |
| 前端 | `#/login` 登录页、`#/settings` 组与成员管理页（UI 规范已预留路由） | app.js + 2 个页面模块 |
| 兼容性 | 存量业务接口路径与响应包**不变**，仅请求头增加 `Authorization: Bearer <token>`；`FA_AUTH_ENABLED=false` 时全部跳过，单机行为与 M0 完全一致 | 无破坏性变更 |

**实施顺序**：M4.1 Token 认证（`api_tokens` + 登录接口 + deps 校验）→ M4.2 群组（002 迁移 + 角色矩阵 + 数据可见性 + 组管理页）。两步可独立交付、独立验证。

---

## 9. 配置管理

单机**零配置可启动**（全部有默认值）；云端通过 `FA_` 前缀环境变量覆盖（12-Factor）：

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `FA_HOST` | `127.0.0.1` | 监听地址（云部署改 `0.0.0.0`） |
| `FA_PORT` | `8300` | 监听端口 |
| `FA_DEBUG` | `false` | 调试模式 |
| `FA_DATA_DIR` | `<项目>/data` | 数据目录（DB + 上传文件） |
| `FA_AUTH_ENABLED` | `false` | 认证开关 |
| `FA_SECRET_KEY` | 占位值 | Token 签名密钥（生产必改） |
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
| **M2** | 理财 MVP（账户/流水/统计报表） | 理财可用 |
| **M3** | 选房/选车 MVP（档案+对比评分） | 五模块全量可用 |
| **M4** | 多用户认证与多群组协作（Token / 两级角色 / 家庭组，实施依据见第 8 节 8.2~8.5） | 协作能力 |
| **M5** | 云端部署增强（PostgreSQL 可选、HTTPS、备份脚本、监控） | 生产化 |

---

## 13. 风险与约束

| 风险 | 应对 |
| --- | --- |
| SQLite 并发写限制 | WAL + 单实例部署；多实例需求出现时按预案切 PostgreSQL |
| 无 ORM 的 SQL 维护成本 | 语句集中在服务层、表结构强约定；复杂查询出现时再评估引入 SQLAlchemy |
| 原生前端复杂度上限 | 以 `/api/v1` 契约为界，必要时整体替换为 Vue/Vite 构建版，后端零改动 |
| admin 默认口令 | 仅占位；启用认证（M4）前强制修改；compose 默认关闭公网暴露 |
| 数据丢失 | `data/` 目录整体备份策略 + M5 自动快照 |

---

## 14. 扩展指南：新增一个业务模块（三步）

1. **建表**：`migrations/00N_xxx.sql` 新增表（遵循通用约定）；
2. **后端**：`services/xxx.py` 业务函数 + `api/v1/xxx.py` 路由 + `router.py` 挂载 + `registry.py` 登记；
3. **前端**：`frontend/assets/js/modules/xxx.js` 渲染函数 + `app.js` 注册 key。

导航、模块接口、健康检查自动纳入新模块，无需改动框架代码。
