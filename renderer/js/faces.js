// Agent faces: colored shape + two eyes, with a status "badge" in the bottom right.

export const FACE_COLORS = ['#ff6b5c', '#34d399', '#38bdf8', '#f59e0b', '#a78bfa', '#f472b6', '#facc15', '#60a5fa', '#fb923c', '#2dd4bf'];
export const FACE_SHAPES = ['blob', 'triangle', 'hexagon', 'square', 'circle', 'diamond', 'shield'];
export const FACE_EYES = ['tall', 'wide', 'round', 'dot'];

const SHAPES = {
  blob: 'M50 4C77 4 96 17 96 45c0 31-15 51-46 51C19 96 4 78 4 50 4 21 22 4 50 4z',
  triangle: 'M40.4 13.6Q50 -2 59.6 13.6L91.6 70.4Q101 88 80 92L20 92Q-1 88 8.4 70.4Z',
  hexagon: 'M27 6h46q7 0 10.5 6l12.5 32q2.5 6 0 12L83.5 88q-3.5 6-10.5 6H27q-7 0-10.5-6L4 56q-2.5-6 0-12l12.5-32Q20 6 27 6z',
  square: 'M24 5h52q19 0 19 19v52q0 19-19 19H24Q5 95 5 76V24Q5 5 24 5z',
  circle: 'M50 4a46 46 0 1 1 0 92a46 46 0 1 1 0-92z',
  diamond: 'M43 7.5q7-7 14 0l35.5 35.5q7 7 0 14L57 92.5q-7 7-14 0L7.5 57q-7-7 0-14z',
  shield: 'M50 4l38 12q5 2 5 7v22c0 27-18 45-43 51C25 90 7 72 7 45V23q0-5 5-7z',
};

const EYES = {
  tall: [[30, 38, 11.5, 22, 5.75], [58.5, 38, 11.5, 22, 5.75]],
  wide: [[25.5, 55, 17, 7.5, 3.75], [57.5, 55, 17, 7.5, 3.75]],
  round: [[28, 42, 16, 16, 8], [56, 42, 16, 16, 8]],
  dot: [[31, 46, 10, 10, 5], [59, 46, 10, 10, 5]],
};

function hash(s) {
  let h = 2166136261;
  for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function randomLook(seed = Math.random().toString(36)) {
  const h = hash(seed);
  return {
    shape: FACE_SHAPES[h % FACE_SHAPES.length],
    color: FACE_COLORS[(h >>> 5) % FACE_COLORS.length],
    eyes: FACE_EYES[(h >>> 11) % FACE_EYES.length],
  };
}

let maskSeq = 0;
const STATE_COLOR = { working: 'var(--run)', needsYou: 'var(--warn)', failed: 'var(--fail)' };

// look = {shape,color,eyes}; size in px; optional state → colored badge.
export function face(look, size = 30, state = null) {
  const lk = look || randomLook('x');
  const path = SHAPES[lk.shape] || SHAPES.blob;
  const eyes = (EYES[lk.eyes] || EYES.tall)
    .map(([x, y, w, hh, r]) => `<rect x="${x}" y="${y}" width="${w}" height="${hh}" rx="${r}" fill="rgba(0,0,0,0.78)"/>`).join('');
  const badge = STATE_COLOR[state];
  if (!badge) {
    return `<svg class="face" viewBox="0 0 100 100" style="width:${size}px;height:${size}px" aria-hidden="true"><path d="${path}" fill="${lk.color}"/>${eyes}</svg>`;
  }
  const id = 'fm-face-m' + (++maskSeq);
  return `<svg class="face" viewBox="0 0 100 100" style="width:${size}px;height:${size}px" aria-hidden="true">`
    + `<mask id="${id}" maskUnits="userSpaceOnUse"><rect x="-10" y="-10" width="120" height="120" fill="#fff"/><circle cx="91.5" cy="91.5" r="21.5" fill="#000"/></mask>`
    + `<g mask="url(#${id})"><path d="${path}" fill="${lk.color}"/>${eyes}</g>`
    + `<circle cx="91.5" cy="91.5" r="15" fill="${badge}"/></svg>`;
}
