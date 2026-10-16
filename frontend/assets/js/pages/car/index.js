/** 选车模块入口：子路由分发 + 二级 Tab 导航。
 *  路由约定：#/car → 车型档案，#/car/detail/:id → 车型详情，#/car/compare → 对比分析。
 */

import { pageHeader, tabs, errorBanner } from "../../ui.js";
import { renderList } from "./list.js";
import { renderDetail } from "./detail.js";
import { renderCompare } from "./compare.js";

const TABS = [
  { key: "list", label: "车型档案" },
  { key: "compare", label: "对比分析" },
];

/** 解析 hash 子路由：返回 { section, id, query } */
export function parseRoute() {
  const rest = location.hash.replace(/^#\/car\/?/, "");
  const [pathPart, queryPart] = rest.split("?");
  const segments = pathPart.split("/").filter(Boolean);
  const query = {};
  if (queryPart) {
    for (const pair of queryPart.split("&")) {
      const [k, v] = pair.split("=");
      if (k) query[decodeURIComponent(k)] = decodeURIComponent(v || "");
    }
  }
  return { section: segments[0] || "", id: segments[1] || "", query };
}

export async function render(root, mod) {
  // 页头
  root.appendChild(pageHeader(mod));

  const route = parseRoute();

  // 详情页无 Tab 栏（独立全页视图，跟随理财详情页模式）
  if (route.section === "detail" && route.id) {
    const detailBox = document.createElement("div");
    root.appendChild(detailBox);
    await renderDetail(detailBox, route.id);
    return;
  }

  // Tab 栏
  const activeTab = route.section === "compare" ? "compare" : "list";
  const tabBar = tabs(TABS, activeTab, (key) => {
    location.hash = key === "compare" ? "#/car/compare" : "#/car";
  });
  root.appendChild(tabBar);

  // 内容区
  const content = document.createElement("div");
  root.appendChild(content);

  try {
    if (activeTab === "compare") {
      await renderCompare(content, mod);
    } else {
      await renderList(content, mod);
    }
  } catch (err) {
    content.appendChild(errorBanner(err.message));
  }
}
