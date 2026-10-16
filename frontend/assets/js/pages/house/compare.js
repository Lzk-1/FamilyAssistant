/** 房源对比页：对比篮子 + 跨房源对比矩阵 + 权重设置（design §4.3，决策点 D3/D5）。
 *  分组：基本信息 / 价格信息 / 配套设施（标签并集行）/ 维度评分（含加权总分）/ 主观评价 + 结论摘要。
 */

import { apiGet, apiPut } from "../../api.js";
import { el, btn, tag, emptyState, card, modal, toast, input } from "../../ui.js";
import { STATUS_LABELS, houseStatusVariant, DIMENSIONS, fmtWan, fmtUnit,
         getCompareIds, saveCompareIds, clearCompare, addManyToCompare, COMPARE_MAX } from "./common.js";

export async function renderCompare(root, mod) {
  root.innerHTML = "";
  const ids = getCompareIds();

  // 空篮子
  if (ids.length === 0) {
    const empty = emptyState(
      "对比篮子是空的",
      "进入「房源档案」勾选房源加入对比，或点击下方按钮直接选择（2~6 个）",
    );
    empty.appendChild(el("div", { class: "empty-action" }, [
      btn("选择房源", { variant: "primary", icon: "plus", onClick: () => openPicker(() => renderCompare(root, mod)) }),
    ]));
    root.appendChild(empty);
    return;
  }

  // 篮内不足 2 个：仅展示篮子与提示
  if (ids.length === 1) {
    renderBasketCard(root, [], ids, () => renderCompare(root, mod));
    root.appendChild(emptyState("还需选择 1 个房源", "至少选择 2 个房源才能生成对比矩阵。"));
    return;
  }

  let data;
  try {
    data = await apiGet(`/house/candidates/compare?ids=${ids.join(",")}`);
  } catch (err) {
    root.appendChild(emptyState("对比数据加载失败", err.message));
    return;
  }
  const items = data.candidates;
  const validIds = new Set(items.map((it) => it.id));
  const invalidIds = ids.filter((id) => !validIds.has(id)); // 已删除房源

  const refresh = () => renderCompare(root, mod);
  renderBasketCard(root, items, invalidIds, refresh);

  // ---------- 对比矩阵（行=维度，列=房源） ----------
  const n = items.length + 1; // 维度列 + 房源列
  const dimTd = (label, extra) => el("td", { class: "compare-matrix__dim" },
    extra ? [label, extra] : [label]);
  const groupRow = (label) => el("tr", { class: "compare-matrix__group" },
    [el("td", { colspan: String(n), text: label })]);
  const row = (label, renderCell, extra) => el("tr", {},
    [dimTd(label, extra), ...items.map((it) => el("td", {}, [renderCell(it)]))]);
  const muted = (v) => v == null || v === "" ? el("span", { class: "muted", text: "—" }) : v;
  const textCell = (get) => (it) => muted(get(it));
  const wanCell = (get) => (it) => {
    const cents = get(it);
    return cents == null ? el("span", { class: "muted", text: "—" }) : el("strong", { text: fmtWan(cents) });
  };
  const unitCell = (get) => (it) => {
    const cents = get(it);
    return cents == null ? el("span", { class: "muted", text: "—" }) : el("strong", { text: fmtUnit(cents) });
  };

  // 配套设施并集行（服务端 feature_rows）：独有 → 整行高亮 + 「独有」标记
  const featureTrs = data.feature_rows.map((fr) => {
    const tr = el("tr", { class: fr.unique ? "car-compare__unique" : "" },
      [dimTd(fr.label, fr.unique ? tag("独有", "warn") : null),
       ...items.map((it) => el("td", {}, [muted(fr.values[it.id])]))]);
    return tr;
  });

  // 维度评分行：label 附当前权重；加权总分行加「最优」标记
  const weights = data.weights || {};
  const weightedList = items.map((it) => it.computed.weighted_score).filter((s) => s != null);
  const bestWeighted = weightedList.length ? Math.max(...weightedList) : null;
  const dimTrs = DIMENSIONS.map((d) =>
    row(`${d.label}`, (it) => {
      const s = (it.dim_scores || {})[d.key];
      return s != null ? el("strong", { text: `${s} 分` }) : el("span", { class: "muted", text: "—" });
    }, el("span", { class: "muted", style: "font-size:11px", text: `（${weights[d.key] ?? 0}%）` })));
  const weightedTr = row("加权总分", (it) => el("span", {}, [
    it.computed.weighted_score != null
      ? el("strong", { style: "color:#f59e0b", text: `${it.computed.weighted_score} 分` })
      : el("span", { class: "muted", text: "—" }),
    bestWeighted != null && it.computed.weighted_score === bestWeighted && items.length > 1
      ? el("span", { style: "margin-left:6px" }, [tag("最优", "ok")])
      : null,
  ]));

  const matrixBody = el("tbody", {}, [
    groupRow("基本信息"),
    row("小区", textCell((it) => it.community || "—")),
    row("城市·区域", textCell((it) => [it.city, it.district].filter(Boolean).join("·") || "—")),
    row("户型", textCell((it) => it.layout)),
    row("面积", (it) => it.area != null ? `${it.area} ㎡` : el("span", { class: "muted", text: "—" })),
    row("楼层", textCell((it) => it.floor_info)),
    row("朝向", textCell((it) => it.orientation)),
    row("建筑年代", (it) => it.build_year != null ? `${it.build_year} 年` : el("span", { class: "muted", text: "—" })),
    row("状态", (it) => tag(STATUS_LABELS[it.status] || it.status, houseStatusVariant(it.status))),
    row("手动评分", (it) => it.score != null ? el("strong", { text: `${it.score} 分` }) : el("span", { class: "muted", text: "—" })),

    groupRow("价格信息"),
    row("总价", wanCell((it) => it.total_price_cents)),
    row("单价", unitCell((it) => it.unit_price_cents)),

    groupRow("配套设施"),
    ...featureTrs,

    groupRow("维度评分"),
    ...dimTrs,
    weightedTr,

    groupRow("主观评价"),
    row("优势", (it) => it.pros ? el("span", { style: "white-space:pre-wrap", text: it.pros }) : el("span", { class: "muted", text: "—" })),
    row("劣势", (it) => it.cons ? el("span", { style: "white-space:pre-wrap", text: it.cons }) : el("span", { class: "muted", text: "—" })),
  ]);

  // 表头：维度列 + 各房源列（小区 + 户型副行）
  const headerRow = el("tr", {}, [
    el("th", { text: "维度" }),
    ...items.map((it) => el("th", {}, [
      el("div", { text: it.community || it.title }),
      it.layout ? el("div", { class: "muted", style: "font-size:11px;font-weight:400", text: it.layout }) : null,
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

  // ---------- 结论摘要（design §4.3：价格最优 + 加权评分最高 + 独有配套差异自动摘要） ----------
  root.appendChild(card("结论摘要", renderSummary(items, data.feature_rows, weights)));
}

/** 篮子卡片区：房源项（含失效项）+ 添加/清空/权重设置操作 */
function renderBasketCard(root, items, invalidIds, refresh) {
  const basket = el("div", { class: "car-basket" });
  for (const it of items) {
    basket.appendChild(el("div", { class: "car-basket__item" }, [
      el("div", { class: "compare-basket__meta" }, [
        el("strong", { text: it.community || it.title }),
        el("span", { class: "muted", text: `${it.layout || "—"} · ${STATUS_LABELS[it.status] || it.status}` }),
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
        el("strong", { style: "color:var(--text-muted)", text: `房源 #${id}` }),
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
        btn("权重设置", { variant: "ghost", size: "sm", icon: "sliders", onClick: () => openWeights(refresh) }),
        btn("添加房源", { variant: "secondary", size: "sm", icon: "plus", onClick: () => openPicker(refresh) }),
        btn("清空对比", { variant: "danger-ghost", size: "sm", icon: "trash", onClick: () => { clearCompare(); refresh(); } }),
      ]),
    ]),
    basket,
  ])));
}

/** 结论摘要：最低总价 / 最低单价 / 加权评分最高 + 各房源独有配套差异 */
function renderSummary(items, featureRows, weights) {
  const lines = [];

  const withTotals = items.filter((it) => it.total_price_cents != null);
  if (withTotals.length === 0) {
    lines.push("所选房源尚未录入总价，录入后可对比价格。");
  } else {
    const best = withTotals.reduce((a, b) => (a.total_price_cents <= b.total_price_cents ? a : b));
    lines.push(`总价最低：${best.community || best.title}（¥${(best.total_price_cents / 1000000).toFixed(2)} 万）。`);
    if (withTotals.length > 1) {
      const others = withTotals.filter((it) => it !== best);
      const gaps = others.map((it) => `${it.community || it.title} 高 ¥${((it.total_price_cents - best.total_price_cents) / 1000000).toFixed(2)} 万`);
      lines.push(`与其他候选的总价相比：${gaps.join("；")}。`);
    }
    const withUnits = items.filter((it) => it.unit_price_cents != null);
    if (withUnits.length > 1) {
      const bestUnit = withUnits.reduce((a, b) => (a.unit_price_cents <= b.unit_price_cents ? a : b));
      lines.push(`单价最低：${bestUnit.community || bestUnit.title}（${Math.round(bestUnit.unit_price_cents / 100).toLocaleString("zh-CN")} 元/㎡）。`);
    }
  }

  const scored = items.filter((it) => it.computed.weighted_score != null);
  if (scored.length === 0) {
    lines.push("所选房源尚未按维度评分，编辑房源打分后可按你的权重计算加权总分。");
  } else {
    const best = scored.reduce((a, b) => (a.computed.weighted_score >= b.computed.weighted_score ? a : b));
    lines.push(`加权评分最高：${best.community || best.title}（${best.computed.weighted_score} 分，当前权重：${DIMENSIONS.map((d) => `${d.label} ${weights[d.key] ?? d.weight}%`).join("、")}）。`);
  }

  const uniqueRows = featureRows.filter((fr) => fr.unique);
  if (uniqueRows.length > 0) {
    const byHouse = {};
    for (const fr of uniqueRows) {
      for (const [cid, value] of Object.entries(fr.values)) {
        if (value) (byHouse[cid] = byHouse[cid] || []).push(fr.label);
      }
    }
    for (const it of items) {
      const labels = byHouse[it.id] || [];
      if (labels.length > 0) {
        lines.push(`${it.community || it.title} 有 ${labels.length} 项独有配套：${labels.slice(0, 6).join("、")}${labels.length > 6 ? " 等" : ""}。`);
      }
    }
  }

  return el("div", {}, lines.map((line, idx) =>
    el("p", { style: "margin:0 0 8px;font-size:13px;line-height:1.7", text: `${idx + 1}. ${line}` })));
}

/** 权重设置弹窗（决策点 D5）：六维度权重 0~100，合计须为 100；保存后全局生效并刷新对比 */
function openWeights(onSaved) {
  const inputsByKey = {};
  const errorEl = el("div", {});
  const sumEl = el("span", {});

  function load() {
    apiGet("/house/scoring-config").then((cfg) => {
      for (const d of DIMENSIONS) {
        inputsByKey[d.key].value = String(cfg.weights[d.key] ?? d.weight);
      }
      syncSum();
    }).catch((err) => {
      errorEl.appendChild(el("p", { class: "fa-field__error", text: err.message }));
    });
  }

  function currentSum() {
    let sum = 0;
    for (const d of DIMENSIONS) {
      const v = parseInt(inputsByKey[d.key].value, 10);
      if (!Number.isFinite(v)) return null;
      sum += v;
    }
    return sum;
  }

  /** 合计提示：100 绿色，否则红色；并即时校验单项 0~100 */
  function syncSum() {
    errorEl.innerHTML = "";
    let bad = false;
    for (const d of DIMENSIONS) {
      const v = parseInt(inputsByKey[d.key].value, 10);
      if (!Number.isFinite(v) || v < 0 || v > 100) {
        errorEl.appendChild(el("p", { class: "fa-field__error", text: `${d.label}：应为 0~100 的整数` }));
        bad = true;
      }
    }
    const sum = currentSum();
    const ok = !bad && sum === 100;
    sumEl.textContent = `合计：${sum ?? "—"}/100`;
    sumEl.style.color = ok ? "var(--ok)" : "var(--err)";
    saveBtn.disabled = !ok;
  }

  const grid = el("div", { class: "dialog-grid" });
  for (const d of DIMENSIONS) {
    const inp = input({
      type: "number", value: String(d.weight), placeholder: String(d.weight),
      onInput: () => syncSum(),
    });
    inputsByKey[d.key] = inp;
    grid.appendChild(el("div", { class: "fa-field" }, [
      el("label", { class: "fa-field__label", text: `${d.label}（%）` }),
      el("div", { class: "fa-field__control" }, [inp]),
    ]));
  }

  const saveBtn = btn("保存权重", { variant: "primary", icon: "check", onClick: async () => {
    const weights = {};
    for (const d of DIMENSIONS) weights[d.key] = parseInt(inputsByKey[d.key].value, 10);
    try {
      await apiPut("/house/scoring-config", { weights });
      toast("评分权重已更新", "ok");
      m.close();
      if (onSaved) onSaved();
    } catch (err) {
      errorEl.innerHTML = "";
      if (err.errors && err.errors.length > 0) {
        errorEl.appendChild(el("div", { class: "error-list" }, [
          el("ul", {}, err.errors.map((e) => el("li", { text: e }))),
        ]));
      } else {
        toast(err.message, "err");
      }
    }
  } });

  const footer = el("div", { class: "fa-dialog-actions fa-dialog-actions--auto" }, [
    btn("取消", { variant: "secondary", onClick: () => m.close() }),
    btn("恢复默认", { variant: "ghost", onClick: () => {
      for (const d of DIMENSIONS) inputsByKey[d.key].value = String(d.weight);
      syncSum();
    } }),
    saveBtn,
  ]);

  const m = modal({
    title: "评分权重设置",
    width: "normal",
    body: el("div", {}, [
      errorEl,
      grid,
      el("div", { style: "display:flex;align-items:center;gap:8px;margin-top:12px" }, [
        el("span", { class: "muted", style: "font-size:12px", text: "加权总分 = Σ(维度得分 × 权重) ÷ 已评维度权重之和；六个维度权重合计须为 100。" }),
        sumEl,
      ]),
    ]),
    footer,
  });

  load();
}

/** 添加房源弹窗：多选 → addManyToCompare */
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
      || `${c.community} ${c.title} ${c.layout || ""}`.toLowerCase().includes(keyword.toLowerCase()));
    if (rows.length === 0) {
      listBox.appendChild(el("p", { class: "muted", text: "没有匹配的房源" }));
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
        el("span", { text: c.community || c.title }),
        el("span", { class: "muted", text: c.layout || "—" }),
        inCurrent ? tag("已在篮中", "muted") : null,
      ]));
    }
  }

  const searchInput = input({
    type: "search", placeholder: "搜索小区 / 户型",
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
    title: "添加房源到对比",
    width: "normal",
    body: el("div", {}, [
      errorEl,
      el("div", { style: "margin-bottom:8px" }, [searchInput]),
      listBox,
    ]),
    footer,
  });

  apiGet("/house/candidates").then((data) => {
    all = data;
    renderList();
  }).catch((err) => {
    errorEl.appendChild(el("p", { class: "fa-field__error", text: err.message }));
  });
}
