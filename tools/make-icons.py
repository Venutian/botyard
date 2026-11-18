#!/usr/bin/env python3
"""Botyard's icons, drawn from one mark: the yard's yellow hex nut on a graphite sign plate.

    python3 tools/make-icons.py      writes assets/icon.png (phone), icon-desktop.png, adaptive-icon.png, splash.png

The same geometry as studio/public/icon.svg (a 64-unit square). Drawn at four times the size and scaled down,
so every edge is smooth. Needs Pillow.
"""
import math
import os
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GRAPHITE = (29, 30, 34)
GRAPHITE_LIGHT = (46, 48, 54)
GRAPHITE_DEEP = (16, 17, 20)
YELLOW = (255, 198, 26)
YELLOW_LIGHT = (255, 221, 110)
YELLOW_DEEP = (204, 146, 0)
BOLT = (141, 143, 150)


def hexagon(cx, cy, r, turn=0.0):
    return [(cx + r * math.cos(math.radians(60 * i - 90 + turn)), cy + r * math.sin(math.radians(60 * i - 90 + turn))) for i in range(6)]


def nut(draw, img, cx, cy, r):
    """A hex nut seen from above: a chamfered face, lit from the top left, and a bored hole."""
    # A soft shadow under it, so it sits on the plate.
    shadow = Image.new('RGBA', img.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).polygon(hexagon(cx + r * 0.04, cy + r * 0.10, r), fill=(0, 0, 0, 150))
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(r * 0.08)))
    outer = hexagon(cx, cy, r)
    inner = hexagon(cx, cy, r * 0.80)
    draw.polygon(outer, fill=YELLOW_DEEP)
    # Chamfer: each side of the ring lit by how much it faces the top left.
    for i in range(6):
        a, b = outer[i], outer[(i + 1) % 6]
        c, d = inner[(i + 1) % 6], inner[i]
        mid = math.radians(60 * i - 60)
        light = 0.5 + 0.5 * math.cos(mid - math.radians(-135))
        col = tuple(int(YELLOW_DEEP[k] + (YELLOW_LIGHT[k] - YELLOW_DEEP[k]) * light) for k in range(3))
        draw.polygon([a, b, c, d], fill=col)
    draw.polygon(inner, fill=YELLOW)
    # The bore: plate showing through, with a dark lip.
    hr = r * 0.40
    draw.ellipse([cx - hr * 1.12, cy - hr * 1.12, cx + hr * 1.12, cy + hr * 1.12], fill=YELLOW_DEEP)
    draw.ellipse([cx - hr, cy - hr, cx + hr, cy + hr], fill=GRAPHITE_DEEP)
    draw.ellipse([cx - hr * 0.86, cy - hr * 0.80, cx + hr * 0.86, cy + hr * 0.92], fill=GRAPHITE)


def plate(size, bolts=True):
    """The full icon: the sign plate with its lit top edge and its thickness, four bolts and the nut."""
    s = size * 4
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = s * 0.0  # full bleed: the stores and launchers cut their own corners
    d.rectangle([0, 0, s, s], fill=GRAPHITE_DEEP)
    d.rectangle([0, 0, s, s * 0.955], fill=GRAPHITE)
    # A lit top edge, the plate's thickness at the bottom.
    for i in range(int(s * 0.012)):
        d.line([(0, i), (s, i)], fill=GRAPHITE_LIGHT)
    if bolts:
        for bx, by in [(0.13, 0.13), (0.87, 0.13), (0.13, 0.83), (0.87, 0.83)]:
            br = s * 0.026
            d.ellipse([s * bx - br, s * by - br, s * bx + br, s * by + br], fill=BOLT)
            d.line([(s * bx - br * 0.6, s * by), (s * bx + br * 0.6, s * by)], fill=GRAPHITE, width=max(2, int(br * 0.3)))
    nut(d, img, s / 2, s * 0.48, s * 0.31)
    return img.resize((size, size), Image.LANCZOS)


def desktop(size):
    """The desktop app's icon: the plate with rounded corners and a margin, as desktop launchers expect."""
    s = size * 4
    full = plate(int(size * 0.84)).resize((int(s * 0.84), int(s * 0.84)), Image.LANCZOS)
    mask = Image.new('L', full.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, full.size[0] - 1, full.size[1] - 1], radius=int(full.size[0] * 0.22), fill=255)
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    shade = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    ImageDraw.Draw(shade).rounded_rectangle([s * 0.08, s * 0.09, s * 0.92, s * 0.93], radius=int(s * 0.84 * 0.22), fill=(0, 0, 0, 110))
    img.alpha_composite(shade.filter(ImageFilter.GaussianBlur(s * 0.012)))
    img.paste(full, (int(s * 0.08), int(s * 0.07)), mask)
    return img.resize((size, size), Image.LANCZOS)


def foreground(size):
    """Android's adaptive icon: the nut alone, inside the middle 60% the launcher always shows."""
    s = size * 4
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    nut(ImageDraw.Draw(img), img, s / 2, s / 2, s * 0.25)
    return img.resize((size, size), Image.LANCZOS)


def splash(size):
    s = size * 4
    img = Image.new('RGBA', (s, s), GRAPHITE + (255,))
    nut(ImageDraw.Draw(img), img, s / 2, s / 2, s * 0.17)
    return img.resize((size, size), Image.LANCZOS)


if __name__ == '__main__':
    out = os.path.join(HERE, 'assets')
    plate(1024).save(os.path.join(out, 'icon.png'))
    desktop(1024).save(os.path.join(out, 'icon-desktop.png'))
    foreground(1024).save(os.path.join(out, 'adaptive-icon.png'))
    splash(1024).save(os.path.join(out, 'splash.png'))
    print('assets/icon.png, assets/icon-desktop.png, assets/adaptive-icon.png, assets/splash.png')
