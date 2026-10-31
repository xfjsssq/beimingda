/* =============================================================================
   北民大小助手 · 会话（匿名身份）  static/js/session.js
   2026-10-31

   为什么有这一层：
     之前站点是"一个人对着演示数据玩"——发的东西没人认领。现在每个浏览器一份**匿名身份**：
       · 首访自动开户（POST /api/session，无需任何令牌），拿到 token 与服务端签发的昵称
       · 之后所有读写都带 X-Session-Token，服务端就知道"这是谁发的"
       · 换昵称（PATCH /api/me），别人看到的就是新昵称

   合规（⛔ 不许破）：
     · 只存 token 与昵称；不要求也不收集姓名/学号/手机号
     · 昵称校验在服务端（拒绝纯数字、11 位以上连续数字）——避免看起来像学号/手机号

   用法：
     import { ensureSession, sessionToken, currentNickname, renameSession, mountIdentityChip } from "/js/session.js";
     await ensureSession();                       // 必须在第一次 api() 之前
     mountIdentityChip("#whoAmI");                // 显示「我是 XX · 改名」
   ============================================================================= */

const TOKEN_KEY = "bm.session.token";
const NICK_KEY = "bm.session.nickname";
const UID_KEY = "bm.session.uid";

let cache = null;      // { token, uid, nickname }

/** 同步取 token（api.js 每次请求都要用，不能 await） */
export function sessionToken() {
  if (cache?.token) return cache.token;
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}

/** 同步取昵称（页面渲染用；ensureSession 之后才准） */
export function currentNickname() {
  if (cache?.nickname) return cache.nickname;
  try { return localStorage.getItem(NICK_KEY) || ""; } catch { return ""; }
}

export function currentUid() {
  if (cache?.uid) return cache.uid;
  try { return localStorage.getItem(UID_KEY) || ""; } catch { return ""; }
}

function save(s) {
  cache = s;
  try {
    localStorage.setItem(TOKEN_KEY, s.token || "");
    localStorage.setItem(NICK_KEY, s.nickname || "");
    localStorage.setItem(UID_KEY, s.uid || "");
  } catch { /* 隐私模式：本次会话内仍可用 */ }
}

/**
 * 开户 / 恢复会话。幂等：随便调多少次都返回同一身份。
 * 失败也不抛（返回 null），页面照常可用——只是"归属"会退回演示口径。
 */
export async function ensureSession({ force = false } = {}) {
  if (cache && !force) return cache;
  const token = sessionToken();
  // ⭐ 已经有 token（刚注册/登录过，或老会话）→ 先用它校验一下，别又开一个匿名身份
  if (token && !force) {
    try {
      const res = await fetch("/api/me", { headers: { "X-Session-Token": token } });
      const env = await res.json();
      if (env?.ok) {
        save({ token, uid: env.data.uid, nickname: env.data.nickname });
        return cache;
      }
    } catch { /* 网络问题就往下走开户兜底 */ }
  }
  try {
    const res = await fetch("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(token ? { token } : {}),
    });
    const env = await res.json();
    if (!env?.ok) return null;
    save(env.data);
    return cache;
  } catch {
    return null;                 // 断网/接口没起：不阻塞页面
  }
}

/** 我的资料（含站内活动量） */
export async function fetchMe() {
  const token = sessionToken();
  if (!token) return null;
  try {
    const res = await fetch("/api/me", { headers: { "X-Session-Token": token } });
    const env = await res.json();
    return env?.ok ? env.data : null;
  } catch {
    return null;
  }
}

/** 改昵称：成功返回新昵称，失败抛错（页面把 message 显示出来即可） */
export async function renameSession(nickname) {
  const token = sessionToken();
  if (!token) {
    const s = await ensureSession();
    if (!s) throw new Error("还没有会话，刷新一下再试");
  }
  const res = await fetch("/api/me", {
    method: "PATCH",
    headers: { "content-type": "application/json", "X-Session-Token": sessionToken() },
    body: JSON.stringify({ nickname }),
  });
  const env = await res.json();
  if (!env?.ok) throw new Error(env?.error?.message || "改名失败");
  save({ token: sessionToken(), uid: env.data.uid, nickname: env.data.nickname });
  return env.data.nickname;
}

/**
 * 身份小条：「我是 XX · 改名」
 * @param {Element|string} target 容器（元素或选择器）
 */
export function mountIdentityChip(target) {
  const box = typeof target === "string" ? document.querySelector(target) : target;
  if (!box) return null;
  const render = () => {
    const nick = currentNickname() || "（连接中…）";
    box.innerHTML = "";
    const span = document.createElement("span");
    span.className = "whoami__nick";
    span.textContent = "我是 " + nick;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "whoami__edit";
    btn.textContent = "改名";
    btn.addEventListener("click", async () => {
      const next = window.prompt("改成什么昵称？（2~12 个字，中文/字母/数字/下划线；不会收集你的姓名学号）", currentNickname());
      if (!next) return;
      try {
        const ok = await renameSession(next.trim());
        render();
        box.dispatchEvent(new CustomEvent("whoami:changed", { detail: { nickname: ok } }));
      } catch (e) {
        window.alert(e.message || "改名失败");
      }
    });
    box.append(span, btn);
  };
  render();
  return { render };
}

export default { ensureSession, sessionToken, currentNickname, currentUid, fetchMe, renameSession, mountIdentityChip };
