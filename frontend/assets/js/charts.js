/** 原生 SVG 图表渲染器（零依赖，规范 §4.10）。
 *  donut() 环形图 + HTML legend；line() 折线图带网格和面积填充；bar() 柱状图。
 */

import { el } from "./ui.js";

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v != null) node.setAttribute(k, v);
  }
  return node;
}

/** 环形图（donut）：data=[{label, value, color}]；onSelect 点击扇区回调 */
export function donut(data, { onSelect } = {}) {
  const total = data.reduce((s, d) => s + d.value, 0);
  const size = 160;
  const r = 60;
  const cx = 80;
  const cy = 80;
  const strokeW = 24;
  const circumference = 2 * Math.PI * r;

  const svg = svgEl("svg", { viewBox: `0 0 ${size} ${size}`, width: size, height: size });

  // 背景圆环
  svg.appendChild(svgEl("circle", {
    cx, cy, r, fill: "none", stroke: "#f1f5f9", "stroke-width": strokeW,
  }));

  if (total === 0) {
    svg.appendChild(svgEl("text", {
      x: cx, y: cy + 5, "text-anchor": "middle", "font-size": "13", fill: "#94a3b8",
    }));
    svg.lastChild.textContent = "暂无数据";
    return el("div", { class: "chart-donut" }, [svg]);
  }

  let offset = 0;
  for (const d of data) {
    if (d.value <= 0) continue;
    const fraction = d.value / total;
    const dashLen = fraction * circumference;
    const gap = circumference - dashLen;
    const circle = svgEl("circle", {
      cx, cy, r, fill: "none",
      stroke: d.color,
      "stroke-width": strokeW,
      "stroke-dasharray": `${dashLen} ${gap}`,
      "stroke-dashoffset": -offset,
      transform: `rotate(-90 ${cx} ${cy})`,
      style: "cursor: pointer; transition: stroke-width 0.2s",
    });
    circle.addEventListener("mouseenter", () => circle.setAttribute("stroke-width", strokeW + 4));
    circle.addEventListener("mouseleave", () => circle.setAttribute("stroke-width", strokeW));
    if (onSelect) circle.addEventListener("click", () => onSelect(d));
    svg.appendChild(circle);
    offset += dashLen;
  }

  // 中心文字
  const t1 = svgEl("text", { x: cx, y: cy - 2, "text-anchor": "middle", "font-size": "20", "font-weight": "600", fill: "#1f2937" });
  t1.textContent = fmtCompact(total);
  const t2 = svgEl("text", { x: cx, y: cy + 16, "text-anchor": "middle", "font-size": "11", fill: "#6b7280" });
  t2.textContent = "总计";
  svg.appendChild(t1);
  svg.appendChild(t2);

  // HTML legend
  const legend = el("div", { class: "chart-legend" },
    data.filter((d) => d.value > 0).map((d) => {
      const pct = total > 0 ? ((d.value / total) * 100).toFixed(1) : "0";
      const item = el("div", {
        class: "chart-legend__item",
        style: onSelect ? "cursor:pointer" : "",
        onClick: onSelect ? () => onSelect(d) : undefined,
      }, [
        el("span", { class: "chart-legend__dot", style: `background:${d.color}` }),
        el("span", { class: "chart-legend__label", text: d.label }),
        el("span", { class: "chart-legend__value", text: `${pct}%` }),
      ]);
      return item;
    })
  );

  return el("div", { class: "chart-donut" }, [svg, legend]);
}

/** 折线图（line）：data=[{label, value}]；返回 SVG 元素 */
export function lineChart(data, { height = 160, color = "#16a34a", areaColor = "rgba(22,163,74,0.1)" } = {}) {
  const W = 560;
  const H = height;
  const pad = { top: 16, right: 16, bottom: 28, left: 48 };
  const cw = W - pad.left - pad.right;
  const ch = H - pad.top - pad.bottom;

  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", height: H, style: "display:block" });

  if (!data || data.length === 0) {
    const t = svgEl("text", { x: W / 2, y: H / 2, "text-anchor": "middle", "font-size": "13", fill: "#94a3b8" });
    t.textContent = "暂无数据";
    svg.appendChild(t);
    return svg;
  }

  const values = data.map((d) => d.value);
  const maxV = Math.max(...values, 0);
  const minV = Math.min(...values, 0);
  const range = maxV - minV || 1;
  const stepX = data.length > 1 ? cw / (data.length - 1) : 0;

  // 水平网格线（4 条）
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (ch / 4) * i;
    const val = maxV - (range / 4) * i;
    svg.appendChild(svgEl("line", {
      x1: pad.left, y1: y, x2: W - pad.right, y2: y,
      stroke: "#f1f5f9", "stroke-width": "1",
    }));
    const label = svgEl("text", { x: pad.left - 6, y: y + 4, "text-anchor": "end", "font-size": "10", fill: "#94a3b8" });
    label.textContent = fmtCompact(val);
    svg.appendChild(label);
  }

  // 折线路径
  const points = data.map((d, i) => {
    const x = pad.left + (data.length > 1 ? i * stepX : cw / 2);
    const y = pad.top + ch - ((d.value - minV) / range) * ch;
    return [x, y];
  });

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p[0]} ${p[1]}`).join(" ");
  const areaPath = `M ${points[0][0]} ${pad.top + ch} ${points.map((p) => `L ${p[0]} ${p[1]}`).join(" ")} L ${points[points.length - 1][0]} ${pad.top + ch} Z`;

  svg.appendChild(svgEl("path", { d: areaPath, fill: areaColor, stroke: "none" }));
  svg.appendChild(svgEl("path", { d: linePath, fill: "none", stroke: color, "stroke-width": "2", "stroke-linejoin": "round", "stroke-linecap": "round" }));

  // 端点圆点
  for (const [x, y] of points) {
    svg.appendChild(svgEl("circle", { cx: x, cy: y, r: "3", fill: color }));
  }

  // X 轴标签（采样，最多 12 个）
  const labelStep = Math.ceil(data.length / 12);
  for (let i = 0; i < data.length; i += labelStep) {
    const x = pad.left + (data.length > 1 ? i * stepX : cw / 2);
    const label = svgEl("text", { x, y: H - 8, "text-anchor": "middle", "font-size": "10", fill: "#94a3b8" });
    label.textContent = data[i].label;
    svg.appendChild(label);
  }

  return svg;
}

/** 柱状图（bar）：data=[{label, value, color?}]；含负值时 0 基线居中、负柱向下（红色） */
export function barChart(data, { height = 160 } = {}) {
  if (!data || data.length === 0) {
    return el("div", { class: "chart-bar chart-bar--empty", text: "暂无数据" });
  }
  const hasNeg = data.some((d) => d.value < 0);
  const maxV = Math.max(...data.map((d) => d.value), 0) || 1;
  const maxNeg = Math.max(...data.map((d) => -d.value), 0) || 1;
  const bars = data.map((d) => {
    let fill;
    if (!hasNeg) {
      fill = el("div", {
        class: "chart-bar__fill",
        style: `height:${(d.value / maxV) * 100}%;background:${d.color || "#16a34a"}`,
        title: `${d.label}: ¥${fmtMoney(d.value)}`,
      });
    } else {
      // 中基线模式：正值向上（绿）、负值向下（红）
      const neg = d.value < 0;
      fill = el("div", {
        class: `chart-bar__fill ${neg ? "chart-bar__fill--neg" : "chart-bar__fill--pos"}`,
        style: neg
          ? `height:${(Math.abs(d.value) / maxNeg) * 50}%;background:${d.color || "#ef4444"}`
          : `height:${(d.value / maxV) * 50}%;background:${d.color || "#22c55e"}`,
        title: `${d.label}: ¥${fmtMoney(d.value)}`,
      });
    }
    return el("div", { class: "chart-bar__item" }, [
      el("div", { class: `chart-bar__track${hasNeg ? " chart-bar__track--split" : ""}` }, [fill]),
      el("div", { class: "chart-bar__label", text: d.label }),
    ]);
  });
  return el("div", { class: "chart-bar", style: `height:${height}px` }, bars);
}

// ============================================================
// 格式化工具
// ============================================================

function fmtMoney(cents) {
  return (cents / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtCompact(cents) {
  const yuan = cents / 100;
  if (Math.abs(yuan) >= 10000) return `¥${(yuan / 10000).toFixed(1)}万`;
  return `¥${yuan.toFixed(0)}`;
}
