"""Render the product's geometric bookmark/keyhole icon. Requires Pillow."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent
icons = root / 'public' / 'icons'
icons.mkdir(parents=True, exist_ok=True)
green, ivory = '#335A49', '#F3F0DE'
svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<title>Veil Bookmark — private bookmarks</title>
<rect width="64" height="64" rx="15" fill="{green}"/>
<path d="M18 11H46V54L32 45L18 54Z" fill="{ivory}"/>
<circle cx="32" cy="26" r="5" fill="{green}"/>
<path d="M29 29H35L37 37H27Z" fill="{green}"/>
</svg>'''
(icons / 'icon.svg').write_text(svg, encoding='utf8')
for size in (16, 32, 48, 128):
    scale = 8
    n = size * scale
    k = n / 64
    image = Image.new('RGBA', (n, n))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((0, 0, n-1, n-1), radius=15*k, fill=green)
    draw.polygon([(x*k,y*k) for x,y in [(18,11),(46,11),(46,54),(32,45),(18,54)]], fill=ivory)
    draw.ellipse((27*k,21*k,37*k,31*k), fill=green)
    draw.polygon([(x*k,y*k) for x,y in [(29,29),(35,29),(37,37),(27,37)]], fill=green)
    image.resize((size,size),Image.Resampling.LANCZOS).save(icons / f'{size}.png')
print('Generated SVG and 16 / 32 / 48 / 128 px product icons.')
