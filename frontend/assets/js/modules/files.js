/** 文件存档模块页面：框架阶段展示模块占位；完整功能（上传/分类/预览/统计）于 M1 迭代交付。 */

import { apiGet } from "../api.js";
import { pageHeader, placeholderCard, card, table } from "../ui.js";

const FEATURES = "拖拽上传 · 分类归档 · 下载预览 · 容量统计";

function formatSize(bytes) {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export async function render(root, mod) {
  root.appendChild(pageHeader(mod));
  const records = await apiGet("/files/records");
  root.appendChild(
    records.length
      ? card("归档文件", table(records, [
          { label: "文件名", key: "original_name" },
          { label: "大小", key: "size", render: formatSize },
          { label: "类型", key: "mime_type" },
          { label: "分类", key: "category" },
          { label: "归档时间", key: "created_at" },
        ]))
      : placeholderCard(mod, FEATURES)
  );
}
