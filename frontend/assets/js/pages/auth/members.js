/** 成员管理页（admin 限定，M4 design §5.4）：#/members 特判路由，不入主导航。
 *  由用户菜单进入；单机免登录模式下不可达（用户菜单隐藏）。
 */

import { apiGet, apiPost, apiPut } from "../../api.js";
import { el, btn, card, tag, field, input, select, modal, toast, confirmModal, errorBanner } from "../../ui.js";
import { avatar } from "../../avatar.js";

const ROLE_LABELS = { admin: "管理员", member: "成员" };

function fmtTime(s) {
  return s ? s.slice(0, 16) : "—";
}

function roleTag(role) {
  return tag(ROLE_LABELS[role] || role, role === "admin" ? "primary" : "muted");
}

function statusTag(isActive) {
  return isActive ? tag("启用", "ok") : tag("已禁用", "danger");
}

export async function render(root, currentUser) {
  root.innerHTML = "";
  if (!currentUser || currentUser.role !== "admin") {
    root.appendChild(errorBanner("成员管理需要管理员权限，且仅在启用认证（FA_AUTH_ENABLED=true）后可用。"));
    return;
  }

  const refresh = () => render(root, currentUser);

  let users;
  try {
    users = await apiGet("/auth/users");
  } catch (err) {
    root.appendChild(errorBanner(err.message));
    return;
  }

  // ---------- 页头 ----------
  const header = el("div", { class: "detail-header" }, [
    btn("", { variant: "ghost", icon: "close", title: "返回", onClick: () => { location.hash = "#/finance"; } }),
    el("h2", { text: "成员管理" }),
    el("span", { class: "muted", text: "管理员直接建号（家庭 2~8 人协作）" }),
    el("div", { style: "flex:1" }),
    btn("新建成员", { variant: "primary", icon: "plus", onClick: () => openCreate(refresh) }),
  ]);
  root.appendChild(header);

  // ---------- 表格 ----------
  const thead = el("thead", {}, [el("tr", {}, ["成员", "用户名", "角色", "状态", "活跃会话", "最近活跃", "创建时间", "操作"]
    .map((t) => el("th", { text: t })))]);
  const tbody = el("tbody", {}, users.map((u) => {
    const isSelf = u.id === currentUser.id;
    const isFirst = u.id === 1;
    const actions = el("div", { class: "fa-dialog-actions", style: "justify-content:flex-end;gap:6px" }, [
      btn("编辑", { variant: "secondary", size: "sm", onClick: () => openEdit(u, isSelf, isFirst, refresh) }),
      btn("重置密码", { variant: "ghost", size: "sm", onClick: () => openResetPassword(u, refresh) }),
    ]);
    // 成员格：头像 + 显示名（自己加「我」角注）；头像仅本人可更换，此处只读展示
    const memberCell = el("div", { class: "member-cell" }, [
      avatar(u, 34),
      el("span", { class: "member-cell__name", text: u.display_name + (isSelf ? "（我）" : "") }),
    ]);
    const cells = [
      memberCell,
      u.username,
      roleTag(u.role),
      statusTag(u.is_active),
      String(u.active_sessions ?? 0),
      fmtTime(u.recent_active_at),
      fmtTime(u.created_at),
      actions,
    ];
    return el("tr", {}, cells.map((c) =>
      c instanceof Node ? el("td", {}, [c]) : el("td", { text: c })));
  }));
  const tableWrap = card(null, el("table", { class: "table" }, [thead, tbody]));
  root.appendChild(tableWrap);

  if (users.some((u) => u.id === 1)) {
    root.appendChild(el("p", { class: "muted", text: "说明：首管理员（ID 1）不可禁用或降级；成员仅可禁用不可删除，以保护历史数据的归属引用。" }));
  }
}

// ============================================================
// 新建成员
// ============================================================

function openCreate(refresh) {
  const userInput = input({ name: "username", placeholder: "登录用户名（≤32 字符）" });
  const passInput = input({ type: "password", name: "password", placeholder: "初始密码（至少 8 位）" });
  const nameInput = input({ name: "display_name", placeholder: "侧边栏显示名（可选）" });
  const roleSel = select("role", [
    { value: "member", label: "成员" },
    { value: "admin", label: "管理员" },
  ]);

  const m = modal({
    title: "新建成员",
    body: el("div", { class: "dialog-grid dialog-grid--form" }, [
      field("用户名", userInput, { required: true }),
      field("初始密码", passInput, { required: true }),
      field("显示名", nameInput),
      field("角色", roleSel),
      el("p", { class: "muted", text: "成员首次登录时将被要求修改初始密码。" }),
    ]),
    footer: el("div", { class: "fa-dialog-actions" }, [
      btn("取消", { variant: "secondary", onClick: () => m.close() }),
      btn("创建", { variant: "primary", onClick: submit }),
    ]),
  });

  async function submit() {
    try {
      await apiPost("/auth/users", {
        username: userInput.value.trim(),
        password: passInput.value,
        display_name: nameInput.value.trim(),
        role: roleSel.value,
      });
      toast("成员已创建", "ok");
      m.close();
      refresh();
    } catch (err) {
      toast(err.errors ? err.errors.join("；") : err.message, "err");
    }
  }
}

// ============================================================
// 编辑成员
// ============================================================

function openEdit(u, isSelf, isFirst, refresh) {
  const nameInput = input({ name: "display_name", value: u.display_name });
  const roleSel = select("role", [
    { value: "member", label: "成员", disabled: (isFirst || isSelf) && u.role === "admin" },
    { value: "admin", label: "管理员" },
  ], { value: u.role });
  const stateSel = select("is_active", [
    { value: "1", label: "启用" },
    { value: "0", label: "禁用", disabled: (isFirst || isSelf) && u.is_active },
  ], { value: u.is_active ? "1" : "0" });

  const notes = [];
  if (isFirst) notes.push("首管理员：不可禁用、不可降级");
  if (isSelf) notes.push("当前登录账号：不可自我禁用或降级");
  if (!u.is_active) notes.push("该成员已被禁用，重新启用后需重新登录");

  const m = modal({
    title: `编辑成员 · ${u.username}`,
    body: el("div", { class: "dialog-grid dialog-grid--form" }, [
      field("显示名", nameInput, { required: true }),
      field("角色", roleSel),
      field("状态", stateSel),
      notes.length ? el("p", { class: "muted", text: notes.join("；") }) : null,
      el("p", { class: "muted", text: "禁用会立即吊销该成员的全部登录会话。" }),
    ]),
    footer: el("div", { class: "fa-dialog-actions" }, [
      btn("取消", { variant: "secondary", onClick: () => m.close() }),
      btn("保存", { variant: "primary", onClick: submit }),
    ]),
  });

  async function submit() {
    try {
      await apiPut(`/auth/users/${u.id}`, {
        display_name: nameInput.value.trim(),
        role: roleSel.value,
        is_active: stateSel.value === "1",
      });
      toast("成员信息已更新", "ok");
      m.close();
      refresh();
    } catch (err) {
      toast(err.message, "err");
    }
  }
}

// ============================================================
// 重置密码
// ============================================================

function openResetPassword(u, refresh) {
  confirmModal({
    title: "重置密码",
    message: `确定重置「${u.username}」的密码吗？该成员的登录状态将全部失效。`,
    confirmLabel: "继续",
    danger: true,
  }).then((ok) => {
    if (!ok) return;
    const passInput = input({ type: "password", name: "password", placeholder: "新密码（至少 8 位）" });
    const m = modal({
      title: `重置密码 · ${u.username}`,
      body: el("div", { class: "dialog-grid dialog-grid--form" }, [
        field("新密码", passInput, { required: true }),
        el("p", { class: "muted", text: "重置后该成员全部会话被吊销，下次登录须修改密码后才能使用。" }),
      ]),
      footer: el("div", { class: "fa-dialog-actions" }, [
        btn("取消", { variant: "secondary", onClick: () => m.close() }),
        btn("重置", { variant: "danger", onClick: submit }),
      ]),
    });
    async function submit() {
      try {
        await apiPut(`/auth/users/${u.id}/password`, { password: passInput.value });
        toast("密码已重置", "ok");
        m.close();
        refresh();
      } catch (err) {
        toast(err.errors ? err.errors.join("；") : err.message, "err");
      }
    }
  });
}
