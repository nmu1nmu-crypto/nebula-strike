"""
Enhanced procedural texture generation for Nebula Strike v2.
Higher quality ships, enemies, scenery with more detail.
"""
import os, math, random
from PIL import Image, ImageDraw, ImageFilter, ImageChops
import numpy as np

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "textures")
os.makedirs(OUT, exist_ok=True)

def save(img, name):
    path = os.path.join(OUT, name)
    img.save(path, "PNG")
    print(f"  ✓ {name} ({img.size[0]}x{img.size[1]})")

def lerp_color(c1, c2, t):
    return tuple(int(a + (b - a) * t) for a, b in zip(c1, c2))

def add_glow(img, radius=3, intensity=1.5):
    blurred = img.filter(ImageFilter.GaussianBlur(radius))
    result = ImageChops.screen(blurred, img)
    for _ in range(int(intensity) - 1):
        result = ImageChops.screen(result, blurred)
    return result

def noise_texture(size, opacity=0.05):
    arr = np.random.rand(size, size, 4) * 255 * opacity
    arr[:,:,3] = 255 * opacity
    return Image.fromarray(arr.astype(np.uint8), "RGBA")

# Player ships - one for each level theme (10 ships)
PLAYER_SHIP_COLORS = [
    # (hull_base, hull_highlight, accent, engine_color)
    ((30, 60, 110), (60, 130, 255), (0, 220, 255), (0, 200, 255)),    # 0: Deep Space - blue
    ((120, 30, 20), (200, 60, 30), (255, 150, 50), (255, 100, 30)),   # 1: Crimson - red
    ((20, 80, 40), (40, 160, 80), (50, 255, 120), (0, 255, 100)),     # 2: Emerald - green
    ((60, 20, 80), (100, 40, 140), (180, 50, 200), (160, 50, 255)),   # 3: Purple
    ((100, 70, 10), (180, 130, 30), (255, 200, 50), (255, 215, 0)),   # 4: Golden
    ((20, 60, 80), (40, 120, 160), (100, 220, 255), (0, 200, 255)),   # 5: Ice - cyan
    ((80, 30, 10), (160, 60, 20), (255, 100, 30), (255, 80, 20)),     # 6: Inferno
    ((40, 30, 80), (60, 50, 120), (100, 100, 255), (80, 80, 255)),    # 7: Twilight
    ((20, 60, 50), (30, 120, 100), (50, 255, 180), (30, 255, 200)),   # 8: Aurora
    ((40, 40, 40), (80, 80, 80), (150, 150, 200), (100, 100, 150)),   # 9: Void - grey
]

def gen_player_ship_v2(idx, colors, size=512):
    """Generate a detailed player ship with the given color scheme."""
    hull_c, hull_h, accent, engine_c = colors
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    cx = size // 2
    
    # Main hull - sleeker arrow shape
    hull = [
        (cx, 30),
        (cx + 40, 120),
        (cx + 70, 200),
        (cx + 120, 260),
        (cx + 130, 320),
        (cx + 70, 340),
        (cx + 45, 420),
        (cx + 25, 470),
        (cx - 25, 470),
        (cx - 45, 420),
        (cx - 70, 340),
        (cx - 130, 320),
        (cx - 120, 260),
        (cx - 70, 200),
        (cx - 40, 120),
    ]
    
    # Fill with gradient
    hull_img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    hull_draw = ImageDraw.Draw(hull_img)
    hull_draw.polygon(hull, fill=(*hull_c, 255))
    
    # Vertical gradient overlay
    grad = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    grad_draw = ImageDraw.Draw(grad)
    for i in range(size):
        t = i / size
        r = int(hull_c[0] + (hull_h[0] - hull_c[0]) * (1 - t) * 0.6)
        g = int(hull_c[1] + (hull_h[1] - hull_c[1]) * (1 - t) * 0.6)
        b = int(hull_c[2] + (hull_h[2] - hull_c[2]) * (1 - t) * 0.6)
        grad_draw.line([(0, i), (size, i)], fill=(r, g, b, 200))
    
    hull_img = Image.alpha_composite(hull_img, grad)
    mask = Image.new("L", (size, size), 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.polygon(hull, fill=255)
    hull_img.putalpha(mask)
    img = Image.alpha_composite(img, hull_img)
    draw = ImageDraw.Draw(img)
    
    # Cockpit - detailed with highlight
    cockpit_pts = [(cx - 25, 80), (cx + 25, 80), (cx + 20, 170), (cx - 20, 170)]
    draw.polygon(cockpit_pts, fill=(*accent, 220))
    # Cockpit inner glow
    draw.ellipse([cx - 15, 95, cx + 15, 150], fill=(*hull_h, 180))
    # Cockpit shine
    draw.ellipse([cx - 8, 100, cx + 5, 130], fill=(255, 255, 255, 200))
    
    # Wing details - accent stripes
    for side in [-1, 1]:
        # Wing edge accent
        draw.line([(cx + side * 70, 200), (cx + side * 120, 260), (cx + side * 130, 320)], 
                  fill=(*accent, 255), width=4)
        # Wing tip glow
        draw.ellipse([cx + side*120 - 15, 255, cx + side*120 + 15, 325], 
                      fill=(*accent, 200), outline=(255, 255, 255, 100))
    
    # Engine glow - dual engines
    for side in [-1, 1]:
        ex = cx + side * 30
        # Engine nacelle
        draw.ellipse([ex - 20, 440, ex + 20, 480], fill=(*hull_c, 255))
        draw.ellipse([ex - 15, 445, ex + 15, 475], fill=(*engine_c, 255))
        draw.ellipse([ex - 8, 450, ex + 8, 470], fill=(255, 255, 255, 255))
    
    # Panel lines
    for i in range(5):
        y = 200 + i * 35
        draw.line([(cx - 60, y), (cx + 60, y)], fill=(max(0, hull_c[0]-20), max(0, hull_c[1]-20), max(0, hull_c[2]-20), 80), width=1)
    
    # Wing markings
    for side in [-1, 1]:
        draw.polygon([(cx + side*90, 280), (cx + side*110, 290), (cx + side*90, 300)], 
                       fill=(*accent, 200))
    
    # Subtle noise texture
    arr = np.array(img).astype(np.float32)
    noise = (np.random.rand(*arr.shape[:2]) * 15 - 7.5).astype(np.float32)
    for c in range(3):
        arr[:, :, c] = np.clip(arr[:, :, c] + noise, 0, 255)
    img = Image.fromarray(arr.astype(np.uint8), "RGBA")
    img = img.filter(ImageFilter.GaussianBlur(0.3))
    
    save(img, f"player_ship_{idx}.png")

# Enemy ships - more variety, 6 types
def gen_enemy_scout(size=256):
    """Fast scout - small, agile, blue-grey."""
    s = size; img = Image.new("RGBA", (s, s), (0, 0, 0, 0)); draw = ImageDraw.Draw(img); cx = s//2
    body = [(cx, 30), (cx+35, 60), (cx+45, 120), (cx+25, 180), (cx-25, 180), (cx-45, 120), (cx-35, 60)]
    for i in range(s):
        t = i/s
        c = lerp_color((60, 70, 90), (30, 40, 60), t)
        draw.line([(0,i),(s,i)], fill=(*c, 0))
    hull_img = Image.new("RGBA", (s,s), (0,0,0,0))
    hd = ImageDraw.Draw(hull_img)
    hd.polygon(body, fill=(50, 60, 80, 255))
    mask = Image.new("L", (s,s), 0)
    ImageDraw.Draw(mask).polygon(body, fill=255)
    hull_img.putalpha(mask)
    img = Image.alpha_composite(img, hull_img)
    draw = ImageDraw.Draw(img)
    # Single eye
    draw.ellipse([cx-12, 70, cx+12, 100], fill=(100, 200, 255, 255))
    draw.ellipse([cx-5, 78, cx+5, 92], fill=(255, 255, 255, 255))
    # Wings
    for side in [-1, 1]:
        draw.polygon([(cx+side*45, 120), (cx+side*65, 160), (cx+side*40, 155)], fill=(40, 50, 70, 255))
    save(img, "enemy_scout.png")

def gen_enemy_fighter(size=256):
    """Fighter - aggressive, red-orange."""
    s = size; img = Image.new("RGBA", (s, s), (0, 0, 0, 0)); draw = ImageDraw.Draw(img); cx = s//2
    body = [(cx, 20), (cx+40, 50), (cx+55, 100), (cx+60, 160), (cx+35, 210), (cx-35, 210), (cx-60, 160), (cx-55, 100), (cx-40, 50)]
    hull_img = Image.new("RGBA", (s,s), (0,0,0,0))
    ImageDraw.Draw(hull_img).polygon(body, fill=(140, 40, 20, 255))
    mask = Image.new("L", (s,s), 0)
    ImageDraw.Draw(mask).polygon(body, fill=255)
    hull_img.putalpha(mask)
    img = Image.alpha_composite(img, hull_img)
    draw = ImageDraw.Draw(img)
    # Dual eyes
    for off in [-15, 15]:
        draw.ellipse([cx+off-10, 60, cx+off+10, 85], fill=(255, 100, 50, 255))
        draw.ellipse([cx+off-4, 67, cx+off+4, 78], fill=(255, 255, 200, 255))
    # Wing pods
    for side in [-1, 1]:
        draw.ellipse([cx+side*50-10, 140, cx+side*50+10, 180], fill=(80, 20, 10, 255))
    save(img, "enemy_fighter.png")

def gen_enemy_heavy(size=256):
    """Heavy bomber - large, purple, armored."""
    s = size; img = Image.new("RGBA", (s, s), (0, 0, 0, 0)); draw = ImageDraw.Draw(img); cx = s//2
    body = [(cx, 40), (cx+55, 80), (cx+75, 140), (cx+80, 200), (cx+50, 230), (cx-50, 230), (cx-80, 200), (cx-75, 140), (cx-55, 80)]
    hull_img = Image.new("RGBA", (s,s), (0,0,0,0))
    ImageDraw.Draw(hull_img).polygon(body, fill=(80, 30, 100, 255))
    mask = Image.new("L", (s,s), 0)
    ImageDraw.Draw(mask).polygon(body, fill=255)
    hull_img.putalpha(mask)
    img = Image.alpha_composite(img, hull_img)
    draw = ImageDraw.Draw(img)
    # Triple eyes
    for off in [-25, 0, 25]:
        draw.ellipse([cx+off-8, 90, cx+off+8, 115], fill=(200, 50, 255, 255))
        draw.ellipse([cx+off-3, 97, cx+off+3, 108], fill=(255, 200, 255, 255))
    # Armor plates
    for side in [-1, 1]:
        draw.ellipse([cx+side*60-15, 160, cx+side*60+15, 200], fill=(50, 15, 70, 255))
    save(img, "enemy_heavy.png")

def gen_enemy_elite(size=256):
    """Elite commander - gold, ornate."""
    s = size; img = Image.new("RGBA", (s, s), (0, 0, 0, 0)); draw = ImageDraw.Draw(img); cx = s//2
    body = [(cx, 20), (cx+25, 40), (cx+60, 90), (cx+70, 150), (cx+55, 210), (cx+25, 240), (cx-25, 240), (cx-55, 210), (cx-70, 150), (cx-60, 90), (cx-25, 40)]
    hull_img = Image.new("RGBA", (s,s), (0,0,0,0))
    ImageDraw.Draw(hull_img).polygon(body, fill=(180, 130, 20, 255))
    mask = Image.new("L", (s,s), 0)
    ImageDraw.Draw(mask).polygon(body, fill=255)
    hull_img.putalpha(mask)
    img = Image.alpha_composite(img, hull_img)
    draw = ImageDraw.Draw(img)
    # Crown spikes
    for i in range(-2, 3):
        draw.line([(cx + i*18, 40), (cx + i*18, 15)], fill=(255, 215, 0, 255), width=3)
    # Central core
    draw.ellipse([cx-18, 80, cx+18, 120], fill=(255, 215, 0, 255))
    draw.ellipse([cx-10, 88, cx+10, 112], fill=(255, 255, 220, 255))
    # Wing ornaments
    for side in [-1, 1]:
        draw.polygon([(cx+side*55, 150), (cx+side*75, 170), (cx+side*55, 190)], fill=(150, 100, 10, 255))
    save(img, "enemy_elite.png")

def gen_boss_v2(size=1024):
    """Detailed boss with multiple features."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    cx = size // 2
    body = [
        (cx, 60), (cx+80, 120), (cx+180, 220), (cx+300, 320),
        (cx+350, 440), (cx+280, 540), (cx+180, 640), (cx+100, 740),
        (cx, 780), (cx-100, 740), (cx-180, 640), (cx-280, 540),
        (cx-350, 440), (cx-300, 320), (cx-180, 220), (cx-80, 120),
    ]
    hull_img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(hull_img).polygon(body, fill=(50, 25, 70, 255))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).polygon(body, fill=255)
    hull_img.putalpha(mask)
    img = Image.alpha_composite(img, hull_img)
    draw = ImageDraw.Draw(img)
    # Core - multi-layer
    for r, col in [(100, (50, 100, 200)), (70, (100, 150, 255)), (40, (200, 100, 255)), (20, (255, 255, 255))]:
        draw.ellipse([cx-r, 380-r, cx+r, 380+r], fill=(*col, 255))
    # Turrets
    for tx, ty in [(cx+200, 300), (cx-200, 300), (cx+150, 500), (cx-150, 500)]:
        draw.ellipse([tx-35, ty-35, tx+35, ty+35], fill=(40, 20, 60, 255))
        draw.ellipse([tx-18, ty-18, tx+18, ty+18], fill=(255, 100, 200, 255))
    # Edge glow
    for side in [-1, 1]:
        draw.line([(cx, 60), (cx + side*80, 120), (cx + side*180, 220)], fill=(0, 255, 200, 200), width=5)
    save(img, "boss_v2.png")

# Scenery elements - asteroids, debris, space stations
def gen_asteroid(size=256):
    """Detailed rocky asteroid."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    cx = size // 2
    # Irregular shape
    points = []
    for angle in range(0, 360, 15):
        r = size * 0.4 + random.randint(-20, 20)
        x = cx + int(r * math.cos(math.radians(angle)))
        y = cx + int(r * math.sin(math.radians(angle)))
        points.append((x, y))
    hull_img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(hull_img).polygon(points, fill=(80, 70, 60, 255))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).polygon(points, fill=255)
    hull_img.putalpha(mask)
    img = Image.alpha_composite(img, hull_img)
    draw = ImageDraw.Draw(img)
    # Craters
    for _ in range(8):
        x = random.randint(size//4, 3*size//4)
        y = random.randint(size//4, 3*size//4)
        r = random.randint(5, 15)
        draw.ellipse([x-r, y-r, x+r, y+r], fill=(50, 45, 38, 200))
        draw.ellipse([x-r, y-r, x+r, y+r], outline=(100, 90, 75, 150))
    # Highlights
    for _ in range(5):
        x = random.randint(size//3, 2*size//3)
        y = random.randint(size//3, 2*size//3)
        r = random.randint(3, 8)
        draw.ellipse([x-r, y-r, x+r, y+r], fill=(120, 110, 95, 150))
    save(img, "asteroid.png")

def gen_space_debris(size=128):
    """Small metallic debris."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    for _ in range(5):
        x1 = random.randint(10, size-10)
        y1 = random.randint(10, size-10)
        x2 = x1 + random.randint(-20, 20)
        y2 = y1 + random.randint(-20, 20)
        draw.line([(x1, y1), (x2, y2)], fill=(100, 100, 110, 200), width=random.randint(1, 3))
    save(img, "debris.png")

def gen_ammo_pickup(size=128):
    """Ammo pickup - blue energy cell."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    cx = size // 2
    for r, alpha in [(50, 50), (40, 100), (30, 150), (20, 200)]:
        draw.ellipse([cx-r, cx-r, cx+r, cx+r], fill=(0, 150, 255, alpha))
    draw.ellipse([cx-12, cx-12, cx+12, cx+12], fill=(200, 240, 255, 255))
    # Bullet icon
    draw.ellipse([cx-5, cx-20, cx+5, cx+20], fill=(255, 255, 255, 255))
    save(img, "powerup_ammo.png")

def gen_coin_pickup(size=128):
    """Coin pickup for scoring/money."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    cx = size // 2
    for r, alpha in [(50, 50), (40, 100), (30, 200)]:
        draw.ellipse([cx-r, cx-r, cx+r, cx+r], fill=(255, 200, 0, alpha))
    draw.ellipse([cx-20, cx-20, cx+20, cx+20], fill=(255, 215, 0, 255))
    draw.ellipse([cx-15, cx-15, cx+15, cx+15], outline=(255, 255, 200, 255), width=2)
    # Star symbol
    for i in range(5):
        angle = -90 + i * 72
        x = cx + int(10 * math.cos(math.radians(angle)))
        y = cx + int(10 * math.sin(math.radians(angle)))
        draw.ellipse([x-2, y-2, x+2, y+2], fill=(255, 255, 200, 255))
    save(img, "powerup_coin.png")

def gen_magnet_pickup(size=128):
    """Magnet pickup - attracts items."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    cx = size // 2
    for r, alpha in [(50, 50), (40, 100), (30, 200)]:
        draw.ellipse([cx-r, cx-r, cx+r, cx+r], fill=(255, 50, 200, alpha))
    draw.ellipse([cx-15, cx-15, cx+15, cx+15], fill=(255, 200, 255, 255))
    # Magnet U shape
    draw.arc([cx-18, cx-15, cx+18, cx+20], 180, 360, fill=(255, 255, 255, 255), width=4)
    save(img, "powerup_magnet.png")

def main():
    random.seed(42); np.random.seed(42)
    print("Generating v2 textures...")
    
    # 10 player ships (one per level)
    print("  Player ships (10)...")
    for i, colors in enumerate(PLAYER_SHIP_COLORS):
        gen_player_ship_v2(i, colors)
    
    # New enemy types
    print("  Enemy ships...")
    gen_enemy_scout()
    gen_enemy_fighter()
    gen_enemy_heavy()
    gen_enemy_elite()
    gen_boss_v2()
    
    # Scenery
    print("  Scenery...")
    gen_asteroid()
    gen_space_debris()
    
    # New power-ups
    print("  New power-ups...")
    gen_ammo_pickup()
    gen_coin_pickup()
    gen_magnet_pickup()
    
    print("\nAll v2 textures generated!")

if __name__ == "__main__":
    main()
