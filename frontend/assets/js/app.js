/** 前端入口：拉取模块注册表装配导航，hash 路由分发到各模块页面。 */

import { apiGet } from "./api.js";
import { icon } from "./icons.js";
import { el, errorBanner, MODULE_ICON } from "./ui.js";
import * as finance from "./modules/finance.js";
import * as house from "./modules/house.js";
import * as car from "./modules/car.js";
import * as memo from "./modules/memo.js";
import * as files from "./modules/files.js";

/** 渲染器按模块 key 注册；与后端 core/registry.py 的 key 一一对应。 */
const RENDERERS = { finance, house, car, memo, files };

const nav = document.getElementById("nav");
const view = document.getElementById("view");

let modules = [];

function buildNav() {
  nav.innerHTML = "";
  for (const mod of modules) {
    nav.appendChild(el("a", { href: mod.path, "data-key": mod.key }, [
      icon(MODULE_ICON[mod.key] || "note", 18),
      mod.name,
    ]));
  }
}

function currentKey() {
  const key = location.hash.replace("#/", "");
  for (const a of nav.querySelectorAll("a")) {
    a.classList.toggle("active", a.dataset.key === key);
  }
  return key;
}

async function route() {
  view.innerHTML = "";
  const key = currentKey();
  const mod = modules.find((m) => m.key === key);
  if (!mod || !RENDERERS[key]) {
    view.appendChild(errorBanner("未找到对应模块，请刷新页面或检查后端服务。"));
    return;
  }
  try {
    await RENDERERS[key].render(view, mod);
  } catch (err) {
    view.appendChild(errorBanner(err.message));
  }
}

async function checkHealth() {
  const dot = document.getElementById("health-dot");
  const text = document.getElementById("health-text");
  try {
    const info = await apiGet("/system/health");
    dot.classList.add("ok");
    text.textContent = `服务运行正常（v${info.version}）`;
  } catch {
    dot.classList.add("err");
    text.textContent = "服务不可用";
  }
}

async function bootstrap() {
  try {
    modules = await apiGet("/system/modules");
  } catch {
    modules = []; // 服务不可用：导航为空，路由阶段展示错误提示
  }
  buildNav();
  await checkHealth();
  if (!location.hash && modules.length > 0) {
    location.hash = modules[0].path; // 默认落在第一个模块，hashchange 触发 route()
    return;
  }
  route();
}

window.addEventListener("hashchange", route);
bootstrap();
