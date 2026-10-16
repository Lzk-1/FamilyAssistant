/** 房源详情页：关键数字 + 基本信息 + 配套设施 + 维度评分 + 房源照片（lightbox 预览）。
 *  路由：#/house/detail/:id
 */

import { apiGet, apiDelete, apiUpload } from "../../api.js";
import { el, btn, iconBtn, card, tag, emptyState, modal, toast, confirmModal, select, errorBanner, lightbox } from "../../ui.js";
import { icon } from "../../icons.js";
import { STATUS_LABELS, PHOTO_KIND_LABELS, PHOTO_KIND_OPTIONS, DIMENSIONS, houseStatusVariant,
         fmtWan, fmtUnit, getCompareIds, toggleCompare } from "./common.js";
import { openCandidateDialog } from "./dialog.js";

const PHOTO_KIND_ORDER = ["layout", "exterior", "interior", "other"]; // 户型图优先展示

export async function renderDetail(root, candidateId) {
  root.innerHTML = ""; // 刷新场景（编辑/照片操作后重入）：先清空再渲染，避免内容堆叠
  let data;
  try {
    data = await apiGet(`/house/candidates/${candidateId}`);
  } catch (err) {
    root.appendChild(errorBanner(err.message));
    return;
  }

  const refresh = () => renderDetail(root, candidateId);
  const inCompare = getCompareIds().includes(data.id);

  // ---------- 页头 ----------
  const header = el("div", { class: "detail-header" }, [
    btn("", { variant: "ghost", icon: "close", title: "返回房源列表", onClick: () => { location.hash = "#/house"; } }),
    el("h2", { text: data.title }),
    tag(STATUS_LABELS[data.status] || data.status, houseStatusVariant(data.status)),
    el("div", { style: "flex:1" }),
    btn(inCompare ? "已对比" : "加入对比", {
      variant: inCompare ? "secondary" : "primary", icon: "check",
      onClick: () => {
        const r = toggleCompare(data.id);
        toast(r.reason, r.ok ? "ok" : "warn");
        refresh();
      },
    }),
    btn("编辑", { variant: "secondary", icon: "edit", onClick: () => openCandidateDialog(data, refresh) }),
    btn("删除", {
      variant: "danger", icon: "trash",
      onClick: async () => {
        const ok = await confirmModal({
          title: "删除房源",
          message: `确定要删除「${data.title}」吗？其 ${data.computed.photo_count} 张照片将一并删除，不可恢复。`,
          confirmLabel: "删除", danger: true,
        });
        if (ok) {
          try {
            await apiDelete(`/house/candidates/${candidateId}`);
            toast("房源已删除", "ok");
            location.hash = "#/house";
          } catch (err) { toast(err.message, "err"); }
        }
      },
    }),
  ]);
  root.appendChild(header);

  // ---------- 关键数字 ----------
  const c = data.computed || {};
  const keyNumbers = el("div", { class: "detail-key-numbers" });
  keyNumbers.appendChild(keyNum("总价", fmtWan(data.total_price_cents)));
  keyNumbers.appendChild(keyNum("单价", fmtUnit(data.unit_price_cents)));
  keyNumbers.appendChild(keyNum("面积", data.area != null ? `${data.area} ㎡` : "—"));
  const scoreShown = c.weighted_score ?? data.score;
  keyNumbers.appendChild(keyNum(
    "评分",
    scoreShown != null ? `${scoreShown} 分` : "—",
    c.weighted_score != null ? "六维加权" : "手动评分",
  ));
  root.appendChild(keyNumbers);

  // ---------- 基本信息 ----------
  const infoGrid = el("div", { class: "dialog-grid" });
  const infoItems = [
    ["小区", data.community || "—"],
    ["城市·区域", [data.city, data.district].filter(Boolean).join("·") || "—"],
    ["户型", data.layout || "—"],
    ["面积", data.area != null ? `${data.area} ㎡` : "—"],
    ["楼层", data.floor_info || "—"],
    ["朝向", data.orientation || "—"],
    ["建筑年代", data.build_year != null ? `${data.build_year} 年` : "—"],
    ["状态", STATUS_LABELS[data.status] || data.status],
    ["备注", data.notes || "—"],
  ];
  for (const [label, value] of infoItems) {
    infoGrid.appendChild(el("div", { class: "fa-field" }, [
      el("label", { class: "fa-field__label", text: label }),
      el("div", { class: "fa-field__control", text: value }),
    ]));
  }
  for (const [label, value] of [["优势", data.pros], ["劣势", data.cons]]) {
    infoGrid.appendChild(el("div", { class: "fa-field fa-field--full" }, [
      el("label", { class: "fa-field__label", text: label }),
      el("div", { class: "fa-field__control", style: "white-space:pre-wrap", text: value || "—" }),
    ]));
  }
  root.appendChild(card("基本信息", infoGrid));

  // ---------- 配套设施 ----------
  root.appendChild(card("配套设施", renderFeatures(data)));

  // ---------- 维度评分 ----------
  root.appendChild(card("维度评分", await renderDimScores(data)));

  // ---------- 房源照片 ----------
  root.appendChild(card("房源照片", renderPhotos(data, refresh)));
}

/** 关键数字（支持子文本） */
function keyNum(label, value, sub) {
  return el("div", { class: "detail-key-number" }, [
    el("div", { class: "detail-key-number__label", text: label }),
    el("div", { class: "detail-key-number__value", text: value }),
    sub ? el("div", { class: "detail-key-number__label", style: "margin-top:2px", text: sub }) : null,
  ]);
}

/** 配套设施标签流：label: value 胶囊（沿用选车模式） */
function renderFeatures(data) {
  const features = data.features || [];
  if (features.length === 0) {
    return emptyState("暂无配套设施", "点击「编辑房源」添加学区、地铁、商场、医院等配套标签，用于跨房源对比。");
  }
  return el("div", { class: "car-feature-tags" },
    features.map((f) => el("span", { class: "car-feature-tag" }, [
      el("b", { text: f.label }),
      f.value ? el("span", { text: f.value }) : null,
    ])));
}

/** 六维度评分 + 当前权重 + 加权总分（权重来自 /house/scoring-config，可自定义） */
async function renderDimScores(data) {
  const weights = await apiGet("/house/scoring-config").then((cfg) => cfg.weights).catch(() => null);
  if (!weights) {
    return emptyState("评分配置加载失败", "刷新页面重试。");
  }

  const dimScores = data.dim_scores || {};
  const hasAny = Object.keys(dimScores).length > 0;
  if (!hasAny) {
    return emptyState("尚未评分", "点击「编辑房源」按 6 个维度打分（0~5），系统按你的权重配置计算加权总分。");
  }

  const container = el("div", {});
  const grid = el("div", { class: "dialog-grid" });
  for (const d of DIMENSIONS) {
    const s = dimScores[d.key];
    grid.appendChild(el("div", { class: "fa-field" }, [
      el("label", { class: "fa-field__label", text: `${d.label}（权重 ${weights[d.key]}%）` }),
      el("div", { class: "fa-field__control" }, [
        s != null
          ? el("span", { style: "color:#f59e0b;display:inline-flex;align-items:center;gap:3px" }, [icon("star", 13), ` ${s} 分`])
          : el("span", { class: "muted", text: "未评" }),
      ]),
    ]));
  }
  container.appendChild(grid);

  const weighted = (data.computed || {}).weighted_score;
  container.appendChild(el("div", { style: "margin-top:12px;display:flex;align-items:center;gap:8px" }, [
    el("span", { text: "加权总分：", style: "font-weight:600" }),
    weighted != null
      ? el("strong", { style: "font-size:20px;color:#f59e0b", text: `${weighted} 分` })
      : el("span", { class: "muted", text: "—" }),
    el("span", { class: "muted", style: "font-size:12px", text: "未评维度不计入（权重归一化），可在对比页「权重设置」调整权重。" }),
  ]));
  return container;
}

/** 房源照片：按户型图/外观/室内/其他分组的照片墙 + 上传弹窗 + lightbox 预览 */
function renderPhotos(data, refresh) {
  const photos = data.photos || [];
  const container = el("div", {});

  const uploadBtn = btn("上传照片", {
    variant: "primary", size: "sm", icon: "upload",
    onClick: () => openUploadDialog(data, refresh),
  });

  if (photos.length === 0) {
    const empty = emptyState("暂无照片", "上传户型图、外观、室内等照片，看房记录一目了然。");
    empty.appendChild(el("div", { class: "empty-action" }, [uploadBtn]));
    container.appendChild(empty);
    return container;
  }

  // 平铺顺序（lightbox 索引对齐）
  const flat = [];
  const groups = el("div", { class: "car-photo-groups" });
  for (const kind of PHOTO_KIND_ORDER) {
    const items = photos.filter((p) => p.kind === kind);
    if (items.length === 0) continue;
    const group = el("div", {}, [
      el("div", { class: "car-photo-group__title", text: `${PHOTO_KIND_LABELS[kind]}（${items.length}）` }),
      el("div", { class: "car-photo-wall" },
        items.map((p) => {
          const start = flat.length; // lightbox 起始索引
          flat.push(p);
          const thumb = el("button", {
            class: "car-photo-thumb",
            title: `${p.file_name}（点击预览大图）`,
            onClick: () => {
              lightbox(
                flat.map((x) => ({ src: `/api/v1/house/photos/${x.id}/download`, name: `${PHOTO_KIND_LABELS[x.kind]} · ${x.file_name}` })),
                start,
              );
            },
          }, [
            el("img", { src: `/api/v1/house/photos/${p.id}/download`, alt: p.file_name, loading: "lazy" }),
            el("span", { class: "car-photo-thumb__name", text: p.file_name }),
          ]);
          const del = iconBtn("trash", {
            variant: "ghost", size: "sm", title: "删除照片",
            onClick: async (e) => {
              e.stopPropagation();
              const ok = await confirmModal({
                title: "删除照片", message: `确定删除「${p.file_name}」？`, confirmLabel: "删除", danger: true,
              });
              if (ok) {
                try { await apiDelete(`/house/photos/${p.id}`); toast("照片已删除", "ok"); refresh(); }
                catch (err) { toast(err.message, "err"); }
              }
            },
          });
          del.classList.add("car-photo-thumb__del");
          return el("div", { class: "car-photo-cell" }, [thumb, del]);
        })),
    ]);
    groups.appendChild(group);
  }
  container.appendChild(groups);
  container.appendChild(el("div", { style: "margin-top:12px" }, [uploadBtn]));
  return container;
}

/** 照片上传弹窗：选分类 + 多选文件 + 逐个上传（进度反馈；file input 挂载 DOM 便于自动化定位） */
function openUploadDialog(data, refresh) {
  let kind = "layout"; // 房源默认传户型图
  let files = [];

  const kindSelect = select("kind", PHOTO_KIND_OPTIONS, {
    value: kind,
    onChange: (v) => { kind = v; },
  });

  const fileList = el("div", {});
  // 文件输入挂在弹窗 DOM（视觉隐藏但保留在无障碍树）：UI 不受影响，
  // 同时可被自动化测试/辅助技术定位（display:none 会被 a11y 树排除）
  const fileInput = el("input", { type: "file", accept: ".jpg,.jpeg,.png,.webp,.heic" });
  fileInput.multiple = true;
  fileInput.style.cssText = "position:absolute;width:1px;height:1px;opacity:0;overflow:hidden;";
  fileInput.addEventListener("change", () => {
    files = [...fileInput.files];
    renderFileList();
    syncConfirm();
  });
  const pickBtn = btn("选择照片（可多选）", { variant: "secondary", icon: "image", onClick: () => fileInput.click() });

  function renderFileList() {
    fileList.innerHTML = "";
    files.forEach((f, idx) => {
      fileList.appendChild(el("div", { class: "detail-event" }, [
        icon("image", 14),
        el("span", { text: f.name, style: "flex:1;font-size:13px" }),
        el("span", { class: "detail-event__time", text: `${(f.size / 1024).toFixed(0)} KB` }),
        iconBtn("trash", {
          variant: "ghost", size: "sm", title: "移除",
          onClick: () => { files.splice(idx, 1); renderFileList(); syncConfirm(); },
        }),
      ]));
    });
  }

  const confirmLabel = el("span", { text: "开始上传" });
  const confirmBtn = el("button", { class: "fa-btn fa-btn--primary", disabled: true }, [confirmLabel]);
  confirmBtn.addEventListener("click", async () => {
    if (files.length === 0) return;
    confirmBtn.disabled = true;
    pickBtn.disabled = true;
    let failed = 0;
    for (const f of files) {
      const bar = el("div", { class: "upload-progress" }, [el("div", { class: "upload-progress__bar", style: "width:0%" })]);
      fileList.appendChild(el("div", { style: "font-size:12px;color:var(--text-muted)", text: `上传中：${f.name}` }));
      fileList.appendChild(bar);
      try {
        await apiUpload(`/house/candidates/${data.id}/photos`, f, {
          fields: { kind },
          onProgress: (pct) => { bar.querySelector(".upload-progress__bar").style.width = pct + "%"; },
        });
      } catch (err) {
        failed++;
        toast(err.errors ? err.errors.join("；") : err.message, "err");
        bar.remove();
      }
    }
    if (failed === 0) {
      toast("照片上传完成", "ok");
      m.close();
      refresh();
    } else {
      toast(`${failed} 个文件上传失败，请检查后重试`, "warn");
      confirmBtn.disabled = false;
      pickBtn.disabled = false;
    }
  });

  function syncConfirm() {
    confirmLabel.textContent = files.length > 0 ? `开始上传（${files.length} 张）` : "开始上传";
    confirmBtn.disabled = files.length === 0;
  }

  const body = el("div", {}, [
    el("div", { class: "fa-field", style: "margin-bottom:12px" }, [
      el("label", { class: "fa-field__label", text: "照片分类" }),
      el("div", { class: "fa-field__control" }, [kindSelect]),
    ]),
    pickBtn,
    fileInput,
    el("p", { class: "muted", style: "margin:10px 0;font-size:12px", text: "支持 jpg / png / webp / heic，单张 ≤ 10MB，每房源 ≤ 24 张。" }),
    fileList,
  ]);

  const m = modal({
    title: `上传照片 · ${data.title}`,
    width: "normal",
    body,
    footer: el("div", { class: "fa-dialog-actions" }, [
      btn("取消", { variant: "secondary", onClick: () => m.close() }),
      confirmBtn,
    ]),
  });
}
