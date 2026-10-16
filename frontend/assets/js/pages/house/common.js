/** 选房模块共享层：枚举镜像、格式化、价格口径、维度评分、对比篮子（镜像后端 house.py 常量与口径）。 */

// ============================================================
// 枚举（镜像后端 house.py）
// ============================================================

export const STATUS_LABELS = {
  watching: "关注中", visiting: "看房中", comparing: "对比中",
  dropped: "已放弃", chosen: "已选定",
};

export const STATUS_OPTIONS = [
  { value: "", label: "全部状态" },
  { value: "watching", label: "关注中" },
  { value: "visiting", label: "看房中" },
  { value: "comparing", label: "对比中" },
  { value: "dropped", label: "已放弃" },
  { value: "chosen", label: "已选定" },
];

export const PHOTO_KIND_LABELS = { exterior: "外观", interior: "室内", layout: "户型图", other: "其他" };
export const PHOTO_KIND_OPTIONS = [
  { value: "layout", label: "户型图" },
  { value: "exterior", label: "外观" },
  { value: "interior", label: "室内" },
  { value: "other", label: "其他" },
];

/** 预置常用配套设施标签（弹窗一键添加；支持自定义行，上限 12 条镜像后端） */
export const PRESET_FEATURES = [
  "学区", "地铁", "商场", "医院", "幼儿园", "南北通透",
  "满五唯一", "电梯", "车位",
];

// ============================================================
// 六维度评分（镜像后端 DIMENSIONS，权重可经 /house/scoring-config 自定义）
// ============================================================

export const DIMENSIONS = [
  { key: "location", label: "区位交通", weight: 25 },
  { key: "facilities", label: "配套资源", weight: 20 },
  { key: "price", label: "价格性价比", weight: 20 },
  { key: "layout", label: "户型产品", weight: 15 },
  { key: "quality", label: "楼盘品质", weight: 10 },
  { key: "liquidity", label: "流通性", weight: 10 },
];

export const DIM_SCORE_OPTIONS = [
  { value: "", label: "未评" },
  ...[0, 1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: `${n} 分` })),
];

export function houseStatusVariant(status) {
  if (status === "chosen") return "ok";
  if (status === "dropped") return "muted";
  if (status === "visiting") return "warn";
  if (status === "comparing") return "soon";
  return "primary"; // watching
}

// ============================================================
// 价格格式化（整数分口径：总价分 / 单价分·㎡）
// ============================================================

/** 分 → 万元展示（200,000,000 分 → ¥200.00万） */
export function fmtWan(cents) {
  if (cents == null) return "—";
  return `¥${(cents / 1000000).toFixed(2)}万`;
}

/** 分/㎡ → 元/㎡展示（2,000,000 分 → 20,000 元/㎡） */
export function fmtUnit(cents) {
  if (cents == null) return "—";
  return `${Math.round(cents / 100).toLocaleString("zh-CN")} 元/㎡`;
}

/** 万元 → 分（总价录入口径） */
export function wanToCents(wan) {
  return Math.round(parseFloat(wan) * 1000000) || 0;
}

/** 元/㎡ → 分/㎡（单价录入口径） */
export function unitYuanToCents(yuan) {
  return Math.round(parseFloat(yuan) * 100) || 0;
}

/** 分 → 万元字符串（编辑回填） */
export function centsToWan(cents) {
  return cents != null ? String(Math.round(cents / 10000) / 100) : "";
}

/** 分/㎡ → 元/㎡字符串（编辑回填） */
export function centsToUnitYuan(cents) {
  return cents != null ? String(Math.round(cents / 100)) : "";
}

/** 由总价推算单价（元/㎡ 字符串）：总价分 ÷ 面积 × 100 */
export function unitFromTotal(totalCents, area) {
  if (!totalCents || !area) return "";
  return String(Math.round(totalCents / area / 100));
}

/** 由单价推算总价（万元字符串）：单价元/㎡ × 面积 ÷ 10000 */
export function totalFromUnit(unitYuan, area) {
  if (!unitYuan || !area) return "";
  return String(Math.round(unitYuan * area * 100) / 100);
}

// ============================================================
// 对比篮子（localStorage 持久化，沿用选车/理财 compare 模式）
// ============================================================

const COMPARE_KEY = "fa_house_compare_ids";
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

/** 单个切换：加入/移出对比篮。返回 { ok, ids, reason }。 */
export function toggleCompare(candidateId) {
  const ids = getCompareIds();
  if (ids.includes(candidateId)) {
    saveCompareIds(ids.filter((i) => i !== candidateId));
    return { ok: true, ids: getCompareIds(), reason: "已从对比篮移除" };
  }
  if (ids.length >= COMPARE_MAX) {
    return { ok: false, ids, reason: `最多对比 ${COMPARE_MAX} 个房源` };
  }
  saveCompareIds([...ids, candidateId]);
  return { ok: true, ids: getCompareIds(), reason: "已加入对比篮子" };
}

/** 批量加入（档案页勾选/对比页选择器确认）：返回 { ok, ids, reason }。 */
export function addManyToCompare(candidateIds) {
  const ids = getCompareIds();
  const merged = [...new Set([...ids, ...candidateIds])];
  if (merged.length > COMPARE_MAX) {
    return { ok: false, ids, reason: `最多对比 ${COMPARE_MAX} 个房源（当前 ${ids.length} 个）` };
  }
  const added = merged.length - ids.length;
  saveCompareIds(merged);
  return { ok: true, ids: merged, reason: added > 0 ? `已加入 ${added} 个房源` : "所选房源均已在对比篮中" };
}
