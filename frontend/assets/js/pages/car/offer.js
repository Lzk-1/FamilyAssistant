/** 4S 报价新增/编辑弹窗：动态条目列表（优惠/费用/赠品）+ 落地价实时预览 +
 *  购置税自动预填（design §3 / D1：按能源与裸车价推算，可改可删，优惠变动时联动刷新）。
 *  条目金额以「元」录入，提交转换为分。
 */

import { apiPost, apiPut } from "../../api.js";
import { el, btn, iconBtn, field, input, textarea, modal, toast } from "../../ui.js";
import { yuanToCents, todayISO, taxHint, fmtMoney } from "./common.js";

export function openOfferDialog(candidate, offer, onSaved) {
  const isEdit = !!offer;
  const guide = candidate.guide_price_cents ?? null;
  const form = {
    dealer_name: offer?.dealer_name || "",
    city: offer?.city || "",
    contact: offer?.contact || "",
    offer_date: offer?.offer_date || todayISO(),
    notes: offer?.notes || "",
  };
  // 条目：金额以元字符串编辑，提交时转分；autoTax 标记购置税预填行（未被手改时随优惠联动）
  let discounts = (offer?.discount_items || []).map((i) => ({ label: i.label, amount: (i.amount_cents / 100).toString() }));
  let fees = (offer?.fee_items || []).map((i) => ({ label: i.label, amount: (i.amount_cents / 100).toString() }));
  let gifts = (offer?.gift_items || []).map((i) => ({ label: i.label, note: i.note || "" }));

  // 新增模式：按能源与指导价（尚无优惠，裸车 = 指导价）预填购置税参考条目（D1）
  if (!isEdit) {
    const hint = taxHint(candidate.energy, guide);
    if (hint != null && hint > 0) {
      fees = [{ label: "购置税", amount: (hint / 100).toString(), autoTax: true }];
    }
  }

  // DOM
  const basicEl = el("div", { class: "dialog-grid" });
  const discountEl = el("div", { class: "fa-field fa-field--full" });
  const feeEl = el("div", { class: "fa-field fa-field--full" });
  const giftEl = el("div", { class: "fa-field fa-field--full" });
  const noteEl = el("div", {});
  const previewEl = el("div", { class: "dialog-preview" });
  const errorEl = el("div", {});
  const body = el("div", {}, [errorEl, basicEl, discountEl, feeEl, giftEl, noteEl, previewEl]);

  let taxInputEl = null; // 购置税预填行金额输入框引用：联动时直接改 DOM，避免整表重渲染导致输入失焦

  function renderBasic() {
    basicEl.innerHTML = "";
    basicEl.appendChild(field("4S 店名称", input({
      value: form.dealer_name, placeholder: "如：XX 路 4S 店",
      onInput: (e) => { form.dealer_name = e.target.value; },
    }), { required: true }));
    basicEl.appendChild(field("城市", input({
      value: form.city, placeholder: "跨城比价可填",
      onInput: (e) => { form.city = e.target.value; },
    })));
    basicEl.appendChild(field("联系人", input({
      value: form.contact, placeholder: "销售姓名 / 电话",
      onInput: (e) => { form.contact = e.target.value; },
    })));
    basicEl.appendChild(field("报价日期", input({
      type: "date", value: form.offer_date,
      onInput: (e) => { form.offer_date = e.target.value; },
    }), { required: true }));
  }

  /** 优惠/费用动态条目列表：kind = discount | fee */
  function renderMoneyItems(container, items, kind) {
    const isFee = kind === "fee";
    const meta = isFee
      ? { title: "费用", placeholder: "如：保险 / 上牌 / 服务费" }
      : { title: "优惠", placeholder: "如：现金优惠 / 置换补贴" };
    container.innerHTML = "";
    if (isFee) taxInputEl = null;
    container.appendChild(el("label", { class: "fa-field__label", text: `${meta.title}（可多条）` }));

    items.forEach((item, idx) => {
      const amountInput = input({
        type: "number", value: item.amount, placeholder: "金额(元)",
        onInput: (e) => {
          item.amount = e.target.value;
          if (item.autoTax) item.autoTax = false; // 手改金额 → 停止自动联动
          if (!isFee) syncTaxRow();               // 优惠变动 → 联动购置税预填行
          updatePreview();
        },
      });
      if (isFee && item.autoTax) taxInputEl = amountInput;
      container.appendChild(el("div", { class: "car-item-row" }, [
        input({
          value: item.label, placeholder: meta.placeholder,
          onInput: (e) => {
            item.label = e.target.value;
            // 手改购置税预填行的名称 → 停止自动联动
            if (item.autoTax && e.target.value !== "购置税") item.autoTax = false;
          },
        }),
        amountInput,
        iconBtn("trash", {
          variant: "ghost", size: "sm", title: "删除",
          onClick: () => {
            items.splice(idx, 1);
            if (!isFee) { syncTaxRow(); renderItems(); }
            else renderItems();
            updatePreview();
          },
        }),
      ]));
    });

    container.appendChild(el("div", { class: "car-item-add" }, [
      btn(`添加${meta.title}`, {
        variant: "secondary", size: "sm", icon: "plus",
        onClick: () => { items.push({ label: "", amount: "" }); renderItems(); },
      }),
    ]));
    if (isFee) {
      container.appendChild(el("p", {
        class: "muted",
        style: "margin:6px 0 0;font-size:12px",
        text: "「购置税」为按 2026 年政策自动推算的参考值（优惠变动会同步刷新，可修改/删除），以 4S 实际报价为准。",
      }));
    }
  }

  function renderGiftItems() {
    giftEl.innerHTML = "";
    giftEl.appendChild(el("label", { class: "fa-field__label", text: "赠品（可多条，不折价）" }));
    gifts.forEach((item, idx) => {
      giftEl.appendChild(el("div", { class: "car-item-row" }, [
        input({
          value: item.label, placeholder: "如：贴膜 / 脚垫",
          onInput: (e) => { item.label = e.target.value; },
        }),
        input({
          value: item.note, placeholder: "备注（可选）",
          onInput: (e) => { item.note = e.target.value; },
        }),
        iconBtn("trash", {
          variant: "ghost", size: "sm", title: "删除",
          onClick: () => { gifts.splice(idx, 1); renderGiftItems(); },
        }),
      ]));
    });
    giftEl.appendChild(el("div", { class: "car-item-add" }, [
      btn("添加赠品", {
        variant: "secondary", size: "sm", icon: "plus",
        onClick: () => { gifts.push({ label: "", note: "" }); renderGiftItems(); },
      }),
    ]));
  }

  function renderItems() {
    renderMoneyItems(discountEl, discounts, "discount");
    renderMoneyItems(feeEl, fees, "fee");
    renderGiftItems();
  }

  /** 购置税预填行联动：优惠变动 → 裸车价变化 → 重算购置税（仅更新未被手改的预填行） */
  function syncTaxRow() {
    const idx = fees.findIndex((f) => f.autoTax);
    if (idx < 0) return;
    const hint = taxHint(candidate.energy, computeBare());
    if (hint == null || hint <= 0) {
      fees.splice(idx, 1);
      renderItems(); // 预填行被移除 → 重渲染条目区
      return;
    }
    fees[idx].amount = (hint / 100).toString();
    if (taxInputEl && taxInputEl.isConnected) taxInputEl.value = fees[idx].amount;
  }

  function computeBare() {
    if (guide == null) return null;
    const discountTotal = discounts.reduce((sum, d) => sum + (parseFloat(d.amount) || 0) * 100, 0);
    return Math.round(guide - discountTotal);
  }

  function updatePreview() {
    previewEl.innerHTML = "";
    if (guide == null) {
      previewEl.appendChild(el("p", {
        style: "margin:0",
        text: "该车型尚未维护指导价，无法计算裸车价与落地价；可在「编辑车型」中补充。",
      }));
      return;
    }
    const discountTotal = Math.round(discounts.reduce((sum, d) => sum + (parseFloat(d.amount) || 0) * 100, 0));
    const feeTotal = Math.round(fees.reduce((sum, f) => sum + (parseFloat(f.amount) || 0) * 100, 0));
    const bare = Math.round(guide - discountTotal);
    const rows = [
      ["优惠合计", discountTotal > 0 ? `− ¥${fmtMoney(discountTotal)}` : "¥0.00"],
      ["裸车价", `¥${fmtMoney(bare)}`],
      ["费用合计", `¥${fmtMoney(feeTotal)}`],
      ["落地价", `¥${fmtMoney(bare + feeTotal)}`],
    ];
    previewEl.appendChild(el("div", { class: "dialog-preview__title", text: "落地价测算" }));
    for (const [label, value] of rows) {
      previewEl.appendChild(el("div", { class: "dialog-preview__row" }, [
        el("span", { text: label }),
        el("span", { class: "dialog-preview__value", text: value }),
      ]));
    }
  }

  function collectPayload() {
    return {
      candidate_id: candidate.id,
      dealer_name: form.dealer_name.trim(),
      city: form.city.trim(),
      contact: form.contact.trim(),
      offer_date: form.offer_date,
      notes: form.notes,
      discount_items: discounts
        .filter((i) => i.label.trim())
        .map((i) => ({ label: i.label.trim(), amount_cents: yuanToCents(i.amount) })),
      fee_items: fees
        .filter((i) => i.label.trim())
        .map((i) => ({ label: i.label.trim(), amount_cents: yuanToCents(i.amount) })),
      gift_items: gifts
        .filter((i) => i.label.trim())
        .map((i) => ({ label: i.label.trim(), note: (i.note || "").trim() })),
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
        await apiPut(`/car/offers/${offer.id}`, payload);
        toast("报价已更新", "ok");
      } else {
        await apiPost("/car/offers", payload);
        toast("报价已创建", "ok");
      }
      m.close();
      if (onSaved) onSaved();
    } catch (err) {
      if (err.errors && err.errors.length > 0) showErrors(err.errors);
      else toast(err.message, "err");
    }
  }

  // 备注（静态渲染一次）
  noteEl.appendChild(field("备注", textarea({
    value: form.notes, rows: 2, placeholder: "如：需在本店投保、贷款 2 年免息",
    onInput: (e) => { form.notes = e.target.value; },
  })));

  const footer = el("div", { class: "fa-dialog-actions" }, [
    btn("取消", { variant: "secondary", onClick: () => m.close() }),
    btn(isEdit ? "保存" : "创建报价", { variant: "primary", icon: "check", onClick: submit }),
  ]);

  const m = modal({
    title: isEdit ? `编辑报价 · ${offer.dealer_name}` : `新增报价 · ${candidate.brand} ${candidate.model}`,
    width: "wide",
    body,
    footer,
  });

  renderBasic();
  renderItems();
  updatePreview();
}
