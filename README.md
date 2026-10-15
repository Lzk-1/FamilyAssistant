# FamilyAssistant 家庭助手

面向个人与小团队的家庭事务一站式管理平台：**理财 / 选房 / 选车 / 备忘录 / 文件存档**。

单机部署、零外部依赖（内嵌 SQLite + 本地文件存储，`data/` 目录即全部状态）、跨平台运行（Windows / macOS / Linux），并预留多团队成员协作与云服务器部署能力。

## 快速开始

要求：Python 3.10+（无需任何外部数据库/服务）。

```bash
# Linux / macOS
./scripts/start.sh

# Windows
scripts\start.bat
```

启动后浏览器访问 <http://127.0.0.1:8300>。

## Docker / 云服务器

```bash
docker compose up -d          # 数据持久化于宿主机 ./data
```

## 文档

- [整体框架方案设计文档](docs/architecture.md) —— 架构、模块设计、数据库、部署形态与路线图
- [整体 UI 设计规范](docs/ui-design.md) —— 设计系统（令牌/组件）与五模块页面布局、交互流程
- [理财模块方案与 UI 设计](docs/finance-module-design.md) —— 业界调研、资产分类与字段、页面设计（已确认）
- [理财模块开发方案](docs/finance-dev-plan.md) —— 数据库迁移、API/服务层/前端实现、测试与实施步骤
- [理财模块需求开发文档](docs/finance-requirements.md) —— 功能需求 FR、验收标准、数据字典与边界场景

## 目录概览

```
backend/    Python3 + FastAPI + SQLite（API / 服务 / 核心基础设施 / 迁移 / 测试）
frontend/   零构建原生 SPA（导航由后端模块注册表驱动）
scripts/    跨平台一键启动脚本
data/       运行时状态（git 忽略）：SQLite 数据库 + uploads/
docs/       设计文档
```

## 当前状态与路线图

当前为 **M0 框架阶段**：五个模块的表结构、数据链路、API 骨架与页面占位已就绪，业务功能按路线图迭代：

| 里程碑 | 内容 |
| --- | --- |
| M1 | 备忘录 + 文件存档 MVP |
| M2 | 理财（账户/流水/统计） |
| M3 | 选房 / 选车（档案+对比评分） |
| M4 | 多用户认证与家庭共享 |
| M5 | 云端部署增强（PostgreSQL 可选 / 备份 / 监控） |
