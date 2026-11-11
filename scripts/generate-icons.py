#!/usr/bin/env python3
"""Generate original DIY Reels seal icons (192, 512, maskable 512, 180, favicon)."""
import math
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

OUT = Path(__file__).resolve().parent.parent / 'public'
SHOTS = Path(__file__).resolve().parent.parent / 'screenshots'

BG = (21, 17, 14)            # #15110e
GOLD = (240, 180, 90)        # mid gold
GOLD_LT = (255, 212, 130)    # #ffd482
GOLD_DK = (210, 130, 50)     # deeper gold
CREAM = (246, 236, 226)      # #f6ece2
INK = (26, 20, 17)           # near-black brown

FONT_SCRIPT = '/usr/share/fonts/truetype/sand-box/google/Lobster/Lobster-Regular.ttf'
FONT_ARC = '/usr/share/fonts/truetype/sand-box/google/Playfair Display SC/PlayfairDisplaySC-Bold.ttf'
FONT_ARC_FALLBACK = '/usr/share/fonts/truetype/sand-box/google/Cormorant SC/CormorantSC-Bold.ttf'

def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))

def font(path, size):
    try:
        return ImageFont.truetype(path, size=size)
    except Exception:
        return ImageFont.truetype(FONT_ARC_FALLBACK, size=size)

def scallop_radii(n_points, r_mid, amp, lobes):
    pts = []
    for i in range(n_points):
        th = 2 * math.pi * i / n_points
        # lobes sit on the rim like a classic bottle-cap / wax seal
        r = r_mid + amp * math.cos(lobes * th)
        pts.append((th, r))
    return pts

def polar(cx, cy, th, r, y_down=True):
    # th=0 is up, clockwise
    x = cx + r * math.sin(th)
    y = cy - r * math.cos(th) if y_down else cy + r * math.cos(th)
    return x, y

def draw_scalloped(draw, cx, cy, r_mid, amp, lobes, fill, n=720):
    coords = [polar(cx, cy, th, r) for th, r in scallop_radii(n, r_mid, amp, lobes)]
    draw.polygon(coords, fill=fill)

def star_pts(cx, cy, outer, inner, n=5, rot=0):
    pts = []
    for i in range(n * 2):
        ang = rot + math.pi * i / n - math.pi / 2
        r = outer if i % 2 == 0 else inner
        pts.append((cx + r * math.cos(ang), cy + r * math.sin(ang)))
    return pts

def draw_arc_text(base, text, cx, cy, radius, start_deg, end_deg, font_obj, fill, flip=False):
    """Letters follow an arc and read left to right.
    flip=False: bases toward the center (top motto).
    flip=True: letters stay upright for the viewer (bottom motto).
    """
    glyphs = list(text)
    if not glyphs:
        return
    widths = []
    for ch in glyphs:
        bbox = font_obj.getbbox(ch)
        widths.append(max(1, bbox[2] - bbox[0] + font_obj.getbbox(' ')[2] * 0.05))
    total_w = sum(widths)
    start = math.radians(start_deg)
    end = math.radians(end_deg)
    delta = end - start
    acc = 0
    for ch, w in zip(glyphs, widths):
        mid = (acc + w / 2) / total_w
        phi = start + delta * mid
        acc += w
        bbox = font_obj.getbbox(ch)
        gw, gh = bbox[2] - bbox[0], bbox[3] - bbox[1]
        pad = 6
        gimg = Image.new('RGBA', (gw + pad * 2, gh + pad * 2), (0, 0, 0, 0))
        gd = ImageDraw.Draw(gimg)
        gd.text((pad - bbox[0], pad - bbox[1]), ch, font=font_obj, fill=fill)
        # PIL rotate is CCW; our phi is clockwise from up.
        angle = -math.degrees(phi)
        if flip:
            angle += 180
        rotated = gimg.rotate(angle, resample=Image.Resampling.BICUBIC, expand=True)
        x, y = polar(cx, cy, phi, radius)
        rx, ry = rotated.size
        base.alpha_composite(rotated, (int(round(x - rx / 2)), int(round(y - ry / 2))))

def draw_seal(size, *, inset=0.0):
    """inset is a fraction of size reserved as outer margin (for maskable safe zone)."""
    img = Image.new('RGBA', (size, size), BG + (255,))
    draw = ImageDraw.Draw(img)
    cx = cy = size / 2
    # usable radius
    margin = size * (0.06 + inset)
    r_outer = size / 2 - margin
    amp = r_outer * 0.055
    r_mid = r_outer - amp
    lobes = 20

    # soft shadow behind the badge
    shadow = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    draw_scalloped(sd, cx + size * 0.012, cy + size * 0.018, r_mid, amp, lobes, (0, 0, 0, 110))
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=max(1, size * 0.02)))
    img.alpha_composite(shadow)

    # gold scalloped body with a slight radial feel (two layers)
    draw_scalloped(draw, cx, cy, r_mid, amp, lobes, GOLD_DK)
    draw_scalloped(draw, cx, cy, r_mid - size * 0.012, amp * 0.92, lobes, GOLD)

    # inner dark field
    inner_r = r_mid - amp - size * 0.018
    draw.ellipse((cx - inner_r, cy - inner_r, cx + inner_r, cy + inner_r), fill=INK)

    # inner gold rings (between field and scallops, around the motto)
    ring_outer = inner_r - size * 0.006
    ring_inner = ring_outer - max(2, size * 0.012)
    draw.ellipse((cx - ring_outer, cy - ring_outer, cx + ring_outer, cy + ring_outer), outline=GOLD, width=max(1, int(size * 0.008)))
    motto_r = (ring_inner + inner_r * 0.62) / 2  # will compute text radius below
    # a thinner inner ring inside the motto
    text_outer = inner_r - size * 0.055
    text_inner = text_outer - size * 0.11
    mid_ring = text_inner - size * 0.012
    draw.ellipse((cx - mid_ring, cy - mid_ring, cx + mid_ring, cy + mid_ring), outline=GOLD, width=max(1, int(size * 0.006)))

    # stars at 3 and 9 o'clock, on the motto band
    star_r = (text_outer + text_inner) / 2
    star_outer = max(3, size * 0.035)
    for deg in (90, 270):
        sx, sy = polar(cx, cy, math.radians(deg), star_r)
        draw.polygon(star_pts(sx, sy, star_outer, star_outer * 0.42, 5, rot=0), fill=GOLD_LT)

    # Arched motto. Skip at very small sizes where it will muddy.
    # Size type from the badge's inner radius so maskable insets stay in proportion.
    if inner_r >= 48:
        fsize = max(8, int(inner_r * 0.15))
        f_arc = font(FONT_ARC, fsize)
        motto = 'DO IT YOURSELF'
        text_r = (text_outer + text_inner) / 2
        draw_arc_text(img, motto, cx, cy, text_r, -58, 58, f_arc, CREAM, flip=False)
        draw_arc_text(img, motto, cx, cy, text_r, 238, 122, f_arc, CREAM, flip=True)

    # Center script DIY — fit inside the inner gold ring with a comfortable margin.
    max_w = mid_ring * 1.55
    diy_size = int(mid_ring * 1.05)
    f_diy = font(FONT_SCRIPT, diy_size)
    bbox = f_diy.getbbox('DIY')
    # shrink until it fits the inner ring
    while diy_size > 8 and (bbox[2] - bbox[0]) > max_w:
        diy_size -= 1
        f_diy = font(FONT_SCRIPT, diy_size)
        bbox = f_diy.getbbox('DIY')
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    pad = 10
    text_img = Image.new('RGBA', (tw + pad * 2, th + pad * 2), (0, 0, 0, 0))
    td = ImageDraw.Draw(text_img)
    td.text((pad - bbox[0] + 1, pad - bbox[1] + 1), 'DIY', font=f_diy, fill=(0, 0, 0, 140))
    td.text((pad - bbox[0], pad - bbox[1]), 'DIY', font=f_diy, fill=GOLD_LT)
    # a very slight tilt; too much overflowed the ring
    tilted = text_img.rotate(4, resample=Image.Resampling.BICUBIC, expand=True)
    tx, ty = tilted.size
    img.alpha_composite(tilted, (int(cx - tx / 2), int(cy - ty / 2 - inner_r * 0.04)))

    return img.convert('RGB')

def make_standard(size):
    return draw_seal(size, inset=0.0)

def make_maskable(size):
    # Keep the badge inside the 80% safe-zone circle (10% padding each side, plus extra).
    return draw_seal(size, inset=0.12)

def save_favicon(src512: Image.Image, dest: Path):
    sizes = [16, 32, 48]
    frames = [src512.resize((s, s), Image.Resampling.LANCZOS) for s in sizes]
    frames[0].save(dest, format='ICO', sizes=[(s, s) for s in sizes], append_images=frames[1:])

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    SHOTS.mkdir(parents=True, exist_ok=True)
    i192 = make_standard(192)
    i512 = make_standard(512)
    i512m = make_maskable(512)
    i180 = make_standard(180)
    i192.save(OUT / 'icon-192.png', 'PNG', optimize=True)
    i512.save(OUT / 'icon-512.png', 'PNG', optimize=True)
    i512m.save(OUT / 'icon-512-maskable.png', 'PNG', optimize=True)
    i180.save(OUT / 'apple-touch-icon.png', 'PNG', optimize=True)
    save_favicon(i512, OUT / 'favicon.ico')
    # also a 32px png favicon
    i512.resize((32, 32), Image.Resampling.LANCZOS).save(OUT / 'favicon-32.png', 'PNG', optimize=True)
    # preview (the 512 standard icon)
    i512.save(SHOTS / 'icon-preview.png', 'PNG', optimize=True)
    for name in ('icon-192.png', 'icon-512.png', 'icon-512-maskable.png', 'apple-touch-icon.png', 'favicon.ico', 'favicon-32.png'):
        p = OUT / name
        print(f'{name}: {p.stat().st_size} bytes')
    print('preview:', SHOTS / 'icon-preview.png', (SHOTS / 'icon-preview.png').stat().st_size, 'bytes')

if __name__ == '__main__':
    main()
