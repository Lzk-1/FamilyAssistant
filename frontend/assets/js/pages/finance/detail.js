/** 资产详情页：关键数字 + 信息 + 市值历史 + 附件 + 操作日志 + 状态流转。
 *  路由：#/finance/assets/:id
 *  权限（M4.1）：编辑/删除/流转/附件上传删除/市值与收益记录删除均仅 admin；成员只读。
 */

import { apiGet, apiPost, apiDelete, apiUpload } from "../../api.js";
import { el, btn, iconBtn, card, tag, emptyState, modal, toast, confirmModal, input, field, errorBanner } from "../../ui.js";
import { isAdmin } from "../../session.js";
import { fmtMoney, dueText, fmtMonth, statusVariant, STATUS_LABELS, SETTLE_LABELS, settleActions, CATEGORY_MAP, todayISO, yuanToCents } from "./common.js";
import { openAssetDialog } from "./dialog.js";

export async function renderDetail(root, assetId) {
  root.innerHTML = ""; // 刷新场景（编辑/流转/附件操作后重入）：先清空再渲染，避免内容堆叠
  let asset;
  try {
    asset = await apiGet(`/finance/assets/${assetId}`);
  } catch (err) {
    root.appendChild(errorBanner(err.message));
    return;
  }
  const admin = isAdmin();

  // 页头
  const header = el("div", { class: "detail-header" }, [
    btn("", { variant: "ghost", icon: "close", title: "返回台账", onClick: () => { location.hash = "#/finance/assets"; } }),
    el("h2", { text: asset.name }),
    tag(STATUS_LABELS[asset.effective_status] || asset.effective_status, statusVariant(asset.effective_status)),
    el("div", { style: "flex:1" }),
    admin ? btn("编辑", { variant: "secondary", icon: "edit", onClick: () => openAssetDialog(asset, () => renderDetail(root, assetId)) }) : null,
    admin ? btn("删除", { variant: "danger", icon: "trash", onClick: async () => {
      const ok = await confirmModal({ title: "删除资产", message: `确定要删除「${asset.name}」吗？此操作不可恢复。`, confirmLabel: "删除", danger: true });
      if (ok) {
        try {
          await apiDelete(`/finance/assets/${assetId}`);
          toast("已删除", "ok");
          location.hash = "#/finance/assets";
        } catch (err) { toast(err.message, "err"); }
      }
    }}) : null,
  ]);
  root.appendChild(header);

  // 关键数字
  const c = asset.computed || {};
  const keyNumbers = el("div", { class: "detail-key-numbers" });
  keyNumbers.appendChild(keyNum("当前金额", fmtMoney(asset.amount_cents)));
  if (c.interest_cents != null) keyNumbers.appendChild(keyNum("到期利息", fmtMoney(c.interest_cents)));
  if (c.maturity_cents != null) keyNumbers.appendChild(keyNum("到期本息", fmtMoney(c.maturity_cents)));
  if (c.actual_interest_cents != null) keyNumbers.appendChild(keyNum("实际累计收益", fmtMoney(c.actual_interest_cents)));
  if (c.actual_annualized_rate != null) keyNumbers.appendChild(keyNum("实际年化", `${c.actual_annualized_rate}%`));
  if (c.market_value_cents != null) keyNumbers.appendChild(keyNum("当前市值", fmtMoney(c.market_value_cents)));
  if (c.pnl_cents != null) keyNumbers.appendChild(keyNum("浮动盈亏", fmtMoney(c.pnl_cents)));
  if (c.repaid_cents != null) keyNumbers.appendChild(keyNum("已还金额", fmtMoney(c.repaid_cents)));
  if (c.remaining_cents != null) keyNumbers.appendChild(keyNum("未还金额", fmtMoney(c.remaining_cents)));
  if (c.remaining_months != null) keyNumbers.appendChild(keyNum("剩余期数", `${c.remaining_months} 期`));
  if (c.payoff_month != null) keyNumbers.appendChild(keyNum("预计结清", fmtMonth(c.payoff_month)));
  if (c.paid_principal_cents != null) keyNumbers.appendChild(keyNum("已还本金", fmtMoney(c.paid_principal_cents)));
  if (c.next_pay_date) keyNumbers.appendChild(keyNum("下次扣款", c.days_to_next_pay === 0 ? `今天（${c.next_pay_date}）` : `${c.next_pay_date}（${c.days_to_next_pay} 天后）`));
  if (c.next_repay_date) keyNumbers.appendChild(keyNum("下一还款日", c.days_to_repay === 0 ? `今天（${c.next_repay_date}）` : `${c.next_repay_date}（${c.days_to_repay} 天后）`));
  if (c.days_to_end != null) keyNumbers.appendChild(keyNum("到期", dueText(c.days_to_end)));
  if (asset.annual_rate != null) {
    const rateLabels = { fixed_deposit: "年利率", loan_out: "约定年利率", loan_in: "约定年利率", mortgage: "贷款年利率" };
    keyNumbers.appendChild(keyNum(rateLabels[asset.category] || "年利率", `${asset.annual_rate}%`));
  }
  root.appendChild(keyNumbers);

  // 基本信息
  const infoGrid = el("div", { class: "dialog-grid" });
  const institutionLabel = { mortgage: "贷款银行", credit_card: "发卡行" }[asset.category] || "机构/交易对手";
  const infoItems = [
    ["分类", CATEGORY_MAP[asset.category]?.name || asset.category],
    ["方向", asset.direction === "asset" ? "资产" : "负债"],
    ["归属人", asset.holder_name],
    [institutionLabel, asset.institution || "—"],
    ["开始日期", asset.start_date || "—"],
    ["到期日", asset.end_date || "—"],
    ["备注", asset.note || "—"],
    ["创建时间", asset.created_at],
  ];
  for (const [label, value] of infoItems) {
    infoGrid.appendChild(el("div", { class: "fa-field" }, [
      el("label", { class: "fa-field__label", text: label }),
      el("div", { class: "fa-field__control", text: value }),
    ]));
  }
  // 专属字段
  if (asset.extra_data) {
    const extraLabels = {
      deposit_no: "存单号", auto_renew: "自动转存", risk_level: "风险等级", base_rate: "业绩基准(%)",
      variety: "品种", form: "形式", quantity: "数量",
      cost_price_cents: "成本单价", current_price_cents: "当前单价",
      code: "代码", market: "市场", cost_cents: "成本金额",
      repay_method: "还款方式", relation: "关系",
      total_cents: "贷款总额", monthly_payment_cents: "月供", pay_day: "还款日",
      bill_day: "账单日", repay_day: "还款日", installment: "分期",
      last_update_date: "余额更新日期",
    };
    for (const [k, v] of Object.entries(asset.extra_data)) {
      const label = extraLabels[k] || k;
      let display = v;
      if (k === "auto_renew" || k === "installment") display = v === 1 || v === "1" ? "是" : "否";
      if (k.endsWith("_cents")) display = fmtMoney(v);
      if (k === "form") display = { physical: "实物", paper: "纸黄金", accumulate: "积存金" }[v] || v;
      if (k === "repay_method") display = { once: "到期一次还", installment: "分期还" }[v] || v;
      infoGrid.appendChild(el("div", { class: "fa-field" }, [
        el("label", { class: "fa-field__label", text: label }),
        el("div", { class: "fa-field__control", text: String(display) }),
      ]));
    }
  }
  root.appendChild(card("基本信息", infoGrid));

  // 状态流转按钮（理财：实际收益录入入口）——仅 admin
  const actions = settleActions(asset.category, asset.status);
  const barButtons = admin ? actions.map((action) =>
    btn(SETTLE_LABELS[action], { variant: action === "clear" ? "danger" : "primary", onClick: () => handleSettle(asset, action, () => renderDetail(root, assetId)) })
  ) : [];
  if (admin && asset.category === "wealth" && asset.status === "holding") {
    barButtons.unshift(btn("更新实际收益", { variant: "secondary", onClick: () => openInterestDialog(asset, () => renderDetail(root, assetId)) }));
  }
  if (barButtons.length > 0) {
    root.appendChild(el("div", { class: "detail-action-bar" }, barButtons));
  }

  // 市值历史（admin 行内可删；删最新一条时后端自动回退当前金额）
  root.appendChild(card("市值历史", renderValues(asset, assetId, () => renderDetail(root, assetId), admin)));

  // 附件
  root.appendChild(card("附件归档", renderAttachments(asset, assetId, () => renderDetail(root, assetId), admin)));

  // 操作日志
  root.appendChild(card("操作日志", renderEvents(asset.events)));
}

function keyNum(label, value) {
  return el("div", { class: "detail-key-number" }, [
    el("div", { class: "detail-key-number__label", text: label }),
    el("div", { class: "detail-key-number__value", text: value }),
  ]);
}

function renderValues(asset, assetId, refresh, admin) {
  const values = asset.values || [];
  if (values.length === 0) {
    return emptyState("暂无市值记录",
      admin ? "理财产品可通过「更新实际收益」录入快照，形成收益轨迹" : "");
  }
  // 理财的快照是「本金+累计收益」，删除不回退本金金额（amount_cents 始终本金语义）；
  // 其他分类（活期/贵金属等）删最新一条时后端把当前金额回退到剩余最新快照。
  const isWealth = asset.category === "wealth";
  const container = el("div", {});
  for (const v of values) {
    const row = el("div", { class: "detail-event" }, [
      el("span", { text: v.value_date, style: "font-size:13px" }),
      el("span", { text: fmtMoney(v.value_cents), style: "font-size:13px;font-weight:500;font-variant-numeric:tabular-nums" }),
      v.note ? el("span", { text: v.note, class: "detail-event__time" }) : null,
      el("span", { style: "flex:1" }),
      admin ? iconBtn("trash", {
        variant: "ghost", size: "sm", title: "删除此市值记录",
        onClick: async () => {
          const rollbackHint = isWealth ? "" : "若删除的是最新一条，当前金额将回退到上一条记录。";
          const ok = await confirmModal({
            title: "删除市值记录",
            message: `确定删除 ${v.value_date} 的记录（${fmtMoney(v.value_cents)}）吗？${rollbackHint}`,
            confirmLabel: "删除", danger: true,
          });
          if (ok) {
            try {
              await apiDelete(`/finance/assets/${assetId}/values/${v.id}`);
              toast("市值记录已删除", "ok");
              refresh();
            } catch (err) { toast(err.message, "err"); }
          }
        },
      }) : null,
    ]);
    container.appendChild(row);
  }
  return container;
}

function renderAttachments(asset, assetId, refresh, admin) {
  const container = el("div", {});
  const attachments = asset.attachments || [];

  // 上传按钮 + 进度条（仅 admin）
  const uploadBtn = admin ? btn("上传附件", { variant: "primary", size: "sm", icon: "upload", onClick: () => {
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".jpg,.jpeg,.png,.webp,.heic,.pdf";
    fileInput.onchange = async () => {
      const file = fileInput.files[0];
      if (!file) return;
      const progressEl = el("div", { class: "upload-progress" }, [el("div", { class: "upload-progress__bar", style: "width:0%" })]);
      container.appendChild(progressEl);
      try {
        await apiUpload(`/finance/assets/${assetId}/attachments`, file, {
          onProgress: (pct) => { progressEl.querySelector(".upload-progress__bar").style.width = pct + "%"; },
        });
        toast("上传成功", "ok");
        refresh();
      } catch (err) {
        toast(err.message, "err");
        progressEl.remove();
      }
    };
    fileInput.click();
  }}) : null;

  if (attachments.length === 0) {
    container.appendChild(emptyState("暂无附件",
      admin ? "上传借据照片、存单扫描件等关键材料" : ""));
  } else {
    for (const att of attachments) {
      container.appendChild(el("div", { class: "detail-attachment" }, [
        iconBtn("download", { variant: "ghost", size: "sm", title: "下载", onClick: () => {
          window.open(`/api/v1/finance/attachments/${att.id}/download`, "_blank");
        }}),
        el("span", { class: "detail-attachment__name", text: att.file_name }),
        el("span", { class: "detail-attachment__size", text: `${(att.file_size / 1024).toFixed(0)} KB` }),
        admin ? iconBtn("trash", { variant: "ghost", size: "sm", title: "删除", onClick: async () => {
          const ok = await confirmModal({ title: "删除附件", message: `确定删除「${att.file_name}」？`, confirmLabel: "删除", danger: true });
          if (ok) {
            try { await apiDelete(`/finance/attachments/${att.id}`); toast("已删除", "ok"); refresh(); }
            catch (err) { toast(err.message, "err"); }
          }
        }}) : null,
      ]));
    }
  }
  if (uploadBtn) container.appendChild(uploadBtn);
  return container;
}

function renderEvents(events) {
  if (!events || events.length === 0) {
    return emptyState("暂无操作记录", "");
  }
  return el("div", {}, events.map((ev) =>
    el("div", { class: "detail-event" }, [
      el("span", { text: ev.summary, style: "flex:1;font-size:13px" }),
      el("span", { class: "detail-event__time", text: (ev.created_at || "").slice(0, 16) }),
    ])
  ));
}

/** 实际收益录入弹窗（M2d，仅理财）：录入银行 App 显示的当前累计收益，
 *  后端换算市值（本金+收益）写入快照轨迹，形成收益变化曲线。 */
function openInterestDialog(asset, refresh) {
  const comp = asset.computed || {};
  const extra = asset.extra_data || {};
  const prev = comp.actual_interest_cents;
  const amountInput = input({
    type: "number",
    value: prev != null ? (prev / 100).toFixed(2) : "",
    placeholder: "如 152.30",
  });
  const dateInput = input({ type: "date", value: todayISO() });
  const noteInput = input({ type: "text", placeholder: "备注（可选）" });
  const hintParts = [`本金 ${fmtMoney(asset.amount_cents)}`];
  if (extra.base_rate) hintParts.push(`业绩基准 ${extra.base_rate}%`);
  if (comp.est_interest_cents != null) hintParts.push(`预计到期收益 ${fmtMoney(comp.est_interest_cents)}`);
  const body = el("div", {}, [
    el("p", { text: hintParts.join(" · "), style: "margin-bottom:12px;color:var(--text-muted);font-size:13px" }),
    field("当前累计收益(元)", amountInput, { required: true }),
    field("记录日期", dateInput, { required: true }),
    field("备注", noteInput),
    el("p", { text: "填写银行 App 中显示的累计收益（非本期增量），每次录入都会留存快照，形成收益轨迹。", style: "margin-top:12px;color:var(--text-muted);font-size:12px" }),
  ]);
  const m = modal({
    title: "更新实际收益",
    width: "narrow",
    body,
    footer: el("div", { class: "fa-dialog-actions" }, [
      btn("取消", { variant: "secondary", onClick: () => m.close() }),
      btn("保存", { variant: "primary", onClick: async () => {
        if (!(parseFloat(amountInput.value) >= 0) || !dateInput.value) { toast("请填写正确的累计收益与日期", "err"); return; }
        try {
          await apiPost(`/finance/assets/${asset.id}/interest`, {
            interest_cents: yuanToCents(amountInput.value),
            value_date: dateInput.value,
            note: noteInput.value.trim(),
          });
          toast("实际收益已记录", "ok");
          m.close();
          refresh();
        } catch (err) { toast(err.message, "err"); }
      }}),
    ]),
  });
}


async function handleSettle(asset, action, refresh) {
  if (action === "repay") {
    // 还款弹窗
    const remaining = asset.computed?.remaining_cents || asset.amount_cents;
    const amountInput = input({ type: "number", value: (remaining / 100).toFixed(2), placeholder: "还款金额(元)" });
    const dateInput = input({ type: "date", value: todayISO() });
    const body = el("div", {}, [
      el("p", { text: `未还金额：${fmtMoney(remaining)}`, style: "margin-bottom:12px;color:var(--text-muted)" }),
      field("还款金额(元)", amountInput, { required: true }),
      field("还款日期", dateInput, { required: true }),
    ]);
    const m = modal({
      title: "登记还款",
      width: "narrow",
      body,
      footer: el("div", { class: "fa-dialog-actions" }, [
        btn("取消", { variant: "secondary", onClick: () => m.close() }),
        btn("确认还款", { variant: "primary", onClick: async () => {
          try {
            await apiPost(`/finance/assets/${asset.id}/settle`, {
              action: "repay",
              amount_cents: yuanToCents(amountInput.value),
              date: dateInput.value,
            });
            toast("还款已登记", "ok");
            m.close();
            refresh();
          } catch (err) { toast(err.message, "err"); }
        }}),
      ]),
    });
    return;
  }

  // 其他操作确认
  const labels = { withdraw: "支取", renew: "续存", clear: "结清" };
  const ok = await confirmModal({
    title: labels[action],
    message: action === "renew" ? "续存将结清当前记录并自动创建一笔新的定期存款。" : `确定要${labels[action]}「${asset.name}」吗？`,
    confirmLabel: labels[action],
    danger: action === "clear",
  });
  if (!ok) return;
  try {
    const result = await apiPost(`/finance/assets/${asset.id}/settle`, { action });
    if (action === "renew" && result.new_asset_id) {
      toast("已续存，新记录已创建", "ok");
      location.hash = `#/finance/assets/${result.new_asset_id}`;
    } else {
      toast(`已${labels[action]}`, "ok");
      refresh();
    }
  } catch (err) { toast(err.message, "err"); }
}
