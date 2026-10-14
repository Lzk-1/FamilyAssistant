"""统一异常体系：业务代码抛 AppError，全局处理器转为统一错误响应包。

错误码段：0 成功；4xxx 客户端；5xxx 服务端；5011 模块建设中（M0 写接口占位）。
"""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse


class AppError(Exception):
    """业务异常。http_status 未指定时按 code 段推导（4xxx→400，其余→500）。"""

    def __init__(self, code: int, message: str, http_status: int | None = None) -> None:
        self.code = code
        self.message = message
        if http_status is None:
            http_status = 400 if 400 <= code < 500 else 500
        self.http_status = http_status
        super().__init__(message)


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def handle_app_error(request: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.http_status,
            content={"code": exc.code, "message": exc.message, "data": None},
        )

    @app.exception_handler(Exception)
    async def handle_unexpected_error(request: Request, exc: Exception) -> JSONResponse:
        return JSONResponse(
            status_code=500,
            content={"code": 5000, "message": f"服务内部错误：{exc}", "data": None},
        )
