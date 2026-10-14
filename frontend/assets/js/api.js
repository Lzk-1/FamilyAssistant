/** 统一 API 客户端：解包后端统一响应包 {code, message, data}，code !== 0 时抛错。 */

const BASE = "/api/v1";

async function request(path, options = {}) {
  const res = await fetch(BASE + path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    /* 非 JSON 响应（如服务未启动） */
  }
  if (!res.ok || !payload || payload.code !== 0) {
    throw new Error((payload && payload.message) || `请求失败（HTTP ${res.status}）`);
  }
  return payload.data;
}

export const apiGet = (path) => request(path);

export const apiPost = (path, body) =>
  request(path, { method: "POST", body: body ? JSON.stringify(body) : undefined });
