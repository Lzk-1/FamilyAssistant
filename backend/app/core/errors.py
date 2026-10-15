"""统一异常体系：业务代码抛 AppError，全局处理器转为统一错误响应包。

错误码段：0 成功；4xxx 客户端；5xxx 服务端；5011 模块建设中（M0 写接口占位）。
"""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse


class AppError(Exception):
    """业务异常。http_status 未指定时按 code 段推导（4xxx→400，其余→500）。

    data 可携带结构化补充信息（如 4001 校验失败时的 {"errors": [...]} 字段级清单）。
    """

    def __init__(self, code: int, message: str, http_status: int | None = None,
                 data: dict | None = None) -> None:
        self.code = code
        self.message = message
        self.data = data
        if http_status is None:
            # 错误码段推导：4004 资源不存在 → 404；其余 4xxx 客户端错误 → 400；5xxx 服务端错误 → 500
            if 4000 <= code < 5000:
                http_status = 404 if code == 4004 else 400
            else:
                http_status = 500
        self.http_status = http_status
        super().__init__(message)


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def handle_app_error(request: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.http_status,
            content={"code": exc.code, "message": exc.message, "data": exc.data},
        )

    @app.exception_handler(Exception)
    async def handle_unexpected_error(request: Request, exc: Exception) -> JSONResponse:
        return JSONResponse(
            status_code=500,
            content={"code": 5000, "message": f"服务内部错误：{exc}", "data": None},
        )
