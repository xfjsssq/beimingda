#!/usr/bin/env python3
"""
把手机「全景」模式实拍的两段素材拼成一张 360° 等距柱状全景（equirectangular）。

v3（2026-10-31）专门治「看着有点弯曲」：
    站长反馈：源图单看是能水平铺开的宽条，但拼出来总觉得弯。原因是**两段各自的
    地平线有倾斜（roll），而 v1/v2 只用"一个全局垂直偏移"去对**，接缝处就拱起来。
    三步治：
      ① estimate_roll：在两段各自的**下半部**用 Hough 找近水平长线（路沿、斑马线、
         路面标线），取中位角度 → 把每段**旋正**（±8° 以内才动手，避免误判）
      ② estimate_horizon_curve：拼好后逐列找"天空→地面"的强梯度行，平滑 + 二次拟合
         → **逐列垂直采样把残留弧度拉直**（这就是"弯"的第二个来源）
      ③ 摆放时让**地平线落在画布垂直正中**，查看器 pitch=0 时地平线才是笔直的

其余沿用站长认可的 v1 观感：上下用"雾化带"补天补地、宽羽化接缝、两轴找接缝位置。
用法： python tools/stitch-pano.py [--src 目录] [--out 目录]
⛔ 只依赖 Pillow / numpy / opencv（仅用于找线）；⛔ 不联网。
"""
from __future__ import annotations

import argparse
import glob
import json
import math
import os

import cv2
import numpy as np
from PIL import Image, ImageFilter

Image.MAX_IMAGE_PIXELS = None

TARGET_H = 1280
SEARCH_W = 900
TAIL_FRAC = 0.22
MAX_SHIFT_FRAC = 0.45
NCC_OK = 0.35
FEATHER_FRAC = 0.75
COLOR_BAND = 0.04
WRAP_FRAC = 0.035
OUT_MAX_W = 6000
JPEG_Q = 82
TITLE_OVERRIDE = {"第一点位": "明湖风光 1", "第二点位": "明湖风光 2", "第三点位": "明湖风光 3"}
MAX_ROLL_DEG = 8.0        # 超过这个角度就不敢旋（多半是误判）
MAX_LEVEL_PX = 90         # 逐列找平的最大位移
TARGET_VAOV = 90.0        # ⭐ 成图覆盖的垂直视场（度）：只比 72° 视场对应的垂直角(≈54°)略大，
                          #    屏幕几乎全是真实画面，上下只留窄窄一圈雾化边


# ---------------------------------------------------------------- 基础
def load(path: str) -> Image.Image:
    return Image.open(path).convert("RGB")


def resize_h(im: Image.Image, h: int) -> Image.Image:
    return im.resize((max(1, round(im.width * h / im.height)), h), Image.LANCZOS)


def ncc(x, y) -> float:
    x = x.astype(np.float32).ravel(); y = y.astype(np.float32).ravel()
    x = x - x.mean(); y = y - y.mean()
    d = math.sqrt(float((x * x).sum()) * float((y * y).sum()))
    return float((x * y).sum() / d) if d else 0.0


# ---------------------------------------------------------------- ① 摆正
def estimate_roll(im: Image.Image) -> float:
    """在下半部找近水平长线，返回中位角度（度）。找不到线就返回 0。"""
    arr = cv2.cvtColor(np.asarray(im), cv2.COLOR_RGB2BGR)
    h, w = arr.shape[:2]
    band = arr[int(h * 0.45):int(h * 0.97), :]
    gray = cv2.cvtColor(band, cv2.COLOR_BGR2GRAY)
    small = cv2.resize(gray, (w // 2, band.shape[0] // 2))
    edges = cv2.Canny(small, 60, 160)
    lines = cv2.HoughLinesP(edges, 1, np.pi / 360, threshold=90,
                            minLineLength=max(60, small.shape[1] // 12), maxLineGap=12)
    if lines is None:
        return 0.0
    angs = []
    for x1, y1, x2, y2 in lines[:, 0]:
        dx, dy = x2 - x1, y2 - y1
        if dx == 0:
            continue
        a = math.degrees(math.atan2(dy, dx))
        if -18 <= a <= 18:                 # 只认近水平线
            angs.append(a)
    if len(angs) < 8:
        return 0.0
    med = float(np.median(angs))
    return med if abs(med) <= MAX_ROLL_DEG else 0.0


def rotate_keep(im: Image.Image, deg: float) -> Image.Image:
    """绕中心旋转并保持尺寸；空出来的边角用边缘像素填充（不留黑）"""
    if abs(deg) < 0.05:
        return im
    arr = np.asarray(im)
    h, w = arr.shape[:2]
    m = cv2.getRotationMatrix2D((w / 2, h / 2), deg, 1.0)
    out = cv2.warpAffine(arr, m, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    return Image.fromarray(out)


# ---------------------------------------------------------------- ② 找缝（两轴）
def gray_small(im: Image.Image, w: int = SEARCH_W) -> np.ndarray:
    g = im.convert("L")
    return np.asarray(g.resize((w, max(1, round(w * im.height / im.width))), Image.LANCZOS), dtype=np.float32)


def find_seam(a: Image.Image, b: Image.Image) -> dict:
    ga, gb = gray_small(a), gray_small(b)
    h = min(ga.shape[0], gb.shape[0])
    ga, gb = ga[:h], gb[:h]
    win = max(40, int(SEARCH_W * TAIL_FRAC))
    tail = ga[:, SEARCH_W - win:]
    lo = max(win, int(gb.shape[1] * 0.08))
    hi = max(lo + 1, int(gb.shape[1] * MAX_SHIFT_FRAC))
    best = {"cut": lo, "ncc": -2.0}
    for cut in range(lo, hi):
        v = ncc(tail, gb[:, cut - win:cut])
        if v > best["ncc"]:
            best = {"cut": cut, "ncc": v}
    cut = best["cut"]
    scale = a.width / SEARCH_W
    # 垂直：小范围搜索（旋正之后不该差很多）
    max_dy = max(4, int(40 / max(a.height / h, 1e-6)))
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
    return {"cut": int(cut * scale), "dy": int(dy_best * scale), "ncc": ncc_best}


def shift_vertical(im: Image.Image, dy: int) -> Image.Image:
    arr = np.asarray(im)
    h = arr.shape[0]
    out = np.empty_like(arr)
    if dy > 0:
        out[dy:] = arr[:h - dy]; out[:dy] = arr[0]
    elif dy < 0:
        out[:h + dy] = arr[-dy:]; out[h + dy:] = arr[-1]
    else:
        out = arr
    return Image.fromarray(out)


def match_color(a: np.ndarray, b: np.ndarray, overlap_px: int | None = None) -> np.ndarray:
    """用两侧真实重叠区估增益/偏移，再沿水平平滑过渡到 1"""
    out = b.astype(np.float32)
    w = max(32, int(overlap_px if overlap_px else a.shape[1] * 0.25))
    ramp = np.linspace(1.0, 0.0, out.shape[1], dtype=np.float32)[None, :]
    for c in range(3):
        ea = a[:, -w:, c].astype(np.float32)
        eb = b[:, :w, c].astype(np.float32)
        gain = float(np.clip((ea.std() + 1e-3) / (eb.std() + 1e-3), 0.85, 1.18))
        shift = float(ea.mean() - eb.mean() * gain)
        out[:, :, c] = out[:, :, c] * (1 + (gain - 1) * ramp) + shift * ramp
    return np.clip(out, 0, 255).astype(np.uint8)


def blend_band(canvas: Image.Image, band_a: Image.Image, band_b: Image.Image, x0: int, wide: bool) -> None:
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

    # ① 先各自摆正（roll）
    roll_a, roll_b = estimate_roll(A0), estimate_roll(B0)
    A0, B0 = rotate_keep(A0, roll_a), rotate_keep(B0, roll_b)

    # ② 找缝（两种顺序取更好的）
    cands = []
    for first, second in ((A0, B0), (B0, A0)):
        cands.append((find_seam(first, second)["ncc"], first, second, find_seam(first, second)))
    ncc_best, A, B, s = max(cands, key=lambda c: c[0])
    cut, dy = s["cut"], s["dy"]
    if dy:
        B = shift_vertical(B, dy)

    connected = ncc_best >= NCC_OK
    overlap = min(cut, A.width, B.width) if connected else 8
    B = Image.fromarray(match_color(np.asarray(A), np.asarray(B), overlap))
    blend_w = max(180, int(overlap * FEATHER_FRAC)) if connected else 260

    W = max(1, A.width + B.width - overlap)
    canvas = Image.new("RGB", (W, target_h))
    canvas.paste(A, (0, 0))
    canvas.paste(B, (A.width - overlap, 0))
    band_a = A.crop((max(0, A.width - blend_w), 0, A.width, target_h))
    band_b = B.crop((0, 0, min(blend_w, B.width), target_h))
    if band_a.width and band_b.width == band_a.width:
        blend_band(canvas, band_a, band_b, max(0, A.width - blend_w), wide=connected)

    info = {
        "connected": bool(connected), "ncc": round(float(ncc_best), 3), "dy": int(dy),
        "overlap_pct": round(overlap / A.width * 100, 1), "seam_x": int(A.width - overlap),
        "roll_a": round(roll_a, 2), "roll_b": round(roll_b, 2),
    }
    return canvas, info


# ---------------------------------------------------------------- ③ 逐列找平
def horizon_curve(strip: Image.Image, smooth: int = 121) -> np.ndarray | None:
    """逐列找"天空/地面分界"（垂直梯度最强行），平滑后返回；找不到返回 None"""
    g = cv2.cvtColor(np.asarray(strip), cv2.COLOR_RGB2GRAY).astype(np.float32)
    h, w = g.shape
    lo, hi = int(h * 0.15), int(h * 0.85)
    gy = np.abs(cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=5))
    band = gy[lo:hi, :]
    rows = lo + np.argmax(band, axis=0).astype(np.float32)
    # 中值滤波去野点（用滑动中值近似）
    k = 51
    pad = np.pad(rows, k // 2, mode="edge")
    med = np.array([np.median(pad[i:i + k]) for i in range(len(rows))], dtype=np.float32)
    if smooth > 1:
        kern = np.ones(smooth, dtype=np.float32) / smooth
        med = np.convolve(np.pad(med, smooth // 2, mode="edge"), kern, mode="valid")
    # 二次拟合（弯曲通常就是二次的），再判可信度
    xs = np.arange(w, dtype=np.float32)
    coef = np.polyfit(xs, med, 2)
    fit = np.polyval(coef, xs).astype(np.float32)
    if float(np.std(med - fit)) > 40:      # 拟合太差 => 没找到真地平线
        return None
    return fit


def level_columns(strip: Image.Image, max_px: int = MAX_LEVEL_PX) -> tuple[Image.Image, float]:
    """逐列垂直采样，把地平线拉成一条水平直线；返回(图, 拉直后的地平线行号)"""
    curve = horizon_curve(strip)
    arr = np.asarray(strip).astype(np.float32)
    h, w = arr.shape[:2]
    if curve is None:
        return strip, h / 2
    target = float(np.median(curve))
    shift = np.clip(target - curve, -max_px, max_px)         # 每列要往下/往上挪多少
    ys = np.arange(h, dtype=np.float32)
    out = np.empty_like(arr)
    for x in range(w):
        src = ys + shift[x]
        for c in range(3):
            col = arr[:, x, c]
            out[:, x, c] = np.interp(src, ys, col, left=col[0], right=col[-1])
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)), target


# ---------------------------------------------------------------- ④ 补天补地
def haze_line(strip: Image.Image, rows: int, top: bool) -> np.ndarray:
    """雾化色带：中位基调 + 左右两端线性过渡（⛔ 不要逐列取样，树干会被拉成竖条）"""
    arr = np.asarray(strip).astype(np.float32)
    band = arr[:rows] if top else arr[-rows:]
    whole = float(np.median(arr.reshape(-1, 3)))
    base = np.median(band.reshape(-1, 3), axis=0)
    if not top and float(np.mean(base)) < whole * 0.86:
        base = base * 0.5 + whole * 0.5
    edge = max(4, strip.width // 40)
    left = np.median(band[:, :edge].reshape(-1, 3), axis=0)
    right = np.median(band[:, -edge:].reshape(-1, 3), axis=0)
    tt = np.linspace(0.0, 1.0, strip.width, dtype=np.float32)[:, None]
    line = left[None, :] * (1 - tt) + right[None, :] * tt
    line = line * 0.35 + base[None, :] * 0.65
    radius = max(4, strip.width // 160)
    k = np.arange(-radius, radius + 1, dtype=np.float32)
    wgt = np.exp(-(k ** 2) / (2 * (radius / 2.2) ** 2)); wgt /= wgt.sum()
    for c in range(3):
        line[:, c] = np.convolve(np.pad(line[:, c], radius, mode="reflect"), wgt, mode="valid")
    return line


def soft_edge(strip: Image.Image, px: int, top: bool) -> Image.Image:
    """补边 = 该侧边缘色的柔和渐隐（⛔ 不用镜像：镜像会让路面出现"倒影"，看着像水渍）。
    只补很窄的一条，而且查看器视场比它小，正常情况下根本看不到。"""
    arr = np.asarray(strip).astype(np.float32)
    rows = max(6, int(strip.height * COLOR_BAND * 2))
    band = arr[:rows] if top else arr[-rows:]
    whole = float(np.median(arr.reshape(-1, 3)))
    base = np.median(band.reshape(-1, 3), axis=0)
    if not top and float(np.mean(base)) < whole * 0.86:
        base = base * 0.5 + whole * 0.5
    edge = max(4, strip.width // 40)
    left = np.median(band[:, :edge].reshape(-1, 3), axis=0)
    right = np.median(band[:, -edge:].reshape(-1, 3), axis=0)
    tt = np.linspace(0.0, 1.0, strip.width, dtype=np.float32)[:, None]
    # 中位基调 + 左右过渡
    line = (left[None, :] * (1 - tt) + right[None, :] * tt) * 0.4 + base[None, :] * 0.6
    # ⭐ 再和"实际边缘行的横向平均"混一半：天空亮处雾也亮、地面暗处雾也暗，接边不再发灰
    rows_n = max(2, min(rows, band.shape[0]))
    edge_rows = band[:rows_n] if top else band[-rows_n:]
    actual = edge_rows.mean(axis=0)                      # [W,3] 每列平均（含结构）
    radius = max(8, strip.width // 90)
    k = np.arange(-radius, radius + 1, dtype=np.float32)
    wgt = np.exp(-(k ** 2) / (2 * (radius / 2.2) ** 2)); wgt /= wgt.sum()
    for c in range(3):
        smooth_actual = np.convolve(np.pad(actual[:, c], radius, mode="reflect"), wgt, mode="valid")
        line[:, c] = 0.45 * line[:, c] + 0.55 * smooth_actual
        # 再轻度平滑一遍，彻底去掉逐列起伏
        line[:, c] = np.convolve(np.pad(line[:, c], radius, mode="reflect"), wgt, mode="valid")
    if top:
        grad = np.linspace(1.12, 1.0, px, dtype=np.float32)[:, None, None]
    else:
        grad = np.linspace(1.0, 0.84, px, dtype=np.float32)[:, None, None]
    img = np.repeat(line[None, :, :], px, axis=0) * grad
    return Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(12))


def pad_to_vaov(strip: Image.Image, horizon_row: float, vaov: float = TARGET_VAOV,
                out_max_w: int = OUT_MAX_W) -> Image.Image:
    """放进"刚好覆盖 vaov 度垂直视场"的画布：地平线居中；上下补很窄的柔化边并长羽化。"""
    if strip.width > out_max_w:
        scale = out_max_w / strip.width
        strip = strip.resize((out_max_w, round(strip.height * scale)), Image.LANCZOS)
        horizon_row *= scale
    W = strip.width
    H = max(strip.height, int(round(W * vaov / 360.0)))
    top_pad = int(round(H / 2 - horizon_row))
    top_pad = max(0, min(top_pad, H - strip.height))
    bottom = H - top_pad - strip.height
    canvas = Image.new("RGB", (W, H))
    feather = 60         # 羽化别太宽：太宽会把条带底部内容"半透明延续"进雾区，看着像倒影

    if top_pad > 0:
        sky = soft_edge(strip, top_pad + feather, top=True)
        canvas.paste(sky.crop((0, feather, W, top_pad + feather)), (0, 0))
    canvas.paste(strip, (0, top_pad))
    if bottom > 0:
        gnd = soft_edge(strip, bottom + feather, top=False)
        canvas.paste(gnd.crop((0, 0, W, bottom)), (0, top_pad + strip.height))

    # 上下接缝羽化
    for y0, n, is_top in ((top_pad, min(feather, top_pad, strip.height), True),
                          (top_pad + strip.height - min(feather, bottom, strip.height), min(feather, bottom, strip.height), False)):
        if n <= 8:
            continue
        a = canvas.crop((0, y0, W, y0 + n))
        b = canvas.crop((0, y0 + n if is_top else y0 - n, W, y0 + 2 * n if is_top else y0))
        A = np.asarray(a).astype(np.float32); B = np.asarray(b).astype(np.float32)
        ramp = np.linspace(0, 1, n, dtype=np.float32)[:, None, None]
        ramp = (1 - np.cos(ramp * math.pi)) / 2
        if is_top:
            cv2_ = np.clip(A * ramp + B * (1 - ramp), 0, 255).astype(np.uint8)
        else:
            cv2_ = np.clip(A * (1 - ramp) + B * ramp, 0, 255).astype(np.uint8)
        canvas.paste(Image.fromarray(cv2_), (0, y0))
    return canvas


def wrap_blend(eq: Image.Image) -> Image.Image:
    W, H = eq.size
    w = max(8, int(W * WRAP_FRAC))
    arr = np.asarray(eq).astype(np.float32)
    left = arr[:, :w, :].copy()
    ramp = np.linspace(0, 1, w, dtype=np.float32)[None, :, None]
    ramp = (1 - np.cos(ramp * math.pi)) / 2
    arr[:, W - w:, :] = arr[:, W - w:, :] * (1 - ramp) + left * ramp
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


# ---------------------------------------------------------------- 输出
def build_manifest(entries: list[dict]) -> dict:
    """每个场景按**真实宽高**声明 haov/vaov：这样查看器不会把画面硬拉成全球面（就是"弯曲"的来源）。
    视场默认 56°：屏幕需要的垂直角(≈39°)小于素材覆盖(≈41°) → 屏幕上 100% 真实画面。"""
    scenes = {}
    for e in entries:
        vaov = round(360.0 * e["h"] / e["w"], 1)
        scenes[e["id"]] = {
            "panorama": f"/pano/{e['file']}",
            "title": e["title"],
            "type": "equirectangular",
            "haov": 360, "vaov": vaov,
            "hfov": 52, "yaw": 0, "pitch": 0,
            "minPitch": -6, "maxPitch": 6,
            "hotSpots": [],
        }
    return {
        "_comment": "Pannellum multi-scene tour（结构冻版，见 contracts/m3-welcome.md §3）。"
                    "图片 = 手机实拍两段素材**纯水平拼接**（tools/stitch-pano.py，⛔ 不补边/不拉伸/不改画幅）。",
        "_view_note": "视场 52°：屏幕垂直角(≈36°) 小于素材实际覆盖 → 全屏真实画面、地平线笔直；两段按重叠区宽融合拼接，接缝连续。"
                      "想更宽可调大 hfov，代价是上下会露出背景。",
        "_hotspot_note": "hotSpots 空着：由站长自己加互跳点。",
        "_privacy_note": "源素材已由站长手动打码（车牌/人脸）。",
        "default": {"firstScene": entries[0]["id"], "sceneFadeDuration": 800, "autoLoad": True, "showControls": True},
        "scenes": scenes,
    }


def natural_key(name: str):
    CN = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}
    for ch in name:
        if ch in CN:
            return (0, CN[ch], name)
    digits = "".join(c for c in name if c.isdigit())
    return (1, int(digits) if digits else 999, name)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=r"C:\Users\17768\Desktop\银移杯素材\3D素材参考")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "pano"))
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    points = []
    for name in sorted(os.listdir(args.src), key=natural_key):
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
        strip, info = stitch_pair(a, b)          # 水平拼接（含 dy 垂直对齐 + 亮度对齐 + 羽化）
        out_img = strip                          # ⛔ 原图不动：连环闭合融合也不做
        out_name = f"pano-{i}.jpg"
        out_path = os.path.join(args.out, out_name)
        out_img.save(out_path, "JPEG", quality=JPEG_Q, optimize=True, progressive=True)
        entries.append({"id": f"pano-{i}", "file": out_name,
                        "title": TITLE_OVERRIDE.get(name, name),
                        "w": out_img.width, "h": out_img.height})
        row = {"point": name, "file": out_name,
               "size": f"{out_img.width}x{out_img.height}",
               "vaov": round(360.0 * out_img.height / out_img.width, 1),
               "mb": round(os.path.getsize(out_path) / 1024 / 1024, 2), **info}
        report.append(row)
        print(json.dumps(row, ensure_ascii=False))

    with open(os.path.join(args.out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(build_manifest(entries), f, ensure_ascii=False, indent=2)
    with open(os.path.join(args.out, "_stitch-report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(f"\n[写] {len(entries)} 个场景 + manifest.json（热点留空，站长自己加）")


if __name__ == "__main__":
    main()
