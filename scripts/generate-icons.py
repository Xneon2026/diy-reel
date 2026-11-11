#!/usr/bin/env python3
"""Generate DIY Reel PWA icons: 192, 512, maskable 512, and 180 apple-touch."""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / 'public'
BG = (21, 17, 14)          # #15110e
ORANGE = (255, 138, 61)    # #ff8a3d
GOLD = (255, 196, 107)     # #ffc46b
DARK = (21, 17, 14)

def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

def gradient_fill(size, c1, c2):
    img = Image.new('RGB', (size, size))
    px = img.load()
    denom = max(size * 2 - 2, 1)
    for y in range(size):
        for x in range(size):
            px[x, y] = lerp(c1, c2, (x + y) / denom)
    return img

def rounded_mask(size, box, radius):
    m = Image.new('L', (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle(box, radius=radius, fill=255)
    return m

def play_triangle(draw, size, inset_left, inset_top, inset_right, inset_bottom, fill):
    # Proportions from the existing icon.svg path: M210 170v172l140-86z on a 512 canvas.
    x0, y0 = inset_left, inset_top
    w = size - inset_left - inset_right
    h = size - inset_top - inset_bottom
    def sx(x): return x0 + x / 512 * w
    def sy(y): return y0 + y / 512 * h
    draw.polygon([(sx(210), sy(170)), (sx(210), sy(342)), (sx(350), sy(256))], fill=fill)

def make_standard(size):
    img = Image.new('RGB', (size, size), BG)
    pad = int(round(56 / 512 * size))
    radius = int(round(90 / 512 * size))
    tile = gradient_fill(size, ORANGE, GOLD)
    mask = rounded_mask(size, (pad, pad, size - pad - 1, size - pad - 1), radius)
    img.paste(tile, (0, 0), mask)
    draw = ImageDraw.Draw(img)
    play_triangle(draw, size, 0, 0, 0, 0, DARK)
    return img

def make_maskable(size):
    """Full-bleed background so OS masks don't crop the mark; mark stays in the 80% safe zone."""
    img = Image.new('RGB', (size, size), BG)
    pad = int(round(size * 0.18))
    radius = int(round((size - 2 * pad) * 0.22))
    tile = gradient_fill(size, ORANGE, GOLD)
    mask = rounded_mask(size, (pad, pad, size - pad - 1, size - pad - 1), radius)
    img.paste(tile, (0, 0), mask)
    draw = ImageDraw.Draw(img)
    play_triangle(draw, size, pad, pad, pad, pad, DARK)
    return img

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    make_standard(192).save(OUT / 'icon-192.png', 'PNG', optimize=True)
    make_standard(512).save(OUT / 'icon-512.png', 'PNG', optimize=True)
    make_maskable(512).save(OUT / 'icon-512-maskable.png', 'PNG', optimize=True)
    make_standard(180).save(OUT / 'apple-touch-icon.png', 'PNG', optimize=True)
    for name in ('icon-192.png', 'icon-512.png', 'icon-512-maskable.png', 'apple-touch-icon.png'):
        p = OUT / name
        im = Image.open(p)
        print(f'{name}: {im.size[0]}x{im.size[1]} {im.mode} {p.stat().st_size} bytes')

if __name__ == '__main__':
    main()
