#!/usr/bin/env python3
"""
用 Hugin（Panorama Tools）把"两段手机全景素材"拼成标准 360° 等距柱状图。

为什么用 Hugin 而不是自己拼（2026-10-31 站长的决定）：
    · 我们的素材是**球面（等距柱状）**投影。相机横滚（roll）在球面上不是"把图片转个角度"，
      必须**反投影回球面 → 按 yaw/pitch/roll 对齐 → 再投影回等距柱状**，否则越校越错位。
    · Hugin 的 autooptimiser 做的正是这件事；融合用 enblend 的多波段，接缝与曝光差异都能压掉。
    · 实测对照：OpenCV 自带 Stitcher 在这类 180° 素材上直接失败（ERR_CAMERA_PARAMS_ADJUST）。

流程（全部命令行，可复现）：
    pto_gen           两段图 → 初始工程
    pto_var --set     把每段的输入投影声明为 equirectangular（v=2），水平视场 f=<由素材估算>
    cpfind            特征匹配找控制点
    autooptimiser -n  仅优化几何（y,p,r,v,d,e）
    pano_modify       输出投影=equirectangular(2)、视场 360x180、画布/裁切自动
    hugin_executor    缝合（内部用 enblend 多波段融合）

用法：
    python tools/stitch-pano-hugin.py                 # 处理默认素材目录 → 写 pano/
    python tools/stitch-pano-hugin.py --only 图书馆正门左侧   # 只处理某一个点位（调试用）
⛔ 需要已安装 Hugin；不联网。
"""
from __future__ import annotations

import argparse
import glob
import importlib.util
import json
import os
import shutil
import subprocess
import sys

HUGIN_BIN_CANDIDATES = [
    r"C:\Program Files\Hugin\bin",
    r"C:\Program Files (x86)\Hugin\bin",
]


def find_bin_dir() -> str | None:
    for d in HUGIN_BIN_CANDIDATES:
        if os.path.isdir(d) and os.path.exists(os.path.join(d, "hugin_executor.exe")):
            return d
    exe = shutil.which("hugin_executor")
    return os.path.dirname(exe) if exe else None


def run(bin_dir: str, exe: str, args: list[str], log: list[str]) -> int:
    cmd = [os.path.join(bin_dir, exe + ".exe") if os.name == "nt" else exe, *args]
    log.append("$ " + " ".join(cmd))
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if p.stdout:
        log.append(p.stdout.strip()[-2000:])
    if p.stderr:
        log.append(p.stderr.strip()[-2000:])
    log.append(f"[exit {p.returncode}]")
    return p.returncode


def estimate_hfov(path: str) -> float:
    """手机全景每段的水平视场：按 180° 声明（典型手机 pano 半圈），
    随后 autooptimiser 会优化视场参数 v —— ⛔ 不要用公式硬算（算错会把条带撑满整球）。"""
    return 180.0


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
    ap.add_argument("--work", default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "pano", "_hugin"))
    ap.add_argument("--only", default=None)
    ap.add_argument("--max-w", type=int, default=6000, help="输出宽度上限（控制体积）")
    args = ap.parse_args()

    bin_dir = find_bin_dir()
    if not bin_dir:
        print("找不到 Hugin，请先安装：winget install --id Hugin.Hugin")
        sys.exit(1)
    print("Hugin:", bin_dir)

    os.makedirs(args.out, exist_ok=True)
    os.makedirs(args.work, exist_ok=True)
    TITLE = {"第一点位": "明湖风光 1", "第二点位": "明湖风光 2", "第三点位": "明湖风光 3"}

    points = []
    for name in sorted(os.listdir(args.src), key=natural_key):
        d = os.path.join(args.src, name)
        if not os.path.isdir(d):
            continue
        if args.only and args.only not in name:
            continue
        files = sorted(f for f in os.listdir(d) if f.lower().endswith((".jpg", ".jpeg", ".png")))
        if len(files) < 2:
            print(f"[skip] {name}: 只有 {len(files)} 张")
            continue
        points.append((name, [os.path.join(d, f) for f in files[:2]]))

    entries, report = [], []
    for i, (name, imgs) in enumerate(points, start=1):
        print(f"\n=== {name} ===")
        work = os.path.join(args.work, name)
        os.makedirs(work, exist_ok=True)
        pto = os.path.join(work, "proj.pto")
        log: list[str] = []

        # 1) 建工程
        run(bin_dir, "pto_gen", ["-o", pto, *imgs], log)
        # 2) 声明输入投影 = 等距柱状（v=2），水平视场按素材宽高比估算
        hfovs = [round(estimate_hfov(p), 1) for p in imgs]
        # ⚠️ pto 图像行：i w<宽> h<高> f<投影类型 2=等距柱状> v<水平视场度>
        #    pto_var 的 --set=f=2 实测不生效 → 直接改文本（最可靠）
        import re as _re
        with open(pto, encoding="latin-1") as _f:      # ⚠️ pto 含中文路径字节，不是 UTF-8
            _pto_txt = _f.read()
        _pto_txt = _re.sub(r"(?m)^i\s+w(\d+)\s+h(\d+)\s+f\d+\s+v[\d.]+",
                           lambda m: f"i w{m.group(1)} h{m.group(2)} f2 v{hfovs[0]:.1f}", _pto_txt)
        # 画布尺寸也直接写进 p 行（pano_modify 的 --canvas 实测被 crop 覆盖掉）
        _pto_txt = _re.sub(r"(?m)^p\s+f(\d+)\s+w\d+\s+h\d+\s+v([\d.]+)",
                           lambda m: f"p f{m.group(1)} w{args.max_w} h{args.max_w // 2} v{m.group(2)}",
                           _pto_txt)
        with open(pto, "w", encoding="latin-1") as _f:
            _f.write(_pto_txt)
        log.append("[pto] 已把输入投影改为 f2（equirectangular），视场 v=%.1f" % hfovs[0])
        # 3) 找控制点（两段之间）
        run(bin_dir, "cpfind", ["--multirow", "--celeste", "-o", pto, pto], log)
        # 4) 几何优化：yaw/pitch/roll/视场/畸变/曝光
        run(bin_dir, "autooptimiser", ["-n", "-o", pto, pto], log)
        run(bin_dir, "pto_var", ["--opt=y,p,r,v", "-o", pto, pto], log)   # ⛔ 不优化 d,e（等距柱状无镜头畸变）
        run(bin_dir, "autooptimiser", ["-n", "-o", pto, pto], log)
        # 5) 输出设置：等距柱状、360x180、自动画布与裁切、限宽
        # ⚠️ 顺序要紧：--crop=AUTO 会覆盖画布设置 → --canvas 必须放最后
        run(bin_dir, "pano_modify", ["--projection=2", "--fov=360x180", "--crop=AUTO",
                                     "--output-format=JPEG", "-o", pto, pto], log)
        # 6) 缝合（内部 enblend 多波段融合）
        out_jpg = os.path.join(args.out, f"pano-{i}.jpg")
        if os.path.exists(out_jpg):
            os.remove(out_jpg)                     # 先删，避免"看起来没更新"
        before = set(glob.glob(os.path.join(args.out, "*")))
        run(bin_dir, "hugin_executor", ["--stitching", f"--prefix={out_jpg}", pto], log)
        run(bin_dir, "hugin_executor", ["--stitching", pto], log) if not os.path.exists(out_jpg) else None
        for cand in sorted(set(glob.glob(os.path.join(args.out, "*"))) - before,
                           key=os.path.getmtime, reverse=True):
            if cand != out_jpg and os.path.isfile(cand) and os.path.splitext(cand)[1].lower() in (".jpg", ".jpeg", ".png", ".tif", ".tiff"):
                os.replace(cand, out_jpg)
                break

        # 兜底：hugin_executor 有时输出到 <prefix>0000.jpg 之类，找最新产物
        found = None
        if os.path.exists(out_jpg):
            found = out_jpg
        else:
            cands = sorted(glob.glob(os.path.join(args.out, f"pano-{i}*")), key=os.path.getmtime, reverse=True)
            if cands:
                found = cands[0]
                if found != out_jpg:
                    shutil.move(found, out_jpg)
                    found = out_jpg
        ok = bool(found and os.path.exists(found))
        # ③ Hugin 输出的是 360x180 画布，未覆盖区域是黑边：
        #    检测"非黑的内容带"裁出来，再交给 v1 的 pad_to_equirect 补雾化边
        if ok:
            try:
                import numpy as _np
                spec = importlib.util.spec_from_file_location(
                    "pano_v1", os.path.join(os.path.dirname(os.path.abspath(__file__)), "stitch-pano-v1.py"))
                pano_v1 = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(pano_v1)
                from PIL import Image as _Image
                with _Image.open(found) as _im:
                    _rgb = _im.convert("RGB")
                    _a = _np.asarray(_rgb).astype(_np.float32)
                    _rows = _a.reshape(_a.shape[0], -1).max(axis=1)      # 每行最大亮度
                    _idx = _np.where(_rows > 24)[0]                       # 非黑 = 有内容
                    if _idx.size > 10:
                        top, bottom = int(_idx.min()), int(_idx.max())
                        band = _rgb.crop((0, top, _rgb.width, bottom + 1))
                        log.append(f"[band] 内容带 y={top}..{bottom}（{band.width}x{band.height}）")
                        eq = pano_v1.pad_to_equirect(band)
                        eq.save(found, "JPEG", quality=82, optimize=True, progressive=True)
                        log.append(f"[pad] {band.width}x{band.height} -> {eq.width}x{eq.height}")
                    else:
                        log.append("[band] 没找到内容带，保留 Hugin 原产物")
            except Exception as e:      # 补边失败就保留 Hugin 原产物，并如实记日志
                log.append("[pad] 失败: " + repr(e))

        with open(os.path.join(work, "log.txt"), "w", encoding="utf-8") as f:
            f.write("\n".join(log))
        row = {"point": name, "file": f"pano-{i}.jpg", "hfov_est": hfovs, "ok": ok,
               "size": None, "mb": None}
        if ok:
            from PIL import Image
            with Image.open(found) as im:
                row["size"] = f"{im.width}x{im.height}"
            row["mb"] = round(os.path.getsize(found) / 1024 / 1024, 2)
            entries.append({"id": f"pano-{i}", "file": f"pano-{i}.jpg",
                            "title": TITLE.get(name, name), "w": im.width, "h": im.height})
        report.append(row)
        print(json.dumps(row, ensure_ascii=False))

    if entries:
        manifest = {
            "_comment": "由 Hugin（Panorama Tools）拼接的 360° 等距柱状图（tools/stitch-pano-hugin.py）。",
            "_view_note": "hfov 72 / pitch 4：站长实测口径。",
            "_hotspot_note": "hotSpots 空着：由站长自己加。",
            "_privacy_note": "源素材已由站长手动打码（车牌/人脸）。",
            "default": {"firstScene": entries[0]["id"], "sceneFadeDuration": 800, "autoLoad": True, "showControls": True},
            "scenes": {e["id"]: {"panorama": f"/pano/{e['file']}", "title": e["title"],
                                 "type": "equirectangular", "hfov": 72, "yaw": 0, "pitch": 4,
                                 "hotSpots": []} for e in entries},
        }
        with open(os.path.join(args.out, "manifest.json"), "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)
    with open(os.path.join(args.out, "_hugin-report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(f"\n[写] {len(entries)} 个场景；报告见 pano/_hugin-report.json")


if __name__ == "__main__":
    main()
