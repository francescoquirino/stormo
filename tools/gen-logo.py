"""Renders Stormo's assets/logo.svg: a flock of dots forming an S, on a midnight-blue square."""
import math, pathlib
ROOT = pathlib.Path(__file__).resolve().parent.parent

def bez(p0, p1, p2, p3, t):
    u = 1 - t
    return tuple(u**3*a + 3*u*u*t*b + 3*u*t*t*c + t**3*d for a, b, c, d in zip(p0, p1, p2, p3))

# The S goes from bottom-left to top-right (the flock "climbs"): two Bézier curves.
A = [(8.2, 23.4), (16.5, 26.6), (22.4, 21.0), (16.0, 16.0)]
B = [(16.0, 16.0), (9.6, 11.0), (15.6, 5.4), (23.8, 8.6)]
N = 13
# Sample densely, then take evenly spaced points along the curve (the flock's constant stride).
dense = [bez(*A, k / 400) for k in range(401)] + [bez(*B, k / 400) for k in range(1, 401)]
acc = [0.0]
for (x0, y0), (x1, y1) in zip(dense, dense[1:]): acc.append(acc[-1] + math.hypot(x1 - x0, y1 - y0))
pts, j = [], 0
for i in range(N):
    target = acc[-1] * i / (N - 1)
    while j < len(acc) - 1 and acc[j] < target: j += 1
    pts.append(dense[j])
cols = ['#a78bfa', '#8b7cf8', '#6f86f7', '#5b8ff6', '#4c9af3', '#3fa7ef', '#33b5ea', '#2bc3e6', '#25cfe4', '#22d8e8', '#3ee0ec', '#67e8f0', '#9af0f5']
dots = []
for i, (x, y) in enumerate(pts):
    r = 0.7 + 0.85 * math.sin(math.pi * (i + 1.4) / (N + 1.2)) ** 1.3  # small at the ends, large in the middle
    if i == N - 1: r = 1.55  # the leader
    dots.append(f'<circle cx="{x:.2f}" cy="{y:.2f}" r="{r:.2f}" fill="{cols[i]}"/>')
svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="1024" height="1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1b1748"/><stop offset=".55" stop-color="#0e1438"/><stop offset="1" stop-color="#081a33"/></linearGradient>
    <radialGradient id="glow" cx=".62" cy=".38" r=".62"><stop offset="0" stop-color="#5b6cff" stop-opacity=".45"/><stop offset="1" stop-color="#5b6cff" stop-opacity="0"/></radialGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#b9a8ff" stop-opacity=".7"/><stop offset="1" stop-color="#3fe0ec" stop-opacity=".5"/></linearGradient>
  </defs>
  <rect x="1" y="1" width="30" height="30" rx="8.5" fill="url(#bg)"/>
  <rect x="1" y="1" width="30" height="30" rx="8.5" fill="url(#glow)"/>
  <rect x="1.35" y="1.35" width="29.3" height="29.3" rx="8.2" fill="none" stroke="url(#rim)" stroke-width=".45"/>
  {chr(10).join("  " + d for d in dots)}
</svg>
'''
(ROOT / 'assets' / 'logo.svg').write_text(svg)
print('ok', len(pts), 'puntini')
