/** 选房模块页面：框架阶段展示模块占位；完整功能（档案/看房记录/对比评分）于 M3 迭代交付。 */

import { apiGet } from "../api.js";
import { pageHeader, placeholderCard, card, table } from "../ui.js";

const MILESTONE = "M3";
const FEATURES = "房源档案 · 看房记录 · 多房对比 · 加权评分";

const STATUS_LABEL = {
  watching: "关注中", visiting: "看房中", comparing: "对比中",
  dropped: "已放弃", chosen: "已选定",
};

export async function render(root, mod) {
  root.appendChild(pageHeader(mod, MILESTONE));
  const candidates = await apiGet("/house/candidates");
  root.appendChild(
    candidates.length
      ? card("候选房源", table(candidates, [
          { label: "房源", key: "title" },
          { label: "小区", key: "community" },
          { label: "城市", key: "city" },
          { label: "总价(万)", key: "total_price" },
          { label: "面积(㎡)", key: "area" },
          { label: "户型", key: "layout" },
          { label: "状态", key: "status", render: (row) => STATUS_LABEL[row.status] || row.status || "—" },
        ]))
      : placeholderCard(mod, FEATURES)
  );
}
