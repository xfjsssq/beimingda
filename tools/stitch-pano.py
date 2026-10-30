#!/usr/bin/env python3
"""
把手机「全景」模式实拍的两段 180° 素材拼成一张 360° 等距柱状全景（equirectangular）。

v2（2026-10-30）针对目视发现的三类问题重写：
  ① 天空/地面那圈"竖向拉丝" → 不再用镜像行拉伸，改成**逐列均值 + 垂直渐变**填充（平滑、无条纹）
  ② 接缝处地平线不齐 → 接缝搜索从"只搜水平"升级为**两轴搜索（dx + dy）**，并试两种拼接顺序
  ③ 不接续的两段左右发暗/割裂 → 亮度对齐**只在重叠边缘估计**并按位置平滑过渡；接缝用**低频线性 + 高频单侧**融合
  另外补上 **360° 环闭合融合**（环视一圈回到起点不会看到一条竖线）。

用法：
    python tools/stitch-pano.py                      # 处理内置素材目录，写到 pano/
    python tools/stitch-pano.py --src <目录> --out <目录>

⛔ 只依赖 Pillow / numpy；⛔ 不联网。
"""
from __future__ import annotations

import argparse
import json
import math
import os

import numpy as np
from PIL import Image, ImageFilter

Image.MAX_IMAGE_PIXELS = None

# ---- 可调参数 ----
TARGET_H = 1280          # 统一后的单段高度
SEARCH_W = 900           # 接缝搜索用的灰度宽度
TAIL_FRAC = 0.22         # A 尾部取多少比例作为探针
MAX_SHIFT_FRAC = 0.45    # B 允许被吃掉的最大水平比例
NCC_OK = 0.35            # 高于此值认为两段接续
FEATHER_FRAC = 0.75      # 羽化带占重叠宽度的比例（比 v1 更宽 → 接缝更柔）
MAX_DY = 34              # 垂直对齐搜索范围（像素，按 TARGET_H 缩放；太大容易配错行）
MIN_OVERLAP_FRAC = 0.08  # ⭐ 至少保留这么多重叠，否则融合带太窄、接缝会露
COLOR_BAND = 0.04        # 天空/地面取样的行比例
WRAP_FRAC = 0.035        # 360 环闭合处的融合宽度比例
OUT_MAX_W = 6000
JPEG_Q = 82

# 场景显示名：目录名只是拍摄时的临时叫法，这里固定成对外展示的名字
# （⚠️ 重跑拼图会用目录名覆盖 manifest 里的标题，所以名字必须写在这里，否则会被改回去）
TITLE_OVERRIDE = {
    "第一点位": "明湖风光 1",
    "第二点位": "明湖风光 2",
    "第三点位": "明湖风光 3",
}


def load(path: str) -> Image.Image:
    return Image.open(path).convert("RGB")


def resize_h(im: Image.Image, h: int) -> Image.Image:
    return im.resize((max(1, round(im.width * h / im.height)), h), Image.LANCZOS)


def ncc(x: np.ndarray, y: np.ndarray) -> float:
    x = x.astype(np.float32).ravel()
    y = y.astype(np.float32).ravel()
    x = x - x.mean()
    y = y - y.mean()
    d = math.sqrt(float((x * x).sum()) * float((y * y).sum()))
    return float((x * y).sum() / d) if d else 0.0


def gray_small(im: Image.Image, w: int = SEARCH_W) -> np.ndarray:
    g = im.convert("L")
    return np.asarray(g.resize((w, max(1, round(w * im.height / im.width))), Image.LANCZOS), dtype=np.float32)


def find_seam(a: Image.Image, b: Image.Image) -> dict:
    """两轴搜索：先找最佳水平位移，再在该位置附近找最佳垂直位移（地平线不齐就靠这一步）。"""
    ga, gb = gray_small(a), gray_small(b)
    h = min(ga.shape[0], gb.shape[0])
    ga, gb = ga[:h], gb[:h]
    win = max(40, int(SEARCH_W * TAIL_FRAC))
    tail = ga[:, SEARCH_W - win:]

    best = {"cut": win, "ncc": -2.0}
    lo = max(win, int(gb.shape[1] * MIN_OVERLAP_FRAC))
    hi = max(lo + 1, int(gb.shape[1] * MAX_SHIFT_FRAC))
    for cut in range(lo, hi):
        v = ncc(tail, gb[:, cut - win:cut])
        if v > best["ncc"]:
            best = {"cut": cut, "ncc": v}
    cut = best["cut"]
    scale = a.height / h
    max_dy = max(4, int(MAX_DY / max(scale, 1e-6)))
    dy_best, ncc_best = 0, best["ncc"]
    for dy in range(-max_dy, max_dy + 1):
        if dy >= 0:
            seg = gb[dy:dy + h - dy, cut - win:cut]
            probe = tail[:seg.shape[0]]
        else:
            seg = gb[:h + dy, cut - win:cut]
            probe = tail[-dy:]
        if seg.shape[0] < 20 or seg.shape[1] != probe.shape[1]:
            continue
        v = ncc(probe, seg)
        if v > ncc_best:
            ncc_best, dy_best = v, dy
    # ⚠️ cut 是在"搜索尺度"下算出来的，必须换算回整图像素，否则重叠会只剩几个百分点（等于硬拼）
    return {"cut": int(cut * scale), "dy": int(dy_best * scale), "ncc": ncc_best}


def shift_vertical(im: Image.Image, dy: int) -> Image.Image:
    """整段垂直平移 dy：空出来的那几行用边缘行复制，不留黑边"""
    arr = np.asarray(im)
    h = arr.shape[0]
    out = np.empty_like(arr)
    if dy > 0:
        out[dy:] = arr[:h - dy]
        out[:dy] = arr[0]
    elif dy < 0:
        out[:h + dy] = arr[-dy:]
        out[h + dy:] = arr[-1]
    else:
        out = arr
    return Image.fromarray(out)


def match_color(a: np.ndarray, b: np.ndarray, overlap_px: int | None = None) -> np.ndarray:
    """⭐ 用两侧**真实重叠区**的统计量估增益/偏移，再沿水平方向平滑过渡到 1（避免整图偏色）。
    重叠区是同一片场景，比"只看 B 的左边 25%"准得多 —— 接缝两侧的明暗就是这么对齐的。"""
    out = b.astype(np.float32)
    w = max(32, int(overlap_px if overlap_px else a.shape[1] * 0.25))
    ramp = np.linspace(1.0, 0.0, out.shape[1], dtype=np.float32)[None, :]
    for c in range(3):
        edge_a = a[:, -w:, c].astype(np.float32)      # A 的尾部
        edge_b = b[:, :w, c].astype(np.float32)       # B 的头部 —— 与 A 尾部是同一片场景
        gain = float(np.clip((edge_a.std() + 1e-3) / (edge_b.std() + 1e-3), 0.85, 1.18))
        shift = float(edge_a.mean() - edge_b.mean() * gain)
        out[:, :, c] = out[:, :, c] * (1 + (gain - 1) * ramp) + shift * ramp
    return np.clip(out, 0, 255).astype(np.uint8)


def blend_band(canvas: Image.Image, band_a: Image.Image, band_b: Image.Image, x0: int, wide: bool) -> None:
    """接缝融合：低频线性过渡 + 高频单侧选择（简化多尺度，减轻"重影/割裂"）"""
    if band_a.size != band_b.size or band_a.width == 0:
        return
    A = np.asarray(band_a).astype(np.float32)
    B = np.asarray(band_b).astype(np.float32)
    w = A.shape[1]
    ramp = np.linspace(0, 1, w, dtype=np.float32)[None, :, None]
    ramp = (1 - np.cos(ramp * math.pi)) / 2
    if not wide:
        canvas.paste(Image.fromarray(np.clip(A * (1 - ramp) + B * ramp, 0, 255).astype(np.uint8)), (x0, 0))
        return
    la = np.asarray(band_a.filter(ImageFilter.GaussianBlur(6))).astype(np.float32)
    lb = np.asarray(band_b.filter(ImageFilter.GaussianBlur(6))).astype(np.float32)
    low = la * (1 - ramp) + lb * ramp
    sel = (ramp > 0.5).astype(np.float32)
    hi = (A - la) * (1 - sel) + (B - lb) * sel
    canvas.paste(Image.fromarray(np.clip(low + hi, 0, 255).astype(np.uint8)), (x0, 0))


def stitch_pair(pa: str, pb: str, target_h: int = TARGET_H) -> tuple[Image.Image, dict]:
    A0 = resize_h(load(pa), target_h)
    B0 = resize_h(load(pb), target_h)

    # 有些素材两段是"倒着"拍的：两种顺序都试，取匹配更好的
    cands = []
    for first, second in ((A0, B0), (B0, A0)):
        s = find_seam(first, second)
        cands.append((s["ncc"], first, second, s))
    ncc_best, A, B, s = max(cands, key=lambda c: c[0])
    cut, dy = s["cut"], s["dy"]
    if dy:
        B = shift_vertical(B, dy)        # ⭐ 平移后边缘复制填空白，绝不出现黑块

    connected = ncc_best >= NCC_OK
    overlap = min(cut, A.width, B.width) if connected else 8
    # ⚠️ 顺序要紧：先算出 overlap，再拿它做亮度对齐（重叠区才是同一片场景）
    B = Image.fromarray(match_color(np.asarray(A), np.asarray(B), overlap))
    blend_w = max(180, int(overlap * FEATHER_FRAC)) if connected else 260   # ⭐ 融合带至少 180px

    W = max(1, A.width + B.width - overlap)
    canvas = Image.new("RGB", (W, target_h))
    canvas.paste(A, (0, 0))
    canvas.paste(B, (A.width - overlap, 0))
    band_a = A.crop((max(0, A.width - blend_w), 0, A.width, target_h))
    band_b = B.crop((0, 0, min(blend_w, B.width), target_h))
    if band_a.width and band_b.width == band_a.width:
        blend_band(canvas, band_a, band_b, max(0, A.width - blend_w), wide=connected)
    info = {
        "connected": bool(connected),
        "ncc": round(float(ncc_best), 3),
        "dy": int(dy),
        "overlap_pct": round(overlap / A.width * 100, 1),
        "seam_x": int(A.width - overlap),
    }
    return canvas, info


def haze_line(strip: Image.Image, rows: int, top: bool) -> np.ndarray:
    """生成一条"雾化色带"（宽 = strip 宽）：
       · 基调 = 该带所有像素的**中位数**（抗异常列，树干/树枝不会变条纹）
       · 左右两端各取一小条的中位数，做**线性过渡**（有横向色变，但没有逐列噪声）
       ⚠️ v2 前两版分别用"镜像行拉伸"和"逐列均值"，都会在画面上留下竖条纹；
          根因是顶行/底行本身就含树干树冠，任何"逐列"的取样都会把它拉成竖条。
    """
    arr = np.asarray(strip).astype(np.float32)
    band = arr[:rows] if top else arr[-rows:]
    whole = float(np.median(arr.reshape(-1, 3)))          # 整幅的中位亮度
    base = np.median(band.reshape(-1, 3), axis=0)
    # ⭐ 地面：底行常常扫到车/影子，会让下半变成一块黑；用画面整体亮度兜底
    if not top and float(np.mean(base)) < whole * 0.86:
        base = base * 0.5 + whole * 0.5
    edge = max(4, strip.width // 40)
    left = np.median(band[:, :edge].reshape(-1, 3), axis=0)
    right = np.median(band[:, -edge:].reshape(-1, 3), axis=0)
    tt = np.linspace(0.0, 1.0, strip.width, dtype=np.float32)[:, None]
    line = left[None, :] * (1 - tt) + right[None, :] * tt
    line = line * 0.35 + base[None, :] * 0.65
    # 轻微水平平滑，消掉线性过渡两端可能出现的台阶
    radius = max(4, strip.width // 160)
    k = np.arange(-radius, radius + 1, dtype=np.float32)
    w = np.exp(-(k ** 2) / (2 * (radius / 2.2) ** 2)); w /= w.sum()
    for c in range(3):
        line[:, c] = np.convolve(np.pad(line[:, c], radius, mode="reflect"), w, mode="valid")
    return line


def pad_to_equirect(strip: Image.Image, out_max_w: int = OUT_MAX_W) -> Image.Image:
    """居中放进 2:1 画布；上下用"逐列均值 + 垂直渐变"补天补地（⭐ v1 的镜像拉伸会出竖条纹，已弃用）"""
    if strip.width > out_max_w:
        strip = strip.resize((out_max_w, round(strip.height * out_max_w / strip.width)), Image.LANCZOS)
    W = strip.width
    H = max(strip.height, W // 2)
    canvas = Image.new("RGB", (W, H))
    top_pad = int((H - strip.height) * 0.46)
    rows = max(6, int(strip.height * COLOR_BAND * 2))
    top_line = haze_line(strip, rows, top=True)
    bottom_line = haze_line(strip, rows, top=False)

    if top_pad > 0:
        grad = np.linspace(1.14, 1.0, top_pad, dtype=np.float32)[:, None, None]
        # 越往上越淡（往"天光"方向飘），同时保持横向的线性色变
        sky = np.repeat(top_line[None, :, :], top_pad, axis=0) * grad
        sky = sky * 0.92 + 255.0 * 0.08 * np.linspace(1, 0, top_pad, dtype=np.float32)[:, None, None]
        sky_img = Image.fromarray(np.clip(sky, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(8))
        canvas.paste(sky_img, (0, 0))

    canvas.paste(strip, (0, top_pad))

    bottom = H - top_pad - strip.height
    if bottom > 0:
        grad = np.linspace(1.06, 0.86, bottom, dtype=np.float32)[:, None, None]
        gnd = np.repeat(bottom_line[None, :, :], bottom, axis=0) * grad + 18.0   # 略微提亮，别像灰板
        gnd_img = Image.fromarray(np.clip(gnd, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(8))
        canvas.paste(gnd_img, (0, top_pad + strip.height))
    return canvas


def feather_edges(eq: Image.Image, band: int = 70) -> Image.Image:
    """把"雾化天空/地面"与中间真实画面的那条硬边做成羽化过渡（不然上下像贴了两块色卡）"""
    W, H = eq.size
    arr = np.asarray(eq).astype(np.float32)
    # 找出中间那条真实带（非雾化部分）的位置：用行内方差判断（雾化带几乎无横向起伏）
    var = arr.std(axis=(1, 2))
    rows = np.where(var > max(3.0, float(var.max()) * 0.28))[0]
    if rows.size < 10:
        return eq
    top, bottom = int(rows.min()), int(rows.max())
    ramp = np.linspace(0, 1, band, dtype=np.float32)[:, None, None]
    ramp = (1 - np.cos(ramp * math.pi)) / 2
    if top >= band:
        arr[top - band:top] = arr[top - band:top] * (1 - ramp) +             np.repeat(arr[top:top + 1], band, axis=0) * ramp
    if bottom + band <= H:
        r2 = ramp[::-1]
        arr[bottom:bottom + band] = arr[bottom:bottom + band] * r2 +             np.repeat(arr[bottom - 1:bottom], band, axis=0) * (1 - r2)
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


def wrap_blend(eq: Image.Image) -> Image.Image:
    """360° 环闭合：把最左与最右各取一条做羽化融合，环视回到起点时不会看到一条竖线"""
    W, H = eq.size
    w = max(8, int(W * WRAP_FRAC))
    arr = np.asarray(eq).astype(np.float32)
    left = arr[:, :w, :].copy()
    ramp = np.linspace(0, 1, w, dtype=np.float32)[None, :, None]
    ramp = (1 - np.cos(ramp * math.pi)) / 2
    arr[:, W - w:, :] = arr[:, W - w:, :] * (1 - ramp) + left * ramp
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


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
            "hfov": 100, "yaw": 0, "pitch": 0,
            "hotSpots": [
                {"pitch": -3, "yaw": 30, "type": "scene", "text": "去下一个点位", "sceneId": nxt},
                {"pitch": -3, "yaw": -150, "type": "scene", "text": "回上一个点位", "sceneId": prv},
            ],
        }
    return {
        "_comment": "Pannellum multi-scene tour（结构冻版，见 contracts/m3-welcome.md §3）。"
                    "图片由手机实拍的两段 180° 素材拼接而成（tools/stitch-pano.py v2）。",
        "_note_attach": "把某个场景挂到点位上：在 static/map/sat-coords.json 里给该点位写 pano_scene=<场景 id>。",
        "default": {"firstScene": entries[0]["id"], "sceneFadeDuration": 800, "autoLoad": True, "showControls": True},
        "scenes": scenes,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=r"C:\Users\17768\Desktop\银移杯素材\3D素材参考")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "pano"))
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    CN_NUM = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}

    def natural(name: str) -> tuple:
        for ch in name:
            if ch in CN_NUM:
                return (0, CN_NUM[ch], name)
        digits = "".join(c for c in name if c.isdigit())
        return (1, int(digits) if digits else 999, name)

    points = []
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
        eq = wrap_blend(feather_edges(pad_to_equirect(strip)))
        out_name = f"pano-{i}.jpg"
        out_path = os.path.join(args.out, out_name)
        eq.save(out_path, "JPEG", quality=JPEG_Q, optimize=True, progressive=True)
        entries.append({"id": f"pano-{i}", "file": out_name, "title": TITLE_OVERRIDE.get(name, name)})
        row = {
            "point": name, "file": out_name, "eq_size": f"{eq.width}x{eq.height}",
            "mb": round(os.path.getsize(out_path) / 1024 / 1024, 2), **info,
        }
        report.append(row)
        print(json.dumps(row, ensure_ascii=False))

    with open(os.path.join(args.out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(build_manifest(entries), f, ensure_ascii=False, indent=2)
    with open(os.path.join(args.out, "_stitch-report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(f"\n[写] {len(entries)} 个场景 + manifest.json（含互跳热点）")


if __name__ == "__main__":
    main()
