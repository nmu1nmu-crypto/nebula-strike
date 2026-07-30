"""
Procedural texture generation for Galaxy Reborn - vectorized with numpy.
Generates AAA-quality textures using PIL + numpy.
"""
import os
import math
import random
from PIL import Image, ImageDraw, ImageFilter, ImageChops
import numpy as np

OUT = os.path.join(os.path.dirname(__file__), "..", "assets", "textures")
os.makedirs(OUT, exist_ok=True)

def save(img, name):
    path = os.path.join(OUT, name)
    img.save(path, "PNG")
    print(f"  ✓ {name} ({img.size[0]}x{img.size[1]})")

def lerp_color(c1, c2, t):
    return tuple(int(a + (b - a) * t) for a, b in zip(c1, c2))

def add_noise(img, amount=0.05):
    arr = np.array(img).astype(np.float32)
    noise = (np.random.rand(*arr.shape[:2]) * 255 * amount).astype(np.float32)
    for c in range(3):
        arr[:, :, c] = np.clip(arr[:, :, c] + noise, 0, 255)
    return Image.fromarray(arr.astype(np.uint8), "RGBA")

def radial_gradient_np(size, center, radius, c_inner, c_outer):
    """Fast radial gradient using numpy."""
    cx, cy = center
    y, x = np.ogrid[:size, :size]
    d = np.sqrt((x - cx)**2 + (y - cy)**2)
    t = np.clip(d / radius, 0, 1)
    t3 = t ** 1.5
    r = c_inner[0] + (c_outer[0] - c_inner[0]) * t3
    g = c_inner[1] + (c_outer[1] - c_inner[1]) * t3
    b = c_inner[2] + (c_outer[2] - c_inner[2]) * t3
    a = (255 * (1 - t3)).clip(0, 255)
    arr = np.zeros((size, size, 4), dtype=np.uint8)
    mask = d <= radius
    arr[mask, 0] = r[mask].clip(0, 255).astype(np.uint8)
    arr[mask, 1] = g[mask].clip(0, 255).astype(np.uint8)
    arr[mask, 2] = b[mask].clip(0, 255).astype(np.uint8)
    arr[mask, 3] = a[mask].clip(0, 255).astype(np.uint8)
    return Image.fromarray(arr, "RGBA")

def vertical_gradient(size, c_top, c_bottom):
    """Fast vertical gradient overlay."""
    y = np.arange(size).reshape(-1, 1)
    t = y / size
    arr = np.zeros((size, size, 4), dtype=np.uint8)
    arr[:, :, 0] = (c_top[0] + (c_bottom[0] - c_top[0]) * t).clip(0, 255).astype(np.uint8)
    arr[:, :, 1] = (c_top[1] + (c_bottom[1] - c_top[1]) * t).clip(0, 255).astype(np.uint8)
    arr[:, :, 2] = (c_top[2] + (c_bottom[2] - c_top[2]) * t).clip(0, 255).astype(np.uint8)
    arr[:, :, 3] = 150
    return Image.fromarray(arr, "RGBA")

def apply_gradient_to_polygon(size, polygon_pts, base_color, grad_top, grad_bottom):
    """Draw polygon, fill with base, overlay gradient, mask by polygon."""
    body_img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    body_draw = ImageDraw.Draw(body_img)
    body_draw.polygon(polygon_pts, fill=(*base_color, 255))

    grad = vertical_gradient(size, grad_top, grad_bottom)
    body_img = Image.alpha_composite(body_img, grad)

    mask = Image.new("L", (size, size), 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.polygon(polygon_pts, fill=255)
    body_img.putalpha(mask)
    return body_img

# ── Player Ship ───────────────────────────────────────────────────────────
def gen_player_ship():
    size = 512
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    cx = size // 2
    hull = [
        (cx, 40), (cx + 60, 180), (cx + 80, 220), (cx + 140, 240),
        (cx + 150, 280), (cx + 80, 300), (cx + 50, 360), (cx + 30, 440),
        (cx - 30, 440), (cx - 50, 360), (cx - 80, 300), (cx - 150, 280),
        (cx - 140, 240), (cx - 80, 220), (cx - 60, 180),
    ]
    hull_img = apply_gradient_to_polygon(size, hull, (40, 70, 120),
                                          (60, 130, 255), (20, 50, 100))
    img = Image.alpha_composite(img, hull_img)
    draw = ImageDraw.Draw(img)

    # Cockpit
    cockpit = [(cx - 20, 100), (cx + 20, 100), (cx + 15, 160), (cx - 15, 160)]
    draw.polygon(cockpit, fill=(0, 180, 255, 200))
    draw.ellipse([cx - 8, 105, cx + 8, 135], fill=(200, 240, 255, 255))

    # Edge highlights
    for pts in [[(cx, 40), (cx + 60, 180), (cx + 80, 220), (cx + 140, 240)],
                [(cx, 40), (cx - 60, 180), (cx - 80, 220), (cx - 140, 240)]]:
        draw.line(pts, fill=(0, 220, 255, 255), width=3)

    # Wing tip glow
    draw.ellipse([cx + 130, 235, cx + 160, 275], fill=(255, 100, 50, 220))
    draw.ellipse([cx - 160, 235, cx - 130, 275], fill=(255, 100, 50, 220))

    # Engine glow
    for side in [-1, 1]:
        engine = radial_gradient_np(size, (cx + side * 40, 420), 50,
                                    (0, 200, 255), (0, 50, 100))
        img = Image.alpha_composite(img, engine)

    # Panel lines
    draw = ImageDraw.Draw(img)
    for i in range(3):
        y = 200 + i * 40
        draw.line([(cx - 50, y), (cx + 50, y)], fill=(20, 40, 80, 100), width=1)

    img = add_noise(img, 0.02)
    img = img.filter(ImageFilter.GaussianBlur(0.5))
    save(img, "player_ship.png")

# ── Enemy Ships ───────────────────────────────────────────────────────────
def gen_enemy_grunt():
    size = 256
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    cx = size // 2
    body = [(cx, 50), (cx+50, 80), (cx+60, 140), (cx+30, 200), (cx-30, 200), (cx-60, 140), (cx-50, 80)]
    body_img = apply_gradient_to_polygon(size, body, (180, 50, 30),
                                          (240, 80, 50), (120, 20, 10))
    img = Image.alpha_composite(img, body_img)
    draw = ImageDraw.Draw(img)

    draw.ellipse([cx-25, 90, cx+25, 140], fill=(255, 200, 0, 255))
    draw.ellipse([cx-12, 100, cx+12, 128], fill=(255, 80, 0, 255))
    draw.ellipse([cx-5, 108, cx+5, 118], fill=(255, 255, 200, 255))

    draw.polygon([(cx-60, 140), (cx-80, 170), (cx-50, 160)], fill=(120, 30, 10, 255))
    draw.polygon([(cx+60, 140), (cx+80, 170), (cx+50, 160)], fill=(120, 30, 10, 255))

    img = add_noise(img, 0.02)
    save(img, "enemy_grunt.png")

def gen_enemy_bomber():
    size = 256
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    cx = size // 2
    body = [(cx, 40), (cx+70, 100), (cx+80, 180), (cx+40, 220), (cx-40, 220), (cx-80, 180), (cx-70, 100)]
    body_img = apply_gradient_to_polygon(size, body, (100, 40, 140),
                                          (80, 60, 160), (60, 20, 100))
    img = Image.alpha_composite(img, body_img)
    draw = ImageDraw.Draw(img)

    for off in [-20, 20]:
        draw.ellipse([cx+off-15, 100, cx+off+15, 130], fill=(255, 0, 255, 255))
        draw.ellipse([cx+off-7, 107, cx+off+7, 122], fill=(255, 200, 255, 255))

    for side in [-1, 1]:
        draw.ellipse([cx + side*70 - 15, 160, cx + side*70 + 15, 200], fill=(60, 20, 80, 255))

    img = add_noise(img, 0.02)
    save(img, "enemy_bomber.png")

def gen_enemy_commander():
    size = 256
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    cx = size // 2
    body = [(cx, 30), (cx+30, 60), (cx+70, 120), (cx+80, 180), (cx+40, 230), (cx-40, 230), (cx-80, 180), (cx-70, 120), (cx-30, 60)]
    body_img = apply_gradient_to_polygon(size, body, (200, 150, 30),
                                          (255, 200, 50), (150, 100, 10))
    img = Image.alpha_composite(img, body_img)
    draw = ImageDraw.Draw(img)

    for i in range(-2, 3):
        draw.line([(cx + i*20, 60), (cx + i*20, 20)], fill=(255, 215, 0, 255), width=4)

    draw.ellipse([cx-20, 100, cx+20, 140], fill=(255, 215, 0, 255))
    draw.ellipse([cx-10, 108, cx+10, 132], fill=(255, 255, 200, 255))

    img = add_noise(img, 0.02)
    save(img, "enemy_commander.png")

# ── Boss ──────────────────────────────────────────────────────────────────
def gen_boss():
    size = 1024
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    cx = size // 2
    body = [
        (cx, 80), (cx + 100, 150), (cx + 200, 250), (cx + 350, 350),
        (cx + 380, 500), (cx + 300, 600), (cx + 200, 700), (cx + 100, 800),
        (cx, 830), (cx - 100, 800), (cx - 200, 700), (cx - 300, 600),
        (cx - 380, 500), (cx - 350, 350), (cx - 200, 250), (cx - 100, 150),
    ]
    body_img = apply_gradient_to_polygon(size, body, (40, 20, 60),
                                          (100, 80, 120), (20, 10, 40))
    img = Image.alpha_composite(img, body_img)
    draw = ImageDraw.Draw(img)

    for r, alpha in [(120, 100), (80, 150), (50, 200), (25, 255)]:
        draw.ellipse([cx-r, 400-r, cx+r, 400+r], fill=(255, 50, 100, alpha))
    draw.ellipse([cx-15, 385, cx+15, 415], fill=(255, 255, 255, 255))

    for tx, ty in [(cx+200, 350), (cx-200, 350), (cx+150, 550), (cx-150, 550)]:
        draw.ellipse([tx-40, ty-40, tx+40, ty+40], fill=(60, 30, 80, 255))
        draw.ellipse([tx-20, ty-20, tx+20, ty+20], fill=(255, 100, 100, 255))

    for side in [-1, 1]:
        draw.line([(cx, 80), (cx + side*100, 150), (cx + side*200, 250)], fill=(0, 255, 200, 200), width=5)

    img = add_noise(img, 0.02)
    img = img.filter(ImageFilter.GaussianBlur(0.5))
    save(img, "boss.png")

# ── Bullets ───────────────────────────────────────────────────────────────
def gen_bullet_player():
    size = 128
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    cx = size // 2
    for r, alpha in [(40, 60), (25, 120), (15, 200), (8, 255)]:
        draw.ellipse([cx-r, 20, cx+r, 108], fill=(0, 200, 255, alpha))
    draw.ellipse([cx-4, 40, cx+4, 88], fill=(255, 255, 255, 255))
    trail = radial_gradient_np(size, (cx, 100), 30, (0, 150, 255), (0, 0, 0))
    img = Image.alpha_composite(img, trail)
    save(img, "bullet_player.png")

def gen_bullet_enemy():
    size = 128
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    cx = size // 2
    for r, alpha in [(35, 60), (20, 120), (12, 200), (6, 255)]:
        draw.ellipse([cx-r, 20, cx+r, 108], fill=(255, 80, 0, alpha))
    draw.ellipse([cx-3, 40, cx+3, 88], fill=(255, 255, 200, 255))
    save(img, "bullet_enemy.png")

# ── Explosions ────────────────────────────────────────────────────────────
def gen_explosion_frames():
    for frame in range(16):
        size = 256
        img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)
        cx, cy = size // 2, size // 2
        t = frame / 15.0
        radius = int(20 + 100 * t)

        if t < 0.3:
            r, g, b = 255, 255, 200
        elif t < 0.6:
            r, g, b = 255, int(200 - 100*(t-0.3)/0.3), 50
        else:
            r = int(200 * (1 - (t - 0.6) / 0.4))
            g = int(50 * (1 - (t - 0.6) / 0.4))
            b = 0

        alpha = int(255 * (1 - t))
        for layer_r, layer_alpha in [(radius, alpha//3), (int(radius*0.7), alpha//2), (int(radius*0.4), alpha), (int(radius*0.2), alpha)]:
            draw.ellipse([cx-layer_r, cy-layer_r, cx+layer_r, cy+layer_r], fill=(r, g, b, layer_alpha))

        if 0.1 < t < 0.8:
            sw_r = int(radius * 1.2)
            sw_alpha = int(200 * (1 - (t-0.1)/0.7))
            draw.ellipse([cx-sw_r, cy-sw_r, cx+sw_r, cy+sw_r], outline=(255, 255, 255, sw_alpha), width=3)

        img = img.filter(ImageFilter.GaussianBlur(3))
        save(img, f"explosion_{frame:02d}.png")

# ── Power-ups ─────────────────────────────────────────────────────────────
def gen_powerup_shield():
    size = 128
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    cx = size // 2
    for r, alpha in [(55, 50), (45, 100), (35, 150), (25, 200)]:
        draw.ellipse([cx-r, cx-r, cx+r, cx+r], fill=(0, 255, 200, alpha))
    draw.ellipse([cx-15, cx-15, cx+15, cx+15], fill=(200, 255, 255, 255))
    draw.polygon([(cx, cx-20), (cx+15, cx-10), (cx+15, cx+10), (cx, cx+20), (cx-15, cx+10), (cx-15, cx-10)], fill=(255, 255, 255, 255))
    save(img, "powerup_shield.png")

def gen_powerup_rapid():
    size = 128
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    cx = size // 2
    for r, alpha in [(55, 50), (45, 100), (35, 150), (25, 200)]:
        draw.ellipse([cx-r, cx-r, cx+r, cx+r], fill=(255, 200, 0, alpha))
    draw.ellipse([cx-15, cx-15, cx+15, cx+15], fill=(255, 255, 200, 255))
    draw.polygon([(cx-5, cx-20), (cx+8, cx-5), (cx, cx-2), (cx+5, cx+20), (cx-8, cx+5), (cx, cx+2)], fill=(255, 255, 255, 255))
    save(img, "powerup_rapid.png")

def gen_powerup_multi():
    size = 128
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    cx = size // 2
    for r, alpha in [(55, 50), (45, 100), (35, 150), (25, 200)]:
        draw.ellipse([cx-r, cx-r, cx+r, cx+r], fill=(255, 50, 200, alpha))
    draw.ellipse([cx-15, cx-15, cx+15, cx+15], fill=(255, 200, 255, 255))
    for off in [-10, 0, 10]:
        draw.ellipse([cx+off-3, cx-15, cx+off+3, cx+15], fill=(255, 255, 255, 255))
    save(img, "powerup_multi.png")

# ── Nebula Backgrounds ────────────────────────────────────────────────────
def gen_nebula(name, colors):
    size = 2048
    arr = np.zeros((size, size, 4), dtype=np.float32)
    arr[:, :, 3] = 255
    for c in range(3):
        arr[:, :, c] = random.randint(3, 12)

    num_clouds = 10
    for _ in range(num_clouds):
        cx = random.randint(0, size)
        cy = random.randint(0, size)
        max_r = random.randint(300, 700)
        col = random.choice(colors)

        y, x = np.ogrid[:size, :size]
        d = np.sqrt((x - cx)**2 + (y - cy)**2)
        t = np.clip(d / max_r, 0, 1)
        factor = (1 - t) ** 2

        inside = d < max_r
        for c_idx in range(3):
            channel_add = col[c_idx] * 0.3 * factor
            arr[:, :, c_idx] = np.where(inside, np.clip(arr[:, :, c_idx] + channel_add, 0, 255), arr[:, :, c_idx])

    img = Image.fromarray(arr.astype(np.uint8), "RGBA")

    draw = ImageDraw.Draw(img)
    # Small stars
    for _ in range(3000):
        x = random.randint(0, size-1)
        y = random.randint(0, size-1)
        brightness = random.randint(100, 255)
        star_size = random.choice([1, 1, 1, 1, 2, 2, 3])
        if star_size == 1:
            img.putpixel((x, y), (brightness, brightness, brightness, 255))
        else:
            draw.ellipse([x-star_size, y-star_size, x+star_size, y+star_size], fill=(brightness, brightness, brightness, 255))

    # Bright stars
    for _ in range(50):
        x = random.randint(0, size-1)
        y = random.randint(0, size-1)
        for r, a in [(8, 50), (5, 100), (3, 200), (1, 255)]:
            draw.ellipse([x-r, y-r, x+r, y+r], fill=(255, 255, 255, a))

    img = img.filter(ImageFilter.GaussianBlur(1))
    save(img, f"nebula_{name}.png")

# ── Starfield ─────────────────────────────────────────────────────────────
def gen_starfield():
    size = 1024
    img = Image.new("RGBA", (size, size), (0, 0, 0, 255))
    draw = ImageDraw.Draw(img)
    for i in range(size):
        t = i / size
        v = int(3 + 2 * math.sin(t * math.pi * 3))
        draw.line([(0, i), (size, i)], fill=(v, v, v+2, 255))
    for _ in range(800):
        x = random.randint(0, size-1)
        y = random.randint(0, size-1)
        brightness = random.randint(60, 200)
        img.putpixel((x, y), (brightness, brightness, brightness + 10, 255))
    for _ in range(80):
        x = random.randint(0, size-1)
        y = random.randint(0, size-1)
        brightness = random.randint(200, 255)
        for r, a in [(3, 50), (2, 120), (1, 255)]:
            draw.ellipse([x-r, y-r, x+r, y+r], fill=(brightness, brightness, brightness, a))
    save(img, "starfield.png")

# ── Engine trail ──────────────────────────────────────────────────────────
def gen_engine_trail():
    size = 128
    img = Image.new("RGBA", (size, 256), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    cx = 64
    for i in range(256):
        t = i / 256
        alpha = int(200 * (1 - t) ** 2)
        width = int(12 * (1 - t * 0.5))
        r = int(100 * (1 - t) + 50 * t)
        g = int(200 * (1 - t) + 100 * t)
        draw.ellipse([cx-width, i, cx+width, i+4], fill=(r, g, 255, alpha))
    img = img.filter(ImageFilter.GaussianBlur(2))
    save(img, "engine_trail.png")

# ── Run all ───────────────────────────────────────────────────────────────
def main():
    random.seed(42)
    np.random.seed(42)
    print("Generating textures...")
    gen_player_ship()
    gen_enemy_grunt(); gen_enemy_bomber(); gen_enemy_commander()
    gen_boss()
    gen_bullet_player(); gen_bullet_enemy()
    gen_explosion_frames()
    gen_powerup_shield(); gen_powerup_rapid(); gen_powerup_multi()
    gen_nebula("blue", [(30, 60, 180), (20, 80, 200), (40, 30, 150)])
    gen_nebula("red", [(180, 30, 30), (200, 50, 20), (150, 20, 40)])
    gen_nebula("green", [(30, 180, 80), (20, 200, 50), (10, 150, 30)])
    gen_nebula("purple", [(150, 30, 180), (120, 20, 200), (100, 40, 150)])
    gen_starfield()
    gen_engine_trail()
    print("\nAll textures generated!")

if __name__ == "__main__":
    main()
