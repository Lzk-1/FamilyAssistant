/** 房源新增/编辑弹窗：基础字段 + 配套设施标签编辑器 + 六维度评分（design §4.2/§5）。
 *  总价以「万元」、单价以「元/㎡」录入，提交转换为分；
 *  填一方与面积时自动推算另一方（镜像后端推算口径，服务端兜底）。
 */

import { apiPost, apiPut } from "../../api.js";
import { el, btn, iconBtn, field, input, select, textarea, modal, toast } from "../../ui.js";
import { STATUS_OPTIONS, PRESET_FEATURES, DIMENSIONS, DIM_SCORE_OPTIONS,
         wanToCents, unitYuanToCents, centsToWan, centsToUnitYuan,
         unitFromTotal, totalFromUnit } from "./common.js";

export function openCandidateDialog(candidate, onSaved) {
  const isEdit = !!candidate;
  const form = {
    title: candidate?.title || "",
    community: candidate?.community || "",
    city: candidate?.city || "",
    district: candidate?.district || "",
    layout: candidate?.layout || "",
    area: candidate?.area != null ? String(candidate.area) : "",
    floor_info: candidate?.floor_info || "",
    orientation: candidate?.orientation || "",
    build_year: candidate?.build_year != null ? String(candidate.build_year) : "",
    total_price: candidate?.total_price_cents != null ? centsToWan(candidate.total_price_cents) : "",
    unit_price: candidate?.unit_price_cents != null ? centsToUnitYuan(candidate.unit_price_cents) : "",
    status: candidate?.status || "watching",
    score: candidate?.score != null ? String(candidate.score) : "",
    pros: candidate?.pros || "",
    cons: candidate?.cons || "",
    notes: candidate?.notes || "",
  };
  let features = (candidate?.features || []).map((f) => ({ label: f.label || "", value: f.value || "" }));
  const dimScores = {};
  for (const d of DIMENSIONS) {
    dimScores[d.key] = candidate?.dim_scores?.[d.key] != null ? String(candidate.dim_scores[d.key]) : "";
  }

  let totalInputEl = null; // 价格联动：直接改对方输入框 DOM，避免整表重渲染失焦
  let unitInputEl = null;

  // DOM
  const formEl = el("div", { class: "dialog-grid" });
  const dimEl = el("div", { class: "fa-field fa-field--full" });
  const featureEl = el("div", { class: "fa-field fa-field--full" });
  const errorEl = el("div", {});
  const body = el("div", {}, [errorEl, formEl, dimEl, featureEl]);

  function renderForm() {
    formEl.innerHTML = "";

    formEl.appendChild(field("房源名称", input({
      name: "title", value: form.title, placeholder: "如：万科翡翠公园 3室2厅",
      onInput: (e) => { form.title = e.target.value; },
    }), { required: true }));

    formEl.appendChild(field("小区", input({
      name: "community", value: form.community, placeholder: "如：万科翡翠公园",
      onInput: (e) => { form.community = e.target.value; },
    })));

    formEl.appendChild(field("城市", input({
      name: "city", value: form.city, placeholder: "如：西安",
      onInput: (e) => { form.city = e.target.value; },
    })));

    formEl.appendChild(field("区域", input({
      name: "district", value: form.district, placeholder: "如：高新",
      onInput: (e) => { form.district = e.target.value; },
    })));

    formEl.appendChild(field("户型", input({
      name: "layout", value: form.layout, placeholder: "如：3室2厅2卫",
      onInput: (e) => { form.layout = e.target.value; },
    })));

    formEl.appendChild(field("面积(㎡)", input({
      type: "number", name: "area", value: form.area, placeholder: "如 120.5",
      onInput: (e) => {
        form.area = e.target.value;
        syncFromTotal(); // 面积变化 → 按最后编辑的一方重推
      },
    })));

    formEl.appendChild(field("楼层", input({
      name: "floor_info", value: form.floor_info, placeholder: "如：中层/18层",
      onInput: (e) => { form.floor_info = e.target.value; },
    })));

    formEl.appendChild(field("朝向", input({
      name: "orientation", value: form.orientation, placeholder: "如：南北",
      onInput: (e) => { form.orientation = e.target.value; },
    })));

    formEl.appendChild(field("建筑年代", input({
      type: "number", name: "build_year", value: form.build_year, placeholder: "如 2015",
      onInput: (e) => { form.build_year = e.target.value; },
    })));

    formEl.appendChild(field("总价(万元)", input({
      type: "number", name: "total_price", value: form.total_price, placeholder: "如 200.5",
      onInput: (e) => {
        form.total_price = e.target.value;
        lastEdited = "total";
        deriveUnit();
      },
    })));

    formEl.appendChild(field("单价(元/㎡)", input({
      type: "number", name: "unit_price", value: form.unit_price, placeholder: "如 16666",
      onInput: (e) => {
        form.unit_price = e.target.value;
        lastEdited = "unit";
        deriveTotal();
      },
    })));

    formEl.appendChild(field("状态", select("status", STATUS_OPTIONS.filter((o) => o.value), {
      value: form.status,
      onChange: (v) => { form.status = v; },
    })));

    formEl.appendChild(field("手动评分(0~5)", input({
      type: "number", name: "score", value: form.score, placeholder: "可选",
      onInput: (e) => { form.score = e.target.value; },
    })));

    formEl.appendChild(field("优势", textarea({
      name: "pros", value: form.pros, rows: 2, placeholder: "如：南北通透、近地铁",
      onInput: (e) => { form.pros = e.target.value; },
    })));

    formEl.appendChild(field("劣势", textarea({
      name: "cons", value: form.cons, rows: 2, placeholder: "如：临街噪音、房龄偏老",
      onInput: (e) => { form.cons = e.target.value; },
    })));

    formEl.appendChild(field("备注", textarea({
      name: "notes", value: form.notes, rows: 2, placeholder: "补充说明",
      onInput: (e) => { form.notes = e.target.value; },
    })));

    totalInputEl = formEl.querySelector('input[name="total_price"]');
    unitInputEl = formEl.querySelector('input[name="unit_price"]');
  }

  // ---------- 价格联动（design §3：填一方 + 面积 → 推算另一方） ----------
  let lastEdited = null; // "total" | "unit"：以最后编辑的一方为基准

  function areaNum() {
    const n = parseFloat(form.area);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /** 以总价为基准推算单价（直接改输入框，不整表重渲染） */
  function deriveUnit() {
    const cents = form.total_price ? wanToCents(form.total_price) : 0;
    const area = areaNum();
    const unit = unitFromTotal(cents, area);
    if (unit && unitInputEl && unitInputEl !== document.activeElement) {
      form.unit_price = unit;
      unitInputEl.value = unit;
    }
  }

  /** 以单价为基准推算总价 */
  function deriveTotal() {
    const unitYuan = parseFloat(form.unit_price);
    const area = areaNum();
    const total = Number.isFinite(unitYuan) && area ? totalFromUnit(unitYuan, area) : "";
    if (total && totalInputEl && totalInputEl !== document.activeElement) {
      form.total_price = total;
      totalInputEl.value = total;
    }
  }

  /** 面积变化时按最后编辑的价格方重推 */
  function syncFromTotal() {
    if (lastEdited === "unit") deriveTotal();
    else if (lastEdited === "total") deriveUnit();
  }

  // ---------- 六维度评分（design §5：加权评分的输入侧） ----------
  function renderDimScores() {
    dimEl.innerHTML = "";
    dimEl.appendChild(el("label", { class: "fa-field__label", text: "维度评分（0~5，未评维度不计入加权分）" }));
    const grid = el("div", { class: "dialog-grid" });
    for (const d of DIMENSIONS) {
      grid.appendChild(field(d.label, select(`dim_${d.key}`, DIM_SCORE_OPTIONS, {
        value: dimScores[d.key],
        onChange: (v) => { dimScores[d.key] = v; },
      })));
    }
    dimEl.appendChild(grid);
  }

  /** 配套设施编辑器：预设 chips（未使用的可点）+ 动态标签行（沿用选车模式） */
  function renderFeatures() {
    featureEl.innerHTML = "";
    featureEl.appendChild(el("label", { class: "fa-field__label", text: "配套设施" }));

    const usedLabels = new Set(features.map((f) => f.label.trim()));
    const chips = el("div", { class: "car-chips" },
      PRESET_FEATURES
        .filter((label) => !usedLabels.has(label))
        .map((label) => el("button", {
          class: "car-chip", type: "button",
          text: `+ ${label}`,
          onClick: () => { features.push({ label, value: "" }); renderFeatures(); },
        })));
    featureEl.appendChild(chips);

    const rows = el("div", {});
    features.forEach((f, idx) => {
      rows.appendChild(el("div", { class: "car-item-row" }, [
        input({
          value: f.label, placeholder: "标签（如：学区）",
          onInput: (e) => { f.label = e.target.value; },
        }),
        input({
          value: f.value, placeholder: "值（如：实验小学 一梯队 / 步行 8 分钟）",
          onInput: (e) => { f.value = e.target.value; },
        }),
        iconBtn("trash", {
          variant: "ghost", size: "sm", title: "删除标签",
          onClick: () => { features.splice(idx, 1); renderFeatures(); },
        }),
      ]));
    });
    featureEl.appendChild(rows);

    featureEl.appendChild(el("div", { class: "car-item-add" }, [
      btn("添加标签", {
        variant: "secondary", size: "sm", icon: "plus",
        onClick: () => { features.push({ label: "", value: "" }); renderFeatures(); },
      }),
    ]));
  }

  function collectPayload() {
    const dim_scores = {};
    for (const d of DIMENSIONS) {
      if (dimScores[d.key] !== "") dim_scores[d.key] = parseInt(dimScores[d.key], 10);
    }
    return {
      title: form.title.trim(),
      community: form.community.trim(),
      city: form.city.trim(),
      district: form.district.trim(),
      layout: form.layout.trim(),
      area: form.area ? parseFloat(form.area) : null,
      floor_info: form.floor_info.trim(),
      orientation: form.orientation.trim(),
      build_year: form.build_year ? parseInt(form.build_year, 10) : null,
      total_price_cents: form.total_price ? wanToCents(form.total_price) : null,
      unit_price_cents: form.unit_price ? unitYuanToCents(form.unit_price) : null,
      status: form.status,
      score: form.score ? parseFloat(form.score) : null,
      pros: form.pros,
      cons: form.cons,
      notes: form.notes,
      features: features
        .filter((f) => f.label.trim())
        .map((f) => ({ label: f.label.trim(), value: f.value.trim() })),
      dim_scores,
    };
  }

  function showErrors(errors) {
    errorEl.innerHTML = "";
    if (errors && errors.length > 0) {
      errorEl.appendChild(el("div", { class: "error-list" }, [
        el("ul", {}, errors.map((e) => el("li", { text: e }))),
      ]));
    }
  }

  async function submit() {
    const payload = collectPayload();
    try {
      if (isEdit) {
        await apiPut(`/house/candidates/${candidate.id}`, payload);
        toast("房源已更新", "ok");
      } else {
        await apiPost("/house/candidates", payload);
        toast("房源已创建", "ok");
      }
      m.close();
      if (onSaved) onSaved();
    } catch (err) {
      if (err.errors && err.errors.length > 0) showErrors(err.errors);
      else toast(err.message, "err");
    }
  }

  const footer = el("div", { class: "fa-dialog-actions" }, [
    btn("取消", { variant: "secondary", onClick: () => m.close() }),
    btn(isEdit ? "保存" : "创建", { variant: "primary", icon: "check", onClick: submit }),
  ]);

  const m = modal({
    title: isEdit ? "编辑房源" : "新增房源",
    width: "wide",
    body,
    footer,
  });

  renderForm();
  renderDimScores();
  renderFeatures();
}
