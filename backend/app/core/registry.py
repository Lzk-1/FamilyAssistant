"""业务模块注册表：前后端共享的模块清单（可扩展机制核心）。

- GET /api/v1/system/modules 对外暴露，前端导航由该接口动态驱动
- 新增业务模块三步接入：在此登记 → router.py 挂载 → 前端加渲染函数
- 顺序即导航顺序，与主菜单一致：理财 / 选房 / 选车 / 备忘录 / 文件存档
"""

MODULES: list[dict] = [
    {"key": "finance", "name": "理财", "path": "#/finance", "description": "家庭资产、收支流水与预算管理"},
    {"key": "house", "name": "选房", "path": "#/house", "description": "候选房源档案、看房记录与对比评估"},
    {"key": "car", "name": "选车", "path": "#/car", "description": "候选车型档案、参数对比与成本评估"},
    {"key": "memo", "name": "备忘录", "path": "#/memo", "description": "家庭待办、提醒与共享笔记"},
    {"key": "files", "name": "文件存档", "path": "#/files", "description": "家庭证件、合同、票据等文件的集中归档"},
]


def get_module(key: str) -> dict | None:
    return next((m for m in MODULES if m["key"] == key), None)
