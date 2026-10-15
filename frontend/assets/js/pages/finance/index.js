/** 理财模块入口：子路由分发 + 二级 Tab 导航。
 *  路由约定：#/finance → 总览，#/finance/assets → 台账，#/finance/assets/:id → 详情，
 *  #/finance/calendar → 日历，#/finance/compare → 对比分析，#/finance/analytics → 收益分析。
 */

import { pageHeader, tabs, errorBanner } from "../../ui.js";
import { renderOverview } from "./overview.js";
import { renderLedger } from "./ledger.js";
import { renderDetail } from "./detail.js";
import { renderCalendar } from "./calendar.js";
import { renderCompare } from "./compare.js";
import { renderAnalytics } from "./analytics.js";

const TABS = [
  { key: "overview", label: "总览" },
  { key: "assets", label: "资产台账" },
  { key: "calendar", label: "到期日历" },
  { key: "compare", label: "对比分析" },
  { key: "analytics", label: "收益分析" },
];

/** 解析 hash 子路由：返回 { section, id, query } */
export function parseRoute() {
  const rest = location.hash.replace(/^#\/finance\/?/, "");
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

/** 从 section 推导 Tab 高亮项 */
function tabKey(section) {
  if (!section) return "overview";
  if (section === "assets") return "assets";
  if (section === "calendar") return "calendar";
  if (section === "compare") return "compare";
  if (section === "analytics") return "analytics";
  return "overview";
}

export async function render(root, mod) {
  // 页头
  root.appendChild(pageHeader(mod, "M2"));

  const route = parseRoute();

  // 详情页无 Tab 栏（独立全页视图）：建独立容器，renderDetail 内部刷新时只清空该容器
  if (route.section === "assets" && route.id) {
    const detailBox = document.createElement("div");
    root.appendChild(detailBox);
    await renderDetail(detailBox, route.id);
    return;
  }

  // Tab 栏
  const activeTab = tabKey(route.section);
  const tabBar = tabs(TABS, activeTab, (key) => {
    const paths = { overview: "#/finance", assets: "#/finance/assets", calendar: "#/finance/calendar", compare: "#/finance/compare", analytics: "#/finance/analytics" };
    location.hash = paths[key] || "#/finance";
  });
  root.appendChild(tabBar);

  // 内容区
  const content = document.createElement("div");
  root.appendChild(content);

  try {
    switch (activeTab) {
      case "overview":
        await renderOverview(content, mod);
        break;
      case "assets":
        await renderLedger(content, mod, route.query);
        break;
      case "calendar":
        await renderCalendar(content, mod);
        break;
      case "compare":
        await renderCompare(content, mod);
        break;
      case "analytics":
        await renderAnalytics(content, mod);
        break;
    }
  } catch (err) {
    content.appendChild(errorBanner(err.message));
  }
}
