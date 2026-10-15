/** 理财模块共享层：分类镜像、格式化、状态着色、颜色、公式预览、API 缓存。
 *  与后端 finance.py 常量保持一致（分类码/状态/公式）。
 */

import { apiGet } from "../../api.js";

// ============================================================
// 分类编码表（镜像后端 migrations/002_finance.sql 种子数据）
// ============================================================

export const CATEGORIES = [
  { code: "fixed_deposit", name: "银行定期", direction: "asset" },
  { code: "demand", name: "银行活期", direction: "asset" },
  { code: "wealth", name: "理财产品", direction: "asset" },
  { code: "metal", name: "贵金属", direction: "asset" },
  { code: "stock", name: "股票基金", direction: "asset" },
  { code: "loan_out", name: "外借（债权）", direction: "asset" },
  { code: "bond_insurance", name: "国债保险", direction: "asset" },
  { code: "asset_other", name: "其他资产", direction: "asset" },
  { code: "mortgage", name: "房贷", direction: "liability" },
  { code: "loan_in", name: "外债（欠款）", direction: "liability" },
  { code: "credit_card", name: "信用卡/消费贷", direction: "liability" },
  { code: "liability_other", name: "其他负债", direction: "liability" },
];

export const CATEGORY_MAP = Object.fromEntries(CATEGORIES.map((c) => [c.code, c]));

// 资产色阶（明快亮色系，橙色主调；暖冷交替排列保证环形图相邻扇区区分度）+ 负债灰色系
export const ASSET_COLORS = ["#f97316", "#38bdf8", "#fbbf24", "#34d399", "#fb7185", "#a78bfa", "#fb923c", "#fcd34d"];
export const LIABILITY_COLORS = ["#64748b", "#94a3b8", "#475569", "#cbd5e1"];
export const MEMBER_COLORS = ["#f97316", "#3b82f6", "#10b981", "#8b5cf6", "#ef4444", "#f59e0b"];
// 机构分布色（亮色系，按名称哈希取色保证颜色稳定不随金额排序漂移）
export const INSTITUTION_COLORS = ["#f59e0b", "#06b6d4", "#8b5cf6", "#ec4899", "#22c55e", "#3b82f6", "#f43f5e", "#14b8a6", "#eab308", "#6366f1"];

// 到期提醒分类色
export const STATUS_COLORS = {
  overdue: "#ef4444",
  matured: "#6b7280",
  urgent: "#ea580c",
  soon: "#ca8a04",
  holding: "#16a34a",
  settled_withdraw: "#94a3b8",
  settled_renew: "#94a3b8",
  settled_clear: "#94a3b8",
};

// 状态标签映射（镜像后端 _STATUS_LABELS）
export const STATUS_LABELS = {
  holding: "持有中", urgent: "即将到期", soon: "30天内到期",
  matured: "已到期", overdue: "已逾期",
  settled_withdraw: "已支取", settled_renew: "已续存", settled_clear: "已结清",
};

export const SETTLE_LABELS = {
  withdraw: "支取", renew: "续存", repay: "登记还款", clear: "结清",
};

// 可登记还款的分类（镜像后端 _REPAYABLE）
const REPAYABLE = new Set(["loan_out", "loan_in", "credit_card"]);

// ============================================================
// 金额格式化（全链路整数分）
// ============================================================

export function fmtMoney(cents) {
  if (cents == null) return "—";
  return (cents / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtCompact(cents) {
  if (cents == null) return "—";
  const yuan = cents / 100;
  if (Math.abs(yuan) >= 10000) return `¥${(yuan / 10000).toFixed(1)}万`;
  return `¥${yuan.toFixed(0)}`;
}

export function yuanToCents(yuan) {
  return Math.round(parseFloat(yuan) * 100) || 0;
}

export function centsToYuan(cents) {
  return (cents / 100).toFixed(2);
}

// ============================================================
// 日期工具
// ============================================================

export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export function daysUntil(dateStr) {
  if (!dateStr) return null;
  const target = new Date(dateStr + "T00:00:00");
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.round((target - now) / 86400000);
}

export function monthsBetween(start, end) {
  if (!start || !end) return 0;
  const s = new Date(start + "T00:00:00");
  const e = new Date(end + "T00:00:00");
  let months = (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth());
  if (e.getDate() < s.getDate()) months -= 1;
  return Math.max(months, 0);
}

/** 下一个「每月 day 日」（day 限 1~28，无月末溢出）：返回 {date: "YYYY-MM-DD", days}（镜像后端 _next_month_day） */
export function nextMonthlyDay(day) {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  let candidate = new Date(now.getFullYear(), now.getMonth(), Number(day));
  if (candidate < now) candidate = new Date(now.getFullYear(), now.getMonth() + 1, Number(day));
  const days = Math.round((candidate - now) / 86400000);
  const p = (n) => String(n).padStart(2, "0");
  return { date: `${candidate.getFullYear()}-${p(candidate.getMonth() + 1)}-${p(candidate.getDate())}`, days };
}

/** "YYYY-MM" → "YYYY年M月" */
export function fmtMonth(ym) {
  if (!ym) return "—";
  const [y, m] = String(ym).split("-");
  return `${y}年${Number(m)}月`;
}

// ============================================================
// 状态着色与文案
// ============================================================

export function statusVariant(status) {
  if (status === "overdue") return "danger";
  if (status === "urgent") return "urgent";
  if (status === "soon") return "soon";
  if (status === "matured") return "muted";
  if (status.startsWith("settled")) return "muted";
  return "ok";
}

export function statusRowClass(status) {
  if (status === "overdue") return "row--overdue";
  if (status === "urgent") return "row--urgent";
  if (status === "soon") return "row--soon";
  if (status === "matured") return "row--matured";
  return "";
}

export function dueText(days) {
  if (days == null) return "—";
  if (days < 0) return `逾期${-days}天`;
  if (days === 0) return "今天到期";
  if (days <= 7) return `${days}天后到期`;
  if (days <= 30) return `${days}天后`;
  return `剩余${days}天`;
}

// ============================================================
// 分类→颜色映射
// ============================================================

export function categoryColor(code) {
  const cat = CATEGORY_MAP[code];
  if (!cat) return "#94a3b8";
  if (cat.direction === "liability") {
    const liabCats = CATEGORIES.filter((c) => c.direction === "liability");
    const idx = liabCats.findIndex((c) => c.code === code);
    return LIABILITY_COLORS[idx % LIABILITY_COLORS.length];
  }
  const assetCats = CATEGORIES.filter((c) => c.direction === "asset");
  const idx = assetCats.findIndex((c) => c.code === code);
  return ASSET_COLORS[idx % ASSET_COLORS.length];
}

export function memberColor(memberId) {
  return MEMBER_COLORS[(memberId - 1) % MEMBER_COLORS.length];
}

export function institutionColor(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return INSTITUTION_COLORS[h % INSTITUTION_COLORS.length];
}

// ============================================================
// 实时计算预览（镜像后端 finance.compute 公式）
// ============================================================

export function computePreview(category, form) {
  const result = [];
  const amountCents = yuanToCents(form.amount || 0);
  const rate = parseFloat(form.annual_rate) || 0;
  const start = form.start_date;
  const end = form.end_date;

  if (category === "fixed_deposit" && start && end && rate) {
    const months = monthsBetween(start, end);
    const interest = Math.round(amountCents * rate / 100 * months / 12);
    result.push({ label: "期限", value: `${months}个月` });
    result.push({ label: "到期利息", value: fmtMoney(interest) + " 元" });
    result.push({ label: "到期本息", value: fmtMoney(amountCents + interest) + " 元" });
  }

  if (category === "wealth" && start && end) {
    // 业绩基准年化存于 extra.base_rate（镜像后端 compute 公式）
    const baseRate = parseFloat(form.extra?.base_rate) || 0;
    if (baseRate) {
      const s = new Date(start + "T00:00:00");
      const e = new Date(end + "T00:00:00");
      const days = Math.round((e - s) / 86400000);
      const est = Math.round(amountCents * baseRate / 100 * days / 365);
      result.push({ label: "持有天数", value: `${days}天` });
      result.push({ label: "预计收益", value: fmtMoney(est) + " 元" });
      result.push({ label: "到期本息", value: fmtMoney(amountCents + est) + " 元" });
    }
  }

  if (category === "metal") {
    const qty = parseFloat(form.extra?.quantity) || 0;
    const costPrice = yuanToCents(form.extra?.cost_price || 0);
    const curPrice = yuanToCents(form.extra?.current_price || 0);
    if (qty && curPrice) {
      const market = Math.round(qty * curPrice);
      const cost = Math.round(qty * costPrice);
      result.push({ label: "当前市值", value: fmtMoney(market) + " 元" });
      result.push({ label: "浮动盈亏", value: fmtMoney(market - cost) + " 元" });
    }
  }

  if (category === "stock") {
    const costCents = yuanToCents(form.extra?.cost || 0);
    if (amountCents && costCents) {
      result.push({ label: "浮动盈亏", value: fmtMoney(amountCents - costCents) + " 元" });
    }
  }

  // 房贷：剩余期数 / 预计结清月 / 已还本金 / 下次扣款日（镜像后端 compute，M3b 负债增强）
  if (category === "mortgage") {
    const monthly = yuanToCents(form.extra?.monthly_payment || 0);
    if (monthly > 0 && amountCents > 0) {
      const months = Math.ceil(amountCents / monthly);
      const now = new Date();
      const idx = now.getFullYear() * 12 + now.getMonth() + months;
      result.push({ label: "剩余期数", value: `${months} 期` });
      result.push({ label: "预计结清", value: fmtMonth(`${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`) });
    }
    const total = yuanToCents(form.extra?.total || 0);
    if (total > amountCents) {
      result.push({ label: "已还本金", value: fmtMoney(total - amountCents) + " 元" });
    }
    if (form.extra?.pay_day) {
      const next = nextMonthlyDay(form.extra.pay_day);
      result.push({ label: "下次扣款", value: next.days === 0 ? `今天（${next.date}）` : `${next.date}（${next.days} 天后）` });
    }
  }

  // 信用卡：下一还款日 / 距还款日天数（M3b 负债增强）
  if (category === "credit_card" && form.extra?.repay_day) {
    const next = nextMonthlyDay(form.extra.repay_day);
    result.push({ label: "下一还款日", value: next.days === 0 ? `今天（${next.date}）` : `${next.date}（${next.days} 天后）` });
  }

  if (end) {
    const d = daysUntil(end);
    if (d != null) {
      result.push({ label: "到期", value: dueText(d) });
    }
  }

  return result;
}

// ============================================================
// 可执行操作（镜像后端 settle_asset 校验逻辑）
// ============================================================

export function settleActions(category, status) {
  if (status !== "holding") return [];
  const actions = [];
  if (category === "fixed_deposit") {
    actions.push("withdraw", "renew");
  }
  if (REPAYABLE.has(category)) {
    actions.push("repay", "clear");
  }
  if (!actions.includes("clear") && !actions.includes("withdraw")) {
    actions.push("clear");
  }
  return actions;
}

// ============================================================
// API 缓存（分类 + 成员字典）
// ============================================================

let _categoriesCache = null;
let _membersCache = null;

export async function fetchCategories() {
  if (_categoriesCache) return _categoriesCache;
  _categoriesCache = await apiGet("/finance/categories");
  return _categoriesCache;
}

export async function fetchMembers() {
  if (_membersCache) return _membersCache;
  _membersCache = await apiGet("/finance/members");
  return _membersCache;
}

export function invalidateMembers() {
  _membersCache = null;
}

export function invalidateCategories() {
  _categoriesCache = null;
}

// ============================================================
// 对比篮子（M2c · localStorage 持久化，compare-design §2/§4.3）
// ============================================================

const COMPARE_KEY = "fa_compare_ids";
export const COMPARE_MAX = 6;

export function getCompareIds() {
  try {
    const ids = JSON.parse(localStorage.getItem(COMPARE_KEY) || "[]");
    return Array.isArray(ids) ? ids.filter((x) => Number.isInteger(x)) : [];
  } catch {
    return [];
  }
}

export function saveCompareIds(ids) {
  localStorage.setItem(COMPARE_KEY, JSON.stringify(ids.slice(0, COMPARE_MAX)));
}

export function clearCompare() {
  localStorage.removeItem(COMPARE_KEY);
}

/** 单个切换：资产加入/移出篮子。返回 { ok, ids, reason }。 */
export function toggleCompare(assetId, direction) {
  if (direction === "liability") {
    return { ok: false, ids: getCompareIds(), reason: "负债无收益概念，暂不支持对比" };
  }
  const ids = getCompareIds();
  if (ids.includes(assetId)) {
    saveCompareIds(ids.filter((i) => i !== assetId));
    return { ok: true, ids: getCompareIds(), reason: "已从对比篮移除" };
  }
  if (ids.length >= COMPARE_MAX) {
    return { ok: false, ids, reason: `最多对比 ${COMPARE_MAX} 个产品` };
  }
  saveCompareIds([...ids, assetId]);
  return { ok: true, ids: getCompareIds(), reason: "已加入对比篮子" };
}

/** 批量加入（添加资产弹窗确认）：返回 { ok, ids, reason }。 */
export function addManyToCompare(assetIds) {
  const ids = getCompareIds();
  const merged = [...new Set([...ids, ...assetIds])];
  if (merged.length > COMPARE_MAX) {
    return { ok: false, ids, reason: `最多对比 ${COMPARE_MAX} 个产品（当前 ${ids.length} 个）` };
  }
  const added = merged.length - ids.length;
  saveCompareIds(merged);
  return { ok: true, ids: merged, reason: added > 0 ? `已加入 ${added} 个资产` : "所选资产均已在对比篮中" };
}
