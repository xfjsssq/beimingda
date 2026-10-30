#!/usr/bin/env python3
"""
把手机「全景」模式实拍的两段 180° 素材拼成一张 360° 等距柱状全景（equirectangular），
产出可直接喂给 Pannellum 的文件。

用法：
    python tools/stitch-pano.py                # 处理内置的 3 组素材，写到 pano/
    python tools/stitch-pano.py --src <目录> --out <目录>

算法（每一步都能单独调）：
    1) 统一高度 → 灰度下采样，做**归一化互相关（NCC）**搜索横向偏移，判断两段是否接续
    2) 亮度/对比对齐（把 B 的均值-标准差拉齐到 A），避免接缝出现一条亮暗界
    3) 按重叠量做**余弦羽化**拼接；NCC 太低（说明两段不接续）就退化成并排 + 窄羽化
    4) 上下补天补地到 2:1：把长条居中放在 2:1 画布，上方用顶行拉伸并提亮、下方用底行拉伸并压暗
       —— 这样 Pannellum 按 360×180 映射时，画面是"一条可环视的街景带 + 假的天空/地面"，
          而不是把 45° 高的一条带子硬拉满整个球面
⛔ 不依赖除 Pillow/numpy 之外的任何库；⛔ 不联网。
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys

try:
    import numpy as np
    from PIL import Image, ImageFilter
except Exception as e:  # pragma: no cover
    print(f"需要 Pillow 与 numpy：{e}", file=sys.stderr)
    sys.exit(1)

Image.MAX_IMAGE_PIXELS = None

# ---- 可调参数 ----
TARGET_H = 1280          # 统一后的单段高度
SEARCH_W = 900           # 用于偏移搜索的灰度宽度（越小越快）
TAIL_FRAC = 0.22         # 取 A 尾部多少比例作为"接缝探针"
MAX_SHIFT_FRAC = 0.45    # B 允许被"吃掉"的最大比例（即最大重叠）
NCC_OK = 0.35            # NCC 高于此值才认为两段接续
FEATHER_FRAC = 0.55      # 羽化带占重叠宽度的比例
OUT_MAX_W = 6000         # 输出宽度上限（体积与显存友好）
JPEG_Q = 82


def load(path: str) -> Image.Image:
    return Image.open(path).convert("RGB")


def resize_h(im: Image.Image, h: int) -> Image.Image:
    w = max(1, round(im.width * h / im.height))
    return im.resize((w, h), Image.LANCZOS)


def match_brightness(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """把 b 的亮度和对比度对齐到 a（逐通道 mean/std 线性映射）"""
    out = b.astype(np.float32)
    for c in range(3):
        ma, sa = float(a[..., c].mean()), float(a[..., c].std()) or 1.0
        mb, sb = float(b[..., c].mean()), float(b[..., c].std()) or 1.0
        out[..., c] = (out[..., c] - mb) * (sa / sb) + ma
    return np.clip(out, 0, 255).astype(np.uint8)


def ncc(x: np.ndarray, y: np.ndarray) -> float:
    """归一化互相关：对均值差异与整体亮度差异都鲁棒"""
    x = x.astype(np.float32).ravel()
    y = y.astype(np.float32).ravel()
    x = x - x.mean()
    y = y - y.mean()
    denom = math.sqrt(float((x * x).sum()) * float((y * y).sum()))
    return float((x * y).sum() / denom) if denom else 0.0


def find_seam(a: Image.Image, b: Image.Image) -> dict:
    """在 B 上滑动 A 的尾部窗口，找 NCC 最高的水平偏移（像素，基于灰度搜索宽度）"""
    ga = np.asarray(a.convert("L").resize((SEARCH_W, SEARCH_W * a.height // a.width), Image.LANCZOS))
    gb = np.asarray(b.convert("L").resize((SEARCH_W, SEARCH_W * b.height // b.width), Image.LANCZOS))
    h = min(ga.shape[0], gb.shape[0])
    ga, gb = ga[:h], gb[:h]
    win = max(40, int(SEARCH_W * TAIL_FRAC))
    tail = ga[:, SEARCH_W - win:]

    best = {"shift": 0, "ncc": -2.0}
    for cut in range(win, int(gb.shape[1] * MAX_SHIFT_FRAC)):
        seg = gb[:, cut - win:cut]
        v = ncc(tail, seg)
        if v > best["ncc"]:
            best = {"shift": cut, "ncc": v}
    return best


def stitch_pair(pa: str, pb: str, target_h: int = TARGET_H) -> tuple[Image.Image, dict]:
    A = resize_h(load(pa), target_h)
    B = resize_h(load(pb), target_h)
    B = Image.fromarray(match_brightness(np.asarray(A), np.asarray(B)))

    s = find_seam(A, B)
    # 把"搜索尺度"的偏移换算回原尺度
    scale = A.width / SEARCH_W
    cut = int(round(s["shift"] * scale))
    connected = s["ncc"] >= NCC_OK

    if connected:
        # cut 是"B 从哪一列开始接到 A 后面" → 重叠的部分 = A 尾部 cut 列
        overlap = min(cut, A.width, B.width)
        blend_w = max(8, int(overlap * FEATHER_FRAC))
        left = A.crop((0, 0, A.width - blend_w, A.height))
        right = B.crop((max(0, B.width - (A.width - blend_w) - 0), 0, B.width, B.height)) if False else B
        # 画布：A 全长 + B 去掉重叠部分
        W = max(1, A.width + B.width - overlap)
        canvas = Image.new("RGB", (W, target_h))
        canvas.paste(A, (0, 0))
        canvas.paste(B, (A.width - overlap, 0))

        # 在接缝处做余弦羽化
        x0 = A.width - overlap
        band_a = np.asarray(A.crop((A.width - overlap, 0, A.width, target_h))).astype(np.float32)
        band_b = np.asarray(B.crop((0, 0, overlap, target_h))).astype(np.float32)
        ramp = np.linspace(0, 1, overlap, dtype=np.float32)[None, :, None]
        ramp = (1 - np.cos(ramp * math.pi)) / 2          # 余弦：两端平滑
        band = band_a * (1 - ramp) + band_b * ramp
        canvas.paste(Image.fromarray(np.clip(band, 0, 255).astype(np.uint8)), (x0, 0))
        info = {"connected": True, "ncc": round(s["ncc"], 3), "overlap_px": overlap,
                "overlap_pct": round(overlap / A.width * 100, 1), "seam_x": x0}
    else:
        feather = 60
        W = A.width + B.width - feather
        canvas = Image.new("RGB", (W, target_h))
        canvas.paste(A, (0, 0))
        canvas.paste(B, (A.width - feather, 0))
        band_a = np.asarray(A.crop((A.width - feather, 0, A.width, target_h))).astype(np.float32)
        band_b = np.asarray(B.crop((0, 0, feather, target_h))).astype(np.float32)
        ramp = np.linspace(0, 1, feather, dtype=np.float32)[None, :, None]
        ramp = (1 - np.cos(ramp * math.pi)) / 2
        band = band_a * (1 - ramp) + band_b * ramp
        canvas.paste(Image.fromarray(np.clip(band, 0, 255).astype(np.uint8)), (A.width - feather, 0))
        info = {"connected": False, "ncc": round(s["ncc"], 3), "overlap_px": feather,
                "overlap_pct": round(feather / A.width * 100, 1), "seam_x": A.width - feather}
    return canvas, info


def pad_to_equirect(strip: Image.Image, out_max_w: int = OUT_MAX_W) -> Image.Image:
    """把宽长条居中放进 2:1 画布，上下补成"天空 / 地面"。

    ⚠️ 第一版用"单行拉伸"，出来是满屏拉丝（已弃用）。现在改成：
       取顶部/底部若干行**镜像翻转**后拉伸铺满，再做强高斯模糊 + 明暗渐变 ——
       看起来像"树冠继续往上延伸 / 地面继续往下延伸"的雾化延伸，而不是条纹。
    """
    if strip.width > out_max_w:
        strip = strip.resize((out_max_w, round(strip.height * out_max_w / strip.width)), Image.LANCZOS)
    W = strip.width
    H = max(strip.height, W // 2)
    canvas = Image.new("RGB", (W, H))
    top = int((H - strip.height) * 0.48)          # 地平线略高于中线，露出更多"地面"
    band = max(6, strip.height // 12)             # 取多少行做镜像延伸
    radius = max(8.0, W / 160.0)                  # 模糊半径随宽度缩放

    if top > 0:
        src = strip.crop((0, 0, W, band)).transpose(Image.FLIP_TOP_BOTTOM)
        sky = src.resize((W, top), Image.BICUBIC).filter(ImageFilter.GaussianBlur(radius))
        arr = np.asarray(sky).astype(np.float32)
        grad = np.linspace(1.20, 1.00, top, dtype=np.float32)[:, None, None]
        canvas.paste(Image.fromarray(np.clip(arr * grad, 0, 255).astype(np.uint8)), (0, 0))

    canvas.paste(strip, (0, top))

    bottom = H - top - strip.height
    if bottom > 0:
        src = strip.crop((0, strip.height - band, W, strip.height)).transpose(Image.FLIP_TOP_BOTTOM)
        gnd = src.resize((W, bottom), Image.BICUBIC).filter(ImageFilter.GaussianBlur(radius))
        arr = np.asarray(gnd).astype(np.float32)
        grad = np.linspace(1.00, 0.68, bottom, dtype=np.float32)[:, None, None]
        canvas.paste(Image.fromarray(np.clip(arr * grad, 0, 255).astype(np.uint8)), (0, top + strip.height))

    # 只在拼接边缘再轻糊一道，消除"上下两条硬边"
    canvas = canvas.filter(ImageFilter.GaussianBlur(0.5))
    return canvas


def build_manifest(entries: list[dict]) -> dict:
    scenes = {}
    for i, e in enumerate(entries):
        sid = e["id"]
        nxt = entries[(i + 1) % len(entries)]["id"]
        prv = entries[(i - 1) % len(entries)]["id"]
        scenes[sid] = {
            "panorama": f"/pano/{e['file']}",
            "title": e["title"],
            "type": "equirectangular",
            "hfov": 100,
            "yaw": 0,
            "pitch": 0,
            "hotSpots": [
                {"pitch": -3, "yaw": 30,  "type": "scene", "text": "去下一个点位", "sceneId": nxt},
                {"pitch": -3, "yaw": -150, "type": "scene", "text": "回上一个点位", "sceneId": prv},
            ],
        }
    return {
        "_comment": "Pannellum multi-scene tour（结构冻版，见 contracts/m3-welcome.md §3）。"
                    "⭐ 图片由手机实拍的两段 180° 素材拼接而成（tools/stitch-pano.py）。",
        "_note_attach": "把某个场景挂到校园点位上：在 config/map-nodes.json 里给该节点写 "
                        "pano_url=\"/pano/pano-N.jpg\"、pano_yaw=<朝向>，页面就会在详情里给出「进入 3D 街景」。",
        "default": {"firstScene": entries[0]["id"], "sceneFadeDuration": 800, "autoLoad": True, "showControls": True},
        "scenes": scenes,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=r"C:\Users\17768\Desktop\银移杯素材\3D素材参考")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "pano"))
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    points = []
    # 目录名是"第一/第二/第三点位"这类中文序号 —— 按语义排序，别按字符串
    CN_NUM = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}

    def natural(name: str) -> tuple:
        for ch in name:
            if ch in CN_NUM:
                return (0, CN_NUM[ch], name)
        digits = "".join(c for c in name if c.isdigit())
        return (1, int(digits) if digits else 999, name)

    for name in sorted(os.listdir(args.src), key=natural):
        d = os.path.join(args.src, name)
        if not os.path.isdir(d):
            continue
        files = sorted(f for f in os.listdir(d) if f.lower().endswith((".jpg", ".jpeg", ".png")))
        if len(files) < 2:
            print(f"[skip] {name}: 只有 {len(files)} 张")
            continue
        points.append((name, os.path.join(d, files[0]), os.path.join(d, files[1])))

    entries, report = [], []
    for i, (name, a, b) in enumerate(points, start=1):
        print(f"\n=== {name} ===")
        strip, info = stitch_pair(a, b)
        eq = pad_to_equirect(strip)
        out_name = f"pano-{i}.jpg"
        out_path = os.path.join(args.out, out_name)
        eq.save(out_path, "JPEG", quality=JPEG_Q, optimize=True, progressive=True)
        size_mb = os.path.getsize(out_path) / 1024 / 1024
        entries.append({"id": f"pano-{i}", "file": out_name, "title": name})
        row = {"point": name, "file": out_name, "eq_size": f"{eq.width}x{eq.height}",
               "ratio": round(eq.width / eq.height, 2), "mb": round(size_mb, 2), **info}
        report.append(row)
        print(json.dumps(row, ensure_ascii=False))

    manifest = build_manifest(entries)
    mpath = os.path.join(args.out, "manifest.json")
    with open(mpath, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f"\n[写] {mpath}（{len(entries)} 个场景，含互跳热点）")
    with open(os.path.join(args.out, "_stitch-report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
