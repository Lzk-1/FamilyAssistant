/** 理财收益分析页（M3a · finance-module-design §5.6）：
 *  收益摘要卡（已实现/近12月/在途预计/加权年化）+ 月度收益柱状图（区间线性分摊，
 *  负月红色向下）+ 分类/成员贡献环形图（已实现口径）+ 收益明细表。
 */

import { apiGet } from "../../api.js";
import { el, statCard, card, table, emptyState } from "../../ui.js";
import { barChart, donut } from "../../charts.js";
import { fmtMoney, categoryColor, memberColor } from "./common.js";

export async function renderAnalytics(root) {
  const data = await apiGet("/finance/analytics?months=12");
  const s = data.summary;
  const hasRealized = s.realized_total_cents !== 0 || (data.details || []).length > 0;

  // 统一纵向容器：垂直间距由 .overview-stack 的 gap 控制
  const stack = el("div", { class: "overview-stack" });
  root.appendChild(stack);

  // 摘要卡：浮动盈亏独立展示，不与已实现混算
  stack.appendChild(el("div", { class: "stat-grid" }, [
    statCard({ label: "累计已实现收益", value: fmtMoney(s.realized_total_cents), accent: "#16a34a",
               sub: "到期利息 + 收益录入 + 赎回差额" }),
    statCard({ label: "近 12 月已实现", value: fmtMoney(s.realized_recent_cents), accent: "#f97316",
               sub: "增量按天分摊到月" }),
    statCard({ label: "在途预计收益", value: fmtMoney(s.pending_estimated_cents), accent: "#2563eb",
               sub: "未到期资产按公式/基准推算" }),
    statCard({
      label: "平均实际年化",
      value: s.weighted_actual_rate == null ? "—" : `${s.weighted_actual_rate}%`,
      accent: "#7c3aed",
      sub: s.unrealized_pnl_cents !== 0
        ? `浮动盈亏 ${fmtMoney(s.unrealized_pnl_cents)}（未实现，未计入）`
        : "按本金加权（有收益录入的理财）",
    }),
  ]));

  if (!hasRealized) {
    stack.appendChild(card("月度收益趋势（近 12 月）",
      emptyState("暂无已实现收益", "定期到期利息、理财收益录入与赎回差额将统计到这里")));
    return;
  }

  // 月度柱状图：负月自动切中基线模式（红柱向下）
  const bars = data.monthly.map((m) => ({ label: `${m.month.slice(5)}月`, value: m.realized_cents }));
  stack.appendChild(card("月度收益趋势（近 12 月）", barChart(bars, { height: 180 })));

  // 分类 / 成员贡献（已实现口径）
  const categoryDonutData = data.by_category.map((c) => ({
    label: c.label, value: c.realized_cents, color: categoryColor(c.code), code: c.code,
  }));
  const memberDonutData = data.by_member.map((m) => ({
    label: m.name, value: m.realized_cents, color: memberColor(m.member_id), memberId: m.member_id,
  }));
  stack.appendChild(el("div", { class: "stat-grid stat-grid--2" }, [
    card("收益贡献（分类）", donut(categoryDonutData, {
      onSelect: (d) => { location.hash = `#/finance/assets?category=${encodeURIComponent(d.code)}`; },
    })),
    card("收益贡献（成员）", memberDonutData.length > 0 ? donut(memberDonutData, {
      onSelect: (d) => { location.hash = `#/finance/assets?holder_id=${encodeURIComponent(d.memberId)}`; },
    }) : emptyState("暂无成员收益", "按归属人归集的已实现收益")),
  ]));

  // 收益明细表（原始事件粒度，倒序）
  stack.appendChild(card("收益明细", table(data.details, [
    { label: "日期", key: "date" },
    { label: "资产", key: "asset_name" },
    { label: "分类", render: (r) => r.category_label },
    { label: "归属人", render: (r) => r.holder_name },
    { label: "类型", render: (r) => r.kind_label },
    { label: "金额（元）", render: (r) => r.amount_cents < 0
      ? `-${fmtMoney(Math.abs(r.amount_cents))}`
      : fmtMoney(r.amount_cents) },
    { label: "备注", render: (r) => r.note || "—" },
  ], { onRowClick: (r) => { location.hash = `#/finance/assets/${r.asset_id}`; } })));
}
