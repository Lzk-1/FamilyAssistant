/** 到期日历页：按状态分组列表（逾期/已到期/即将到期/30天内）。
 *  每组展示资产名称、分类、归属人、到期日、剩余天数、金额；行点击进详情。
 */

import { apiGet } from "../../api.js";
import { el, emptyState, card } from "../../ui.js";
import { fmtMoney, dueText, CATEGORY_MAP } from "./common.js";

export async function renderCalendar(root) {
  const today = todayISO();
  const from90 = new Date();
  from90.setDate(from90.getDate() + 90);
  const to90 = from90.toISOString().slice(0, 10);

  const data = await apiGet(`/finance/calendar?from=${today}&to=${to90}`);

  // 工具栏
  root.appendChild(el("div", { class: "ledger-toolbar" }, [
    el("span", { text: "到期日历", style: "font-size:16px;font-weight:600" }),
    el("span", { class: "muted", text: "展示未来 90 天内到期资产及所有逾期记录" }),
  ]));

  // 汇总
  const totalCount = data.groups.reduce((s, g) => s + g.items.length, 0);
  if (totalCount === 0) {
    root.appendChild(card("", emptyState("暂无到期记录", "30 天内到期的资产将显示在这里")));
    return;
  }

  // 分组渲染
  for (const group of data.groups) {
    if (group.items.length === 0) continue;
    const groupEl = el("div", { class: "cal-group" }, [
      el("div", { class: `cal-group__head cal-group__head--${group.level}` }, [
        el("span", { text: group.label }),
        el("span", { class: "badge", text: `${group.items.length} 项` }),
      ]),
    ]);

    // 列表
    const cols = [
      { label: "资产名称", key: "name" },
      { label: "分类", key: "category", render: (row) => CATEGORY_MAP[row.category]?.name || row.category },
      { label: "归属人", key: "holder_name" },
      { label: "到期日", key: "end_date" },
      { label: "剩余天数", key: "days", render: (row) => dueText(row.days_to_end) },
      { label: "金额", key: "amount", render: (row) => fmtMoney(row.amount_cents) },
    ];

    const tbody = group.items.map((row) =>
      el("tr", {
        class: `asset-row row--${group.level}`,
        onClick: () => { location.hash = `#/finance/assets/${row.asset_id}`; },
      }, cols.map((col) =>
        el("td", {}, [col.render ? col.render(row) : (row[col.key] || "—")])
      ))
    );

    groupEl.appendChild(el("table", { class: "table" }, [
      el("thead", {}, [el("tr", {}, cols.map((c) => el("th", { text: c.label })))]),
      el("tbody", {}, tbody),
    ]));

    root.appendChild(groupEl);
  }
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
