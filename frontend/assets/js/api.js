/** 统一 API 客户端：解包后端统一响应包 {code, message, data}，code !== 0 时抛错。
 * apiUpload 走 XMLHttpRequest：支持上传进度回调（dev-plan §6.2）。
 */

const BASE = "/api/v1";

async function request(path, options = {}) {
  const init = { ...options };
  if (init.body && !init.headers) init.headers = { "Content-Type": "application/json" };
  const res = await fetch(BASE + path, init);
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    /* 非 JSON 响应（如服务未启动） */
  }
  if (!res.ok || !payload || payload.code !== 0) {
    const err = new Error((payload && payload.message) || `请求失败（HTTP ${res.status}）`);
    err.status = res.status;
    err.data = payload && payload.data;
    if (err.data && Array.isArray(err.data.errors)) err.errors = err.data.errors;
    throw err;
  }
  return payload.data;
}

export const apiGet = (path) => request(path);

export const apiPost = (path, body) =>
  request(path, { method: "POST", body: body ? JSON.stringify(body) : undefined });

export const apiPut = (path, body) =>
  request(path, { method: "PUT", body: body ? JSON.stringify(body) : undefined });

export const apiDelete = (path) => request(path, { method: "DELETE" });

/** multipart 文件上传；onProgress 收 0~100 进度百分比，失败时 err.errors 为字段级错误清单。
 * fields：附加表单字段（如导入备份的 mode）。
 */
export function apiUpload(path, file, { onProgress, field = "upload", fields = {} } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", BASE + path);
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    });
    xhr.addEventListener("load", () => {
      let payload = null;
      try {
        payload = JSON.parse(xhr.responseText);
      } catch {
        /* 非 JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300 && payload && payload.code === 0) {
        resolve(payload.data);
      } else {
        const err = new Error((payload && payload.message) || `上传失败（HTTP ${xhr.status}）`);
        err.data = payload && payload.data;
        if (err.data && Array.isArray(err.data.errors)) err.errors = err.data.errors;
        reject(err);
      }
    });
    xhr.addEventListener("error", () => reject(new Error("网络错误，上传失败")));
    const form = new FormData();
    form.append(field, file);
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    xhr.send(form);
  });
}
