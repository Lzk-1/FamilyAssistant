/** 理财数据导入导出弹窗（M3b · finance-module-design §5.7）。
 *  导出：CSV 列表 / JSON 备份 / ZIP 完整备份（含附件）三下载项。
 *  导入：选择 .json/.zip 备份 + merge 合并 / restore 清空恢复（危险确认），
 *  结果按表展示导入行数、跳过明细与附件文件恢复数。
 */

import { apiUpload } from "../../api.js";
import { el, btn, field, modal, toast, confirmModal } from "../../ui.js";

const TABLE_LABELS = {
  finance_members: "成员", finance_categories: "分类", finance_assets: "资产",
  finance_asset_values: "市值记录", finance_asset_events: "事件", finance_attachments: "附件",
};

/** 触发浏览器下载（响应带 Content-Disposition attachment，浏览器按文件名落盘） */
function download(url) {
  const a = document.createElement("a");
  a.href = url;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function openExportDialog() {
  const options = [
    { title: "CSV 资产列表", desc: "未删除资产的摘要表，Excel 可直接打开查看", url: "/api/v1/finance/export?format=csv" },
    { title: "JSON 数据备份", desc: "全量数据快照（成员/分类/资产/市值/事件/附件元数据），可用于导入恢复", url: "/api/v1/finance/export?format=json" },
    { title: "ZIP 完整备份", desc: "JSON 备份 + 附件物理文件打包，适合整机迁移与定期归档", url: "/api/v1/finance/export?format=json&attachments=1" },
  ];
  const body = el("div", {});
  for (const opt of options) {
    body.appendChild(el("div", {
      style: "display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--border)",
    }, [
      el("div", { style: "flex:1" }, [
        el("div", { text: opt.title, style: "font-weight:600" }),
        el("div", { text: opt.desc, class: "muted", style: "font-size:12px;margin-top:2px" }),
      ]),
      btn("下载", { variant: "secondary", size: "sm", icon: "download", onClick: () => download(opt.url) }),
    ]));
  }
  body.appendChild(el("p", {
    class: "muted", style: "font-size:12px;margin:12px 0 0",
    text: "建议定期导出 ZIP 完整备份并保存到其他位置；导入功能位于「导入」按钮。",
  }));
  const m = modal({ title: "导出理财数据", width: "narrow", body,
    footer: btn("关闭", { variant: "secondary", onClick: () => m.close() }) });
}

export function openImportDialog(onRefresh) {
  let file = null;
  let mode = "merge";

  const fileLabel = el("span", { class: "muted", text: "未选择文件", style: "font-size:13px" });
  const pickBtn = btn("选择备份文件", { variant: "secondary", size: "sm", icon: "upload", onClick: pickFile });
  const fileRow = el("div", { style: "display:flex;align-items:center;gap:10px" }, [pickBtn, fileLabel]);

  const mergeRadio = el("input", { type: "radio", name: "finance-import-mode", value: "merge" });
  mergeRadio.checked = true;
  const restoreRadio = el("input", { type: "radio", name: "finance-import-mode", value: "restore" });
  mergeRadio.addEventListener("click", () => setMode("merge"));
  restoreRadio.addEventListener("click", () => setMode("restore"));

  const restoreWarn = el("div", {
    style: "display:none;margin-top:8px;padding:10px 12px;border-radius:8px;background:var(--danger-bg,#fdecec);color:var(--danger,#b91c1c);font-size:13px;line-height:1.6",
    text: "清空恢复将删除当前全部理财数据（含附件物理文件），再恢复为备份内容，操作不可撤销。建议先导出一份当前数据。",
  });

  const progressWrap = el("div", { style: "display:none;margin-top:8px" }, [
    el("div", { class: "upload-progress" }, [el("div", { class: "upload-progress__bar", style: "width:0%" })]),
  ]);
  const resultBox = el("div", {});

  const body = el("div", {}, [
    field("备份文件（.json / .zip）", fileRow),
    field("导入模式", el("div", { style: "display:flex;flex-direction:column;gap:8px" }, [
      el("label", { style: "display:flex;gap:8px;align-items:flex-start;cursor:pointer" }, [
        mergeRadio,
        el("div", {}, [
          el("div", { text: "合并导入（merge）", style: "font-weight:600" }),
          el("div", { class: "muted", style: "font-size:12px", text: "按主键合并到现有数据，可恢复软删除行；适合同源备份恢复" }),
        ]),
      ]),
      el("label", { style: "display:flex;gap:8px;align-items:flex-start;cursor:pointer" }, [
        restoreRadio,
        el("div", {}, [
          el("div", { text: "清空恢复（restore）", style: "font-weight:600" }),
          el("div", { class: "muted", style: "font-size:12px", text: "先清空当前全部数据再完整恢复备份点" }),
        ]),
      ]),
    ])),
    restoreWarn,
    progressWrap,
    resultBox,
  ]);

  const submitBtn = btn("开始导入", { variant: "primary", icon: "check", onClick: submit });
  submitBtn.disabled = true;
  const m = modal({ title: "导入理财数据", width: "narrow", body,
    footer: el("div", { style: "display:flex;gap:10px" }, [
      btn("取消", { variant: "secondary", onClick: () => m.close() }),
      submitBtn,
    ]),
    onClose: () => { if (onRefresh) onRefresh(); } });

  function pickFile() {
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".json,.zip";
    fileInput.onchange = () => {
      file = fileInput.files[0] || null;
      fileLabel.textContent = file ? `${file.name}（${Math.max(1, Math.round(file.size / 1024))} KB）` : "未选择文件";
      fileLabel.classList.toggle("muted", !file);
      submitBtn.disabled = !file;
    };
    fileInput.click();
  }

  function setMode(next) {
    mode = next;
    restoreWarn.style.display = mode === "restore" ? "block" : "none";
  }

  async function submit() {
    if (!file) return;
    if (mode === "restore") {
      const go = await confirmModal({
        title: "确认清空恢复？",
        message: "当前全部理财数据将被删除并替换为备份内容，操作不可撤销。确定继续吗？",
        confirmLabel: "清空并恢复",
        danger: true,
      });
      if (!go) return;
    }
    submitBtn.disabled = true;
    progressWrap.style.display = "block";
    const bar = progressWrap.querySelector(".upload-progress__bar");
    try {
      const result = await apiUpload("/finance/import", file, {
        onProgress: (pct) => { bar.style.width = pct + "%"; },
        fields: { mode },
      });
      toast("导入完成", "ok");
      renderResult(result);
    } catch (err) {
      toast(err.errors ? err.errors.join("；") : err.message, "err");
      submitBtn.disabled = false;
      progressWrap.style.display = "none";
    }
  }

  function renderResult(result) {
    progressWrap.style.display = "none";
    submitBtn.style.display = "none";
    resultBox.innerHTML = "";
    const counts = Object.entries(result.imported || {})
      .map(([t, n]) => `${TABLE_LABELS[t] || t} ${n} 行`).join("，");
    resultBox.appendChild(el("p", { text: `已${result.mode === "restore" ? "清空恢复" : "合并导入"}：${counts}`, style: "margin:12px 0 0" }));
    if (result.files_restored) {
      resultBox.appendChild(el("p", { text: `已恢复 ${result.files_restored} 个附件物理文件`, style: "margin:8px 0 0" }));
    }
    const skipped = result.skipped || [];
    if (skipped.length) {
      resultBox.appendChild(el("p", { text: `跳过 ${skipped.length} 行：`, style: "margin:8px 0 4px" }));
      for (const s of skipped) {
        resultBox.appendChild(el("div", {
          class: "muted", style: "font-size:12px;line-height:1.8",
          text: `${TABLE_LABELS[s.table] || s.table} #${s.id}：${s.reason}`,
        }));
      }
    }
    resultBox.appendChild(el("p", {
      class: "muted", style: "font-size:12px;margin:12px 0 0",
      text: "关闭弹窗后列表将自动刷新。",
    }));
  }
}
