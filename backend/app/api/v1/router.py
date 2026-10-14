"""/api/v1 总路由：系统模块 + 五个业务模块在此挂载。

新增模块两步接入：include_router 挂载 + core/registry.py 登记。
"""

from fastapi import APIRouter

from app.api.v1 import car, files, finance, house, memo, system

api_router = APIRouter(prefix="/api/v1")
api_router.include_router(system.router, prefix="/system")
api_router.include_router(finance.router, prefix="/finance", tags=["finance 理财"])
api_router.include_router(house.router, prefix="/house", tags=["house 选房"])
api_router.include_router(car.router, prefix="/car", tags=["car 选车"])
api_router.include_router(memo.router, prefix="/memo", tags=["memo 备忘录"])
api_router.include_router(files.router, prefix="/files", tags=["files 文件存档"])
