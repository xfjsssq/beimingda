#!/usr/bin/env python3
"""
隐私脱敏：把全景里可能出现的**车牌、人脸、行人**一律糊掉。

为什么宁可多糊：
    街景素材里的车牌/人脸属于个人信息；漏一个就是合规事故，多糊一块（树枝、路牌）
    在 72° 视场下几乎看不出来。策略是 recall 优先，但**用结构校验压掉纯颜色误报**
    （不加这一关，绿色掩码会把树叶/草地全当车牌，实测每张 50~100 个误报）。

四个通道的并集（都留足边距）：
    1) 车牌 Haar 级联
    2) 蓝牌颜色通道（蓝色在校园里罕见，误报低）
    3) 新能源绿牌颜色通道（严格色域 + **白字结构校验**：框内需有 3 个以上高亮字符块）
    4) 人脸 Haar（正脸 + 侧脸）与行人 HOG

可核查：被糊的框写进 pano/_privacy-redactions.json，并输出
       pano/pano-N-blur-review.jpg（脱敏前后对照）供人工核对。

用法：
    python tools/privacy-blur.py --dry-run     # 只报告
    python tools/privacy-blur.py               # 原地脱敏（原图备份为 pano-N.orig.jpg）
⛔ 只依赖 opencv + numpy；⛔ 不联网。
"""
from __future__ import annotations

import argparse
import glob
import json
import os

import cv2
import numpy as np

PAD_FACE = 0.9      # 人脸框外扩（把头发/耳朵也算进去）
PAD_PLATE = 0.7
PAD_PERSON = 0.35


def merge(boxes, tol: float = 0.3):
    out = []
    for b in sorted(boxes, key=lambda b: -b[2] * b[3]):
        x, y, w, h = b
        dup = False
        for (X, Y, W, H) in out:
            ix = max(0, min(x + w, X + W) - max(x, X))
            iy = max(0, min(y + h, Y + H) - max(y, Y))
            if ix * iy > tol * min(w * h, W * H):
                dup = True
                break
        if not dup:
            out.append((x, y, w, h))
    return out


def detect_faces(gray, cascades, tile=(900, 1200)):
    h, w = gray.shape
    found = []
    for y in range(0, h, tile[0] // 2):
        for x in range(0, w, tile[1] // 2):
            t = gray[y:y + tile[0], x:x + tile[1]]
            if t.shape[0] < 60 or t.shape[1] < 60:
                continue
            for c in cascades:
                for (fx, fy, fw, fh) in c.detectMultiScale(t, 1.07, 5, minSize=(22, 22)):
                    found.append((x + int(fx), y + int(fy), int(fw), int(fh)))
    return merge(found)


def detect_plates(img, haar):
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    found = []
    for y in range(0, h, 400):
        for x in range(0, w, 600):
            t = gray[y:y + 900, x:x + 1200]
            if t.shape[0] < 80 or t.shape[1] < 80:
                continue
            for (fx, fy, fw, fh) in haar.detectMultiScale(t, 1.05, 4, minSize=(26, 8)):
                found.append((x + int(fx), y + int(fy), int(fw), int(fh)))

    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    masks = [
        cv2.inRange(hsv, (100, 90, 45), (128, 255, 255)),   # 蓝牌
        cv2.inRange(hsv, (40, 130, 60), (72, 255, 255)),    # 新能源绿牌（严格：高饱和 + 窄色域）
    ]
    for mk in masks:
        mk = cv2.morphologyEx(mk, cv2.MORPH_CLOSE, np.ones((3, 15), np.uint8))
        cnts, _ = cv2.findContours(mk, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for c in cnts:
            x, y, bw, bh = cv2.boundingRect(c)
            if bw < 24 or bh < 8 or bw > w * 0.035:
                continue
            if not (2.0 <= bw / max(bh, 1) <= 6.5):
                continue
            # 结构校验：车牌一定"彩色底 + 白字"，框里应有 3 个以上高亮字符块
            roi = img[y:y + bh, x:x + bw]
            g = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
            _, binimg = cv2.threshold(g, max(150, int(g.mean()) + 45), 255, cv2.THRESH_BINARY)
            n, _, stats, _ = cv2.connectedComponentsWithStats(binimg, 8)
            blobs = sum(1 for i in range(1, n)
                        if stats[i, cv2.CC_STAT_HEIGHT] > bh * 0.35 and stats[i, cv2.CC_STAT_AREA] > 4)
            if blobs >= 3:
                found.append((x, y, bw, bh))
    return merge(found)


def detect_people(img):
    hog = cv2.HOGDescriptor()
    hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())
    small = cv2.resize(img, (img.shape[1] // 3, img.shape[0] // 3))
    rects, _ = hog.detectMultiScale(small, winStride=(8, 8), padding=(16, 16), scale=1.06)
    return merge([(int(x * 3), int(y * 3), int(w * 3), int(h * 3)) for (x, y, w, h) in rects])


def blur_box(img, box, pad: float, strength: int = 41) -> None:
    x, y, w, h = box
    px, py = int(w * pad) + 8, int(h * pad) + 8
    x0, y0 = max(0, x - px), max(0, y - py)
    x1, y1 = min(img.shape[1], x + w + px), min(img.shape[0], y + h + py)
    if x1 - x0 < 4 or y1 - y0 < 4:
        return
    roi = img[y0:y1, x0:x1]
    k = strength if strength % 2 == 1 else strength + 1
    img[y0:y1, x0:x1] = cv2.GaussianBlur(roi, (k, k), 0)
    m = 9
    tiny = cv2.resize(roi, (max(1, roi.shape[1] // m), max(1, roi.shape[0] // m)), interpolation=cv2.INTER_AREA)
    img[y0:y1, x0:x1] = cv2.resize(tiny, (roi.shape[1], roi.shape[0]), interpolation=cv2.INTER_NEAREST)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "pano"))
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    frontal = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    profile = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_profileface.xml")
    plate = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_russian_plate_number.xml")
    report = {}

    for path in sorted(glob.glob(os.path.join(args.dir, "pano-*.jpg"))):
        if ".orig" in path or "review" in path:
            continue
        name = os.path.basename(path)
        img = cv2.imread(path)
        if img is None:
            print("[skip]", name)
            continue

        gray = cv2.equalizeHist(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY))
        faces = detect_faces(gray, [frontal, profile])
        plates = detect_plates(img, plate)
        people = detect_people(img)
        plan = ([("face", b, PAD_FACE) for b in faces]
                + [("plate", b, PAD_PLATE) for b in plates]
                + [("person", b, PAD_PERSON) for b in people])

        review = []
        if not args.dry_run:
            orig = path.replace(".jpg", ".orig.jpg")
            if not os.path.exists(orig):
                cv2.imwrite(orig, img, [cv2.IMWRITE_JPEG_QUALITY, 92])
            for kind, b, pad in plan:
                x, y, w_, h_ = b
                px, py = int(w_ * pad) + 8, int(h_ * pad) + 8
                x0, y0 = max(0, x - px), max(0, y - py)
                x1, y1 = min(img.shape[1], x + w_ + px), min(img.shape[0], y + h_ + py)
                before = img[y0:y1, x0:x1].copy() if x1 > x0 and y1 > y0 else None
                blur_box(img, b, pad)
                if before is not None and before.size:
                    review.append((kind, before, img[y0:y1, x0:x1].copy()))
            cv2.imwrite(path, img, [cv2.IMWRITE_JPEG_QUALITY, 82, cv2.IMWRITE_JPEG_PROGRESSIVE, 1])

            if review:
                rows = []
                for j in range(0, len(review), 4):
                    cells = []
                    for kind, before, after in review[j:j + 4]:
                        ch = 150
                        a = cv2.resize(before, (max(24, int(before.shape[1] * ch / before.shape[0])), ch))
                        b2 = cv2.resize(after, (a.shape[1], ch))
                        pair = np.hstack([a, b2])
                        cv2.putText(pair, kind, (4, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 1)
                        cells.append(pair)
                    H = max(c.shape[0] for c in cells)
                    cells = [cv2.copyMakeBorder(c, 0, H - c.shape[0], 0, 10, cv2.BORDER_CONSTANT, value=(255, 255, 255)) for c in cells]
                    rows.append(np.hstack(cells))
                Wm = max(r.shape[1] for r in rows)
                rows = [cv2.copyMakeBorder(r, 0, 10, 0, Wm - r.shape[1], cv2.BORDER_CONSTANT, value=(255, 255, 255)) for r in rows]
                cv2.imwrite(os.path.join(args.dir, name.replace(".jpg", "-blur-review.jpg")),
                            np.vstack(rows), [cv2.IMWRITE_JPEG_QUALITY, 85])

        report[name] = {
            "face": [[int(v) for v in b] for b in faces],
            "plate": [[int(v) for v in b] for b in plates],
            "person": [[int(v) for v in b] for b in people],
        }
        print("%-12s 人脸 %2d  车牌 %2d  行人 %2d  共糊 %2d 处%s"
              % (name, len(faces), len(plates), len(people), len(plan), "（dry-run）" if args.dry_run else ""))

    with open(os.path.join(args.dir, "_privacy-redactions.json"), "w", encoding="utf-8") as f:
        json.dump({
            "_why": "街景素材里的车牌/人脸/行人属于个人信息，一律模糊；宁可多糊不可漏",
            "_how": "tools/privacy-blur.py：车牌 Haar + 蓝/绿牌颜色（绿牌需通过白字结构校验）+ 人脸 Haar（正/侧）+ 行人 HOG",
            "_note": "重跑拼图 stitch-pano.py 之后必须再跑一次本脚本；boxes 为 [x,y,w,h]，原图 6000x3000 像素",
            "boxes": report,
        }, f, ensure_ascii=False, indent=2)
    print("\n[写] 脱敏记录:", os.path.join(args.dir, "_privacy-redactions.json"))


if __name__ == "__main__":
    main()
