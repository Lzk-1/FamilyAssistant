/** 内联 SVG 图标注册表（零依赖图标方案，见 docs/ui-design.md 第 4.9 节）。
 *
 * 风格约定：24 viewBox / stroke 1.5 / 圆角端点 / currentColor 继承文字颜色。
 * 使用：icon("wallet", 18) 返回 SVG 元素；导航图标颜色由 CSS 按模块主题色控制。
 */

const ICONS = {
  /* 模块图标 */
  wallet:
    '<path d="M20 12V8H6a2 2 0 0 1 0-4h12v4"/>' +
    '<path d="M4 6v12a2 2 0 0 0 2 2h14v-5"/>' +
    '<path d="M18 12a2 2 0 0 0 0 4h2v-4h-2Z"/>',
  home:
    '<path d="M3 11 12 4l9 7"/>' +
    '<path d="M6 9.5V20h12V9.5"/>' +
    '<path d="M10 20v-5h4v5"/>',
  car:
    '<path d="M4 16.5 5.7 11a2 2 0 0 1 1.9-1.5h8.8a2 2 0 0 1 1.9 1.5l1.7 5.5"/>' +
    '<path d="M3 16.5h18"/>' +
    '<path d="M6.5 16.5v2.5"/><path d="M17.5 16.5v2.5"/>' +
    '<path d="M5.5 13.5h13"/>',
  note:
    '<path d="M6 3h8l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/>' +
    '<path d="M14 3v6h6"/>' +
    '<path d="M8 13h7"/><path d="M8 17h5"/>',
  folder:
    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',

  /* 操作图标 */
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  edit: '<path d="M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  trash:
    '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/>' +
    '<path d="m19 6-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>' +
    '<path d="M10 11v6"/><path d="M14 11v6"/>',
  upload:
    '<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/>' +
    '<path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  download:
    '<path d="M12 4v12"/><path d="m7 11 5 5 5-5"/>' +
    '<path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4-2v-4Z"/>',
  close: '<path d="m6 6 12 12"/><path d="M18 6 6 18"/>',
  check: '<path d="m5 13 4 4L19 7"/>',
  calendar:
    '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/>' +
    '<path d="M8 3v4"/><path d="M16 3v4"/>',
  alert: '<path d="M12 4 2.5 20h19Z"/><path d="M12 10v4"/><path d="M12 17.5v.01"/>',
  paperclip:
    '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',

  /* 选车模块（M3） */
  star: '<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.7l5.9-.9Z"/>',
  image:
    '<rect x="3" y="5" width="18" height="14" rx="2"/>' +
    '<circle cx="8.5" cy="10" r="1.5"/>' +
    '<path d="m5 17.5 4.5-4.5 3 3 3.5-3.5 3 3"/>',
  "chevron-left": '<path d="m14 6-6 6 6 6"/>',
  "chevron-right": '<path d="m10 6 6 6-6 6"/>',
};

export function icon(name, size = 16) {
  const markup = ICONS[name];
  if (!markup) {
    console.warn(`icons.js: 未定义图标 "${name}"`);
    return document.createTextNode("");
  }
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = markup;
  return svg;
}
