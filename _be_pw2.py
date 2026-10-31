# -*- coding: utf-8 -*-
"""① session API：POST /api/session 支持密码（注册/认领/登录）、新增 /api/session/login、PATCH /api/me 支持改密码
   ② 去掉 contact_code 对外的输出（改成 chat_ready + thread_id：双方同意 → 直接开私聊）"""
import os
import re

BASE = r"C:\Users\17768\.dsh\bot\workspace\bm\ui2"

def patch(rel, rules, label):
    p = os.path.join(BASE, rel)
    t = open(p, encoding="utf-8").read()
    for pat, rep, why in rules:
        t2, n = re.subn(pat, rep, t, count=1)
        if n == 0:
            print(f"  ✗ {label}: 未命中 → {why}")
            continue
        t = t2
        print(f"  ✓ {label}: {why}")
    open(p, "w", encoding="utf-8").write(t)

# ---------- ① api/session.js ----------
patch(r"src\api\session.js", [
    (r'import \{ createSession, meView, renameSessionUser, sessionFromToken \} from "\.\./services/session\.js";',
     'import { createSession, loginWithPassword, meView, registerOrLogin, renameSessionUser, sessionFromToken, setPassword } from "../services/session.js";',
     "导入新函数"),
    (r'(router\.post\("/session", \(req, res, next\) => \{\s*\n\s*try \{\s*\n\s*const body = req\.body \?\? \{\};\s*\n)(\s*const existing = sessionFromToken\(body\.token\);)',
     r'\1      // 带密码 = 注册/认领/登录（四合一）；不带 = 原来的匿名开户\1\2',
     "注释"),
    (r'      res\.json\(ok\(createSession\(\{ nickname: body\.nickname \}\)\)\);',
     '      if (body.password) return res.json(ok(registerOrLogin({ nickname: body.nickname, password: body.password })));\n      res.json(ok(createSession({ nickname: body.nickname })));',
     "支持密码"),
    (r'(  router\.get\("/me", requireSession,)',
     '''  // 显式登录（换设备找回自己的单与聊天）
  router.post("/session/login", (req, res, next) => {
    try {
      const b = req.body ?? {};
      res.json(ok(loginWithPassword({ nickname: b.nickname, password: b.password })));
    } catch (e) {
      next(e);
    }
  });

\1''', "新增 /session/login"),
    (r'(  router\.patch\("/me", requireSession, \(req, res, next\) => \{\s*\n\s*try \{\s*\n\s*res\.json\(ok\(renameSessionUser\(req\.session\.uid, \(req\.body \?\? \{\}\)\.nickname\)\)\);)',
     '''  // 改密码：已设过密码的要给旧密码；匿名用户可直接设
  router.patch("/me/password", requireSession, (req, res, next) => {
    try {
      const b = req.body ?? {};
      res.json(ok(setPassword(req.session.uid, { password: b.password, old_password: b.old_password })));
    } catch (e) {
      next(e);
    }
  });

\1''', "新增 /me/password"),
], "api/session.js")

# ---------- ② buddy.js：contact_code → thread_id ----------
patch(r"src\services\buddy.js", [
    (r'return toResponse\(next, next\.revealed === 1 \? ensureContactCode\(author\) : null\);',
     'return toResponseWithChat(next, author);',
     "寻找方表决返回改走 chat"),
    (r'return toResponse\(next, next\.revealed === 1 \? ensureContactCode\(author\) : null\);\s*\n\}',
     'return toResponseWithChat(next, author);\n}',
     "发布方表决返回改走 chat"),
], "buddy.js（contact_code → chat）")

print("\n接下来手工检查 toResponse 的调用点")
