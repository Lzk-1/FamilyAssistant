/** 资产台账页：分类侧栏 + 分组表格 + 筛选 + 搜索 + 新增/成员管理入口。
 *  分类树点击筛选，分组表头折叠/展开，行着色按状态，行点击进详情。
 *  权限（M4.1）：写操作（新增/导入/成员管理/批量删除）仅 admin；成员只读。
 */

import { apiGet, apiPost, apiDelete } from "../../api.js";
import { el, btn, input, select, tag, emptyState, toast, confirmModal, iconBtn } from "../../ui.js";
import { icon } from "../../icons.js";
import { isAdmin } from "../../session.js";
import { fmtMoney, statusVariant, statusRowClass, dueText, fmtMonth, STATUS_LABELS, CATEGORY_MAP, categoryColor, fetchMembers, toggleCompare, addManyToCompare, getCompareIds } from "./common.js";
import { openAssetDialog } from "./dialog.js";
import { openMembersDialog } from "./members.js";
import { openExportDialog, openImportDialog } from "./io.js";

export async function renderLedger(root, query) {
  // 本地状态
  let currentCategory = query.category || "";
  let currentDirection = "";
  let currentHolder = query.holder_id || "";
  let currentStatus = "";
  let searchKeyword = query.q || ""; // 总览机构分布图跳转：按机构名预填搜索
  const collapsedGroups = new Set();
  const selectedIds = new Set(); // 行首勾选：admin 可用于「加入对比/批量删除」，成员仅用于对比
  const rowMap = new Map();     // 当前列表 id → 行数据（判断资产/负债、单删取名称）
  let compareLabel; // 工具栏「加入对比」按钮的文案节点（动态更新计数）
  let deleteLabel;  // 工具栏「批量删除」按钮的文案节点
  const admin = isAdmin();

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

    // 加入对比（统一勾选：仅资产参与，负债自动剔除并提示）
    compareLabel = document.createTextNode("加入对比");
    const compareBtn = el("button", {
      class: "fa-btn fa-btn--secondary fa-btn--sm",
      disabled: true,
      onClick: () => addSelectedToCompare(),
    }, [compareLabel]);
    toolbar.appendChild(compareBtn);
    if (admin) {
      // 顺序：导入 → 导出（数据交换一对）→ 成员管理 → 批量删除 → 新增资产（主按钮收尾）
      toolbar.appendChild(btn("导入", { variant: "secondary", size: "sm", icon: "upload", onClick: () => openImportDialog(refresh) }));
      toolbar.appendChild(btn("导出", { variant: "secondary", size: "sm", icon: "download", onClick: openExportDialog }));
      toolbar.appendChild(btn("成员管理", { variant: "secondary", size: "sm", icon: "note", onClick: () => openMembersDialog(refresh) }));
      deleteLabel = document.createTextNode("批量删除");
      const batchDelBtn = el("button", {
        class: "fa-btn fa-btn--secondary fa-btn--sm",
        disabled: true,
        onClick: () => execBatchDelete(),
      }, [icon("trash", 14), deleteLabel]);
      toolbar.appendChild(batchDelBtn);
      toolbar.appendChild(btn("新增资产", { variant: "primary", icon: "plus", onClick: () => openAssetDialog(null, refresh) }));
    } else {
      toolbar.appendChild(btn("导出", { variant: "secondary", size: "sm", icon: "download", onClick: openExportDialog }));
    }
    syncActionButtons();
  }

  /** 当前勾选中的资产/负债拆分 */
  function selectedSplit() {
    const assetIds = [], liabilityCount = { n: 0 };
    for (const id of selectedIds) {
      const row = rowMap.get(Number(id));
      if (!row) continue;
      if (row.direction === "liability") liabilityCount.n += 1;
      else assetIds.push(Number(id));
    }
    return { assetIds, liabilityCount: liabilityCount.n };
  }

  async function addSelectedToCompare() {
    if (selectedIds.size === 0) return;
    const { assetIds, liabilityCount } = selectedSplit();
    if (assetIds.length === 0) {
      toast("负债无收益概念，暂不支持对比", "warn");
      return;
    }
    const r = addManyToCompare(assetIds);
    toast(r.ok && liabilityCount > 0
      ? `${r.reason}；${liabilityCount} 项负债不支持对比已自动跳过`
      : r.reason, r.ok ? "ok" : "warn");
    if (r.ok) {
      selectedIds.clear();
      syncActionButtons();
      renderList();
      location.hash = "#/finance/compare";
    }
  }

  async function execBatchDelete() {
    if (selectedIds.size === 0) return;
    const n = selectedIds.size;
    const ok = await confirmModal({
      title: "批量删除资产",
      message: `确定删除勾选的 ${n} 项资产吗？删除后从台账消失且不可恢复。`,
      confirmLabel: `删除 ${n} 项`,
      danger: true,
    });
    if (!ok) return;
    try {
      const result = await apiPost("/finance/assets/batch-delete", { ids: [...selectedIds] });
      const missing = result.missing?.length || 0;
      toast(missing ? `已删除 ${result.deleted} 项，${missing} 项不存在或已被删除` : `已删除 ${result.deleted} 项`, "ok");
      selectedIds.clear();
      await refresh();
    } catch (err) {
      toast(err.message, "err");
    }
  }

  /** 行尾垃圾桶：直接删除单行（二次确认） */
  async function deleteSingle(row) {
    const ok = await confirmModal({
      title: "删除资产",
      message: `确定删除「${row.name}」吗？删除后从台账消失且不可恢复。`,
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    try {
      await apiDelete(`/finance/assets/${row.id}`);
      toast("已删除", "ok");
      selectedIds.delete(row.id);
      await refresh();
    } catch (err) {
      toast(err.message, "err");
    }
  }

  /** 同步「加入对比 / 批量删除」两个按钮的计数与可用态（不重建输入框，避免失焦） */
  function syncActionButtons() {
    const n = selectedIds.size;
    const cBtn = compareLabel?.parentElement;
    if (cBtn) {
      compareLabel.textContent = n > 0 ? `加入对比（${n}）` : "加入对比";
      cBtn.disabled = n === 0;
    }
    const dBtn = deleteLabel?.parentElement;
    if (dBtn) {
      deleteLabel.textContent = n > 0 ? `批量删除（${n}）` : "批量删除";
      dBtn.disabled = n === 0;
    }
  }

  function renderList() {
    listBox.innerHTML = "";
    // 同步行数据索引；筛选/删除后清掉已不在列表中的勾选项
    rowMap.clear();
    for (const item of data.items) rowMap.set(item.id, item);
    for (const id of [...selectedIds]) if (!rowMap.has(Number(id))) selectedIds.delete(Number(id));
    syncActionButtons();
    if (data.items.length === 0) {
      const empty = emptyState("暂无资产记录",
        admin ? "点击右上角「新增资产」开始记录你的家庭资产" : "管理员尚未添加资产记录");
      if (admin) {
        empty.appendChild(el("div", { class: "empty-action" }, [
          btn("新增资产", { variant: "primary", icon: "plus", onClick: () => openAssetDialog(null, refresh) }),
        ]));
      }
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
        { label: "", key: "_select", render: (row) => {
          // 通用勾选列：勾选结果同时供「加入对比」（只取资产）与「批量删除」（admin）使用
          const cb = el("input", { type: "checkbox", class: "compare-check", title: "勾选" });
          cb.checked = selectedIds.has(row.id);
          cb.addEventListener("change", (e) => {
            if (e.target.checked) selectedIds.add(row.id);
            else selectedIds.delete(row.id);
            e.target.closest("tr")?.classList.toggle("asset-row--selected", e.target.checked);
            syncActionButtons();
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
        { label: "到期", key: "end_date", render: (row) => {
          if (row.end_date) return dueText(row.computed?.days_to_end);
          // 负债无到期日的兜底（M3b 增强）：房贷显示预计结清月、信用卡显示距还款日
          const c = row.computed || {};
          if (row.category === "mortgage" && c.payoff_month) return `预计结清 ${fmtMonth(c.payoff_month)}`;
          if (row.category === "credit_card" && c.next_repay_date) return c.days_to_repay === 0 ? "今天还款" : `${c.days_to_repay} 天后还款`;
          return "—";
        } },
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
          admin
            ? iconBtn("trash", {
                variant: "ghost", size: "sm", title: "删除该行",
                onClick: (e) => { e.stopPropagation(); deleteSingle(row); },
              })
            : null,
        ]) },
      ];

      const tbody = items.map((row) => {
        const tr = el("tr", {
          class: `asset-row ${statusRowClass(row.effective_status)}${selectedIds.has(row.id) ? " asset-row--selected" : ""}`,
          onClick: () => { location.hash = `#/finance/assets/${row.id}`; },
        });
        for (const col of cols) {
          tr.appendChild(el("td", {}, [col.render ? col.render(row) : (row[col.key] || "—")]));
        }
        return tr;
      });

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
