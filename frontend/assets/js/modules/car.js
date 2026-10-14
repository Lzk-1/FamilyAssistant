/** 选车模块页面：框架阶段展示模块占位；完整功能（档案/参数对比/成本测算）于 M3 迭代交付。 */

import { apiGet } from "../api.js";
import { pageHeader, placeholderCard, card, table } from "../ui.js";

const MILESTONE = "M3";
const FEATURES = "车型档案 · 参数对比 · 持有成本测算 · 评分决策";

const STATUS_LABEL = {
  watching: "关注中", test_driving: "试驾中", comparing: "对比中",
  dropped: "已放弃", chosen: "已选定",
};

const ENERGY_LABEL = { fuel: "燃油", ev: "纯电", hybrid: "混动" };

export async function render(root, mod) {
  root.appendChild(pageHeader(mod, MILESTONE));
  const candidates = await apiGet("/car/candidates");
  root.appendChild(
    candidates.length
      ? card("候选车型", table(candidates, [
          { label: "品牌", key: "brand" },
          { label: "车型", key: "model" },
          { label: "配置", key: "version" },
          { label: "能源", key: "energy", render: (row) => ENERGY_LABEL[row.energy] || row.energy || "—" },
          { label: "价格(万)", key: "price" },
          { label: "状态", key: "status", render: (row) => STATUS_LABEL[row.status] || row.status || "—" },
        ]))
      : placeholderCard(mod, FEATURES)
  );
}
