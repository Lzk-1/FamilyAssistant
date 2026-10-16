/** 用户头像组件（M4.1）：自定义图片或「显示名首字」确定性配色默认头像。
 *  零图片零依赖：默认头像颜色由用户名哈希决定（同一用户跨设备颜色一致）。
 *  自定义头像走 /auth/users/{id}/avatar（同源 <img> 自动带会话 cookie）。
 */

import { el } from "./ui.js";

const API_BASE = "/api/v1";

// 克制的家庭向色板（饱和度适中，白字可读），与平台蓝色系协调
const PALETTE = [
  "#2563eb", "#0891b2", "#059669", "#d97706",
  "#dc2626", "#7c3aed", "#db2777", "#4f46e5",
  "#0d9488", "#65a30d", "#ea580c", "#9333ea",
];

function hashIndex(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h % PALETTE.length;
}

/** 取头像首字：优先显示名，其次用户名；中文取首字，英文取首字母大写 */
function initialOf(user) {
  const name = (user.display_name || user.username || "?").trim();
  return (name[0] || "?").toUpperCase();
}

/** 圆形头像。size=28（侧边栏）/36（成员表格）/72（个人中心）。 */
export function avatar(user, size = 28) {
  const box = el("span", {
    class: "fa-avatar",
    style: `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px`,
    "aria-hidden": "true",
  });
  if (user.avatar_path) {
    const img = el("img", {
      class: "fa-avatar__img",
      src: `${API_BASE}/auth/users/${user.id}/avatar?v=${encodeURIComponent(user.avatar_path)}`,
      alt: "",
    });
    img.addEventListener("error", () => {
      // 文件丢失/404：降级为默认头像
      box.classList.add("fa-avatar--fallback");
      box.style.background = PALETTE[hashIndex(user.username)];
      box.textContent = initialOf(user);
      img.remove();
    });
    box.appendChild(img);
  } else {
    box.style.background = PALETTE[hashIndex(user.username)];
    box.textContent = initialOf(user);
  }
  return box;
}
