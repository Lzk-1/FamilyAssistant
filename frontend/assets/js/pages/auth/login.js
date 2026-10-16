/** 认证视图：登录卡片 + 首登强制改密（M4，design §5.1/§5.2）。
 *  由 app.js 在未登录 / must_change_password 时直接渲染到 #view（认证是横切关注点，不占 hash 路由）。
 */

import { apiPost, apiPut, setUnauthorizedHandler } from "../../api.js";
import { el, btn, input, errorBanner } from "../../ui.js";
import { icon } from "../../icons.js";

/** 整屏背景：渐变底色 + 两团品牌色光晕（纯 CSS 装饰，零图片零依赖） */
function loginShell() {
  return el("div", { class: "login-shell" }, [
    el("div", { class: "login-glow login-glow--a" }),
    el("div", { class: "login-glow login-glow--b" }),
  ]);
}

function brandMark() {
  return el("div", { class: "login-brand" }, [
    el("div", { class: "login-brand__logo" }, [icon("home", 26)]),
    el("h1", { text: "家庭助手" }),
    el("p", { text: "家庭事务一站式管理平台" }),
  ]);
}

/** 带前置图标的表单字段 */
function iconField(label, iconName, control, { required = false } = {}) {
  const wrap = el("div", { class: "login-input" }, [
    el("span", { class: "login-input__icon" }, [icon(iconName, 17)]),
    control,
  ]);
  return el("div", { class: "fa-field" }, [
    el("label", { class: "fa-field__label", text: required ? `${label} *` : label }),
    el("div", { class: "fa-field__control" }, [wrap]),
  ]);
}

/** 卡片标题区：眉题 + 主标题 */
function cardHead(eyebrow, title, headIcon) {
  return el("div", { class: "login-card__head" }, [
    headIcon ? el("span", { class: "login-card__headicon" }, [icon(headIcon, 18)]) : null,
    el("div", {}, [
      el("p", { class: "login-card__eyebrow", text: eyebrow }),
      el("h2", { text: title }),
    ]),
  ]);
}

/** 登录卡片。onSuccess(meData) 在登录成功并（若需）完成强制改密后回调。 */
export function renderLogin(root, onSuccess) {
  root.innerHTML = "";
  // 登录表单自身的 401（密码错误）就地展示，不触发全局登录视图重入
  setUnauthorizedHandler(null);

  const shell = loginShell();

  const userInput = input({ name: "username", placeholder: "请输入用户名" });
  const passInput = input({ type: "password", name: "password", placeholder: "请输入密码" });
  userInput.addEventListener("keydown", submitOnEnter);
  passInput.addEventListener("keydown", submitOnEnter);
  const errorBox = el("div", { class: "login-error" });

  const submitBtn = btn("登 录", { variant: "primary", icon: "check" });
  submitBtn.classList.add("login-submit");

  const form = el("form", { class: "login-card" }, [
    brandMark(),
    cardHead("欢迎回来", "登录账户", "user"),
    iconField("用户名", "user", userInput, { required: true }),
    iconField("密码", "lock", passInput, { required: true }),
    errorBox,
    submitBtn,
  ]);

  function submitOnEnter(e) {
    if (e.key === "Enter") submit();
  }

  async function submit() {
    if (!userInput.value.trim() || !passInput.value) return;
    submitBtn.disabled = true;
    errorBox.innerHTML = "";
    try {
      const data = await apiPost("/auth/login", {
        username: userInput.value.trim(),
        password: passInput.value,
      });
      if (data.must_change_password) {
        renderForceChangePassword(root, data.user, () => {
          // 不能复用登录响应快照：其中 must_change_password 仍为 true，
          // 否则 assemble() 会再次渲染强制改密页（表现为"要求重置第二次"）
          data.must_change_password = false;
          data.user.must_change_password = false;
          onSuccess(data);
        });
      } else {
        onSuccess(data);
      }
    } catch (err) {
      errorBox.appendChild(errorBanner(err.message));
    } finally {
      submitBtn.disabled = false;
    }
  }

  submitBtn.addEventListener("click", (e) => { e.preventDefault(); submit(); });
  form.addEventListener("submit", (e) => { e.preventDefault(); submit(); });
  shell.appendChild(form);
  root.appendChild(shell);
  // preventScroll：避免页面加载后浏览器自动滚动到输入框，使登录页保持居中
  userInput.focus({ preventScroll: true });
}

/** 首登/被重置后的强制改密视图：不可跳过（无导航无退出）。
 *  能进入此页说明已用当前密码登录通过、会话有效，因此不再要求输入当前密码；
 *  刷新页面重入时表现一致（会话仍在，身份已证明）。
 */
export function renderForceChangePassword(root, user, onDone) {
  root.innerHTML = "";
  setUnauthorizedHandler(null);

  const shell = loginShell();

  const passInput = input({ type: "password", name: "new_password", placeholder: "至少 8 位，不能与用户名相同" });
  const confirmInput = input({ type: "password", name: "confirm_password", placeholder: "请再次输入新密码" });
  passInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  confirmInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  const errorBox = el("div", { class: "login-error" });
  const submitBtn = btn("修改密码并继续", { variant: "primary", icon: "check" });
  submitBtn.classList.add("login-submit");

  async function submit() {
    const pass = passInput.value;
    if (pass.length < 8) { errorBox.innerHTML = ""; errorBox.appendChild(errorBanner("新密码至少 8 位")); return; }
    if (pass !== confirmInput.value) { errorBox.innerHTML = ""; errorBox.appendChild(errorBanner("两次输入的密码不一致")); return; }
    submitBtn.disabled = true;
    errorBox.innerHTML = "";
    try {
      await apiPut("/auth/password", { new_password: pass });
      onDone();
    } catch (err) {
      errorBox.appendChild(errorBanner(err.message));
    } finally {
      submitBtn.disabled = false;
    }
  }

  submitBtn.addEventListener("click", (e) => { e.preventDefault(); submit(); });

  const form = el("form", { class: "login-card" }, [
    brandMark(),
    cardHead("安全验证", "设置新密码", "shield"),
    el("p", { class: "login-notice" }, [
      el("strong", { text: user.display_name || user.username }),
      document.createTextNode("，首次登录或密码已被重置，请设置新密码后继续使用。"),
    ]),
    iconField("新密码", "lock", passInput, { required: true }),
    iconField("确认新密码", "lock", confirmInput, { required: true }),
    errorBox,
    submitBtn,
  ]);
  form.addEventListener("submit", (e) => { e.preventDefault(); submit(); });
  shell.appendChild(form);
  root.appendChild(shell);
  passInput.focus({ preventScroll: true });
}
