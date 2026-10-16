/** 对比分析页（M2c · compare-design §4）：对比篮子 + 并排对比矩阵 + 收益模拟器。
 *  篮子持久化于 localStorage（fa_compare_ids）；数据经 GET /finance/assets/compare 归一。
 */

import { apiGet } from "../../api.js";
import { el, btn, input, card, tag, emptyState, modal, toast } from "../../ui.js";
import { barChart } from "../../charts.js";
import { fmtMoney, yuanToCents, categoryColor, statusVariant,
         getCompareIds, saveCompareIds, clearCompare, addManyToCompare, COMPARE_MAX } from "./common.js";

export async function renderCompare(root, mod) {
  root.innerHTML = "";
  const ids = getCompareIds();

  // 空篮子
  if (ids.length === 0) {
    const empty = emptyState(
      "对比篮子是空的",
      "进入「资产台账」勾选资产加入对比，或点击下方按钮直接选择（2~6 个）"
    );
    empty.appendChild(el("div", { class: "empty-action" }, [
      btn("添加资产", { variant: "primary", icon: "plus", onClick: () => openPicker(() => renderCompare(root, mod)) }),
    ]));
    root.appendChild(empty);
    return;
  }

  let items = [];
  try {
    items = (await apiGet(`/finance/assets/compare?ids=${ids.join(",")}`)).items;
  } catch (err) {
    root.appendChild(emptyState("对比数据加载失败", err.message));
    return;
  }
  const validIds = new Set(items.map((it) => it.id));
  const invalidIds = ids.filter((id) => !validIds.has(id)); // 已删除/失效资产

  const refresh = () => renderCompare(root, mod);

  // ---------- 篮子卡片区 ----------
  const basket = el("div", { class: "compare-basket" });
  for (const it of items) {
    basket.appendChild(el("div", { class: "compare-basket__item" }, [
      el("span", { class: "compare-basket__dot", style: `background:${categoryColor(it.category)}` }),
      el("div", { class: "compare-basket__meta" }, [
        el("strong", { text: it.name }),
        el("span", { class: "muted", text: `${it.category_name} · ¥${fmtMoney(it.amount_cents)}` }),
      ]),
      btn("移除", {
        variant: "ghost", size: "sm",
        onClick: () => {
          saveCompareIds(getCompareIds().filter((i) => i !== it.id));
          refresh();
        },
      }),
    ]));
  }
  for (const id of invalidIds) {
    basket.appendChild(el("div", { class: "compare-basket__item compare-basket__item--invalid" }, [
      el("span", { class: "compare-basket__dot", style: "background:#d1d5db" }),
      el("div", { class: "compare-basket__meta" }, [
        el("strong", { text: `资产 #${id}` }),
        el("span", { class: "muted", text: "已删除或不可对比" }),
      ]),
      btn("移除", {
        variant: "ghost", size: "sm",
        onClick: () => {
          saveCompareIds(getCompareIds().filter((i) => i !== id));
          refresh();
        },
      }),
    ]));
  }

  const basketCard = card(
    "",
    el("div", {}, [
      el("div", { style: "display:flex;align-items:center;justify-content:space-between;margin-bottom:12px" }, [
        el("h3", { text: `对比篮子（${items.length}/${COMPARE_MAX}）`, style: "margin:0;font-size:15px" }),
        el("div", { style: "display:flex;align-items:center;gap:10px" }, [
          btn("添加资产", { variant: "secondary", size: "sm", icon: "plus", onClick: () => openPicker(refresh) }),
          btn("清空对比", { variant: "danger-ghost", size: "sm", icon: "trash", onClick: async () => { clearCompare(); refresh(); } }),
        ]),
      ]),
      basket,
    ])
  );
  root.appendChild(basketCard);

  if (items.length === 0) return; // 全部失效时仅显示篮子

  // ---------- 对比矩阵（行=维度，列=产品；compare-design §3.1） ----------
  const n = items.length + 1; // 维度列 + 产品列
  const dimTd = (label) => el("td", { class: "compare-matrix__dim", text: label });
  const groupRow = (label) => el("tr", { class: "compare-matrix__group" },
    [el("td", { colspan: String(n), text: label })]);
  const row = (label, renderCell) => el("tr", {},
    [dimTd(label), ...items.map((it) => el("td", {}, [renderCell(it)]))]);
  const muted = (v) => v == null || v === "" ? el("span", { class: "muted", text: "—" }) : v;
  const textCell = (get) => (it) => muted(get(it));

  const matrixBody = el("tbody", {}, [
    groupRow("基本信息"),
    row("分类", (it) => el("span", {}, [
      el("span", { class: "compare-basket__dot", style: `background:${categoryColor(it.category)};margin-right:6px` }),
      it.category_name,
    ])),
    row("机构/对手", textCell((it) => it.institution)),
    row("金额（元）", textCell((it) => fmtMoney(it.amount_cents))),
    row("归属人", textCell((it) => it.holder_name)),
    row("起始日期", textCell((it) => it.start_date)),
    row("到期日期", textCell((it) => it.end_date)),
    row("期限", textCell((it) => it.period_label)),
    row("当前状态", (it) => tag(it.status_label, statusVariant(it.status))),

    groupRow("收益能力"),
    row("统一年化", (it) => it.annualized_rate == null
      ? el("span", { class: "muted", text: "—" })
      : el("strong", { text: `${it.annualized_rate}%${it.annualized_note ? "（基准）" : ""}` })),
    row("利率口径", textCell((it) => it.rate_label)),
    row("实际年化", (it) => it.actual_annualized_rate == null
      ? el("span", { class: "muted", text: "—" })
      : el("strong", { text: `${it.actual_annualized_rate}%` })),
    row("实际累计收益（元）", (it) => it.actual_interest_cents == null
      ? el("span", { class: "muted", text: "—" })
      : el("strong", { text: fmtMoney(it.actual_interest_cents) })),
    row("预计到期收益（元）", textCell((it) => fmtMoney(it.est_interest_cents))),
    row("到期本息（元）", textCell((it) => fmtMoney(it.maturity_cents))),

    groupRow("风险"),
    row("风险等级", (it) => it.risk_label ? tag(it.risk_label, it.floating ? "muted" : "warn") : el("span", { class: "muted", text: "—" })),
    row("风险提示", (it) => it.floating
      ? el("span", { class: "muted", text: "收益浮动，不保本" })
      : el("span", { class: "muted", text: it.category === "wealth" ? "业绩基准非承诺收益" : "—" })),

    groupRow("流动性"),
    row("距到期", textCell((it) => it.due_label)),
    row("附件材料", textCell((it) => it.attachment_count > 0 ? `${it.attachment_count} 个` : null)),
  ]);

  const matrixCard = card("", el("div", { class: "compare-matrix-wrap" }, [
    el("div", { style: "font-size:15px;font-weight:600;margin-bottom:12px", text: "对比矩阵" }),
    el("table", { class: "table compare-matrix" }, [
      el("thead", {}, [el("tr", {},
        [el("th", { text: "维度" }), ...items.map((it) => el("th", { text: it.name }))])]),
      matrixBody,
    ]),
  ]));
  root.appendChild(matrixCard);

  // ---------- 收益模拟器（compare-design §5 前端公式） ----------
  const simulatable = items.filter((it) => it.annualized_rate != null);
  let simAmountYuan = 100000;
  let simDays = 365;

  const simAmountInput = input({ type: "number", value: "100000", onInput: (e) => { simAmountYuan = parseFloat(e.target.value) || 0; scheduleSim(); } });
  const simDaysInput = input({ type: "number", value: "365", onInput: (e) => { simDays = parseInt(e.target.value) || 0; scheduleSim(); } });
  const simChartBox = el("div", {});

  function renderSim() {
    simChartBox.innerHTML = "";
    if (simulatable.length === 0) {
      simChartBox.appendChild(el("p", { class: "muted", text: "篮内均为浮动收益类（活期/股票/贵金属等），无固定年化，不参与模拟。" }));
      return;
    }
    const amountCents = yuanToCents(simAmountYuan);
    const bars = simulatable.map((it) => ({
      label: it.name,
      value: Math.round(amountCents * it.annualized_rate / 100 * simDays / 365),
      color: categoryColor(it.category),
    }));
    simChartBox.appendChild(barChart(bars, { height: 180 }));
    simChartBox.appendChild(el("p", {
      class: "muted",
      style: "margin-top:8px",
      text: `按统一年化单利试算：${simulatable.map((it) => `${it.name} ${it.annualized_rate}%${it.annualized_note ? "（基准）" : ""}`).join("；")}。仅供参考，不代表实际收益。`,
    }));
  }

  let simTimer;
  function scheduleSim() {
    clearTimeout(simTimer);
    simTimer = setTimeout(renderSim, 300); // 防抖 300ms
  }

  root.appendChild(card("", el("div", {}, [
    el("div", { style: "font-size:15px;font-weight:600;margin-bottom:12px", text: "收益模拟器" }),
    el("div", { class: "compare-sim-controls" }, [
      el("label", { text: "模拟金额（元）" }, []), simAmountInput,
      el("label", { text: "模拟期限（天）" }, []), simDaysInput,
    ]),
    simChartBox,
  ])));

  renderSim();
}

/** 添加资产弹窗：资产方向多选 → addManyToCompare（compare-design §4.2） */
function openPicker(onSaved) {
  const selected = new Set();
  let allAssets = [];
  let keyword = "";
  let m;

  const listBox = el("div", { class: "compare-picker__list" });
  const errorEl = el("div", {});

  function renderList() {
    listBox.innerHTML = "";
    const inBasket = new Set(getCompareIds());
    const rows = allAssets.filter((a) => !keyword || a.name.includes(keyword) || (a.institution || "").includes(keyword));
    if (rows.length === 0) {
      listBox.appendChild(el("p", { class: "muted", text: "没有匹配的资产" }));
      return;
    }
    for (const a of rows) {
      const inCurrent = inBasket.has(a.id);
      const cb = el("input", { type: "checkbox", class: "compare-check" });
      cb.checked = inCurrent || selected.has(a.id);
      cb.disabled = inCurrent;
      cb.addEventListener("change", (e) => {
        if (e.target.checked) selected.add(a.id);
        else selected.delete(a.id);
        syncConfirmLabel();
      });
      listBox.appendChild(el("label", { class: "compare-picker__item" }, [
        cb,
        el("span", { text: a.name }),
        el("span", { class: "muted", text: `${a.category_name} · ¥${fmtMoney(a.amount_cents)}` }),
        inCurrent ? tag("已在篮中", "muted") : null,
      ]));
    }
  }

  const searchInput = input({
    type: "search", placeholder: "搜索资产名称或机构",
    onInput: (e) => { keyword = e.target.value.trim(); renderList(); },
  });

  const body = el("div", {}, [
    errorEl,
    el("div", { style: "margin-bottom:8px" }, [searchInput]),
    listBox,
  ]);

  const confirmLabel = el("span", { text: "加入对比" });
  const footer = el("div", { class: "fa-dialog-actions fa-dialog-actions--auto" }, [
    btn("取消", { variant: "secondary", onClick: () => m.close() }),
    el("button", {
      class: "fa-btn fa-btn--primary",
      onClick: () => {
        if (selected.size === 0) return;
        const r = addManyToCompare([...selected]);
        toast(r.reason, r.ok ? "ok" : "warn");
        if (r.ok) { m.close(); onSaved && onSaved(); }
      },
    }, [confirmLabel]),
  ]);

  function syncConfirmLabel() {
    confirmLabel.textContent = selected.size > 0 ? `加入对比（已选 ${selected.size}）` : "加入对比";
  }

  m = modal({ title: "添加资产到对比", width: "normal", body, footer });
  apiGet("/finance/assets?direction=asset").then((data) => {
    allAssets = data.items;
    renderList();
  }).catch((err) => {
    errorEl.appendChild(el("p", { class: "fa-field__error", text: err.message }));
  });
}
