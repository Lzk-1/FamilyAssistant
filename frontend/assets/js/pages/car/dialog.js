/** 车型新增/编辑弹窗：基础字段 + 配置特点标签编辑器（design §4.2）。
 *  指导价以「万元」录入（贴合厂商指导价习惯），提交转换为分。
 */

import { apiPost, apiPut } from "../../api.js";
import { el, btn, iconBtn, field, input, select, textarea, modal, toast } from "../../ui.js";
import { ENERGY_OPTIONS, STATUS_OPTIONS, PRESET_FEATURES, wanToCents, centsToWan } from "./common.js";

export function openCandidateDialog(candidate, onSaved) {
  const isEdit = !!candidate;
  const form = {
    brand: candidate?.brand || "",
    model: candidate?.model || "",
    version: candidate?.version || "",
    year: candidate?.year != null ? String(candidate.year) : "",
    energy: candidate?.energy || "fuel",
    mileage: candidate?.mileage != null ? String(candidate.mileage) : "",
    guide_price: candidate?.guide_price_cents != null ? centsToWan(candidate.guide_price_cents) : "",
    status: candidate?.status || "watching",
    score: candidate?.score != null ? String(candidate.score) : "",
    pros: candidate?.pros || "",
    cons: candidate?.cons || "",
    notes: candidate?.notes || "",
  };
  let features = (candidate?.features || []).map((f) => ({ label: f.label || "", value: f.value || "" }));

  // DOM
  const formEl = el("div", { class: "dialog-grid" });
  const featureEl = el("div", { class: "fa-field fa-field--full" });
  const errorEl = el("div", {});
  const body = el("div", {}, [errorEl, formEl, featureEl]);

  function renderForm() {
    formEl.innerHTML = "";

    formEl.appendChild(field("品牌", input({
      name: "brand", value: form.brand, placeholder: "如：比亚迪",
      onInput: (e) => { form.brand = e.target.value; },
    }), { required: true }));

    formEl.appendChild(field("车型", input({
      name: "model", value: form.model, placeholder: "如：汉 EV",
      onInput: (e) => { form.model = e.target.value; },
    }), { required: true }));

    formEl.appendChild(field("配置版本", input({
      name: "version", value: form.version, placeholder: "如：2026 冠军版 506KM 尊贵型",
      onInput: (e) => { form.version = e.target.value; },
    })));

    formEl.appendChild(field("年款", input({
      type: "number", name: "year", value: form.year, placeholder: "如 2026",
      onInput: (e) => { form.year = e.target.value; },
    })));

    formEl.appendChild(field("能源类型", select("energy", ENERGY_OPTIONS, {
      value: form.energy,
      onChange: (v) => { form.energy = v; },
    }), { required: true }));

    formEl.appendChild(field("指导价(万元)", input({
      type: "number", name: "guide_price", value: form.guide_price, placeholder: "如 18.98",
      onInput: (e) => { form.guide_price = e.target.value; },
    })));

    formEl.appendChild(field("里程(万公里)", input({
      type: "number", name: "mileage", value: form.mileage, placeholder: "二手车填写",
      onInput: (e) => { form.mileage = e.target.value; },
    })));

    formEl.appendChild(field("状态", select("status", STATUS_OPTIONS.filter((o) => o.value), {
      value: form.status,
      onChange: (v) => { form.status = v; },
    })));

    formEl.appendChild(field("评分(0~5)", input({
      type: "number", name: "score", value: form.score, placeholder: "如 4.5",
      onInput: (e) => { form.score = e.target.value; },
    })));

    formEl.appendChild(field("优点", textarea({
      name: "pros", value: form.pros, rows: 2, placeholder: "如：空间大、智驾好用",
      onInput: (e) => { form.pros = e.target.value; },
    })));

    formEl.appendChild(field("缺点", textarea({
      name: "cons", value: form.cons, rows: 2, placeholder: "如：悬挂偏硬",
      onInput: (e) => { form.cons = e.target.value; },
    })));

    formEl.appendChild(field("备注", textarea({
      name: "notes", value: form.notes, rows: 2, placeholder: "补充说明",
      onInput: (e) => { form.notes = e.target.value; },
    })));
  }

  /** 配置特点编辑器：预设 chips（未使用的可点）+ 动态标签行 */
  function renderFeatures() {
    featureEl.innerHTML = "";
    featureEl.appendChild(el("label", { class: "fa-field__label", text: "配置特点" }));

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
          value: f.label, placeholder: "标签（如：座位数）",
          onInput: (e) => { f.label = e.target.value; },
        }),
        input({
          value: f.value, placeholder: "值（如：5座 / 有 / 城市 NOA）",
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
    return {
      brand: form.brand.trim(),
      model: form.model.trim(),
      version: form.version.trim(),
      year: form.year ? parseInt(form.year, 10) : null,
      energy: form.energy,
      mileage: form.mileage ? parseFloat(form.mileage) : null,
      guide_price_cents: form.guide_price ? wanToCents(form.guide_price) : null,
      status: form.status,
      score: form.score ? parseFloat(form.score) : null,
      pros: form.pros,
      cons: form.cons,
      notes: form.notes,
      features: features
        .filter((f) => f.label.trim())
        .map((f) => ({ label: f.label.trim(), value: f.value.trim() })),
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
        await apiPut(`/car/candidates/${candidate.id}`, payload);
        toast("车型已更新", "ok");
      } else {
        await apiPost("/car/candidates", payload);
        toast("车型已创建", "ok");
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
    title: isEdit ? "编辑车型" : "新增车型",
    width: "wide",
    body,
    footer,
  });

  renderForm();
  renderFeatures();
}
