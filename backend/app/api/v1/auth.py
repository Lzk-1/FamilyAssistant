"""认证模块 API：登录/登出/本人信息/本人改密 + 成员管理（admin）。

设计依据 docs/multi-user-module-design.md §6。登录公开（CSRF 豁免），
其余会话接口经 get_current_user（含写方法 X-Requested-With 校验），
成员管理经 require_admin。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, File, Request, Response, UploadFile
from fastapi.responses import FileResponse

from app.api.deps import get_current_user, get_db, get_settings, require_admin
from app.core.errors import AppError
from app.core.responses import ok
from app.services import auth as auth_service
from app.services.auth import SESSION_COOKIE

router = APIRouter()


def _set_session_cookie(request: Request, response: Response, token: str, max_age: int) -> None:
    """HttpOnly + SameSite=Lax；HTTPS 部署时附加 Secure（本机 127.0.0.1 不受影响）。"""
    response.set_cookie(
        SESSION_COOKIE, token,
        max_age=max_age, httponly=True, samesite="lax", path="/",
        secure=request.url.scheme == "https",
    )


def _request_token(request: Request) -> str:
    return request.cookies.get(SESSION_COOKIE) or ""


@router.get("/me")
def me(request: Request, user=Depends(get_current_user)) -> dict:
    """当前用户信息；单机免登录模式返回内置 admin + single_user_mode 标记。"""
    settings = request.app.state.settings
    return ok({"user": user, "single_user_mode": not settings.auth_enabled})


@router.post("/login")
def login(payload: dict, request: Request, response: Response, conn=Depends(get_db)) -> dict:
    """登录：校验 → 透明哈希升级 → 签发会话 → Set-Cookie。错误信息统一防用户枚举。"""
    data = auth_service.login(
        conn,
        (payload.get("username") or "").strip(),
        payload.get("password") or "",
        request.headers.get("user-agent", ""),
    )
    _set_session_cookie(request, response, data["token"], data["cookie_max_age"])
    return ok({"user": data["user"], "must_change_password": data["must_change_password"],
               "single_user_mode": False})


@router.post("/logout", dependencies=[Depends(get_current_user)])
def logout(request: Request, response: Response, conn=Depends(get_db)) -> dict:
    """登出：删除当前会话行（即吊销）+ 清除 cookie。"""
    token = _request_token(request)
    if token:
        auth_service.logout(conn, token)
    response.delete_cookie(SESSION_COOKIE, path="/")
    return ok()


@router.put("/password")
def change_password(payload: dict, request: Request, conn=Depends(get_db),
                    user=Depends(get_current_user)) -> dict:
    """本人改密（old/new）：吊销其他会话、清强制改密标记。"""
    result = auth_service.change_password(
        conn, user["id"],
        payload.get("old_password") or "",
        payload.get("new_password"),
        _request_token(request),
    )
    return ok(result)


@router.put("/profile")
def update_profile(payload: dict, conn=Depends(get_db),
                   user=Depends(get_current_user)) -> dict:
    """本人更新自己的显示名（不含用户名/角色）。"""
    return ok(auth_service.update_profile(conn, user["id"], payload))


# ---------- 头像（本人管理；读图对所有登录用户开放，成员表格需要） ----------

@router.post("/avatar")
def upload_avatar(upload: UploadFile = File(...), conn=Depends(get_db),
                  settings=Depends(get_settings), user=Depends(get_current_user)) -> dict:
    data = upload.file.read(auth_service.AVATAR_MAX_SIZE + 1)
    if len(data) > auth_service.AVATAR_MAX_SIZE:
        raise AppError(4001, "file: 头像不能超过 2 MB")
    result = auth_service.save_avatar(conn, settings.upload_dir, user["id"],
                                      upload.filename or "avatar.jpg", data)
    return ok(result)


@router.get("/users/{user_id}/avatar", dependencies=[Depends(get_current_user)])
def read_avatar(user_id: int, conn=Depends(get_db), settings=Depends(get_settings)) -> FileResponse:
    """返回头像图片（<img src> 同源请求自带会话 cookie）。"""
    media_type, full = auth_service.get_avatar_file(conn, settings.upload_dir, user_id)
    return FileResponse(full, media_type=media_type)


@router.delete("/avatar")
def remove_avatar(conn=Depends(get_db), settings=Depends(get_settings),
                  user=Depends(get_current_user)) -> dict:
    auth_service.delete_avatar(conn, settings.upload_dir, user["id"])
    return ok({"avatar_path": ""})


# ---------- 成员管理（admin 限定） ----------

@router.get("/users", dependencies=[Depends(require_admin)])
def list_users(conn=Depends(get_db)) -> dict:
    return ok(auth_service.list_users(conn))


@router.post("/users", dependencies=[Depends(require_admin)])
def create_user(payload: dict, conn=Depends(get_db)) -> dict:
    return ok(auth_service.create_user(conn, payload))


@router.put("/users/{user_id}", dependencies=[Depends(require_admin)])
def update_user(user_id: int, payload: dict, conn=Depends(get_db)) -> dict:
    return ok(auth_service.update_user(conn, user_id, payload))


@router.put("/users/{user_id}/password", dependencies=[Depends(require_admin)])
def reset_member_password(user_id: int, payload: dict, conn=Depends(get_db)) -> dict:
    return ok(auth_service.reset_member_password(conn, user_id, payload))
