/** 全局会话状态：app.js 在登录/登出/过期时写入，各业务页面只读。
 *  避免页面层反向 import app.js 造成循环依赖。
 */

export const session = {
  /** 当前登录用户（/auth/me 形状）或 null（未登录）。 */
  user: null,
};

/** 是否管理员（单机旁路模式下无 user，视为完全权限）。 */
export function isAdmin() {
  if (!session.user) return true; // 单机免登录模式：DEFAULT_USER 旁路
  return session.user.role === "admin";
}
