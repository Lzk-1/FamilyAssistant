/** 个人中心弹窗（M4.1）：头像上传/移除、显示名修改、跳转修改密码。
 *  仅本人域操作；角色/用户名只读。成员管理（管理域）在独立页面 #/members。
 */

import { apiPut, apiDelete, apiUpload } from "../../api.js";
import { el, btn, field, input, modal, toast } from "../../ui.js";
import { avatar } from "../../avatar.js";

/**
 * @param user 当前登录用户对象（会被原地更新头像/显示名）
 * @param onChange 资料变更后回调（app.js 刷新侧边栏用户块）
 * @param onChangePassword 点击「修改密码」回调（复用 app.js 的改密弹窗）
 */
export function openProfile(user, onChange, onChangePassword) {
  const nameInput = input({ name: "display_name", value: user.display_name });
  let busy = false;

  const avatarSlot = el("span", {}, [avatar(user, 72)]);

  // 无障碍文件输入：视觉隐藏但可点击/聚焦（memory 既有教训）
  const fileInput = el("input", {
    type: "file", accept: "image/jpeg,image/png,image/webp",
    class: "fa-sr-only", "aria-label": "选择头像图片",
  });
  const uploadBtn = btn("上传头像", { variant: "secondary", size: "sm", icon: "upload" });
  uploadBtn.addEventListener("click", () => fileInput.click());
  const removeBtn = btn("移除", { variant: "danger-ghost", size: "sm" });
  removeBtn.addEventListener("click", removeAvatar);
  fileInput.addEventListener("change", onPick);

  function renderAvatar() {
    avatarSlot.innerHTML = "";
    avatarSlot.appendChild(avatar(user, 72));
    removeBtn.style.display = user.avatar_path ? "" : "none";
  }

  async function onPick() {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    busy = true;
    uploadBtn.disabled = true;
    try {
      const data = await apiUpload("/auth/avatar", file);
      user.avatar_path = data.avatar_path;
      renderAvatar();
      toast("头像已更新", "ok");
    } catch (err) {
      toast(err.errors ? err.errors.join("；") : err.message, "err");
    } finally {
      fileInput.value = ""; // 允许再次选择同一文件
      uploadBtn.disabled = false;
      busy = false;
    }
  }

  async function removeAvatar() {
    busy = true;
    try {
      await apiDelete("/auth/avatar");
      user.avatar_path = "";
      renderAvatar();
      toast("已恢复默认头像", "ok");
    } catch (err) {
      toast(err.message, "err");
    } finally {
      busy = false;
    }
  }

  const changePwBtn = btn("修改密码", {
    variant: "ghost", icon: "lock",
    onClick: () => { m.close(); onChangePassword(); },
  });
  changePwBtn.classList.add("fa-dialog-spacer"); // 与右侧主次按钮分组

  const m = modal({
    title: "个人中心",
    width: "narrow",
    body: el("div", { class: "dialog-grid dialog-grid--form" }, [
      el("div", { class: "avatar-editor" }, [
        avatarSlot,
        el("div", { class: "avatar-editor__meta" }, [
          el("div", { style: "display:flex;gap:8px;align-items:center" }, [uploadBtn, removeBtn, fileInput]),
          el("span", { class: "avatar-editor__hint", text: "支持 JPG / PNG / WebP，不超过 2 MB" }),
        ]),
      ]),
      el("p", { class: "muted", text: `用户名：${user.username}` }),
      field("显示名", nameInput, { required: true }),
    ]),
    footer: el("div", { class: "fa-dialog-actions" }, [
      changePwBtn,
      btn("关闭", { variant: "secondary", onClick: () => m.close() }),
      btn("保存资料", { variant: "primary", icon: "check", onClick: saveProfile }),
    ]),
  });
  renderAvatar();
  nameInput.focus();

  async function saveProfile() {
    const name = nameInput.value.trim();
    if (!name) { toast("显示名不能为空", "warn"); return; }
    if (busy) return;
    try {
      const updated = await apiPut("/auth/profile", { display_name: name });
      Object.assign(user, { display_name: updated.display_name, avatar_path: updated.avatar_path });
      toast("资料已保存", "ok");
      onChange(user);
      m.close();
    } catch (err) {
      toast(err.message, "err");
    }
  }
}
