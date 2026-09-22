"""Build dark-themed shaded-relief raster tiles from Natural Earth GRAY_50M_SR_OB.

usage: uv run --with pillow --with numpy python scripts/build_tiles.py path/to/GRAY_50M_SR_OB.tif
Writes static/tiles/{z}/{x}/{y}.jpg (512px tiles, z0-4).
"""
import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

Image.MAX_IMAGE_PIXELS = None
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "static" / "tiles"
TILE = 512
MAXZ = 4

LAND_LO, LAND_HI = np.array([20, 21, 26]), np.array([118, 120, 128])     # dark warm grey relief
OCEAN_LO, OCEAN_HI = np.array([4, 7, 14]), np.array([34, 46, 74])      # deep blue-black seabed


def land_mask(w, h):
    g = json.load(open(ROOT / "static" / "data" / "ne_50m_admin_0_countries.geojson"))
    img = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(img)
    to_px = lambda ring: [((x + 180) / 360 * w, (90 - y) / 180 * h) for x, y in ring]
    for f in g["features"]:
        geom = f["geometry"]
        polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
        for poly in polys:
            d.polygon(to_px(poly[0]), fill=255)
            for hole in poly[1:]:
                d.polygon(to_px(hole), fill=0)
    return np.asarray(img) > 127


def main(tif):
    src = Image.open(tif).convert("L")
    w, h = src.size
    print("source", w, h, flush=True)
    g = np.asarray(src).astype(np.float32) / 255.0
    # boost relief contrast a little
    g = np.clip((g - 0.5) * 1.9 + 0.5, 0, 1)
    mask = land_mask(w, h)
    print("land fraction", round(mask.mean(), 3), flush=True)
    rgb = np.empty((h, w, 3), dtype=np.uint8)
    for c in range(3):
        land = LAND_LO[c] + (LAND_HI[c] - LAND_LO[c]) * g
        ocean = OCEAN_LO[c] + (OCEAN_HI[c] - OCEAN_LO[c]) * g
        rgb[..., c] = np.where(mask, land, ocean).astype(np.uint8)
    full = Image.fromarray(rgb, "RGB")
    del g, rgb

    for z in range(MAXZ + 1):
        n = 2 ** z
        world = n * TILE
        eq = np.asarray(full.resize((world, world // 2), Image.LANCZOS))
        # mercator row -> equirectangular row lookup
        gy = np.arange(world)
        lat = np.degrees(np.arctan(np.sinh(math.pi * (1 - 2 * (gy + 0.5) / world))))
        rows = np.clip(((90 - lat) / 180 * (world // 2)).astype(int), 0, world // 2 - 1)
        merc = eq[rows]  # (world, world, 3)
        for x in range(n):
            for y in range(n):
                tile = merc[y * TILE:(y + 1) * TILE, x * TILE:(x + 1) * TILE]
                p = OUT / str(z) / str(x)
                p.mkdir(parents=True, exist_ok=True)
                Image.fromarray(tile, "RGB").save(p / f"{y}.jpg", quality=82, optimize=True)
        print("zoom", z, "done", n * n, "tiles", flush=True)
    # a single equirectangular preview for the globe fallback / debugging
    full.resize((4096, 2048), Image.LANCZOS).save(OUT / "world-equirect.jpg", quality=85)
    print("finished", flush=True)


if __name__ == "__main__":
    main(sys.argv[1])
