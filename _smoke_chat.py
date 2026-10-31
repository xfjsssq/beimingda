# -*- coding: utf-8 -*-
"""私聊链路冒烟：搭子双方同意 → 出现会话 → 发消息 → 对方读到"""
import json, subprocess, time

BASE = "http://127.0.0.1:3080"
tok = open(r"C:\Users\17768\.dsh\bot\workspace\bm\ui2\.env", encoding="utf-8").read()
tok = [l.split("=", 1)[1].strip() for l in tok.splitlines() if l.startswith("DEMO_TOKEN=")][0]

def call(m, p, body=None, s=None, demo=False):
    c = ["curl.exe", "-s", "-m", "15", "-X", m, BASE + p, "-H", "content-type: application/json"]
    if demo: c += ["-H", f"X-Demo-Token: {tok}"]
    if s: c += ["-H", f"X-Session-Token: {s}"]
    if body is not None: c += ["-d", json.dumps(body, ensure_ascii=False)]
    out = subprocess.run(c, capture_output=True, text=True, encoding="utf-8").stdout
    try: return json.loads(out)
    except Exception: return {"raw": out[:200]}

A = call("POST", "/api/session", {"nickname": "聊天甲"})["data"]
B = call("POST", "/api/session", {"nickname": "聊天乙"})["data"]

post = call("POST", "/api/buddies", {"kind": "study", "text_profile": "想找人一起自习，图书馆三楼"}, s=A["token"], demo=True)
pid = post["data"]["post_id"]
print("① 甲发帖:", pid)

# 甲（帖主）同意乙 —— 走 consent 的"发布方同意"分支需要先有乙的意愿：先乙表达意愿
c1 = call("POST", f"/api/buddies/{pid}/consent", {"agree": True, "message": "我想一起"}, s=B["token"], demo=True)
print("② 乙表达意愿:", c1["ok"], json.dumps(c1.get("data") or c1.get("error"), ensure_ascii=False)[:120])
c2 = call("POST", f"/api/buddies/{pid}/consent", {"agree": True, "to_seeker": "聊天乙"}, s=A["token"], demo=True)
print("③ 甲同意乙:", c2["ok"], json.dumps(c2.get("data") or c2.get("error"), ensure_ascii=False)[:160])

th = call("GET", "/api/threads", s=A["token"])
print("④ 甲的会话列表:", json.dumps(th.get("data") or th.get("error"), ensure_ascii=False)[:260])
if th.get("data"):
    tid = th["data"][0]["thread_id"]
    m = call("POST", f"/api/threads/{tid}/messages", {"body": "太好了，那晚上七点图书馆门口见"}, s=A["token"])
    print("⑤ 甲发消息:", m["ok"], json.dumps(m.get("data") or m.get("error"), ensure_ascii=False)[:120])
    got = call("GET", f"/api/threads/{tid}/messages", s=B["token"])
    print("⑥ 乙读消息:", json.dumps(got.get("data") or got.get("error"), ensure_ascii=False)[:220])
    # 无关的人不能看
    C = call("POST", "/api/session", {"nickname": "路人丙"})["data"]
    bad = call("GET", f"/api/threads/{tid}/messages", s=C["token"])
    print("⑦ 路人丙试图偷看:", bad["ok"], (bad.get("error") or {}).get("message"))
