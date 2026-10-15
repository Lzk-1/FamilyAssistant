/** 理财总览页：四张统计卡片 + 资产分布环形图（分类/归属人双维度）+
 *  净资产趋势折线图 + 即将到期列表 + 最近动态。
 */

import { apiGet } from "../../api.js";
import { el, statCard, card, tag, emptyState } from "../../ui.js";
import { donut, lineChart } from "../../charts.js";
import { fmtMoney, fmtCompact, categoryColor, memberColor, institutionColor, dueText, statusVariant } from "./common.js";

export async function renderOverview(root) {
  const data = await apiGet("/finance/overview");
  const trendData = await apiGet("/finance/trend?months=12");

  // 统一纵向容器：各区块垂直间距一致（由 .overview-stack 的 gap 控制）
  const stack = el("div", { class: "overview-stack" });
  root.appendChild(stack);

  // 四张统计卡片
  const stats = el("div", { class: "stat-grid" }, [
    statCard({ label: "总资产", value: fmtMoney(data.totals.assets_cents), accent: "#16a34a", sub: `${data.by_category.filter((c) => c.direction === "asset").length} 类资产` }),
    statCard({ label: "总负债", value: fmtMoney(data.totals.liabilities_cents), accent: "#ef4444", sub: `${data.by_category.filter((c) => c.direction === "liability").length} 类负债` }),
    statCard({ label: "净资产", value: fmtMoney(data.totals.net_cents), accent: "#2563eb", sub: "资产 − 负债" }),
    statCard({ label: "即将到期", value: `${data.upcoming.length}`, accent: "#ea580c", sub: "30 天内到期" }),
  ]);
  stack.appendChild(stats);

  // 资产分布环形图（分类 / 归属人 / 机构三维度）
  const categoryDonutData = data.by_category
    .filter((c) => c.direction === "asset")
    .map((c) => ({
      label: c.name,
      value: c.amount_cents,
      color: categoryColor(c.code),
      code: c.code,
    }));
  const memberDonutData = data.by_member.map((m) => ({
    label: m.name,
    value: m.amount_cents,
    color: memberColor(m.member_id),
    memberId: m.member_id,
  }));
  const institutionDonutData = (data.by_institution || []).map((i) => ({
    label: i.name,
    value: i.amount_cents,
    color: institutionColor(i.name),
  }));

  const chartsRow = el("div", { class: "stat-grid stat-grid--3" }, [
    card("资产分布（分类）", donut(categoryDonutData, {
      onSelect: (d) => { location.hash = `#/finance/assets?category=${encodeURIComponent(d.code)}`; },
    })),
    card("资产分布（归属人）", memberDonutData.length > 0 ? donut(memberDonutData, {
      onSelect: (d) => { location.hash = `#/finance/assets?holder_id=${encodeURIComponent(d.memberId)}`; },
    }) : emptyState("暂无归属人", "添加资产后将自动统计")),
    card("资产分布（机构）", institutionDonutData.length > 0 ? donut(institutionDonutData, {
      onSelect: (d) => { location.hash = `#/finance/assets?q=${encodeURIComponent(d.label)}`; },
    }) : emptyState("暂无机构", "添加资产时填写机构后将自动统计")),
  ]);
  stack.appendChild(chartsRow);

  // 趋势折线图
  const trendSeries = trendData.map((p) => ({ label: p.date, value: p.net_cents }));
  stack.appendChild(card("净资产趋势（12 个月）", lineChart(trendSeries, { color: "#2563eb", areaColor: "rgba(37,99,235,0.1)" })));

  // 即将到期 + 最近动态
  const bottomRow = el("div", { class: "stat-grid stat-grid--2" }, [
    card("即将到期（30 天内）", renderUpcoming(data.upcoming)),
    card("最近动态", renderEvents(data.recent_events)),
  ]);
  stack.appendChild(bottomRow);
}

function renderUpcoming(items) {
  if (!items || items.length === 0) {
    return emptyState("暂无即将到期的资产", "30 天内到期的资产将显示在这里");
  }
  return el("div", {}, items.map((item) =>
    el("div", {
      class: "asset-row",
      style: "display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border);cursor:pointer",
      onClick: () => { location.hash = `#/finance/assets/${item.asset_id}`; },
    }, [
      tag(dueText(item.days_to_end), statusVariant(item.level)),
      el("span", { text: item.name, style: "flex:1;font-size:13px" }),
      el("span", { text: fmtCompact(item.amount_cents), style: "font-size:13px;color:var(--text-muted);font-variant-numeric:tabular-nums" }),
    ])
  ));
}

function renderEvents(events) {
  if (!events || events.length === 0) {
    return emptyState("暂无动态", "最近的操作记录将显示在这里");
  }
  return el("div", {}, events.map((ev) =>
    el("div", { class: "detail-event" }, [
      el("span", { text: ev.summary, style: "flex:1;font-size:13px" }),
      el("span", { text: (ev.at || "").slice(5, 16), class: "detail-event__time" }),
    ])
  ));
}
