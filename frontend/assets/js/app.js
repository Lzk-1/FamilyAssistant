/** 前端入口：登录态引导 → 拉取模块注册表装配导航 → hash 路由分发。
 *
 * M4 认证流程（design §5）：
 * - bootstrap 先探测 /auth/me：401 渲染登录卡片；must_change_password 渲染强制改密视图
 * - 单机免登录模式（FA_AUTH_ENABLED=false）返回内置 admin + single_user_mode，
 *   直接进入应用且不渲染用户菜单（与 M0 行为一致）
 * - 401 统一钩子：会话过期时回登录视图；#/members 为特判路由（不入主导航）
 */

import { apiGet, apiPost, apiPut, setUnauthorizedHandler } from "./api.js";
import { icon } from "./icons.js";
import { el, btn, errorBanner, field, input, modal, toast, MODULE_ICON } from "./ui.js";
import { avatar } from "./avatar.js";
import * as finance from "./modules/finance.js";
import * as house from "./modules/house.js?v=0.8.0"; // ?v 击穿旧缓存：M0 占位版 house.js 曾被浏览器长期缓存
import * as car from "./modules/car.js?v=0.7.0"; // ?v 击穿旧缓存：M0 占位版 car.js 曾被浏览器长期缓存
import * as memo from "./modules/memo.js";
import * as files from "./modules/files.js";
import { renderLogin, renderForceChangePassword } from "./pages/auth/login.js";
import * as members from "./pages/auth/members.js";
import { openProfile } from "./pages/auth/profile.js";
import { session } from "./session.js";

/** 渲染器按模块 key 注册；与后端 core/registry.py 的 key 一一对应。 */
const RENDERERS = { finance, house, car, memo, files };

const nav = document.getElementById("nav");
const view = document.getElementById("view");
const sidebarFooter = document.querySelector(".sidebar-footer");

let modules = [];
let currentUser = null;      // null = 未登录（认证模式）
let singleUserMode = true;   // auth_enabled=false 旁路

function buildNav() {
  nav.innerHTML = "";
  for (const mod of modules) {
    nav.appendChild(el("a", { href: mod.path, "data-key": mod.key }, [
      icon(MODULE_ICON[mod.key] || "note", 18),
      mod.name,
    ]));
  }
}

function currentKey() {
  // 支持模块子路由：#/finance/assets/3?x=1 → finance
  const key = location.hash.replace(/^#\//, "").split(/[/?]/)[0];
  for (const a of nav.querySelectorAll("a")) {
    a.classList.toggle("active", a.dataset.key === key);
  }
  return key;
}

async function route() {
  // 登录/强制改密视图激活时，hash 变化不得接管 #view（含未登录探测前的 singleUserMode 初始值场景）
  if (document.body.classList.contains("login-mode")) return;
  view.innerHTML = "";
  // 特判路由：成员管理（admin，由用户菜单进入，不入模块注册表）
  if (location.hash === "#/members") {
    try {
      await members.render(view, currentUser);
    } catch (err) {
      view.appendChild(errorBanner(err.message));
    }
    return;
  }
  const key = currentKey();
  const mod = modules.find((m) => m.key === key);
  if (!mod || !RENDERERS[key]) {
    view.appendChild(errorBanner("未找到对应模块，请刷新页面或检查后端服务。"));
    return;
  }
  try {
    await RENDERERS[key].render(view, mod);
  } catch (err) {
    view.appendChild(errorBanner(err.message));
  }
}

// ============================================================
// 登录态管理（M4）
// ============================================================

function enterLogin() {
  document.body.classList.add("login-mode");
  buildUserMenu(null);
  setUnauthorizedHandler(null); // 登录表单内的失败就地展示
  renderLogin(view, async (data) => {
    currentUser = data.user;
    session.user = currentUser;
    singleUserMode = false; // 能走到登录流程即认证模式（bootstrap 401 时探测不到 single_user_mode）
    await assemble();
  });
}

/** 401 统一钩子：已登录用户会话过期时回登录视图。 */
setUnauthorizedHandler(() => {
  if (!currentUser) return;
  currentUser = null;
  session.user = null;
  toast("登录已过期，请重新登录", "warn");
  enterLogin();
});

async function assemble() {
  document.body.classList.remove("login-mode");
  if (!currentUser) return;
  if (currentUser.must_change_password) {
    document.body.classList.add("login-mode");
    renderForceChangePassword(view, currentUser, async () => {
      currentUser.must_change_password = false;
      await assemble();
    });
    return;
  }
  try {
    modules = await apiGet("/system/modules");
  } catch {
    modules = []; // 服务不可用：导航为空，路由阶段展示错误提示
  }
  buildNav();
  buildUserMenu(currentUser);
  if (!location.hash || location.hash === "#/login") {
    if (modules.length > 0) {
      location.hash = modules[0].path; // 赋值触发 hashchange → route()
      return;
    }
  }
  route();
}

/** 侧边栏底部用户块：单机免登录模式不渲染；头像 + 显示名（不显示角色），点击弹浮层菜单。 */
function buildUserMenu(user) {
  const old = document.getElementById("user-block");
  if (old) old.remove();
  if (!user || singleUserMode) return;

  const userBtn = el("button", {
    id: "user-block",
    class: "fa-btn fa-btn--ghost fa-btn--sm",
    title: "账户菜单",
    "aria-haspopup": "menu",
  }, [
    avatar(user, 28),
    el("span", { id: "user-block__name", text: user.display_name || user.username }),
    el("span", { id: "user-block__caret" }, [icon("chevron-down", 14)]),
  ]);
  userBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openUserMenu(userBtn, user);
  });
  sidebarFooter.prepend(userBtn);
}

/** 头像浮层菜单：个人中心 / 成员管理（admin）/ 退出登录。 */
function openUserMenu(anchor, user) {
  const existing = document.getElementById("user-popover");
  if (existing) { existing.remove(); return; } // 再次点击 = 收起

  const pop = el("div", { id: "user-popover", class: "fa-popover", role: "menu" });
  const items = [
    el("button", { class: "fa-popover__item", role: "menuitem" }, [
      icon("user", 16), document.createTextNode("个人中心"),
    ]),
    user.role === "admin"
      ? el("button", { class: "fa-popover__item", role: "menuitem" }, [
          icon("shield", 16), document.createTextNode("成员管理"),
        ])
      : null,
    el("div", { class: "fa-popover__divider" }),
    el("button", { class: "fa-popover__item fa-popover__item--danger", role: "menuitem" }, [
      icon("logout", 16), document.createTextNode("退出登录"),
    ]),
  ];
  const [profileItem, membersItem, , logoutItem] = items;
  profileItem.addEventListener("click", () => {
    close();
    openProfile(user, () => buildUserMenu(currentUser), openChangePassword);
  });
  if (membersItem) membersItem.addEventListener("click", () => {
    close();
    location.hash = "#/members";
  });
  logoutItem.addEventListener("click", () => { close(); doLogout(); });
  for (const it of items) if (it) pop.appendChild(it);
  document.body.appendChild(pop);

  // 定位：浮层出现在用户块上方，右边缘与用户块对齐（侧边栏宽 232px）
  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  pop.style.top = `${Math.max(8, r.top - ph - 8)}px`;
  pop.style.left = `${Math.max(8, Math.min(r.right - pw, window.innerWidth - pw - 8))}px`;

  function onDocClick(e) {
    if (!pop.contains(e.target)) close();
  }
  function onKey(e) {
    if (e.key === "Escape") close();
  }
  function close() {
    pop.remove();
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", close);
  }
  // 延迟注册 click，避免本次触发 click 立即命中 document 关闭
  setTimeout(() => {
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
  }, 0);
}

async function doLogout() {
  try {
    await apiPost("/auth/logout");
  } catch { /* 会话已失效也继续退出本地态 */ }
  currentUser = null;
  session.user = null;
  location.hash = "";
  enterLogin();
}

/** 本人修改密码弹窗。 */
function openChangePassword() {
  const oldInput = input({ type: "password", placeholder: "当前密码" });
  const newInput = input({ type: "password", placeholder: "新密码（至少 8 位）" });
  const confirmInput = input({ type: "password", placeholder: "再次输入新密码" });
  const m = modal({
    title: "修改密码",
    width: "narrow",
    body: el("div", { class: "dialog-grid dialog-grid--form" }, [
      field("当前密码", oldInput, { required: true }),
      field("新密码", newInput, { required: true }),
      field("确认新密码", confirmInput, { required: true }),
      el("p", { class: "muted", text: "修改成功后其他设备的登录状态将被吊销。" }),
    ]),
    footer: el("div", { class: "fa-dialog-actions" }, [
      btn("取消", { variant: "secondary", onClick: () => m.close() }),
      btn("保存", { variant: "primary", onClick: submit }),
    ]),
  });

  async function submit() {
    if (!newInput.value || newInput.value !== confirmInput.value) {
      toast("两次输入的新密码不一致", "warn");
      return;
    }
    try {
      await apiPut("/auth/password", {
        old_password: oldInput.value,
        new_password: newInput.value,
      });
      toast("密码已修改", "ok");
      m.close();
    } catch (err) {
      toast(err.message, "err");
    }
  }
}

// ============================================================
// 启动
// ============================================================

async function bootstrap() {
  try {
    const me = await apiGet("/auth/me");
    singleUserMode = !!me.single_user_mode;
    currentUser = me.user;
  } catch {
    currentUser = null; // 401：未登录（认证模式）
  }
  session.user = currentUser; // 单机旁路时为 null：isAdmin() 视为完全权限
  if (!currentUser) {
    enterLogin();
    return;
  }
  await assemble();
}

window.addEventListener("hashchange", route);
bootstrap();
