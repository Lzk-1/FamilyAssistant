/** 车型档案页：工具栏（状态筛选/加入对比/新增）+ 候选车型表（design §4.1）。
 *  行点击进详情；勾选 + 工具栏「加入对比」批量入篮（沿用理财台账对比篮子交互）。
 */

import { apiGet } from "../../api.js";
import { el, btn, select, tag, emptyState, toast } from "../../ui.js";
import { icon } from "../../icons.js";
import { STATUS_LABELS, STATUS_OPTIONS, ENERGY_LABELS, carStatusVariant, fmtCompact,
         getCompareIds, addManyToCompare, toggleCompare } from "./common.js";
import { openCandidateDialog } from "./dialog.js";

export async function renderList(root) {
  let statusFilter = "";
  let all = [];
  const compareSelected = new Set();
  let compareLabel;

  all = await apiGet("/car/candidates");

  const toolbar = el("div", { class: "ledger-toolbar" });
  root.appendChild(toolbar);
  const listBox = el("div", {});
  root.appendChild(listBox);

  renderToolbar();
  renderTable();

  async function refresh() {
    try {
      all = await apiGet("/car/candidates");
    } catch (err) {
      listBox.innerHTML = "";
      listBox.appendChild(el("div", { class: "banner error", text: err.message }));
      return;
    }
    renderToolbar();
    renderTable();
  }

  function renderToolbar() {
    toolbar.innerHTML = "";
    toolbar.appendChild(select("status", STATUS_OPTIONS, {
      value: statusFilter,
      onChange: (v) => { statusFilter = v; renderTable(); },
    }));
    toolbar.appendChild(el("div", { style: "flex:1" }));

    compareLabel = el("span", { text: "加入对比" });
    const compareBtn = el("button", {
      class: "fa-btn fa-btn--secondary fa-btn--sm",
      disabled: true,
      onClick: () => {
        if (compareSelected.size === 0) return;
        const r = addManyToCompare([...compareSelected]);
        toast(r.reason, r.ok ? "ok" : "warn");
        if (r.ok) {
          compareSelected.clear();
          location.hash = "#/car/compare";
        }
      },
    }, [compareLabel]);
    toolbar.appendChild(compareBtn);
    toolbar.appendChild(btn("新增车型", { variant: "primary", icon: "plus", onClick: () => openCandidateDialog(null, refresh) }));
    syncCompareBtn();
  }

  /** 同步工具栏「加入对比」按钮的可用态与计数 */
  function syncCompareBtn() {
    const btnNode = compareLabel?.parentElement;
    if (!btnNode) return;
    const n = compareSelected.size;
    compareLabel.textContent = n > 0 ? `加入对比（${n}）` : "加入对比";
    btnNode.disabled = n === 0;
  }

  function renderTable() {
    listBox.innerHTML = "";
    const rows = statusFilter ? all.filter((c) => c.status === statusFilter) : all;

    if (all.length === 0) {
      const empty = emptyState("暂无候选车型", "点击「新增车型」开始记录你的看车清单");
      empty.appendChild(el("div", { class: "empty-action" }, [
        btn("新增车型", { variant: "primary", icon: "plus", onClick: () => openCandidateDialog(null, refresh) }),
      ]));
      listBox.appendChild(empty);
      return;
    }
    if (rows.length === 0) {
      listBox.appendChild(emptyState("该状态下暂无车型", "切换筛选条件查看其他车型。"));
      return;
    }

    const inBasket = new Set(getCompareIds());
    const cols = [
      { label: "", key: "_compare", render: (row) => {
        const cb = el("input", { type: "checkbox", class: "compare-check", title: "勾选加入对比" });
        cb.checked = compareSelected.has(row.id);
        cb.addEventListener("change", (e) => {
          e.stopPropagation();
          if (e.target.checked) compareSelected.add(row.id);
          else compareSelected.delete(row.id);
          syncCompareBtn();
        });
        const holder = el("span", {}, [cb]);
        holder.addEventListener("click", (e) => e.stopPropagation());
        return holder;
      } },
      { label: "品牌", key: "brand" },
      { label: "车型", key: "model" },
      { label: "配置版本", key: "version", render: (row) => row.version || "—" },
      { label: "能源", key: "energy", render: (row) => ENERGY_LABELS[row.energy] || row.energy || "—" },
      { label: "指导价", key: "_guide", render: (row) => fmtCompact(row.guide_price_cents) },
      { label: "最低落地", key: "_best", render: (row) => {
        if (row.computed.best_total_cents == null) return el("span", { class: "muted", text: "—" });
        return el("span", {}, [
          el("strong", { text: fmtCompact(row.computed.best_total_cents) }),
          el("span", { class: "muted", style: "font-size:12px", text: `（${row.computed.offer_count} 家）` }),
        ]);
      } },
      { label: "照片", key: "_photos", render: (row) => row.computed.photo_count > 0
        ? el("span", { title: `${row.computed.photo_count} 张照片` }, [icon("image", 14), ` ${row.computed.photo_count}`])
        : "—" },
      { label: "评分", key: "_score", render: (row) => row.score != null
        ? el("span", { style: "color:#f59e0b;display:inline-flex;align-items:center;gap:3px" }, [icon("star", 13), ` ${row.score}`])
        : "—" },
      { label: "状态", key: "status", render: (row) => tag(STATUS_LABELS[row.status] || row.status, carStatusVariant(row.status)) },
      { label: "", key: "_actions", render: (row) => el("span", { class: "row-actions" }, [
        btn(inBasket.has(row.id) ? "已对比" : "对比", {
          variant: "ghost", size: "sm",
          onClick: (e) => {
            e.stopPropagation();
            const r = toggleCompare(row.id);
            toast(r.reason, r.ok ? "ok" : "warn");
            renderTable();
          },
        }),
      ]) },
    ];

    const tbody = rows.map((row) =>
      el("tr", { onClick: () => { location.hash = `#/car/detail/${row.id}`; }, style: "cursor:pointer" },
        cols.map((col) => {
          const content = col.render ? col.render(row) : (row[col.key] ?? "—");
          return content instanceof Node ? el("td", {}, [content]) : el("td", { text: content });
        })));

    listBox.appendChild(el("table", { class: "table" }, [
      el("thead", {}, [el("tr", {}, cols.map((c) => el("th", { text: c.label })))]),
      el("tbody", {}, tbody),
    ]));
  }
}
