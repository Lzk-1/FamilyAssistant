/** 新增/编辑资产弹窗：按分类动态字段模板 + 实时计算预览。
 *  对话框从台账/总览/日历均可发起；编辑模式预填已有数据。
 */

import { apiGet, apiPost, apiPut, apiDelete, apiUpload } from "../../api.js";
import { el, btn, iconBtn, field, input, select, textarea, modal, toast, confirmModal } from "../../ui.js";
import { CATEGORY_MAP, yuanToCents, computePreview, fetchCategories, fetchMembers } from "./common.js";

// 分类专属字段模板定义（镜像后端 _EXTRA_RULES）
const EXTRA_DEFS = {
  fixed_deposit: [
    { key: "deposit_no", label: "存单号", type: "text" },
    { key: "auto_renew", label: "自动转存", type: "select", options: [{ value: "0", label: "否" }, { value: "1", label: "是" }] },
  ],
  demand: [
    { key: "last_update_date", label: "余额更新日期", type: "date" },
  ],
  wealth: [
    { key: "risk_level", label: "风险等级", type: "select", options: ["", "R1", "R2", "R3", "R4", "R5"].map((v) => ({ value: v, label: v || "请选择" })) },
    { key: "base_rate", label: "业绩基准年化(%)", type: "number" },
  ],
  metal: [
    { key: "variety", label: "品种", type: "text", placeholder: "金/银/铂" },
    { key: "form", label: "形式", type: "select", options: [{ value: "", label: "请选择" }, { value: "physical", label: "实物" }, { value: "paper", label: "纸黄金" }, { value: "accumulate", label: "积存金" }] },
    { key: "quantity", label: "持有数量", type: "number", placeholder: "如 10（克）" },
    { key: "cost_price", label: "成本单价(元)", type: "money" },
    { key: "current_price", label: "当前单价(元)", type: "money" },
  ],
  stock: [
    { key: "code", label: "代码", type: "text" },
    { key: "market", label: "市场", type: "text", placeholder: "A股/港股/美股" },
    { key: "quantity", label: "持仓数量", type: "number" },
    { key: "cost", label: "成本金额(元)", type: "money" },
  ],
  loan_out: [
    { key: "repay_method", label: "还款方式", type: "select", options: [{ value: "", label: "请选择" }, { value: "once", label: "到期一次还" }, { value: "installment", label: "分期还" }] },
    { key: "relation", label: "关系备注", type: "text", placeholder: "如：朋友/亲戚" },
  ],
  loan_in: [
    { key: "repay_method", label: "还款方式", type: "select", options: [{ value: "", label: "请选择" }, { value: "once", label: "到期一次还" }, { value: "installment", label: "分期还" }] },
    { key: "relation", label: "关系备注", type: "text", placeholder: "如：朋友/亲戚" },
  ],
  mortgage: [
    { key: "total", label: "贷款总额(元)", type: "money" },
    { key: "monthly_payment", label: "月供(元)", type: "money" },
    { key: "pay_day", label: "还款日", type: "select", options: Array.from({ length: 28 }, (_, i) => ({ value: String(i + 1), label: `每月${i + 1}日` })) },
  ],
  credit_card: [
    { key: "bill_day", label: "账单日", type: "select", options: Array.from({ length: 28 }, (_, i) => ({ value: String(i + 1), label: `每月${i + 1}日` })) },
    { key: "repay_day", label: "还款日", type: "select", options: Array.from({ length: 28 }, (_, i) => ({ value: String(i + 1), label: `每月${i + 1}日` })) },
    { key: "installment", label: "分期中", type: "select", options: [{ value: "0", label: "否" }, { value: "1", label: "是" }] },
  ],
  bond_insurance: [],
  asset_other: [],
  liability_other: [],
};

// 有"年利率"概念的分类（理财用业绩基准年化 extra.base_rate，其余分类无利率字段）
const RATE_CATEGORIES = new Set(["fixed_deposit", "loan_out", "loan_in", "mortgage"]);
const RATE_LABELS = {
  fixed_deposit: "年利率(%)",
  loan_out: "约定年利率(%)",
  loan_in: "约定年利率(%)",
  mortgage: "贷款年利率(%)",
};

/**
 * 打开资产新增/编辑弹窗。
 * @param {object|null} asset 编辑模式时传入已有资产；新增模式传 null
 * @param {function} onSaved 保存成功回调（通常刷新列表）
 */
export async function openAssetDialog(asset, onSaved) {
  const isEdit = !!asset;
  const categories = await fetchCategories();
  let members = await fetchMembers();

  // 表单状态
  const form = {
    name: asset?.name || "",
    direction: asset?.direction || "asset",
    category: asset?.category || "fixed_deposit",
    holder_member_id: asset?.holder_member_id || members[0]?.id || 1,
    institution: asset?.institution || "",
    amount: asset ? (asset.amount_cents / 100).toString() : "",
    start_date: asset?.start_date || "",
    end_date: asset?.end_date || "",
    annual_rate: asset?.annual_rate != null ? String(asset.annual_rate) : "",
    note: asset?.note || "",
    extra: {},
  };

  // 初始化 extra（从已有数据的 extra_data 或空）
  if (asset?.extra_data) {
    form.extra = { ...asset.extra_data };
    // metal/stock 的 *_cents 字段转回元
    for (const key of Object.keys(form.extra)) {
      if (key.endsWith("_cents") && form.extra[key] != null) {
        const yuanKey = key.replace("_cents", "");
        form.extra[yuanKey] = (form.extra[key] / 100).toString();
      }
    }
  }

  // DOM 引用
  const formEl = el("div", { class: "dialog-grid" });
  const attachmentsEl = el("div", {});
  const previewEl = el("div", { class: "dialog-preview" });
  const errorEl = el("div", {});
  const bodyContainer = el("div", {}, [errorEl, formEl, attachmentsEl, previewEl]);

  // 附件（编辑模式已有资产 id，可直接上传/删除；新增模式提示保存后再传）
  let attachments = [];
  let progressBox = el("div", {});
  if (isEdit) {
    try {
      const detail = await apiGet(`/finance/assets/${asset.id}`);
      attachments = detail.attachments || [];
    } catch {
      attachments = asset.attachments || [];
    }
  }

  async function refreshAttachments() {
    const detail = await apiGet(`/finance/assets/${asset.id}`);
    attachments = detail.attachments || [];
    renderAttachments();
  }

  function pickFile() {
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".jpg,.jpeg,.png,.webp,.heic,.pdf";
    fileInput.onchange = async () => {
      const file = fileInput.files[0];
      if (!file) return;
      const bar = el("div", { class: "upload-progress" }, [
        el("div", { class: "upload-progress__bar", style: "width:0%" }),
      ]);
      progressBox.appendChild(bar);
      try {
        await apiUpload(`/finance/assets/${asset.id}/attachments`, file, {
          onProgress: (pct) => { bar.querySelector(".upload-progress__bar").style.width = pct + "%"; },
        });
        toast("上传成功", "ok");
        await refreshAttachments();
      } catch (err) {
        toast(err.errors ? err.errors.join("；") : err.message, "err");
        bar.remove();
      }
    };
    fileInput.click();
  }

  function renderAttachments() {
    attachmentsEl.innerHTML = "";
    if (!isEdit) {
      attachmentsEl.appendChild(el("p", {
        class: "muted",
        text: "保存后可在详情页或编辑弹窗中上传借据照片、存单扫描件等附件。",
        style: "margin:4px 0 12px",
      }));
      return;
    }
    const header = el("div", {
      style: "display:flex;align-items:center;justify-content:space-between;margin:4px 0 8px;border-top:1px dashed var(--border);padding-top:12px",
    }, [
      el("h4", { text: `附件材料（${attachments.length}/20）`, style: "font-size:13px;font-weight:600" }),
      btn("上传附件", { variant: "secondary", size: "sm", icon: "upload", onClick: pickFile }),
    ]);
    attachmentsEl.appendChild(header);

    if (attachments.length === 0) {
      attachmentsEl.appendChild(el("p", {
        class: "muted", text: "暂无附件，点击「上传附件」归档借据、存单等关键材料。",
        style: "margin:0 0 8px",
      }));
    } else {
      for (const att of attachments) {
        attachmentsEl.appendChild(el("div", { class: "detail-attachment" }, [
          iconBtn("download", {
            variant: "ghost", size: "sm", title: "下载",
            onClick: () => { window.open(`/api/v1/finance/attachments/${att.id}/download`, "_blank"); },
          }),
          el("span", { class: "detail-attachment__name", text: att.file_name }),
          el("span", { class: "detail-attachment__size", text: `${(att.file_size / 1024).toFixed(0)} KB` }),
          iconBtn("trash", {
            variant: "ghost", size: "sm", title: "删除",
            onClick: async () => {
              const ok = await confirmModal({
                title: "删除附件", message: `确定删除「${att.file_name}」？`, confirmLabel: "删除", danger: true,
              });
              if (ok) {
                try { await apiDelete(`/finance/attachments/${att.id}`); toast("已删除", "ok"); await refreshAttachments(); }
                catch (err) { toast(err.message, "err"); }
              }
            },
          }),
        ]));
      }
    }
    progressBox = el("div", {});
    attachmentsEl.appendChild(progressBox);
  }

  function renderForm() {
    formEl.innerHTML = "";
    errorEl.innerHTML = "";

    // 分类选择
    const catOptions = categories
      .filter((c) => c.is_active)
      .map((c) => ({ value: c.code, label: `${c.direction === "asset" ? "资产" : "负债"} · ${c.name}` }));
    const catSelect = select("category", catOptions, {
      value: form.category,
      onChange: (v) => { form.category = v; form.direction = CATEGORY_MAP[v]?.direction || form.direction; renderForm(); },
    });

    // 方向选择
    const dirSelect = select("direction", [
      { value: "asset", label: "资产" },
      { value: "liability", label: "负债" },
    ], {
      value: form.direction,
      onChange: (v) => { form.direction = v; },
    });

    // 归属人选择
    const holderOptions = members
      .filter((m) => m.is_active)
      .map((m) => ({ value: String(m.id), label: m.name }));
    const holderSelect = select("holder_member_id", holderOptions, {
      value: String(form.holder_member_id),
      onChange: (v) => { form.holder_member_id = parseInt(v); },
    });

    // 金额输入
    const amountInput = input({
      type: "number", name: "amount", value: form.amount, placeholder: "0.00",
      onInput: (e) => { form.amount = e.target.value; updatePreview(); },
    });

    // 公共字段
    formEl.appendChild(field("名称", input({
      name: "name", value: form.name, placeholder: "如：工商银行定期存款",
      onInput: (e) => { form.name = e.target.value; },
    }), { required: true }));

    formEl.appendChild(field("分类", catSelect, { required: true }));
    formEl.appendChild(field("方向", dirSelect, { required: true }));
    formEl.appendChild(field("归属人", holderSelect, { required: true }));
    // 机构字段按分类改名（房贷=贷款银行、信用卡=发卡行，design §4.3）
    const institutionLabel = { mortgage: "贷款银行", credit_card: "发卡行" }[form.category] || "机构/交易对手";
    formEl.appendChild(field(institutionLabel, input({
      name: "institution", value: form.institution, placeholder: "银行/机构/借款人",
      onInput: (e) => { form.institution = e.target.value; },
    })));

    // 金额（money 类型用 number input，存为 yuan 字符串，提交时转 cents）
    formEl.appendChild(field("金额(元)", amountInput, { required: true }));

    // 日期与利率
    formEl.appendChild(field("开始日期", input({
      type: "date", name: "start_date", value: form.start_date,
      onInput: (e) => { form.start_date = e.target.value; updatePreview(); },
    })));

    formEl.appendChild(field("到期日", input({
      type: "date", name: "end_date", value: form.end_date,
      onInput: (e) => { form.end_date = e.target.value; updatePreview(); },
    })));

    // 年利率仅对有利率概念的分类显示（定期必填；外借/外债/房贷可空）
    if (RATE_CATEGORIES.has(form.category)) {
      formEl.appendChild(field(RATE_LABELS[form.category], input({
        type: "number", name: "annual_rate", value: form.annual_rate, placeholder: "如 3.5",
        onInput: (e) => { form.annual_rate = e.target.value; updatePreview(); },
      }), { required: form.category === "fixed_deposit" }));
    }

    // 分类专属字段
    const defs = EXTRA_DEFS[form.category] || [];
    for (const def of defs) {
      const control = renderExtraField(def);
      formEl.appendChild(field(def.label, control));
    }

    // 备注
    formEl.appendChild(field("备注", textarea({
      name: "note", value: form.note, rows: 2, placeholder: "补充说明",
      onInput: (e) => { form.note = e.target.value; },
    })));

    updatePreview();
  }

  function renderExtraField(def) {
    if (def.type === "select") {
      return select(`extra_${def.key}`, def.options, {
        value: String(form.extra[def.key] || ""),
        onChange: (v) => { form.extra[def.key] = v; updatePreview(); },
      });
    }
    const type = def.type === "money" ? "number" : def.type === "date" ? "date" : "text";
    return input({
      type, name: `extra_${def.key}`, value: String(form.extra[def.key] || ""),
      placeholder: def.placeholder || "",
      onInput: (e) => { form.extra[def.key] = e.target.value; updatePreview(); },
    });
  }

  function updatePreview() {
    const items = computePreview(form.category, form);
    previewEl.innerHTML = "";
    if (items.length === 0) return;
    previewEl.appendChild(el("div", { class: "dialog-preview__title", text: "实时计算预览" }));
    for (const item of items) {
      previewEl.appendChild(el("div", { class: "dialog-preview__row" }, [
        el("span", { text: item.label }),
        el("span", { class: "dialog-preview__value", text: item.value }),
      ]));
    }
  }

  // 收集提交数据
  function collectPayload() {
    const payload = {
      name: form.name,
      direction: form.direction,
      category: form.category,
      holder_member_id: form.holder_member_id,
      institution: form.institution,
      amount_cents: yuanToCents(form.amount),
      start_date: form.start_date || null,
      end_date: form.end_date || null,
      // 年利率仅利率类分类提交；其他分类显式清空（编辑时若原分类有利率而新分类无）
      annual_rate: RATE_CATEGORIES.has(form.category) && form.annual_rate
        ? parseFloat(form.annual_rate) : null,
      note: form.note,
      extra: {},
    };

    // extra：money 类型字段转 cents
    const defs = EXTRA_DEFS[form.category] || [];
    for (const def of defs) {
      const v = form.extra[def.key];
      if (v != null && v !== "") {
        if (def.type === "money") {
          payload.extra[def.key + "_cents"] = yuanToCents(v);
        } else if (def.type === "number") {
          payload.extra[def.key] = parseFloat(v);
        } else {
          payload.extra[def.key] = v;
        }
      }
    }

    return payload;
  }

  // 显示错误清单
  function showErrors(errors) {
    errorEl.innerHTML = "";
    if (errors && errors.length > 0) {
      const list = el("div", { class: "error-list" }, [
        el("ul", {}, errors.map((e) => el("li", { text: e }))),
      ]);
      errorEl.appendChild(list);
    }
  }

  // 提交
  async function submit() {
    const payload = collectPayload();
    try {
      if (isEdit) {
        await apiPut(`/finance/assets/${asset.id}`, payload);
        toast("更新成功", "ok");
      } else {
        await apiPost("/finance/assets", payload);
        toast("创建成功", "ok");
      }
      m.close();
      if (onSaved) onSaved();
    } catch (err) {
      if (err.errors && err.errors.length > 0) {
        showErrors(err.errors);
      } else {
        toast(err.message, "err");
      }
    }
  }

  // 弹窗
  const footer = el("div", {}, [
    btn("取消", { variant: "secondary", onClick: () => m.close() }),
    btn(isEdit ? "保存" : "创建", { variant: "primary", icon: "check", onClick: submit }),
  ]);

  const m = modal({
    title: isEdit ? "编辑资产" : "新增资产",
    width: "wide",
    body: bodyContainer,
    footer,
  });

  renderForm();
  renderAttachments();
}
