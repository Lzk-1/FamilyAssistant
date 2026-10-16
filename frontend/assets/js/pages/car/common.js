/** 选车模块共享层：枚举镜像、格式化、购置税推算、对比篮子（镜像后端 car.py 常量与口径）。 */

// ============================================================
// 枚举（镜像后端 car.py）
// ============================================================

export const STATUS_LABELS = {
  watching: "关注中", test_driving: "试驾中", comparing: "对比中",
  dropped: "已放弃", chosen: "已选定",
};

export const STATUS_OPTIONS = [
  { value: "", label: "全部状态" },
  { value: "watching", label: "关注中" },
  { value: "test_driving", label: "试驾中" },
  { value: "comparing", label: "对比中" },
  { value: "dropped", label: "已放弃" },
  { value: "chosen", label: "已选定" },
];

export const ENERGY_LABELS = { fuel: "燃油", ev: "纯电", hybrid: "混动" };
export const ENERGY_OPTIONS = [
  { value: "fuel", label: "燃油" },
  { value: "ev", label: "纯电" },
  { value: "hybrid", label: "混动" },
];

export const PHOTO_KIND_LABELS = { exterior: "外观", interior: "内饰", other: "其他" };
export const PHOTO_KIND_OPTIONS = [
  { value: "exterior", label: "外观" },
  { value: "interior", label: "内饰" },
  { value: "other", label: "其他" },
];

/** 预置常用配置标签（弹窗一键添加；支持自定义行，上限 12 条镜像后端） */
export const PRESET_FEATURES = [
  "座位数", "抬头显示", "智驾", "零重力按摩座椅", "空气悬架", "天窗",
  "360 影像", "激光雷达", "座椅通风/加热", "音响", "车机芯片", "电池容量",
];

// ============================================================
// 状态着色（沿用 fa-tag variant 体系）
// ============================================================

export function carStatusVariant(status) {
  if (status === "chosen") return "ok";
  if (status === "dropped") return "muted";
  if (status === "test_driving") return "warn";
  if (status === "comparing") return "soon";
  return "primary"; // watching
}

// ============================================================
// 金额格式化（整数分口径，与理财一致）
// ============================================================

export function fmtMoney(cents) {
  if (cents == null) return "—";
  return (cents / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtCompact(cents) {
  if (cents == null) return "—";
  const yuan = cents / 100;
  if (Math.abs(yuan) >= 10000) return `¥${(yuan / 10000).toFixed(2)}万`;
  return `¥${yuan.toFixed(0)}`;
}

export function yuanToCents(yuan) {
  return Math.round(parseFloat(yuan) * 100) || 0;
}

/** 万元 → 分（指导价录入口径） */
export function wanToCents(wan) {
  return Math.round(parseFloat(wan) * 1000000) || 0;
}

/** 分 → 万元字符串（编辑回填） */
export function centsToWan(cents) {
  return cents != null ? String(Math.round(cents / 10000) / 100) : "";
}

export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// ============================================================
// 购置税推算（镜像后端 car.tax_hint：2026 政策，仅作预填参考）
// ============================================================

export function taxHint(energy, barePriceCents) {
  if (barePriceCents == null || barePriceCents <= 0) return null;
  const taxable = Math.floor(barePriceCents * 100 / 113); // 计税价 = 裸车 ÷ 1.13
  const full = Math.floor(taxable * 10 / 100);           // 10% 口径
  if (energy === "fuel") return full;
  const relief = Math.min(Math.floor(full * 50 / 100), 15000 * 100); // 新能源减半、减税额 ≤ 1.5 万
  return full - relief;
}

// ============================================================
// 对比篮子（localStorage 持久化，模式沿用理财 compare）
// ============================================================

const COMPARE_KEY = "fa_car_compare_ids";
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
    return { ok: false, ids, reason: `最多对比 ${COMPARE_MAX} 个车型` };
  }
  saveCompareIds([...ids, candidateId]);
  return { ok: true, ids: getCompareIds(), reason: "已加入对比篮子" };
}

/** 批量加入（档案页勾选/对比页选择器确认）：返回 { ok, ids, reason }。 */
export function addManyToCompare(candidateIds) {
  const ids = getCompareIds();
  const merged = [...new Set([...ids, ...candidateIds])];
  if (merged.length > COMPARE_MAX) {
    return { ok: false, ids, reason: `最多对比 ${COMPARE_MAX} 个车型（当前 ${ids.length} 个）` };
  }
  const added = merged.length - ids.length;
  saveCompareIds(merged);
  return { ok: true, ids: merged, reason: added > 0 ? `已加入 ${added} 个车型` : "所选车型均已在对比篮中" };
}
