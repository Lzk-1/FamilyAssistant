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
    else if (key === "onClick" && typeof value === "function") node.addEventListener("click", value);
    else if (key === "style" && typeof value === "string") node.style.cssText = value;
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

/** 数据表格。columns: [{label, key, render?}]（render 可返回字符串或 DOM 节点）；
 *  onRowClick(row) 行点击回调。rows 为空时展示空状态。 */
export function table(rows, columns, { onRowClick } = {}) {
  if (!rows || rows.length === 0) {
    return emptyState("暂无数据", "功能开发完成后，这里将展示你的记录。");
  }
  const thead = el("thead", {}, [
    el("tr", {}, columns.map((col) => el("th", { text: col.label }))),
  ]);
  const tbody = el("tbody", {}, rows.map((row) => {
    const cells = columns.map((col) => {
      const content = col.render ? col.render(row) : (row[col.key] ?? "—");
      return content instanceof Node
        ? el("td", {}, [content])
        : el("td", { text: content });
    });
    return el("tr", onRowClick ? { onClick: () => onRowClick(row), style: "cursor:pointer" } : {}, cells);
  }));
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

// ============================================================
// M2 组件（规范第 4 章）
// ============================================================

/** 按钮（规范 4.1）：variant = primary/secondary/danger/ghost；size = sm/md */
export function btn(label, { variant = "primary", size, icon: iconName, onClick } = {}) {
  const cls = `fa-btn fa-btn--${variant}${size === "sm" ? " fa-btn--sm" : ""}`;
  const node = el("button", { class: cls }, [
    iconName ? icon(iconName, size === "sm" ? 14 : 16) : null,
    label ? label : null,
  ]);
  if (onClick) node.addEventListener("click", onClick);
  return node;
}

/** 图标按钮（行内轻量操作） */
export function iconBtn(iconName, { variant = "ghost", size, title, onClick } = {}) {
  const cls = `fa-btn fa-btn--${variant} fa-btn--icon${size === "sm" ? " fa-btn--sm" : ""}`;
  const node = el("button", { class: cls, title: title || "" }, [icon(iconName, size === "sm" ? 14 : 16)]);
  if (onClick) node.addEventListener("click", onClick);
  return node;
}

/** 文本输入框 */
export function input({ type = "text", name, value, placeholder, onInput } = {}) {
  const node = el("input", { type, class: "fa-input" });
  if (name) node.name = name;
  if (value != null) node.value = value;
  if (placeholder) node.placeholder = placeholder;
  if (onInput) node.addEventListener("input", onInput);
  return node;
}

/** 下拉选择框 */
export function select(name, options, { value, onChange } = {}) {
  const node = el("select", { class: "fa-input" });
  if (name) node.name = name;
  for (const opt of options) {
    const o = el("option", { value: opt.value, text: opt.label });
    if (opt.value === value) o.selected = true;
    if (opt.disabled) o.disabled = true;
    node.appendChild(o);
  }
  if (onChange) node.addEventListener("change", () => onChange(node.value));
  return node;
}

/** 多行文本框 */
export function textarea({ name, value, placeholder, rows = 3, onInput } = {}) {
  const node = el("textarea", { class: "fa-input", rows: String(rows) });
  if (name) node.name = name;
  if (value != null) node.value = value;
  if (placeholder) node.placeholder = placeholder;
  if (onInput) node.addEventListener("input", onInput);
  return node;
}

/** 表单字段：label + 控件 + 错误提示 */
export function field(label, control, { error, required } = {}) {
  const children = [
    el("label", { class: "fa-field__label", text: required ? `${label} *` : label }),
    el("div", { class: "fa-field__control" }, [control]),
  ];
  if (error) children.push(el("p", { class: "fa-field__error", text: error }));
  return el("div", { class: "fa-field" }, children);
}

/** 统计卡片：左侧色条 + 标签 + 数值 + 可选子文本 */
export function statCard({ label, value, sub, accent } = {}) {
  const style = accent ? `--stat-accent: ${accent}` : "";
  return el("div", { class: "fa-stat", style }, [
    el("div", { class: "fa-stat__bar" }),
    el("div", { class: "fa-stat__body" }, [
      el("div", { class: "fa-stat__label", text: label }),
      el("div", { class: "fa-stat__value", text: value }),
      sub ? el("div", { class: "fa-stat__sub", text: sub }) : null,
    ]),
  ]);
}

/** Tab 栏：tabs=[{key,label}]；activeKey 当前选中；onChange 切换回调 */
export function tabs(tabs, activeKey, onChange) {
  const nav = el("div", { class: "fa-tabs" },
    tabs.map((t) =>
      el("a", {
        class: `fa-tabs__item${t.key === activeKey ? " active" : ""}`,
        text: t.label,
        href: "javascript:void(0)",
        onClick: () => onChange && onChange(t.key),
      })
    )
  );
  return nav;
}

/** 模态弹窗（规范 4.3）：返回 {el, close}；width = normal/wide/narrow */
export function modal({ title, body, footer, width = "normal", onClose, danger } = {}) {
  const overlay = el("div", { class: `fa-modal__overlay${danger ? " fa-modal__overlay--danger" : ""}` });
  const dialog = el("div", { class: `fa-modal fa-modal--${width}` }, [
    el("div", { class: "fa-modal__header" }, [
      el("h3", { text: title }),
      iconBtn("close", { variant: "ghost", size: "sm", title: "关闭", onClick: () => close() }),
    ]),
    el("div", { class: "fa-modal__body" }, [body]),
    footer ? el("div", { class: "fa-modal__footer" }, [footer]) : null,
  ]);
  overlay.appendChild(dialog);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  function close() {
    overlay.remove();
    if (onClose) onClose();
  }
  document.body.appendChild(overlay);
  return { el: dialog, close };
}

/** Toast 通知（规范 4.7）：type = ok/warn/err/info；2.5s 自动消失 */
export function toast(message, type = "info") {
  const t = el("div", { class: `fa-toast fa-toast--${type}` }, [
    icon(type === "ok" ? "check" : type === "err" ? "alert" : "alert", 16),
    el("span", { text: message }),
  ]);
  const container = document.querySelector(".fa-toast-container") || (() => {
    const c = el("div", { class: "fa-toast-container" });
    document.body.appendChild(c);
    return c;
  })();
  container.appendChild(t);
  setTimeout(() => {
    t.classList.add("fa-toast--out");
    setTimeout(() => t.remove(), 300);
  }, 2500);
  return t;
}

/** 确认弹窗：返回 Promise<boolean> */
export function confirmModal({ title, message, confirmLabel = "确认", danger } = {}) {
  return new Promise((resolve) => {
    let resolved = false;
    const m = modal({
      title,
      width: "narrow",
      danger,
      body: el("p", { text: message, style: "line-height:1.6" }),
      footer: el("div", { class: "fa-modal__footer" }, [
        btn("取消", { variant: "secondary", onClick: () => { if (!resolved) { resolved = true; resolve(false); m.close(); } } }),
        btn(confirmLabel, { variant: danger ? "danger" : "primary", onClick: () => { if (!resolved) { resolved = true; resolve(true); m.close(); } } }),
      ]),
    });
  });
}

/** Lightbox 大图预览（ui-design 文件存档「图片直显」规范）：images = [{src, name?}]，
 *  index 为起始索引；交互：左右翻页（循环）/ Esc / 点击遮罩关闭。返回 {el, close}。 */
export function lightbox(images, index = 0) {
  images = images || [];
  if (images.length === 0) return { el: null, close: () => {} };
  let current = Math.max(0, Math.min(index, images.length - 1));

  const img = el("img", { class: "fa-lightbox__img", alt: "照片预览" });
  const caption = el("div", { class: "fa-lightbox__caption" });
  const prevBtn = el("button", { class: "fa-lightbox__nav fa-lightbox__nav--prev", title: "上一张" }, [icon("chevron-left", 22)]);
  const nextBtn = el("button", { class: "fa-lightbox__nav fa-lightbox__nav--next", title: "下一张" }, [icon("chevron-right", 22)]);
  const closeBtn = el("button", { class: "fa-lightbox__close", title: "关闭（Esc）" }, [icon("close", 20)]);
  const overlay = el("div", { class: "fa-lightbox" });

  function render() {
    const item = images[current];
    img.src = item.src;
    caption.textContent = [item.name, `${current + 1} / ${images.length}`].filter(Boolean).join("　·　");
  }
  function go(delta) {
    current = (current + delta + images.length) % images.length;
    render();
  }
  function onKey(e) {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowLeft") go(-1);
    else if (e.key === "ArrowRight") go(1);
  }
  function close() {
    document.removeEventListener("keydown", onKey);
    overlay.remove();
  }

  prevBtn.addEventListener("click", () => go(-1));
  nextBtn.addEventListener("click", () => go(1));
  closeBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.append(prevBtn, nextBtn, closeBtn, img, caption);
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
  render();
  return { el: overlay, close };
}
