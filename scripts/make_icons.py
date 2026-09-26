#!/usr/bin/env python3
"""Generate the toolbar icons (a Catppuccin Mocha moon) without any image libraries."""
import math, struct, zlib, os

BASE = (30, 30, 46)      # #1e1e2e
MAUVE = (203, 166, 247)  # #cba6f7
SS = 4  # supersampling

def moon_alpha(x, y, size):
    """Return (coverage of circle, coverage of moon) at pixel (x, y) with supersampling."""
    r = size / 2.0
    cx = cy = r
    circle = 0
    moon = 0
    for i in range(SS):
        for j in range(SS):
            px = x + (i + 0.5) / SS
            py = y + (j + 0.5) / SS
            d = math.hypot(px - cx, py - cy)
            if d <= r - 0.5:
                circle += 1
                # moon: inside big disc, outside a shifted disc
                mr = r * 0.62
                mcx, mcy = cx + r * 0.02, cy
                bite_cx, bite_cy, bite_r = mcx + mr * 0.55, mcy - mr * 0.35, mr * 0.85
                if math.hypot(px - mcx, py - mcy) <= mr and math.hypot(px - bite_cx, py - bite_cy) > bite_r:
                    moon += 1
    n = SS * SS
    return circle / n, moon / n

def png(size):
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            c, m = moon_alpha(x, y, size)
            if c == 0:
                row += bytes([0, 0, 0, 0])
                continue
            col = tuple(int(BASE[k] * (1 - m) + MAUVE[k] * m) for k in range(3))
            row += bytes([col[0], col[1], col[2], int(255 * c)])
        rows.append(bytes(row))
    raw = b''.join(rows)
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')

out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'icons')
os.makedirs(out, exist_ok=True)
for s in (16, 32, 48, 128):
    with open(os.path.join(out, f'icon{s}.png'), 'wb') as f:
        f.write(png(s))
    print('wrote', f'icon{s}.png')
