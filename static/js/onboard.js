/* =============================================================================
   北民大小助手 · 首次进入的注册 / 登录引导（2026-10-31）

   站长要求：**第一次打开站点必须设置用户名和密码**；用户名全站唯一；
   设置好之后，用同一个用户名+密码就能直接登录（换设备/清缓存也能找回自己的单与聊天）。

   与 session.js 的分工：
     · 本文件负责**引导界面**（注册 / 登录两种模式）
     · session.js 负责**存 token / 取昵称 / 改名**这些日常操作
     两者共用同一套 localStorage 键，所以注册完 session.js 立刻就能用。

   合规：只存用户名 + 密码的哈希（服务端 scrypt 加盐）；⛔ 不收集姓名/学号/手机号。
   ============================================================================= */

const TOKEN_KEY = "bm.session.token";
const NICK_KEY = "bm.session.nickname";
const UID_KEY = "bm.session.uid";

let pending = null;          // 同一时刻只弹一次

const readKey = (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
const writeSession = (d) => {
  try {
    localStorage.setItem(TOKEN_KEY, d.token || "");
    localStorage.setItem(NICK_KEY, d.nickname || d.handle || "");
    localStorage.setItem(UID_KEY, d.uid || "");
  } catch { /* 隐私模式：本次会话内仍可用 */ }
};

/** 有没有会话（不代表服务端还认） */
export function hasIdentity() {
  return Boolean(readKey(TOKEN_KEY));
}

export function clearIdentity() {
  try {
    [TOKEN_KEY, NICK_KEY, UID_KEY].forEach((k) => localStorage.removeItem(k));
  } catch { /* 忽略 */ }
}

/** 校验本地 token 在服务端还有效；无效则清掉 */
async function verifyToken() {
  const token = readKey(TOKEN_KEY);
  if (!token) return null;
  try {
    const res = await fetch("/api/me", { headers: { "X-Session-Token": token } });
    const env = await res.json();
    if (env?.ok) return env.data;
  } catch { /* 网络问题：先当有效，页面自己会降级 */ }
  clearIdentity();
  return null;
}

/**
 * 确保"我是谁"：没身份就弹引导，直到注册/登录成功才 resolve。
 * 页面里 `await ensureIdentity()` 之后，`api()` 就会自动带上身份。
 */
export async function ensureIdentity() {
  if (hasIdentity()) {
    const me = await verifyToken();
    if (me) return me;
  }
  if (pending) return pending;
  pending = new Promise((resolve) => openAuth(resolve));
  const me = await pending;
  pending = null;
  return me;
}

/* ------------------------------------------------------------------ 界面 */

function injectStyle() {
  if (document.getElementById("bm-auth-style")) return;
  const st = document.createElement("style");
  st.id = "bm-auth-style";
  st.textContent = `
  .bm-auth { position: fixed; inset: 0; z-index: 3000; display: flex; align-items: center; justify-content: center;
    padding: 24px; background: rgba(16,24,40,.46); backdrop-filter: blur(4px); }
  .bm-auth__card { width: min(440px, 100%); background: #fff; border-radius: 16px; padding: 24px;
    box-shadow: 0 30px 60px -24px rgba(16,24,40,.5); }
  .bm-auth__title { margin: 0 0 6px; font-size: 20px; font-weight: 650; color: var(--color-text, #1f2a37); }
  .bm-auth__sub { margin: 0 0 18px; font-size: 13px; line-height: 1.7; color: var(--color-muted, #6b7280); }
  .bm-auth__field { display: block; margin-bottom: 12px; }
  .bm-auth__field span { display: block; margin-bottom: 4px; font-size: 12px; color: var(--color-muted, #6b7280); }
  .bm-auth__field input { width: 100%; box-sizing: border-box; padding: 10px 12px; font-size: 14px;
    border: 1px solid var(--color-line, #e5e7eb); border-radius: 10px; font-family: inherit; }
  .bm-auth__field input:focus { outline: 2px solid var(--color-primary, #1f4e8c); outline-offset: 1px; }
  .bm-auth__err { min-height: 20px; margin: 2px 0 10px; font-size: 12.5px; color: #b42318; }
  .bm-auth__row { display: flex; align-items: center; gap: 10px; }
  .bm-auth__btn { appearance: none; border: 0; cursor: pointer; font-family: inherit; font-size: 14px; font-weight: 600;
    padding: 10px 16px; border-radius: 10px; background: var(--color-primary, #1f4e8c); color: #fff; flex: 1; }
  .bm-auth__btn[disabled] { opacity: .6; cursor: default; }
  .bm-auth__link { appearance: none; border: 0; background: none; cursor: pointer; font-family: inherit;
    font-size: 13px; color: var(--color-primary, #1f4e8c); text-decoration: underline; padding: 4px 0; }
  .bm-auth__note { margin: 14px 0 0; font-size: 12px; line-height: 1.7; color: var(--color-muted, #6b7280); }`;
  document.head.appendChild(st);
}

function openAuth(resolve) {
  injectStyle();

  let mode = "register";                       // register | login
  const wrap = document.createElement("div");
  wrap.className = "bm-auth";
  wrap.setAttribute("role", "dialog");
  wrap.setAttribute("aria-modal", "true");

  const card = document.createElement("form");
  card.className = "bm-auth__card";
  card.noValidate = true;
  wrap.appendChild(card);

  const render = () => {
    const isReg = mode === "register";
    card.innerHTML = "";
    const h = document.createElement("h2");
    h.className = "bm-auth__title";
    h.textContent = isReg ? "先给自己起个名字" : "登录你的账号";
    const sub = document.createElement("p");
    sub.className = "bm-auth__sub";
    sub.textContent = isReg
      ? "第一次来要设置用户名和密码：用户名全站唯一，之后用同一个用户名和密码就能登录，换设备也能找回你发布的单和聊天。"
      : "用你注册时的用户名和密码登录。";
    card.append(h, sub);

    const mk = (label, type, placeholder, autocomplete) => {
      const lab = document.createElement("label");
      lab.className = "bm-auth__field";
      const s = document.createElement("span");
      s.textContent = label;
      const i = document.createElement("input");
      i.type = type;
      i.placeholder = placeholder;
      i.autocomplete = autocomplete;
      lab.append(s, i);
      card.appendChild(lab);
      return i;
    };

    const nick = mk("用户名（2~12 个字，全站唯一）", "text", "例如：小明", isReg ? "username" : "username");
    const pw = mk("密码（6~64 位）", "password", "至少 6 位", isReg ? "new-password" : "current-password");
    let pw2 = null;
    if (isReg) pw2 = mk("再输一遍密码", "password", "两次要一样", "new-password");

    const err = document.createElement("div");
    err.className = "bm-auth__err";
    const row = document.createElement("div");
    row.className = "bm-auth__row";
    const ok = document.createElement("button");
    ok.type = "submit";
    ok.className = "bm-auth__btn";
    ok.textContent = isReg ? "创建并进入" : "登录";
    row.appendChild(ok);
    card.append(err, row);

    const swap = document.createElement("button");
    swap.type = "button";
    swap.className = "bm-auth__link";
    swap.textContent = isReg ? "我已经有账号，去登录" : "还没有账号？去注册";
    swap.addEventListener("click", () => { mode = isReg ? "login" : "register"; render(); });
    card.appendChild(swap);

    const note = document.createElement("p");
    note.className = "bm-auth__note";
    note.textContent = "我们只保存用户名和你设置的密码（加盐哈希，不可逆）；"
      + "不收集姓名、学号、手机号，也不接入学校任何内部系统。";
    card.appendChild(note);

    nick.focus();

    const fail = (msg) => { err.textContent = msg || ""; };

    card.onsubmit = async (ev) => {
      ev.preventDefault();
      fail("");
      const name = nick.value.trim();
      if (name.length < 2) return fail("用户名至少 2 个字");
      if (pw.value.length < 6) return fail("密码至少 6 位");
      if (isReg && pw.value !== pw2.value) return fail("两次输入的密码不一样");
      ok.disabled = true;
      ok.textContent = isReg ? "创建中…" : "登录中…";
      try {
        const res = await fetch(isReg ? "/api/session" : "/api/session/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ nickname: name, password: pw.value }),
        });
        const env = await res.json();
        if (!env?.ok) throw new Error(env?.error?.message || "失败了，再试一次");
        writeSession(env.data);
        wrap.remove();
        resolve(env.data);
      } catch (e) {
        ok.disabled = false;
        ok.textContent = isReg ? "创建并进入" : "登录";
        fail(e.message || "网络不太好，再试一次");
      }
    };
  };

  render();
  document.body.appendChild(wrap);
}

export default { ensureIdentity, hasIdentity, clearIdentity };
