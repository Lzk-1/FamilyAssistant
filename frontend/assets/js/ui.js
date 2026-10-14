/** DOM 渲染工具：原生 JS 实现，避免引入前端框架与构建链（零构建策略）。
 * 组件规范见 docs/ui-design.md 第 4 章。
 */

import { icon } from "./icons.js";

/** 各业务模块的图标名（与后端 registry key 对应） */
export const MODULE_ICON = {
  finance: "wallet",
  house: "home",
  car: "car",
  memo: "note",
  files: "folder",
};

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (value != null) node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

/** 模块色徽标：模块主题色浅底 + 图标（用于页头 / 占位页） */
export function moduleBadge(key, size = "md") {
  const iconSize = size === "lg" ? 36 : 22;
  return el("span", { class: `module-badge${size === "lg" ? " module-badge--lg" : ""}`, "data-key": key }, [
    icon(MODULE_ICON[key] || "note", iconSize),
  ]);
}

/** 状态标签（规范 4.5）：variant = primary / ok / warn / danger / muted */
export function tag(text, variant = "primary") {
  return el("span", { class: `fa-tag fa-tag--${variant}`, text });
}

/** 页头：模块徽标 + 名称 + 描述 + 交付里程碑标签（规范 5.x 线框） */
export function pageHeader(mod, milestone) {
  return el("div", { class: "page-header" }, [
    el("div", { class: "page-header__main" }, [
      moduleBadge(mod.key),
      el("div", {}, [
        el("h2", { text: mod.name }),
        el("p", { text: mod.description }),
      ]),
    ]),
    milestone ? tag(`${milestone} 迭代交付`, "primary") : null,
  ]);
}

export function card(title, content) {
  return el("div", { class: "card" }, [
    title ? el("h3", { text: title }) : null,
    content,
  ]);
}

/** 数据表格。columns: [{label, key, render?}]；rows 为空时展示空状态。 */
export function table(rows, columns) {
  if (!rows || rows.length === 0) {
    return emptyState("暂无数据", "功能开发完成后，这里将展示你的记录。");
  }
  const thead = el("thead", {}, [
    el("tr", {}, columns.map((col) => el("th", { text: col.label }))),
  ]);
  const tbody = el("tbody", {}, rows.map((row) =>
    el("tr", {}, columns.map((col) =>
      el("td", { text: col.render ? col.render(row) : (row[col.key] ?? "—") })
    ))
  ));
  return el("table", { class: "table" }, [thead, tbody]);
}

/** 模块占位卡片（框架阶段）：模块大图标 + 建设中说明 + 规划功能 */
export function placeholderCard(mod, features) {
  return el("div", { class: "card placeholder-card" }, [
    moduleBadge(mod.key, "lg"),
    el("h3", { text: `「${mod.name}」模块建设中` }),
    el("p", { class: "muted", text: "数据接口与框架链路已就绪，页面功能将按路线图迭代交付。" }),
    features ? el("p", { class: "placeholder-features", text: `规划功能：${features}` }) : null,
  ]);
}

export function emptyState(title, desc) {
  return el("div", { class: "empty" }, [el("strong", { text: title }), desc]);
}

export function errorBanner(message) {
  return el("div", { class: "banner error", text: message });
}
