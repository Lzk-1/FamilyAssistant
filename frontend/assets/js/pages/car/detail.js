/** 车型详情页：关键数字 + 基本信息 + 配置特点 + 实车照片（lightbox 预览）+ 4S 报价对比。
 *  路由：#/car/detail/:id
 */

import { apiGet, apiDelete, apiUpload } from "../../api.js";
import { el, btn, iconBtn, card, tag, emptyState, modal, toast, confirmModal, select, errorBanner, lightbox } from "../../ui.js";
import { icon } from "../../icons.js";
import { STATUS_LABELS, ENERGY_LABELS, PHOTO_KIND_LABELS, PHOTO_KIND_OPTIONS, carStatusVariant,
         fmtMoney, fmtCompact, getCompareIds, toggleCompare } from "./common.js";
import { openCandidateDialog } from "./dialog.js";
import { openOfferDialog } from "./offer.js";

const PHOTO_KIND_ORDER = ["exterior", "interior", "other"];

export async function renderDetail(root, candidateId) {
  root.innerHTML = ""; // 刷新场景（编辑/报价/照片操作后重入）：先清空再渲染，避免内容堆叠
  let data;
  try {
    data = await apiGet(`/car/candidates/${candidateId}`);
  } catch (err) {
    root.appendChild(errorBanner(err.message));
    return;
  }

  const refresh = () => renderDetail(root, candidateId);
  const inCompare = getCompareIds().includes(data.id);

  // ---------- 页头 ----------
  const header = el("div", { class: "detail-header" }, [
    btn("", { variant: "ghost", icon: "close", title: "返回档案列表", onClick: () => { location.hash = "#/car"; } }),
    el("h2", { text: `${data.brand} ${data.model}` }),
    data.version ? el("span", { class: "muted", text: data.version }) : null,
    tag(STATUS_LABELS[data.status] || data.status, carStatusVariant(data.status)),
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
          title: "删除车型",
          message: `确定要删除「${data.brand} ${data.model}」吗？其 ${data.computed.offer_count} 份报价与 ${data.computed.photo_count} 张照片将一并删除，不可恢复。`,
          confirmLabel: "删除", danger: true,
        });
        if (ok) {
          try {
            await apiDelete(`/car/candidates/${candidateId}`);
            toast("车型已删除", "ok");
            location.hash = "#/car";
          } catch (err) { toast(err.message, "err"); }
        }
      },
    }),
  ]);
  root.appendChild(header);

  // ---------- 关键数字 ----------
  const c = data.computed || {};
  const keyNumbers = el("div", { class: "detail-key-numbers" });
  keyNumbers.appendChild(keyNum("指导价", fmtCompact(data.guide_price_cents)));
  keyNumbers.appendChild(keyNum(
    "最低落地价",
    c.best_total_cents != null ? fmtCompact(c.best_total_cents) : "—",
    c.offer_count > 0 ? `共 ${c.offer_count} 家报价` : "尚未录入报价",
  ));
  keyNumbers.appendChild(keyNum(
    "最大优惠",
    c.max_discount_cents != null ? fmtCompact(c.max_discount_cents) : "—",
    c.offer_count > 0 ? "各店报价中" : null,
  ));
  keyNumbers.appendChild(keyNum("评分", data.score != null ? `${data.score} 分` : "—"));
  if (c.avg_total_cents != null) {
    keyNumbers.appendChild(keyNum("平均落地价", fmtCompact(c.avg_total_cents)));
  }
  root.appendChild(keyNumbers);

  // ---------- 基本信息 ----------
  const infoGrid = el("div", { class: "dialog-grid" });
  const infoItems = [
    ["品牌", data.brand],
    ["车型", data.model],
    ["配置版本", data.version || "—"],
    ["年款", data.year != null ? `${data.year} 款` : "—"],
    ["能源类型", ENERGY_LABELS[data.energy] || data.energy],
    ["里程", data.mileage != null ? `${data.mileage} 万公里` : "—"],
    ["状态", STATUS_LABELS[data.status] || data.status],
    ["备注", data.notes || "—"],
  ];
  for (const [label, value] of infoItems) {
    infoGrid.appendChild(el("div", { class: "fa-field" }, [
      el("label", { class: "fa-field__label", text: label }),
      el("div", { class: "fa-field__control", text: value }),
    ]));
  }
  for (const [label, value] of [["优点", data.pros], ["缺点", data.cons]]) {
    infoGrid.appendChild(el("div", { class: "fa-field fa-field--full" }, [
      el("label", { class: "fa-field__label", text: label }),
      el("div", { class: "fa-field__control", style: "white-space:pre-wrap", text: value || "—" }),
    ]));
  }
  root.appendChild(card("基本信息", infoGrid));

  // ---------- 配置特点 ----------
  root.appendChild(card("配置特点", renderFeatures(data)));

  // ---------- 实车照片 ----------
  root.appendChild(card("实车照片", renderPhotos(data, refresh)));

  // ---------- 4S 报价对比 ----------
  root.appendChild(card("4S 店报价对比", renderOffers(data, refresh)));
}

/** 关键数字（支持子文本） */
function keyNum(label, value, sub) {
  return el("div", { class: "detail-key-number" }, [
    el("div", { class: "detail-key-number__label", text: label }),
    el("div", { class: "detail-key-number__value", text: value }),
    sub ? el("div", { class: "detail-key-number__label", style: "margin-top:2px", text: sub }) : null,
  ]);
}

/** 配置特点标签流：label: value 胶囊 */
function renderFeatures(data) {
  const features = data.features || [];
  if (features.length === 0) {
    return emptyState("暂无配置特点", "点击「编辑车型」添加座位数、抬头显示、智驾等配置标签，用于跨车型对比。");
  }
  return el("div", { class: "car-feature-tags" },
    features.map((f) => el("span", { class: "car-feature-tag" }, [
      el("b", { text: f.label }),
      f.value ? el("span", { text: f.value }) : null,
    ])));
}

/** 实车照片：按外观/内饰/其他分组的照片墙 + 上传弹窗 + lightbox 预览 */
function renderPhotos(data, refresh) {
  const photos = data.photos || [];
  const container = el("div", {});

  const uploadBtn = btn("上传照片", {
    variant: "primary", size: "sm", icon: "upload",
    onClick: () => openUploadDialog(data, refresh),
  });

  if (photos.length === 0) {
    const empty = emptyState("暂无照片", "上传外观、内饰等实车照片，看车记录一目了然。");
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
                flat.map((x) => ({ src: `/api/v1/car/photos/${x.id}/download`, name: `${PHOTO_KIND_LABELS[x.kind]} · ${x.file_name}` })),
                start,
              );
            },
          }, [
            el("img", { src: `/api/v1/car/photos/${p.id}/download`, alt: p.file_name, loading: "lazy" }),
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
                try { await apiDelete(`/car/photos/${p.id}`); toast("照片已删除", "ok"); refresh(); }
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

/** 照片上传弹窗：选分类 + 多选文件 + 逐个上传（进度反馈） */
function openUploadDialog(data, refresh) {
  let kind = "exterior";
  let files = [];

  const kindSelect = select("kind", PHOTO_KIND_OPTIONS, {
    value: kind,
    onChange: (v) => { kind = v; },
  });

  const fileList = el("div", {});
  // 文件输入挂在弹窗 DOM（隐藏）：保持交互不变，同时可被自动化测试定位
  const fileInput = el("input", { type: "file", accept: ".jpg,.jpeg,.png,.webp,.heic" });
  fileInput.multiple = true;
  fileInput.style.display = "none";
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
        await apiUpload(`/car/candidates/${data.id}/photos`, f, {
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
    el("p", { class: "muted", style: "margin:10px 0;font-size:12px", text: "支持 jpg / png / webp / heic，单张 ≤ 10MB，每车型 ≤ 24 张。" }),
    fileList,
  ]);

  const m = modal({
    title: `上传照片 · ${data.brand} ${data.model}`,
    width: "normal",
    body,
    footer: el("div", { class: "fa-dialog-actions" }, [
      btn("取消", { variant: "secondary", onClick: () => m.close() }),
      confirmBtn,
    ]),
  });
}

/** 4S 报价对比表：落地价最低行「最优」高亮；行内编辑/删除 */
function renderOffers(data, refresh) {
  const offers = data.offers || [];
  const container = el("div", {});

  const addBtn = btn("新增报价", {
    variant: "primary", size: "sm", icon: "plus",
    onClick: () => openOfferDialog(data, null, refresh),
  });

  if (offers.length === 0) {
    const empty = emptyState("暂无 4S 店报价", "录入各店优惠、费用与赠品，自动计算裸车价与落地价并对比。");
    empty.appendChild(el("div", { class: "empty-action" }, [addBtn]));
    container.appendChild(empty);
    return container;
  }

  const totals = offers.map((o) => o.computed.total_cents).filter((t) => t != null);
  const bestTotal = totals.length ? Math.min(...totals) : null;

  container.appendChild(el("div", { style: "margin-bottom:12px" }, [addBtn]));

  const cols = [
    { label: "4S 店", key: "dealer_name", render: (o) => el("div", {}, [
      el("div", { text: o.dealer_name, style: "font-weight:500" }),
      o.contact ? el("div", { class: "muted", style: "font-size:12px", text: o.contact }) : null,
    ]) },
    { label: "城市", key: "city", render: (o) => o.city || "—" },
    { label: "报价日", key: "offer_date" },
    { label: "优惠合计", key: "_discount", render: (o) => o.computed.discount_total_cents > 0
      ? `− ¥${fmtMoney(o.computed.discount_total_cents)}` : "¥0.00" },
    { label: "裸车价", key: "_bare", render: (o) => o.computed.bare_price_cents != null ? fmtMoney(o.computed.bare_price_cents) : "—" },
    { label: "费用合计", key: "_fee", render: (o) => fmtMoney(o.computed.fee_total_cents) },
    { label: "落地价", key: "_total", render: (o) => el("span", {}, [
      o.computed.total_cents != null
        ? el("strong", { text: `¥${fmtMoney(o.computed.total_cents)}` })
        : el("span", { class: "muted", text: "—" }),
      bestTotal != null && o.computed.total_cents === bestTotal && offers.length > 1
        ? el("span", { style: "margin-left:6px" }, [tag("最优", "ok")])
        : null,
    ]) },
    { label: "赠品", key: "_gifts", render: (o) => o.gift_items.length > 0
      ? el("span", { title: o.gift_items.map((g) => g.label).join("、"), text: `${o.gift_items.length} 项` })
      : "—" },
    { label: "", key: "_actions", render: (o) => el("span", { class: "row-actions" }, [
      iconBtn("edit", { variant: "ghost", size: "sm", title: "编辑报价", onClick: (e) => { e.stopPropagation(); openOfferDialog(data, o, refresh); } }),
      iconBtn("trash", {
        variant: "ghost", size: "sm", title: "删除报价",
        onClick: async (e) => {
          e.stopPropagation();
          const ok = await confirmModal({
            title: "删除报价", message: `确定删除「${o.dealer_name}」的报价单？`, confirmLabel: "删除", danger: true,
          });
          if (ok) {
            try { await apiDelete(`/car/offers/${o.id}`); toast("报价已删除", "ok"); refresh(); }
            catch (err) { toast(err.message, "err"); }
          }
        },
      }),
    ]) },
  ];

  const tbody = offers.map((o) =>
    el("tr", { class: bestTotal != null && o.computed.total_cents === bestTotal && offers.length > 1 ? "row--best" : "" },
      cols.map((col) => {
        const content = col.render ? col.render(o) : (o[col.key] ?? "—");
        return content instanceof Node ? el("td", {}, [content]) : el("td", { text: content });
      })));

  container.appendChild(el("table", { class: "table" }, [
    el("thead", {}, [el("tr", {}, cols.map((c) => el("th", { text: c.label })))]),
    el("tbody", {}, tbody),
  ]));
  return container;
}
