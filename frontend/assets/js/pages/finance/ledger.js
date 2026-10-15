/** 资产台账页：分类侧栏 + 分组表格 + 筛选 + 搜索 + 新增/成员管理入口。
 *  分类树点击筛选，分组表头折叠/展开，行着色按状态，行点击进详情。
 */

import { apiGet } from "../../api.js";
import { el, btn, iconBtn, input, select, tag, emptyState, toast } from "../../ui.js";
import { icon } from "../../icons.js";
import { fmtMoney, statusVariant, statusRowClass, dueText, STATUS_LABELS, CATEGORY_MAP, categoryColor, fetchMembers, toggleCompare, addManyToCompare, getCompareIds } from "./common.js";
import { openAssetDialog } from "./dialog.js";
import { openMembersDialog } from "./members.js";

export async function renderLedger(root, mod, query) {
  // 本地状态
  let currentCategory = query.category || "";
  let currentDirection = "";
  let currentHolder = query.holder_id || "";
  let currentStatus = "";
  let searchKeyword = query.q || ""; // 总览机构分布图跳转：按机构名预填搜索
  const collapsedGroups = new Set();
  const compareSelected = new Set(); // 当前页勾选待加入对比的资产 id
  let compareLabel; // 工具栏「加入对比」按钮的文案节点（动态更新计数）

  // 初始数据
  let data = await fetchData();
  const members = await fetchMembers();

  // 整体布局
  const layout = el("div", { class: "ledger-layout" });
  root.appendChild(layout);

  // 左侧分类树
  const tree = el("div", { class: "ledger-tree" });
  layout.appendChild(tree);

  // 右侧内容
  const right = el("div", {});
  layout.appendChild(right);

  // 工具栏
  const toolbar = el("div", { class: "ledger-toolbar" });
  right.appendChild(toolbar);

  // 列表区
  const listBox = el("div", {});
  right.appendChild(listBox);

  renderTree();
  renderToolbar();
  renderList();

  async function fetchData() {
    const params = new URLSearchParams();
    if (currentDirection) params.set("direction", currentDirection);
    if (currentCategory) params.set("category", currentCategory);
    if (currentHolder) params.set("holder_id", currentHolder);
    if (currentStatus) params.set("status", currentStatus);
    if (searchKeyword) params.set("q", searchKeyword);
    const qs = params.toString();
    return apiGet(`/finance/assets${qs ? "?" + qs : ""}`);
  }

  function renderTree() {
    tree.innerHTML = "";
    // 全部
    tree.appendChild(el("div", {
      class: `ledger-tree__item${!currentCategory ? " active" : ""}`,
      onClick: () => { currentCategory = ""; refresh(); },
    }, [el("span", { text: "全部分类" })]));

    // 各分类
    for (const g of data.groups) {
      const isActive = currentCategory === g.code;
      tree.appendChild(el("div", {
        class: `ledger-tree__item${isActive ? " active" : ""}`,
        onClick: () => { currentCategory = g.code; refresh(); },
      }, [
        el("span", { class: "ledger-tree__dot", style: `width:8px;height:8px;border-radius:2px;background:${categoryColor(g.code)};flex-shrink:0` }),
        el("span", { text: g.name }),
        el("span", { class: "ledger-tree__count", text: String(g.count) }),
      ]));
    }
  }

  function renderToolbar() {
    toolbar.innerHTML = "";

    // 搜索框
    const searchInput = input({
      type: "search", name: "q", value: searchKeyword, placeholder: "搜索资产名称或机构",
      onInput: (e) => { searchKeyword = e.target.value; },
    });
    // 搜索防抖
    let debounce;
    searchInput.addEventListener("input", () => {
      clearTimeout(debounce);
      debounce = setTimeout(refresh, 300);
    });

    // 方向筛选
    const dirSelect = select("direction", [
      { value: "", label: "全部方向" },
      { value: "asset", label: "资产" },
      { value: "liability", label: "负债" },
    ], {
      value: currentDirection,
      onChange: (v) => { currentDirection = v; refresh(); },
    });

    // 归属人筛选
    const holderOptions = [{ value: "", label: "全部归属人" }];
    for (const m of members) {
      if (m.is_active) holderOptions.push({ value: String(m.id), label: m.name });
    }
    const holderSelect = select("holder", holderOptions, {
      value: currentHolder,
      onChange: (v) => { currentHolder = v; refresh(); },
    });

    // 状态筛选
    const statusSelect = select("status", [
      { value: "", label: "全部状态" },
      { value: "holding", label: "持有中" },
      { value: "urgent", label: "即将到期" },
      { value: "soon", label: "30天内" },
      { value: "matured", label: "已到期" },
      { value: "overdue", label: "已逾期" },
      { value: "settled", label: "已结清" },
    ], {
      value: currentStatus,
      onChange: (v) => { currentStatus = v; refresh(); },
    });

    toolbar.appendChild(searchInput);
    toolbar.appendChild(dirSelect);
    toolbar.appendChild(holderSelect);
    toolbar.appendChild(statusSelect);
    toolbar.appendChild(el("div", { style: "flex:1" }));
    // 加入对比（勾选 ≥1 时可用，计入 basket 后跳转对比页，compare-design §4.2）
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
          syncCompareBtn();
          location.hash = "#/finance/compare";
        }
      },
    }, [compareLabel]);
    toolbar.appendChild(compareBtn);
    toolbar.appendChild(btn("成员管理", { variant: "secondary", size: "sm", icon: "note", onClick: () => openMembersDialog(refresh) }));
    toolbar.appendChild(btn("新增资产", { variant: "primary", icon: "plus", onClick: () => openAssetDialog(null, refresh) }));
    syncCompareBtn();
  }

  /** 同步工具栏「加入对比」按钮的可用态与计数（不重建输入框，避免失焦） */
  function syncCompareBtn() {
    const btnNode = compareLabel?.parentElement;
    if (!btnNode) return;
    const n = compareSelected.size;
    compareLabel.textContent = n > 0 ? `加入对比（${n}）` : "加入对比";
    btnNode.disabled = n === 0;
  }

  function renderList() {
    listBox.innerHTML = "";
    if (data.items.length === 0) {
      const empty = emptyState("暂无资产记录", "点击右上角「新增资产」开始记录你的家庭资产");
      empty.appendChild(el("div", { class: "empty-action" }, [
        btn("新增资产", { variant: "primary", icon: "plus", onClick: () => openAssetDialog(null, refresh) }),
      ]));
      listBox.appendChild(empty);
      return;
    }

    // 按分类分组
    const groups = {};
    for (const item of data.items) {
      (groups[item.category] = groups[item.category] || []).push(item);
    }

    // 按预置分类顺序排列
    const orderedCodes = Object.values(CATEGORY_MAP).map((c) => c.code);
    for (const code of orderedCodes) {
      if (!groups[code]) continue;
      const items = groups[code];
      const g = data.groups.find((x) => x.code === code) || { name: code, amount_cents: 0 };
      const isCollapsed = collapsedGroups.has(code);

      const groupEl = el("div", { class: `group-head${isCollapsed ? " group-head--collapsed" : ""}`, onClick: () => {
        if (collapsedGroups.has(code)) collapsedGroups.delete(code);
        else collapsedGroups.add(code);
        renderList();
      }}, [
        el("span", { class: "group-head__arrow", text: "▼" }),
        el("span", { text: g.name || CATEGORY_MAP[code]?.name || code }),
        el("span", { class: "group-head__count", text: `${items.length} 项` }),
        el("span", { class: "group-head__amount", text: fmtMoney(g.amount_cents) }),
      ]);
      listBox.appendChild(groupEl);

      if (isCollapsed) continue;

      // 表格
      const cols = [
        { label: "", key: "_compare", render: (row) => {
          // 对比勾选列（compare-design §4.2）：负债行禁用
          const cb = el("input", { type: "checkbox", class: "compare-check" });
          cb.checked = compareSelected.has(row.id);
          cb.disabled = row.direction === "liability";
          cb.title = row.direction === "liability" ? "负债无收益概念，暂不支持对比" : "勾选加入对比";
          cb.addEventListener("change", (e) => {
            e.stopPropagation();
            if (e.target.checked) compareSelected.add(row.id);
            else compareSelected.delete(row.id);
            syncCompareBtn();
          });
          const td = el("span", {}, [cb]);
          td.addEventListener("click", (e) => e.stopPropagation()); // 防止触发行点击进详情
          return td;
        } },
        { label: "名称", key: "name", render: (row) => el("span", {}, [
          row.attachment_count > 0
            ? el("span", { class: "ledger-attach-icon", title: `${row.attachment_count} 个附件` }, [icon("paperclip", 14)])
            : null,
          el("span", { text: row.name }),
        ]) },
        { label: "归属人", key: "holder_name" },
        { label: "机构/对手", key: "institution", render: (row) => row.institution || "—" },
        { label: "金额", key: "amount", render: (row) => {
          const amt = row.computed?.remaining_cents != null ? row.computed.remaining_cents : row.amount_cents;
          return fmtMoney(amt);
        }},
        { label: "状态", key: "status", render: (row) => tag(STATUS_LABELS[row.effective_status] || row.effective_status, statusVariant(row.effective_status)) },
        { label: "到期", key: "end_date", render: (row) => row.end_date ? dueText(row.computed?.days_to_end) : "—" },
        { label: "", key: "_actions", render: (row) => el("span", { class: "row-actions" }, [
          row.direction === "asset"
            ? btn(getCompareIds().includes(row.id) ? "已对比" : "对比", {
                variant: "ghost", size: "sm",
                onClick: (e) => {
                  e.stopPropagation();
                  const r = toggleCompare(row.id, row.direction);
                  toast(r.reason, r.ok ? "ok" : "warn");
                  renderList(); // 刷新按钮文案
                },
              })
            : null,
        ]) },
      ];

      const tbody = items.map((row) =>
        el("tr", {
          class: `asset-row ${statusRowClass(row.effective_status)}`,
          onClick: () => { location.hash = `#/finance/assets/${row.id}`; },
        }, cols.map((col) =>
          el("td", {}, [col.render ? col.render(row) : (row[col.key] || "—")])
        ))
      );

      const tbl = el("table", { class: "table" }, [
        el("thead", {}, [el("tr", {}, cols.map((c) => el("th", { text: c.label })))]),
        el("tbody", {}, tbody),
      ]);
      listBox.appendChild(tbl);
    }
  }

  async function refresh() {
    try {
      data = await fetchData();
      renderTree();
      renderList();
    } catch (err) {
      listBox.innerHTML = "";
      listBox.appendChild(el("div", { class: "banner error", text: err.message }));
    }
  }
}
