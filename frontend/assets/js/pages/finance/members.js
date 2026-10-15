/** 成员管理弹窗：列表 + 新增/编辑/停用。
 *  小号弹窗；成员增删改后 invalidateMembers 缓存并回调刷新。
 */

import { apiPost, apiPut } from "../../api.js";
import { el, btn, field, input, modal, toast } from "../../ui.js";
import { fetchMembers, invalidateMembers } from "./common.js";

export async function openMembersDialog(onRefresh) {
  let members = await fetchMembers();
  const body = el("div", {});
  const m = modal({
    title: "成员管理",
    width: "narrow",
    body,
    footer: btn("关闭", { variant: "secondary", onClick: () => m.close() }),
    onClose: () => { if (onRefresh) onRefresh(); },
  });

  renderList();

  function renderList() {
    body.innerHTML = "";

    // 新增表单
    const nameInput = input({ name: "name", placeholder: "成员姓名（如：配偶）" });
    const noteInput = input({ name: "note", placeholder: "备注（可选）" });
    body.appendChild(field("姓名", nameInput, { required: true }));
    body.appendChild(field("备注", noteInput));

    body.appendChild(btn("新增成员", {
      variant: "primary", icon: "plus", size: "sm",
      onClick: async () => {
        try {
          await apiPost("/finance/members", { name: nameInput.value, note: noteInput.value });
          invalidateMembers();
          members = await fetchMembers();
          toast("成员已添加", "ok");
          renderList();
        } catch (err) {
          toast(err.message, "err");
        }
      },
    }));

    body.appendChild(el("hr", { style: "border:none;border-top:1px solid var(--border);margin:16px 0" }));

    // 成员列表
    for (const mem of members) {
      const isDefault = mem.name === "本人";
      const row = el("div", { class: "member-row" }, [
        el("span", { class: "member-row__name", text: mem.name }),
        el("span", { class: "member-row__note", text: mem.note || "—" }),
        el("span", {}, [
          isDefault
            ? el("span", { class: "muted", text: "默认成员", style: "font-size:12px;color:var(--text-faint)" })
            : btn(mem.is_active ? "停用" : "启用", {
                variant: "ghost", size: "sm",
                onClick: async () => {
                  try {
                    await apiPut(`/finance/members/${mem.id}`, { is_active: !mem.is_active });
                    invalidateMembers();
                    members = await fetchMembers();
                    toast("已更新", "ok");
                    renderList();
                  } catch (err) { toast(err.message, "err"); }
                },
              }),
        ]),
      ]);
      body.appendChild(row);
    }
  }
}
