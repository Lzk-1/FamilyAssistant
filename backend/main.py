"""FamilyAssistant 应用入口。

用法：
    python backend/main.py                                  # 单机默认 http://127.0.0.1:8300
    FA_HOST=0.0.0.0 FA_PORT=9000 python backend/main.py      # 云端 / 自定义端口
    uvicorn main:app --reload --app-dir backend              # 开发热重载

设计要点：
- create_app 工厂便于测试注入自定义 Settings（临时数据目录）
- lifespan 启动时自动执行数据库迁移（幂等）
- 同一进程托管 API（/api/v1）与前端静态资源（frontend/），单进程即全栈
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app import __version__
from app.api.v1.router import api_router
from app.core.config import Settings, load_settings
from app.core.database import Database
from app.core.errors import register_error_handlers


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or load_settings()
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    settings.upload_dir.mkdir(parents=True, exist_ok=True)

    database = Database(settings.db_file, settings.migrations_dir)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        applied = database.run_migrations()
        if applied:
            print(f"[startup] 已应用数据库迁移: {', '.join(applied)}")
        yield

    app = FastAPI(title="FamilyAssistant API", version=__version__, lifespan=lifespan)
    app.state.settings = settings
    app.state.database = database

    if settings.cors_origin_list:  # 预留前后端分离部署
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origin_list,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    register_error_handlers(app)
    app.include_router(api_router)

    frontend_dir = Path(__file__).resolve().parent.parent / "frontend"
    if frontend_dir.exists():
        # 挂载在最后：/api/v1 优先命中，未匹配的路径回落到 SPA 静态资源
        app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")

    return app


app = create_app()


if __name__ == "__main__":
    import uvicorn

    current = load_settings()
    uvicorn.run(app, host=current.host, port=current.port, log_level="info")
