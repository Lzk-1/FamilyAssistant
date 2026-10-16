# 多用户协作模块设计（FamilyAssistant · auth / M4）

| 项目 | 内容 |
| --- | --- |
| 版本 | v1.2（已按本设计实施交付，决策点见 §9） |
| 日期 | 2026-10-16 |
| 上游输入 | [architecture.md](architecture.md) §1.1「预留多团队协作」、[ui-design.md](ui-design.md) 全局规范、[house-module-design.md](house-module-design.md) 模块设计模式 |
| 状态 | **已交付（v0.9.0 起，v0.9.2 增量）**：005/006 迁移 + 认证服务 + 头像/个人中心 + 前端登录/成员管理全链路完成，pytest 72/72 通过，auth_enabled=true/false 双模式实测通过 |

---

## 1. 模块定位与调研结论

### 1.1 模块定位

M4 是平台级迭代而非业务模块：为 FamilyAssistant 引入**登录认证、角色分级与成员管理**，使 2~8 人规模的家庭团队可以在同一实例上协作使用理财/选房/选车/备忘录/文件存档五个模块。硬约束不变：零外部依赖（标准库实现）、SQLite 单文件、单进程、跨平台，且 **FA_AUTH_ENABLED=false 时单机免登录模式必须完全不变**（回归风险最高优先级）。

### 1.2 现状盘点（M0~M3 预留，全部已核实）

| 组件 | 现状 | 结论 |
| --- | --- | --- |
| `users` 表 | username/password_hash/display_name/**role(admin\|member)**/is_active + 内置 admin（id=1，弱口令 admin123） | 结构可用，需加 must_change_password 列 |
| `security.py` | PBKDF2-SHA256 260k 轮（三段式格式）+ token_urlsafe 签发 | 轮数需升级到 600k，格式需扩展带轮数 |
| `config.py` | `auth_enabled`（FA_AUTH_ENABLED）+ secret_key | 就绪 |
| `deps.py` | `get_current_user` 桩：关闭时返回 DEFAULT_USER，开启时 401 | M4 实装点 |
| `sessions` 表 | **不存在**（仅 TODO 注释中的 api_tokens 设想） | 需新迁移创建 |
| 业务表 | 全部带 `user_id NOT NULL DEFAULT 1` + FK | 行级审计字段就绪 |
| 服务层 | car/house/memo/files 四个 service 硬编码 `_DEFAULT_USER_ID = 1`；finance 已有 user_id 形参接线范本 | M4 改造点 |
| 前端 | 无登录页/用户菜单/成员管理页；api.js 未处理 401、未注入凭证 | M4 改造点 |
| SQLite | WAL + 每请求短连接 + timeout=30s（database.py） | 已满足调研推荐，无需改动 |

**概念澄清（重要）**：`users`（登录账号）与 `finance_members`（家庭成员档案，资金归属人：爸爸/妈妈/孩子）是两套正交概念——前者是系统身份，后者是业务数据维度。这与 Home Assistant 的 User/Person 解耦模式完全一致，M4 维持该正交：家庭成员可以只是 finance_members 里的一行（有名字、可被记账），而不需要登录账号。

### 1.3 调研结论摘要

两项业界调研（7 款自托管家庭应用的多用户设计 + 认证技术选型）核心结论：

- **数据归属规律**：协作密集型内容（媒体、菜谱、家庭决策）共享优先；隐私敏感型（照片、钱、密码）隔离优先、共享须显式授权。家庭应用四种模型：全共享（Grocy/HA/Jellyfin 库）、完全隔离（Firefly III）、默认隔离+显式共享（Immich/Vaultwarden）、账本/空间切换（Actual/Grist）。
- **角色规律**：家庭场景一致用 2~3 档**固定角色**，无人做自定义 RBAC；细粒度需求用布尔开关而非策略引擎；Owner/首管理员不可删除是通行铁律（HA/Gitea/Seerr）。
- **加入方式**：自托管应用几乎全是**管理员建号**而非开放注册（零依赖下邮件邀请不可行，家庭规模下建号最简单）。
- **会话机制**：单单体+单数据库应选**服务端会话**（opaque token 存库哈希，登出删行即吊销）；JWT 对自托管单体属过度设计。实证：Gitea（cookie `i_like_gitea`，24h）、Jellyfin（token 存库每请求查库）。
- **CSRF**：同源应用用 HttpOnly Cookie + `SameSite=Lax` + 写操作自定义头校验即可，无需完整 CSRF token 体系。
- **密码哈希**：PBKDF2-SHA256 选型正确（标准库原生、Django 默认同款），但 OWASP 现行标准为 **600k 轮**（260k 是 2020 年代旧标准）；格式带轮数、登录时透明升级（Django 同款机制）。
- **SQLite 并发**：WAL 下 <10 并发用户绰绰有余，现有实践已是推荐配置。
- **弱口令账号**：硬编码默认账号是历史入侵常见入口（Jenkins/Confluence 案例）；Gitea 无任何默认凭据、首启向导后锁定。

---

## 2. 领域模型（migrations/005_multi_user.sql）

### 2.1 sessions（会话表，即 M0 规划中的 api_tokens）

```sql
CREATE TABLE IF NOT EXISTS sessions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash     TEXT    NOT NULL UNIQUE,    -- opaque token 的 SHA-256 hex（非明文存储，拖库不可复用）
    user_id        INTEGER NOT NULL,
    created_at     TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
    expires_at     TEXT    NOT NULL,           -- 绝对上限：created_at + 30 天，不可续（OWASP 双限时原则）
    last_active_at TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),  -- 滑动基准：空闲 14 天失效
    user_agent     TEXT    NOT NULL DEFAULT '',
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
```

设计要点：

- **token 生成**：`secrets.token_urlsafe(32)`（256bit 熵，security.py 现成），**库中只存 SHA-256 哈希**——token 是高熵随机值无爆破空间，用普通 SHA-256 而非慢哈希（慢 KDF 只会拖慢每个请求，无安全增益）
- **双限过期**（OWASP）：空闲 14 天滑动续期 + 绝对 30 天上限；登录成功时重新签发新 token（会话固定攻击防护）
- **滑动续期节流**：`last_active_at` 距今超过 1 小时才 UPDATE，避免每请求写库
- **时间口径**：沿用全平台 `datetime('now', 'localtime')`，ISO 字符串比较口径一致

### 2.2 users 表扩展

```sql
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;

-- D4：仅当内置 admin 的哈希指纹未被修改时标记强制改密（精确匹配，不误伤已改密用户）
UPDATE users SET must_change_password = 1
 WHERE id = 1
   AND password_hash = 'pbkdf2_sha256$19270a0d690f42a9623202ab9fbc5741$d45f7e5a76a72091f8b3473b68f3fb354e8927f8e47ef82bc06b8436b744bd7c';
```

新装库（001 插入弱口令 admin → 005 立即跑）与存量库路径一致：内置 admin 首次登录即强制改密，弱口令实际不存在。

### 2.3 密码哈希格式升级（security.py 改造）

| 项 | 旧格式（M0） | 新格式（M4） |
| --- | --- | --- |
| 形态 | `pbkdf2_sha256$<salt>$<hash>`（三段） | `pbkdf2_sha256$<600000>$<salt>$<hash>`（四段，轮数自带） |
| 轮数 | 260_000（写死） | 从存储值解析，校验按存储轮数执行 |
| 升级 | — | `verify_password` 通过后若为旧格式/低轮数 → 登录服务层透明重哈希为 600k 四段式（Django 同款平滑升级机制） |

兼容性：001_init.sql 内置的三段式哈希在新格式解析器下按 260k 校验（三段=260k，四段=自带轮数），校验通过即透明升级，**不改历史迁移文件**。

---

## 3. 认证与会话管理

### 3.1 登录流程（POST /auth/login）

```
用户名+密码 → verify_password（按存储格式轮数校验）
  ├─ 失败 → 401（M4 不做失败计数锁定，家庭内网场景；错误信息不区分「用户不存在/密码错误」）
  └─ 成功 → is_active=0 拒绝 → 校验通过：
        ① 旧格式哈希透明升级（600k 四段式）
        ② 签发 opaque token → SHA-256 入库 sessions（双限时间戳）
        ③ Set-Cookie: fa_session=<token>; HttpOnly; SameSite=Lax; Path=/; Max-Age=...（HTTPS 部署时加 Secure）
        ④ 返回 {user, must_change_password}
```

### 3.2 get_current_user 实装（deps.py）

```python
def get_current_user(request, settings, conn=Depends(get_db)) -> dict:
    if not settings.auth_enabled:
        return DEFAULT_USER                      # 单机免登录旁路：行为与 M0 完全一致
    token = request.cookies.get("fa_session")
    if not token:
        raise AppError(4001, "未认证：请先登录", http_status=401)
    user = auth_service.validate_session(conn, token, request)   # 查表→双限校验→滑动续期→is_active 校验
    if not user:
        raise AppError(4001, "登录已过期，请重新登录", http_status=401)
    _check_csrf_header(request)                  # 写方法须带 X-Requested-With（§3.4）
    return user
```

要点：`dependencies=[Depends(get_current_user)]` 级联触发 `get_db`，现有各业务路由接线**零改动**；`get_db` 每请求短连接不依赖现有 conn 注入顺序。

### 3.3 Cookie 策略

| 属性 | 值 | 依据 |
| --- | --- | --- |
| HttpOnly | ✅ | XSS 无法读取，token 不落 localStorage |
| SameSite | Lax | 现代浏览器默认值，跨站写请求不携带 cookie |
| Path | / | 同源单应用 |
| Secure | 仅 HTTPS | `request.url.scheme == "https"` 时附加；本机 127.0.0.1 部署不受影响 |

### 3.4 CSRF 防护

`SameSite=Lax` 已挡跨站写请求；再加一道自定义头校验：**非 GET/HEAD/OPTIONS 请求必须携带 `X-Requested-With: XMLHttpRequest`**，否则 403。跨站攻击者附加自定义头会触发 CORS 预检被拦（攻击页面无预检响应权），双保险成立。豁免：`/auth/login`（登录 CSRF 危害有限且需支持无会话首请求）。GET 请求全平台无副作用（已核实现有 API），符合 Lax 模型要求。

### 3.5 首登强制改密（D4）

登录响应携带 `must_change_password=true` → 前端渲染**不可跳过的全屏改密表单**（无导航、无退出旁路；仅新密码 + 确认两框）→ `PUT /auth/password` 完成后清除标记并释放应用。改密成功同时吊销该用户其他全部会话（除当前）。**强制改密态不校验旧密码**（能进入该视图即已通过登录验证，Keycloak/Gitea 同款）；改密成功后前端不得复用登录响应的旧快照（`must_change_password` 仍为 true，会导致改密视图二次渲染，即用户感知的"要重置两次密码"）。

### 3.6 改密与重置

- `PUT /auth/password`（本人）：常规自助改密**校验 old_password**；`must_change_password=1`（首登/被管理员重置）时跳过旧密校验 → 新哈希（600k）→ 清标记 → 吊销其他会话
- `PUT /auth/users/{id}/password`（admin 重置成员）：不校验旧密 → 置 must_change_password=1 → 吊销该成员全部会话（强制重新登录）
- 密码强度：最小 8 位 + 不得等于用户名（轻量校验，家庭场景不做复杂度策略引擎）

---

## 4. 权限模型

### 4.1 角色与铁律（D3）

两档固定角色（沿用现有 role 列，不加档位、不做自定义角色）：

| 角色 | 能力 |
| --- | --- |
| admin | 全部业务读写 + 理财模块全部写操作 + 成员管理（建号/改角色/禁用/重置密码）+ 改密 + 登出 |
| member | 业务**只读为主**：理财模块读可见、写一律 403（M4.1，详见 §4.2）；其余业务模块（选房/选车/备忘录/文件存档）仍全员读写；本人改密 + 登出 |

> 成员要记账时由管理员将其角色改为 admin；细粒度权限（如"可写理财但不可删成员"）按 YAGNI 不做。

三条铁律（服务层校验，API 层无 DELETE 成员接口）：

1. **id=1 首管理员**：不可禁用、不可降级、不可删除（HA Owner 原则的简化实现）
2. **最后一个活跃 admin**：不可禁用/降级（`UPDATE` 前检查活跃 admin 计数）
3. **成员只禁不删**：is_active=0 软禁用（Jellyfin 模式）——user_id 被 30+ 业务行 FK 引用，物理删除会破坏引用完整性；被禁用户活跃会话即时吊销

### 4.2 require_admin 依赖

```python
def require_admin(user=Depends(get_current_user)) -> dict:
    if user["role"] != "admin":
        raise AppError(4003, "权限不足：需要管理员权限", http_status=403)
    return user
```

挂载范围：

- **成员管理路由**（`/auth/users*` 全部写接口）
- **理财模块全部写接口（M4.1，v0.9.2）**：资产 CRUD / 批量删除 / 状态流转 / 市值记录增删 / 收益录入 / 附件上传删除 / 备份导入 / 成员字典维护——共 14 个端点；只靠前端隐藏按钮是表面功夫，后端强制是安全底线
- 其余业务路由维持 get_current_user（全员读写）

### 4.3 数据归属语义（D1：全家庭共享）

**读**：所有业务数据对全部成员可见可编辑——服务层查询**移除** `WHERE user_id = ?` 过滤（`_DEFAULT_USER_ID` 从查询条件中退位）。
**写**：INSERT 时 user_id 记录**真实操作者**（审计语义：谁创建的），UPDATE 不变更归属。

| 现状 | M4 改造 |
| --- | --- |
| car/house/memo/files service：查询硬编码 `user_id = _DEFAULT_USER_ID` | 读查询去过滤；写入处 `_DEFAULT_USER_ID` → 函数形参 `user_id`（API 层传 `user["id"]`） |
| finance service：已有 user_id 形参范本 | 对齐补齐（部分 list 查询带 user_id 过滤的同样移除） |
| `house_scoring_config`：每用户一行权重（PK user_id） | **保持按用户隔离**——评分权重是个人偏好，不共享；免登录模式恒为 user_id=1，行为不变 |

单机免登录模式：`get_current_user` 旁路返回 DEFAULT_USER(id=1)，写入与 M0 完全一致；读查询去过滤后 admin 可见全部数据（含协作期成员创建的数据），**单机模式数据只增不减**，无回归风险。

---

## 5. 前端页面与交互（遵循 ui-design.md 组件规范）

### 5.1 登录视图（新增）

- 触发：`bootstrap()` 先 `GET /auth/me` → 401（auth_enabled=true 且无有效会话）→ 隐藏侧边栏、`#view` 渲染居中登录卡片；`GET /auth/me` 返回 200（免登录模式或已登录）→ 正常装配
- 布局：品牌 logo + 用户名/密码 + 登录按钮（primary）；登录失败行内错误提示，不区分用户名/密码错误原因
- 成功：`must_change_password=false` → 重新 bootstrap 进应用；`true` → 渲染强制改密视图

### 5.2 强制改密视图（新增）

不可跳过（无导航无退出）：新密码 + 确认新密码 + 提交，走 `PUT /auth/password`；完成 toast 后进应用。

### 5.3 用户菜单（侧边栏 sidebar-footer，v0.9.2 更新）

侧边栏底部用户块：**圆形头像 + 显示名 + 下拉箭头**，点击弹浮层菜单：

- **个人中心**（弹窗：头像上传/移除、显示名修改、修改密码）
- **成员管理**（仅 admin 可见，跳 `#/members`）
- **退出登录**（POST /auth/logout → 回登录视图）

侧边栏不再展示服务健康状态圆点（`/system/health` 探活仅保留 API，前端不渲染）。

**头像（v0.9.2 新增，006 迁移）**：

- 默认头像 = 显示名首字 + 按用户名哈希的确定性配色（同一人跨设备颜色一致，零图片零依赖）
- 上传：仅本人（个人中心内），JPG/PNG/WebP、≤2MB、扩展名 + 魔数双校验，替换式上传自动删旧文件；可移除恢复默认
- 存储：文件落盘 `data/uploads/avatars/{id}/{uuid}.ext`，DB 只存相对路径（可随 data/ 整目录备份）；成员表格新增只读头像列
- `session.js`：全局共享登录态模块（app.js 写入、页面层只读，避免循环依赖）；`isAdmin()` 对 null user（单机旁路）返回 true

免登录模式：GET /auth/me 返回内置 admin → 用户块显示「管理员 · 单机模式」，菜单仅展示改密项？——**不展示**（免登录模式改密无意义，登录关闭时密码不参与认证），用户块整体隐藏。

### 5.4 成员管理页 `#/members`（admin）

- app.js `route()` 特判 `#/members`（不入模块注册表，不出现在主导航）
- 表格列：用户名 / 显示名 / 角色 / 状态（启用·已禁用 tag）/ 活跃会话数 / 最近活跃 / 创建时间
- 工具栏：**新建成员**（弹窗：用户名/初始密码/显示名/角色；`.fa-dialog-actions` + danger 按钮规范）
- 行操作：编辑（显示名/角色/启用禁用，服务层铁律校验）、重置密码（confirmModal 确认 → 弹窗输入新密码）
- 自我保护：操作自己的行时禁用「角色降级/禁用」选项；id=1 行提示「首管理员不可修改」

### 5.5 api.js 改造

- `request()`：写方法（POST/PUT/DELETE）统一附加 `"X-Requested-With": "XMLHttpRequest"` 头
- `apiUpload()`：`xhr.setRequestHeader("X-Requested-With", "XMLHttpRequest")`
- 401 统一拦截：`location.hash === "#/login"` 时不再跳转（防循环），其余场景跳登录视图
- Cookie 由 fetch/XHR 自动携带（同源默认），api.js 不感知 token

---

## 6. API 清单（/api/v1/auth 前缀，统一响应包）

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| GET | /auth/me | 当前用户信息（含 must_change_password）；免登录模式返回内置 admin + `single_user_mode: true` | 会话/旁路 |
| POST | /auth/login | 登录：校验 → 透明哈希升级 → 签发 → Set-Cookie；返回 {user, must_change_password} | 公开（CSRF 豁免） |
| POST | /auth/logout | 登出：删除当前会话行 + 清 cookie | 会话 |
| PUT | /auth/password | 本人改密（old/new；must_change_password=1 时免 old）→ 吊销其他会话、清强制改密标记 | 会话 |
| PUT | /auth/profile | 更新本人显示名（个人中心） | 会话 |
| POST | /auth/avatar | 上传本人头像（≤2MB，扩展名+魔数校验，替换式） | 会话 |
| DELETE | /auth/avatar | 移除本人头像（恢复默认字母头像） | 会话 |
| GET | /auth/users/{id}/avatar | 读取成员头像（成员表格/侧边栏头像源） | 会话 |
| GET | /auth/users | 成员列表（computed：active_sessions / recent_active_at） | admin |
| POST | /auth/users | 新建成员（username 唯一、密码强度校验、role 白名单） | admin |
| PUT | /auth/users/{id} | 更新成员（display_name / role / is_active；三条铁律服务层校验） | admin |
| PUT | /auth/users/{id}/password | 重置成员密码：置 must_change_password=1 + 吊销其全部会话 | admin |

错误码：4001 未认证（401，沿用现有）、4003 权限不足（403）。路由挂载：`router.py` include `auth.router, prefix="/auth"`。

---

## 7. 与既有模块的复用与影响面

| 影响面 | 内容 | 风险控制 |
| --- | --- | --- |
| 现有 47 个 pytest | 全部在 auth_enabled=false 下构造，走旁路 | 零改动回归；新增 test_auth.py 用 `Settings(auth_enabled=True)` 独立 app 实例 |
| 服务层四个文件 | `_DEFAULT_USER_ID` 退位为形参 user_id + 读查询去过滤 | 接口签名变化仅 API 层调用，无跨 service 依赖 |
| finance 备份导入 | import_backup 已有 default_user_id 兜底逻辑（跨机恢复场景） | 语义不变：导入数据统一落当前用户 |
| memos/files 等查询 | user_id 过滤移除 | 免登录模式数据只增不减 |
| 前端模块页 | 理财页面按 `isAdmin()` 条件渲染写入口（M4.1）；其余业务页零改动 | `session.js` 共享登录态，页面层不反向依赖 app.js |
| 复用组件 | modal/toast/confirmModal/tag/select/errorBanner + `.fa-dialog-actions` 按钮规范 | 全部沿用 ui.js 既有组件 |

## 8. 实施切分

| 里程碑 | 内容 | 状态 |
| --- | --- | --- |
| **M-auth1** | 后端：005 迁移、security.py 格式升级（600k 四段式+透明升级）、auth service（会话签发/校验/续期/吊销 + 成员管理铁律）、auth API、deps.py 实装 + CSRF 校验、服务层 user_id 审计改造、test_auth.py + 全量回归 | ✅ |
| **M-auth2** | 前端：登录视图、强制改密视图、用户菜单、成员管理页、api.js 401/头改造 | ✅ |
| **M-auth3** | v0.9.2：006 迁移（avatar_path 列）+ 头像上传/移除/读取 + 个人中心（改显示名/改密）+ `session.js` 共享登录态；强制改密态免旧密校验（修复"两次改密"体感） | ✅ |
| **M4.1** | v0.9.2：理财权限模型（写接口 require_admin，14 端点）+ 台账批量删除 + 市值记录删除 + 行尾单行删除 + 统一勾选模型 | ✅ |
| **验证** | auth_enabled=true 浏览器全链路实测（登录/改密/多成员协作/铁律/会话过期/头像/个人中心/双角色理财读写矩阵）+ auth_enabled=false 回归 + 文档更新 + 版本 0.8.0 → 0.9.0 → 0.9.2 | ✅ |

## 9. 决策点

1. **D1 数据归属模型**：A. **全家庭共享**（读不过滤 + 写记录操作者审计）【推荐已采纳：家庭协作语义最贴合、Grocy/HA 先例；理财数据在家庭记账场景本就以 finance_members 家庭维度共享】；B. 共享 + 理财隔离（Firefly III 哲学，但与现有 finance_members 家庭维度冲突）；C. 按模块可配置（家庭规模收益存疑，显著增加测试面）
2. **D2 会话凭证机制**：A. **HttpOnly Cookie + SQLite sessions 表存 SHA-256 哈希**【推荐已采纳：Gitea/Jellyfin 实证、登出删行即吊销、前端改动最小、XSS 偷不走】；B. Authorization Bearer（免 CSRF 但 localStorage 有 XSS 窃取面、前端全改）
3. **D3 角色分级**：A. **admin/member 两档 + 三条铁律（id=1 首管理员保护、最后活跃 admin 保护、只禁不删）**【推荐已采纳：家庭场景两档够用，HA Owner 原则简化实现】；B. 三档 owner/admin/member（owner/admin 差异在家庭场景很小）；C. 加 viewer 只读（显著增加前端条件渲染工作量，M4 范围外）
4. **D4 内置弱口令处理**：A. **首登强制改密**（迁移精确匹配内置哈希指纹 → must_change_password=1，保住 id=1 的 FK 引用链）【推荐已采纳】；B. 删除重建 + 首启向导（迁移复杂度高、存量 user_id=1 过户成本大）
5. **D5 成员删除语义**：A. **仅软禁用不物理删除**（FK 引用保护，HA/Jellyfin 模式）【推荐已采纳】；B. 物理删除 + 数据过户 admin
6. **D6 密码哈希轮数**：A. **600k 轮四段式格式 + 登录透明升级**（OWASP 现行标准，Django 同款机制，不改历史迁移）【推荐已采纳】；B. 维持 260k 三段式（低于 OWASP 标准）
7. **D7 邀请方式**：A. **管理员直接建号**【推荐已采纳：家庭 2~8 人、零依赖下邮件邀请不可行、业界自托管一致做法】；B. 一次性邀请码自助注册（Mealie 模式，M4 后续可选增强，sessions 表机制可直接复用）

> 以上决策点按推荐方案写入本文档。实施前如需调整任一决策点，修订本节与对应章节即可。

## 10. 测试要点（test_auth.py）

- 登录成功/失败/禁用用户登录拒绝；错误信息不泄露用户存在性
- 会话全生命周期：签发 → 校验通过 → 滑动续期（节流窗口）→ 空闲超时失效 → 绝对上限失效 → 登出删行即吊销
- 哈希透明升级：260k 三段式登录成功后库中变 600k 四段式；verify 按存储轮数校验
- must_change_password：内置 admin 首登强制改密 → 改密后标记清除 → 其他会话被吊销
- 铁律：id=1 不可禁用/降级；最后一个活跃 admin 不可禁用/降级；member 调成员管理 API → 403
- CSRF：写请求缺 X-Requested-With → 403；GET 不受影响；login 豁免
- 服务层审计：user A 创建的候选车，user B 可见可编辑；user_id 落 A 的 id
- 权重隔离：user B 的 scoring_config 与 user A 互不干扰
- 旁路回归：auth_enabled=false 时 get_current_user 返回 DEFAULT_USER、无 Cookie 校验、写请求 user_id=1 与 M0 一致
