/** 车型对比页：对比篮子 + 跨车型对比矩阵（design §4.3，决策点 D3：全标签并集 + 独有高亮）。
 *  分组：基本信息 / 配置特点（标签并集行）/ 费用价格 / 主观评价 + 结论摘要。
 */

import { apiGet } from "../../api.js";
import { el, btn, tag, emptyState, card, modal, toast, input } from "../../ui.js";
import { STATUS_LABELS, ENERGY_LABELS, carStatusVariant, fmtCompact,
         getCompareIds, saveCompareIds, clearCompare, addManyToCompare, COMPARE_MAX } from "./common.js";

export async function renderCompare(root, mod) {
  root.innerHTML = "";
  const ids = getCompareIds();

  // 空篮子
  if (ids.length === 0) {
    const empty = emptyState(
      "对比篮子是空的",
      "进入「车型档案」勾选车型加入对比，或点击下方按钮直接选择（2~6 个）",
    );
    empty.appendChild(el("div", { class: "empty-action" }, [
      btn("选择车型", { variant: "primary", icon: "plus", onClick: () => openPicker(() => renderCompare(root, mod)) }),
    ]));
    root.appendChild(empty);
    return;
  }

  // 篮内不足 2 个：仅展示篮子与提示
  if (ids.length === 1) {
    renderBasketCard(root, [], ids, () => renderCompare(root, mod));
    root.appendChild(emptyState("还需选择 1 个车型", "至少选择 2 个车型才能生成对比矩阵。"));
    return;
  }

  let data;
  try {
    data = await apiGet(`/car/candidates/compare?ids=${ids.join(",")}`);
  } catch (err) {
    root.appendChild(emptyState("对比数据加载失败", err.message));
    return;
  }
  const items = data.candidates;
  const validIds = new Set(items.map((it) => it.id));
  const invalidIds = ids.filter((id) => !validIds.has(id)); // 已删除车型

  const refresh = () => renderCompare(root, mod);
  renderBasketCard(root, items, invalidIds, refresh);

  // ---------- 对比矩阵（行=维度，列=车型） ----------
  const n = items.length + 1; // 维度列 + 车型列
  const dimTd = (label, extra) => el("td", { class: "compare-matrix__dim" },
    extra ? [label, extra] : [label]);
  const groupRow = (label) => el("tr", { class: "compare-matrix__group" },
    [el("td", { colspan: String(n), text: label })]);
  const row = (label, renderCell, extra) => el("tr", {},
    [dimTd(label, extra), ...items.map((it) => el("td", {}, [renderCell(it)]))]);
  const muted = (v) => v == null || v === "" ? el("span", { class: "muted", text: "—" }) : v;
  const textCell = (get) => (it) => muted(get(it));
  const moneyCell = (get) => (it) => {
    const cents = get(it);
    return cents == null ? el("span", { class: "muted", text: "—" }) : el("strong", { text: fmtCompact(cents) });
  };

  // 配置特点并集行（服务端 feature_rows）：独有 → 整行高亮 + 「独有」标记
  const featureTrs = data.feature_rows.map((fr) => {
    const tr = el("tr", { class: fr.unique ? "car-compare__unique" : "" },
      [dimTd(fr.label, fr.unique ? tag("独有", "warn") : null),
       ...items.map((it) => el("td", {}, [muted(fr.values[it.id])]))]);
    return tr;
  });

  const matrixBody = el("tbody", {}, [
    groupRow("基本信息"),
    row("品牌", textCell((it) => it.brand)),
    row("车型", textCell((it) => it.model)),
    row("配置版本", textCell((it) => it.version)),
    row("年款", (it) => it.year != null ? `${it.year} 款` : el("span", { class: "muted", text: "—" })),
    row("能源", textCell((it) => ENERGY_LABELS[it.energy] || it.energy)),
    row("指导价", moneyCell((it) => it.guide_price_cents)),
    row("状态", (it) => tag(STATUS_LABELS[it.status] || it.status, carStatusVariant(it.status))),
    row("评分", (it) => it.score != null ? el("strong", { text: `${it.score} 分` }) : el("span", { class: "muted", text: "—" })),

    groupRow("配置特点"),
    ...featureTrs,

    groupRow("费用价格"),
    row("最低落地价", moneyCell((it) => it.computed.best_total_cents)),
    row("平均落地价", moneyCell((it) => it.computed.avg_total_cents)),
    row("最大优惠", moneyCell((it) => it.computed.max_discount_cents)),
    row("报价数", (it) => it.computed.offer_count > 0
      ? `${it.computed.offer_count} 家` : el("span", { class: "muted", text: "—" })),

    groupRow("主观评价"),
    row("优点", (it) => it.pros ? el("span", { style: "white-space:pre-wrap", text: it.pros }) : el("span", { class: "muted", text: "—" })),
    row("缺点", (it) => it.cons ? el("span", { style: "white-space:pre-wrap", text: it.cons }) : el("span", { class: "muted", text: "—" })),
  ]);

  // 表头：维度列 + 各车型列（品牌车型 + 版本副行）
  const headerRow = el("tr", {}, [
    el("th", { text: "维度" }),
    ...items.map((it) => el("th", {}, [
      el("div", { text: `${it.brand} ${it.model}` }),
      it.version ? el("div", { class: "muted", style: "font-size:11px;font-weight:400", text: it.version }) : null,
    ])),
  ]);
  const matrixTable = el("table", { class: "table compare-matrix" }, [
    el("thead", {}, [headerRow]),
    matrixBody,
  ]);
  const matrixCard = card("", el("div", { class: "compare-matrix-wrap" }, [
    el("div", { style: "font-size:15px;font-weight:600;margin-bottom:12px", text: "对比矩阵" }),
    matrixTable,
  ]));
  root.appendChild(matrixCard);

  // ---------- 结论摘要（design §4.3：最低落地 + 独有配置差异自动摘要） ----------
  root.appendChild(card("结论摘要", renderSummary(items, data.feature_rows)));
}

/** 篮子卡片区：车型项（含失效项）+ 添加/清空操作 */
function renderBasketCard(root, items, invalidIds, refresh) {
  const basket = el("div", { class: "car-basket" });
  for (const it of items) {
    basket.appendChild(el("div", { class: "car-basket__item" }, [
      el("div", { class: "compare-basket__meta" }, [
        el("strong", { text: `${it.brand} ${it.model}` }),
        el("span", { class: "muted", text: `${it.version || "—"} · ${STATUS_LABELS[it.status] || it.status}` }),
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
    basket.appendChild(el("div", { class: "car-basket__item", style: "background:#f1f5f9;border-color:var(--border)" }, [
      el("div", { class: "compare-basket__meta" }, [
        el("strong", { style: "color:var(--text-muted)", text: `车型 #${id}` }),
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

  root.appendChild(card("", el("div", {}, [
    el("div", { style: "display:flex;align-items:center;justify-content:space-between;margin-bottom:12px" }, [
      el("h3", { text: `对比篮子（${items.length + invalidIds.length}/${COMPARE_MAX}）`, style: "margin:0;font-size:15px" }),
      el("div", { style: "display:flex;align-items:center;gap:10px" }, [
        btn("添加车型", { variant: "secondary", size: "sm", icon: "plus", onClick: () => openPicker(refresh) }),
        btn("清空对比", { variant: "danger-ghost", size: "sm", icon: "trash", onClick: () => { clearCompare(); refresh(); } }),
      ]),
    ]),
    basket,
  ])));
}

/** 结论摘要：最低落地 + 各车型独有配置差异 */
function renderSummary(items, featureRows) {
  const lines = [];

  const withTotals = items.filter((it) => it.computed.best_total_cents != null);
  if (withTotals.length === 0) {
    lines.push("所选车型尚未录入 4S 店报价，录入后可对比落地价。");
  } else {
    const best = withTotals.reduce((a, b) => (a.computed.best_total_cents <= b.computed.best_total_cents ? a : b));
    lines.push(`落地价最低：${best.brand} ${best.model}（¥${(best.computed.best_total_cents / 100 / 10000).toFixed(2)} 万，共 ${best.computed.offer_count} 家报价）。`);
    if (withTotals.length > 1) {
      const others = withTotals.filter((it) => it !== best);
      const gaps = others.map((it) => `${it.brand} ${it.model} 高 ¥${((it.computed.best_total_cents - best.computed.best_total_cents) / 100).toLocaleString("zh-CN")}`);
      lines.push(`与其他候选的最低落地价相比：${gaps.join("；")}。`);
    }
  }

  const uniqueRows = featureRows.filter((fr) => fr.unique);
  if (uniqueRows.length > 0) {
    const byCar = {};
    for (const fr of uniqueRows) {
      for (const [cid, value] of Object.entries(fr.values)) {
        if (value) (byCar[cid] = byCar[cid] || []).push(fr.label);
      }
    }
    for (const it of items) {
      const labels = byCar[it.id] || [];
      if (labels.length > 0) {
        lines.push(`${it.brand} ${it.model} 有 ${labels.length} 项独有配置：${labels.slice(0, 6).join("、")}${labels.length > 6 ? " 等" : ""}。`);
      }
    }
  }

  return el("div", {}, lines.map((line, idx) =>
    el("p", { style: "margin:0 0 8px;font-size:13px;line-height:1.7", text: `${idx + 1}. ${line}` })));
}

/** 添加车型弹窗：多选 → addManyToCompare */
function openPicker(onSaved) {
  const selected = new Set();
  let all = [];
  let keyword = "";
  let m;

  const listBox = el("div", { class: "compare-picker__list" });
  const errorEl = el("div", {});

  function renderList() {
    listBox.innerHTML = "";
    const inBasket = new Set(getCompareIds());
    const rows = all.filter((c) => !keyword
      || `${c.brand} ${c.model} ${c.version || ""}`.toLowerCase().includes(keyword.toLowerCase()));
    if (rows.length === 0) {
      listBox.appendChild(el("p", { class: "muted", text: "没有匹配的车型" }));
      return;
    }
    for (const c of rows) {
      const inCurrent = inBasket.has(c.id);
      const cb = el("input", { type: "checkbox", class: "compare-check" });
      cb.checked = inCurrent || selected.has(c.id);
      cb.disabled = inCurrent;
      cb.addEventListener("change", (e) => {
        if (e.target.checked) selected.add(c.id);
        else selected.delete(c.id);
        syncConfirmLabel();
      });
      listBox.appendChild(el("label", { class: "compare-picker__item" }, [
        cb,
        el("span", { text: `${c.brand} ${c.model}` }),
        el("span", { class: "muted", text: c.version || "—" }),
        inCurrent ? tag("已在篮中", "muted") : null,
      ]));
    }
  }

  const searchInput = input({
    type: "search", placeholder: "搜索品牌 / 车型 / 版本",
    onInput: (e) => { keyword = e.target.value.trim(); renderList(); },
  });

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

  m = modal({
    title: "添加车型到对比",
    width: "normal",
    body: el("div", {}, [
      errorEl,
      el("div", { style: "margin-bottom:8px" }, [searchInput]),
      listBox,
    ]),
    footer,
  });

  apiGet("/car/candidates").then((data) => {
    all = data;
    renderList();
  }).catch((err) => {
    errorEl.appendChild(el("p", { class: "fa-field__error", text: err.message }));
  });
}
