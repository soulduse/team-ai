#!/usr/bin/env python3
"""Render the README's dashboard screenshot.

The TUI is text and colored gauges, so the illustration is generated rather
than captured: that keeps real account labels out of the repository while
still showing the exact layout src/tui.ts produces. Account names are drawn
as redaction blocks, the way the original screenshot was shared.
"""
from PIL import Image, ImageDraw, ImageFont
import random

SCALE = 2  # render at 2x for a crisp image on high-DPI displays

# Palette: the terminal theme the screenshot was taken in.
BG = (30, 32, 38)
FG = (208, 212, 220)
DIM = (128, 134, 146)
TEAL = (108, 190, 185)
YELLOW = (200, 200, 110)
GAUGE_BG = (90, 94, 102)
GAUGE_OLIVE = (176, 185, 96)
GAUGE_RED = (206, 106, 106)
WHITE = (236, 238, 242)

CH_W, CH_H = 9 * SCALE, 21 * SCALE          # monospace cell
PAD = 14 * SCALE
COLS, ROWS = 156, 27
W, H = COLS * CH_W + PAD * 2, ROWS * CH_H + PAD * 2

font = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 13 * SCALE)
bold = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 13 * SCALE, index=1)

img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)


def xy(col, row):
    return PAD + col * CH_W, PAD + row * CH_H


def text(col, row, s, fill=FG, f=font):
    d.text(xy(col, row), s, font=f, fill=fill)


def redact(col, row, cells, seed, limit=None):
    """Draw a blurred-looking name: uneven blocks, like the shared screenshot."""
    rng = random.Random(seed)
    if limit is not None:               # never bleed into the next column
        cells = min(cells, limit - col - 1)
    x, y = xy(col, row)
    cx = x
    for _ in range(cells):
        if rng.random() < 0.18:                      # gap between "words"
            cx += CH_W
            continue
        w = CH_W - 1 * SCALE
        h = rng.randint(8, 12) * SCALE
        top = y + (CH_H - h) // 2 + rng.randint(-1, 1) * SCALE
        g = rng.randint(96, 150)
        d.rectangle([cx, top, cx + w, top + h], fill=(g, g, g + rng.randint(0, 6)))
        cx += CH_W


def gauge(col, row, cells, ratio, label, color):
    """A usage bar: filled portion in `color`, centered label, like bar() in tui.ts."""
    x, y = xy(col, row)
    w = cells * CH_W
    top, bot = y + 1 * SCALE, y + CH_H - 2 * SCALE
    d.rectangle([x, top, x + w, bot], fill=GAUGE_BG)
    if ratio > 0:
        d.rectangle([x, top, x + int(w * ratio), bot], fill=color)
    # Right-aligned, as in the TUI: the number stays readable whatever the fill
    # boundary is doing behind it.
    tw = d.textlength(label, font=font)
    d.text((x + w - tw - CH_W * 0.6, y), label, font=font, fill=WHITE)


def panel(col, row, cells, rows_n, title):
    """A titled box, drawn with the same corner glyphs the TUI uses."""
    x, y = xy(col, row)
    w, h = cells * CH_W, rows_n * CH_H
    d.line([x, y + CH_H // 2, x, y + h], fill=TEAL, width=SCALE)
    d.line([x, y + h, x + w, y + h], fill=TEAL, width=SCALE)
    d.line([x + w, y + CH_H // 2, x + w, y + h], fill=TEAL, width=SCALE)
    d.line([x, y + CH_H // 2, x + CH_W, y + CH_H // 2], fill=TEAL, width=SCALE)
    text(col + 2, row, title, TEAL, bold)
    tw = d.textlength(title, font=bold)
    d.line([x + 2 * CH_W + tw + CH_W // 2, y + CH_H // 2, x + w, y + CH_H // 2],
           fill=TEAL, width=SCALE)


# ── header ───────────────────────────────────────────────────────────────────
text(1, 0, "TeamAI", WHITE, bold)
hx, hy = xy(0, 1)
d.line([hx, hy + CH_H // 2, hx + COLS * CH_W, hy + CH_H // 2], fill=WHITE, width=SCALE)

# ── Claude group ─────────────────────────────────────────────────────────────
panel(1, 3, COLS - 3, 11, "Claude accounts (8)")

COL_PLAN, COL_STATE, COL_ORDER = 28, 40, 51
G1, G2, G3 = 58, 76, 94          # gauge columns
GW = 17                          # gauge width in cells

text(3, 4, "account", DIM)
text(COL_PLAN, 4, "plan", DIM)
text(COL_STATE, 4, "state", DIM)
text(COL_ORDER, 4, "order", DIM)
text(G1, 4, "5h session", DIM)
text(G2, 4, "7d overall", DIM)
text(G3, 4, "7d Fable", DIM)

claude = [
    # plan,     name cells, 5h,                 7d overall,          7d Fable
    ("Max 20x", 22, (0.09, "9% 1h22m"), (0.02, "2% 6d15h"),   (0.01, "1% 6d15h")),
    ("Max 20x", 24, (0.08, "8% 1h2m"),  (0.58, "58% 11h22m"), (1.00, "100% 11h22m")),
    ("Max 5x",  19, (0.08, "8% 32m"),   (0.58, "58% 1d3h"),   (1.00, "100% 1d3h")),
    ("Max 20x", 26, (0.00, "0% 52m"),   (0.54, "54% 3d11h"),  (1.00, "100% 3d11h")),
    ("Max 20x", 21, (0.00, "0% 52m"),   (0.52, "52% 3d12h"),  (1.00, "100% 3d12h")),
    ("Max 20x", 23, (0.00, "0% 52m"),   (0.52, "52% 3d17h"),  (1.00, "100% 3d17h")),
    ("Max 20x", 25, (0.00, "0% 52m"),   (0.50, "50% 4d9h"),   (1.00, "100% 4d9h")),
    ("Max 20x", 27, (None, "-"),        (0.50, "50% 5d15h"),  (1.00, "100% 5d15h")),
]

for i, (plan, cells, w5, w7, wf) in enumerate(claude):
    r = 5 + i
    if i == 0:
        text(1, r, ">", TEAL)
    redact(3, r, cells, seed=i, limit=COL_PLAN)
    text(COL_PLAN, r, plan)
    text(COL_STATE, r, "active", YELLOW)
    text(COL_ORDER, r, "auto")
    ratio, label = w5
    if ratio is None:                        # unmeasured: gauge with a bare dash
        gauge(G1, r, GW, 0, label, GAUGE_BG)
    else:
        gauge(G1, r, GW, ratio, label, GAUGE_OLIVE)
    gauge(G2, r, GW, w7[0], w7[1], GAUGE_OLIVE)
    gauge(G3, r, GW, wf[0], wf[1], GAUGE_RED if wf[0] >= 1.0 else GAUGE_OLIVE)

# ── Codex group ──────────────────────────────────────────────────────────────
panel(1, 16, COLS - 3, 7, "Codex accounts (4)")

text(3, 17, "account", DIM)
text(COL_PLAN, 17, "plan", DIM)
text(COL_STATE, 17, "state", DIM)
text(COL_ORDER, 17, "order", DIM)
text(G1, 17, "1w limit", DIM)

codex = [
    ("Pro",      21, "100% 1d23h"),
    ("Pro Lite", 25, "100% 3d1h"),
    ("Pro Lite", 23, "100% 5d3h"),
    ("Pro Lite", 26, "100% 5d7h"),
]

for i, (plan, cells, label) in enumerate(codex):
    r = 18 + i
    redact(3, r, cells, seed=100 + i, limit=COL_PLAN)
    text(COL_PLAN, r, plan)
    text(COL_STATE, r, "active", YELLOW)
    text(COL_ORDER, r, "auto")
    gauge(G1, r, GW, 1.0, label, GAUGE_RED)

# ── footer ───────────────────────────────────────────────────────────────────
fy = 24
text(1, fy, " 1 Claude   2 Codex   ↑↓ select   s switch   e enable   o order   "
            "d delete   a add   R Reload   c config-sort   q quit", DIM)

img.resize((W // SCALE, H // SCALE), Image.LANCZOS).save("docs/dashboard.png")
print(f"wrote docs/dashboard.png ({W // SCALE}x{H // SCALE})")
