/** 备忘录模块页面：框架阶段展示模块占位；完整功能（增删改查/优先级/提醒/标签）于 M1 迭代交付。 */

import { apiGet } from "../api.js";
import { pageHeader, placeholderCard, card, table } from "../ui.js";

const MILESTONE = "M1";
const FEATURES = "增删改查 · 优先级 · 到期提醒 · 标签分类";

const PRIORITY_LABEL = { low: "低", normal: "中", high: "高" };
const STATUS_LABEL = { open: "进行中", done: "已完成" };

export async function render(root, mod) {
  root.appendChild(pageHeader(mod, MILESTONE));
  const memos = await apiGet("/memo/memos");
  root.appendChild(
    memos.length
      ? card("全部备忘", table(memos, [
          { label: "标题", key: "title" },
          { label: "优先级", key: "priority", render: (row) => PRIORITY_LABEL[row.priority] || row.priority || "—" },
          { label: "状态", key: "status", render: (row) => STATUS_LABEL[row.status] || row.status || "—" },
          { label: "截止时间", key: "due_at" },
        ]))
      : placeholderCard(mod, FEATURES)
  );
}
