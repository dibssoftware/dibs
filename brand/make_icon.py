# Draws the dibs icon's layers: a take-a-number ticket stub, and its
# perforation, as separate layers for Icon Composer's glass.
import sys
from PIL import Image, ImageDraw

out = sys.argv[1]
S = 1024
SS = 4  # supersample, then downscale for clean edges

def canvas():
    return Image.new("RGBA", (S * SS, S * SS), (0, 0, 0, 0))

def save(img, name):
    img.resize((S, S), Image.LANCZOS).save(f"{out}/{name}")

# Ticket body: wide rounded rectangle with a half-circle bite out of each side.
w, h = 700, 420
x0, y0 = (S - w) // 2, (S - h) // 2 + 10
img = canvas()
d = ImageDraw.Draw(img)
k = SS
d.rounded_rectangle([x0 * k, y0 * k, (x0 + w) * k, (y0 + h) * k], radius=44 * k, fill=(255, 176, 0, 255))
r = 58
cy = y0 + h // 2
for cx in (x0, x0 + w):
    d.ellipse([(cx - r) * k, (cy - r) * k, (cx + r) * k, (cy + r) * k], fill=(0, 0, 0, 0))
# The stub is torn off along a perforation a third of the way in.
px = x0 + 236
hole = 13
y = y0 + 34
while y + hole * 2 < y0 + h - 30:
    d.ellipse([(px - hole) * k, y * k, (px + hole) * k, (y + hole * 2) * k], fill=(0, 0, 0, 0))
    y += 50
save(img, "ticket.png")

# Three bars on the big half: a short queue, read left to right.
img = canvas()
d = ImageDraw.Draw(img)
bx = px + 80
for i, length in enumerate((300, 230, 160)):
    by = y0 + 118 + i * 72
    d.rounded_rectangle([bx * k, by * k, (bx + length) * k, (by + 36) * k], radius=18 * k, fill=(240, 40, 30, 255))
save(img, "queue.png")
