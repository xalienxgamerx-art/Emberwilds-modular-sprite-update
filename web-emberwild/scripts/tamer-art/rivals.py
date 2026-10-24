# Download the 12 generated rival-tamer sprites and process them to the
# townsfolk sprite spec: trim transparent margins, scale to height 320,
# save as public/tamers/rival_<n>.png (t1 -> rival_1 ... t12 -> rival_12).
#
#   python3 scripts/tamer-art/rivals.py
import io
import urllib.request

from PIL import Image

# R2 URLs returned by generateImageAsset (2026-10-22), in tamer order t1..t12.
SOURCES = [
    "https://99bbvwtw7u5419o9ce6j1.rork.app/~assets/img/11f70f3a-a595-4f3e-ad9f-4a05c014a8d1.png",
    "https://99bbvwtw7u5419o9ce6j1.rork.app/~assets/img/da321916-e4ab-4273-b4fb-91fd7721a1d1.png",
    "https://99bbvwtw7u5419o9ce6j1.rork.app/~assets/img/3f5562e9-6aed-454c-9479-e6b3f2287d47.png",
    "https://99bbvwtw7u5419o9ce6j1.rork.app/~assets/img/6fab20cb-7391-400b-a81d-981e1278029b.png",
    "https://99bbvwtw7u5419o9ce6j1.rork.app/~assets/img/37cf322e-f15e-4074-8cb8-6f572238fc72.png",
    "https://99bbvwtw7u5419o9ce6j1.rork.app/~assets/img/d63712eb-8a92-4830-a1c2-db1f8e53c79a.png",
    "https://99bbvwtw7u5419o9ce6j1.rork.app/~assets/img/c96b0a13-e861-407b-90d3-d01925d17393.png",
    "https://99bbvwtw7u5419o9ce6j1.rork.app/~assets/img/a4d7d452-d931-4641-b4be-3a04e7bc4aaf.png",
    "https://99bbvwtw7u5419o9ce6j1.rork.app/~assets/img/71af1640-dbb3-4e2f-9fba-ec179fc361e8.png",
    "https://99bbvwtw7u5419o9ce6j1.rork.app/~assets/img/f39d8e21-8b4f-4b31-ad65-e2b51ed9693c.png",
    "https://99bbvwtw7u5419o9ce6j1.rork.app/~assets/img/69e12af3-bcb8-4d35-9a7d-fa65f3ed1045.png",
    "https://99bbvwtw7u5419o9ce6j1.rork.app/~assets/img/3fd7a995-0466-4913-a600-73e624d07768.png",
]

OUT = "public/tamers"


def alpha_bbox(im: Image.Image) -> tuple[int, int, int, int]:
    a = im.getchannel("A")
    lo, hi = a.getextrema()
    if hi == 0:
        return (0, 0, im.width, im.height)
    return a.getbbox()


for n, url in enumerate(SOURCES, start=1):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    raw = urllib.request.urlopen(req, timeout=60).read()
    im = Image.open(io.BytesIO(raw)).convert("RGBA")
    box = alpha_bbox(im)
    im = im.crop(box)
    h = 320
    w = max(1, round(im.width * h / im.height))
    im = im.resize((w, h), Image.LANCZOS)
    path = f"{OUT}/rival_{n}.png"
    im.save(path)
    print(f"rival_{n}.png  {im.width}x{im.height}")
