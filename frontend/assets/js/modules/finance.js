/** 理财模块页面：框架阶段展示模块占位；完整功能（账户/记账/统计/预算）于 M2 迭代交付。 */

import { apiGet } from "../api.js";
import { pageHeader, placeholderCard, card, table } from "../ui.js";

const MILESTONE = "M2";
const FEATURES = "账户管理 · 收支记账 · 统计报表 · 预算管理";

const STATUS_LABEL = { cash: "现金", bank: "银行", investment: "投资", debt: "负债" };

export async function render(root, mod) {
  root.appendChild(pageHeader(mod, MILESTONE));
  const accounts = await apiGet("/finance/accounts");
  root.appendChild(
    accounts.length
      ? card("账户列表", table(accounts, [
          { label: "名称", key: "name" },
          { label: "类型", key: "type", render: (row) => STATUS_LABEL[row.type] || row.type || "—" },
          { label: "币种", key: "currency" },
          { label: "初始余额", key: "initial_balance" },
          { label: "备注", key: "note" },
        ]))
      : placeholderCard(mod, FEATURES)
  );
}
