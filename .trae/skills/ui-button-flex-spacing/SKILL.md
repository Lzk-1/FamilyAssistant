---
name: ui-button-flex-spacing
description: 规范前端多按钮/控件容器的 flex 间距对齐与五种按钮变体选用。当新增或修改弹窗 footer、工具栏、操作按钮组，或处理按钮紧贴、错位、主次不清、清空删除按钮样式时使用。不适用于单按钮或非 UI 布局问题。
---

# 前端按钮变体与 flex 间距规范

FamilyAssistant 前端为零构建原生 ESM（`frontend/assets/js` + `frontend/assets/css/main.css`），无 UI 框架。生成或修改任何"一行多个按钮/控件"的界面时遵循本规范。

## 1. 铁律：多控件容器必须带 flex，禁止裸 div

直接包含 ≥2 个按钮或表单控件的容器，**禁止** `el("div", {})`（block 布局会导致按钮紧贴、垂直错位、宽度各自为政）。按场景选用：

- 模态弹窗底部动作条 → `class: "fa-dialog-actions"`（传给 `modal({ footer })` 的内层容器）
- 页面工具栏（筛选 + 按钮一行）→ 复用 `.ledger-toolbar`
- 卡片内一行零散控件 → 内联 `style: "display:flex;align-items:center;gap:Npx"`
- 表格行内图标操作组 → `.row-actions`

间距一律用 `gap`，不要用相邻元素 `margin`。

注意 `ui.js` 的 `modal()` 内部已自带一层 `.fa-modal__footer`（flex 右对齐）。调用方只需传一个带 `fa-dialog-actions` 的内层容器，**不要**自己再套 `fa-modal__footer`，也不要传裸 div（`confirmModal` 内部实现除外）。

## 2. 五种按钮变体（`btn(label, { variant })`）

| variant | 外观 | 用途 |
| --- | --- | --- |
| `primary` | 实心蓝 | 区域内唯一主操作：提交/保存/创建。一个视图只保留一个 |
| `secondary` | 白底描边 | 次要但需明确可点：添加、编辑、取消 |
| `ghost` | 透明蓝字 | 弱化的辅助/导航操作。**不得用于破坏性操作** |
| `danger` | 实心红 | 需严肃对待的删除（如删除整条主记录），通常配合 `confirmModal` 二次确认 |
| `danger-ghost` | 红字透明底，hover 浅红 | 次要破坏性操作：清空对比篮子、移除选择等；误操作易恢复时直接执行、不加确认 |

选择顺序：先判断是否破坏性（danger 系）→ 再判断主/次（primary vs secondary）→ 最弱化才用 ghost。

## 3. 尺寸、等宽与动态文案

- 默认高 34px；工具栏、紧凑卡片用 `size: "sm"`（28px）。
- 弹窗底部主次按钮等宽由 `.fa-dialog-actions .fa-btn` 统一控制（`flex:1`，min 96px / max 128px，文字居中），不要手写宽度或 `text-align` 补丁。
- 含动态长文案的按钮（如「加入对比（已选 N）」）：容器加修饰类 `fa-dialog-actions fa-dialog-actions--auto`，按钮按内容自适应，避免被等宽规则压缩截断。

## 4. 对齐与图标

- 同行控件 `align-items: center`；弹窗动作条右对齐已由类内置（`justify-content: flex-end`）。
- 图标语义：添加 `plus`、确认/保存 `check`、删除/清空 `trash`。统一经 `icons.js` 的 `icon()` 或 `btn(..., { icon })`，**禁止 emoji**。

## 5. 改完自查

- 每个装 ≥2 个按钮/控件的容器是否都有 flex + gap？
- 同一区域是否只有一个 primary？破坏性操作是否误用了蓝色 ghost？
- 弹窗 footer 是否为 `fa-dialog-actions`（非裸 div、非重复 `fa-modal__footer`）？
- 动态文案按钮是否需要 `--auto`？
- 对改动的 JS 跑 `node --check`；静态资源直读磁盘无需重启后端，但在 no-cache 中间件生效前提示用户 Ctrl+F5 硬刷新。
