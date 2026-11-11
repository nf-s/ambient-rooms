// Rose window geometry: a central oculus and three rings of eight panes.
// Sizes are fractions of the window radius; layouts are in CSS pixels.

export const PETALS = 8;
export const RINGS = 3;
export const DEGREES = PETALS - 1;

const HALF = Math.PI / PETALS;
const TOP = -Math.PI / 2;
const TWO_PI = Math.PI * 2;

// Each ring is a band of rounded cells between thin mullions. The middle ring
// is turned half a pane so its mullions meet the centres of its neighbours.
// Cusps are stone points hanging into the outer edge, giving foiled ends.
const BANDS = [
  { inner: 0.178, outer: 0.412, innerCorner: 0.06, outerCorner: 0.085, offset: 0, cusps: [], cuspDepth: 0 },
  { inner: 0.44, outer: 0.682, innerCorner: 0.06, outerCorner: 0.1, offset: HALF, cusps: [0], cuspDepth: 0.05 },
  { inner: 0.71, outer: 0.958, innerCorner: 0.05, outerCorner: 0.09, offset: 0, cusps: [-0.44, 0.44], cuspDepth: 0.042 },
];

const OCULUS = { lobeCentre: 0.085, lobeRadius: 0.05, hit: 0.168 };
const HIT_EDGES = [0.426, 0.696, 1.0];
const CORE_MARGIN = 0.022;
const INCISED = [0.157, 0.426, 0.696, 0.981];

export function createPanes() {
  const panes = [];
  for (let ring = 0; ring < RINGS; ring += 1) {
    for (let petal = 0; petal < PETALS; petal += 1) {
      panes.push({ index: panes.length, ring, petal, ladderIndex: ring * DEGREES + petal });
    }
  }
  return panes;
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

// A ring cell with constant-width mullions and filleted corners. Traversed with
// increasing angle so every convex corner is drawn clockwise in canvas terms.
function cellPath(cx, cy, angle, band, radius, gap) {
  const rIn = band.inner * radius;
  const rOut = band.outer * radius;
  const cIn = band.innerCorner * radius;
  const cOut = band.outerCorner * radius;
  const half = gap / 2;
  const side = HALF + Math.PI / 2;
  const sOut = rOut - cOut;
  const psiOut = HALF - Math.asin((half + cOut) / sOut);
  const sIn = rIn + cIn;
  const psiIn = HALF - Math.asin((half + cIn) / sIn);
  const path = new Path2D();

  path.arc(
    cx + sOut * Math.cos(angle - psiOut),
    cy + sOut * Math.sin(angle - psiOut),
    cOut,
    angle - side,
    angle - psiOut,
  );
  path.arc(cx, cy, rOut, angle - psiOut, angle + psiOut);
  path.arc(
    cx + sOut * Math.cos(angle + psiOut),
    cy + sOut * Math.sin(angle + psiOut),
    cOut,
    angle + psiOut,
    angle + side,
  );
  path.arc(
    cx + sIn * Math.cos(angle + psiIn),
    cy + sIn * Math.sin(angle + psiIn),
    cIn,
    angle + side,
    angle + psiIn + Math.PI,
  );
  path.arc(cx, cy, rIn, angle + psiIn, angle - psiIn, true);
  path.arc(
    cx + sIn * Math.cos(angle - psiIn),
    cy + sIn * Math.sin(angle - psiIn),
    cIn,
    angle - psiIn + Math.PI,
    angle - side + TWO_PI,
  );
  path.closePath();
  return path;
}

// A stone cusp: a concave-sided point hanging inward from the outer edge.
function addCusp(path, cx, cy, angle, rOut, depth, gap) {
  const spread = (depth * 1.25) / rOut;
  const base = rOut + gap * 0.6;
  const shoulder = rOut - depth * 0.2;
  const tip = rOut - depth;
  const point = (r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const [bx0, by0] = point(base, angle - spread);
  const [qx0, qy0] = point(shoulder, angle - spread * 0.2);
  const [tx, ty] = point(tip, angle);
  const [qx1, qy1] = point(shoulder, angle + spread * 0.2);
  const [bx1, by1] = point(base, angle + spread);
  path.moveTo(bx0, by0);
  path.quadraticCurveTo(qx0, qy0, tx, ty);
  path.quadraticCurveTo(qx1, qy1, bx1, by1);
  path.closePath();
}

// An eight-lobed foil for the oculus glass.
function foilPath(cx, cy, radius) {
  const centre = OCULUS.lobeCentre * radius;
  const lobe = OCULUS.lobeRadius * radius;
  const step = TWO_PI / PETALS;
  const cusp =
    centre * Math.cos(step / 2) + Math.sqrt(lobe ** 2 - (centre * Math.sin(step / 2)) ** 2);
  const path = new Path2D();
  for (let index = 0; index < PETALS; index += 1) {
    const phi = TOP + index * step;
    const lx = cx + centre * Math.cos(phi);
    const ly = cy + centre * Math.sin(phi);
    const start = Math.atan2(
      cy + cusp * Math.sin(phi - step / 2) - ly,
      cx + cusp * Math.cos(phi - step / 2) - lx,
    );
    const end = Math.atan2(
      cy + cusp * Math.sin(phi + step / 2) - ly,
      cx + cusp * Math.cos(phi + step / 2) - lx,
    );
    path.arc(lx, ly, lobe, start, end);
  }
  path.closePath();
  return path;
}

function cellBounds(cx, cy, angle, rIn, rOut) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let step = 0; step <= 12; step += 1) {
    const a = angle - HALF + (step / 12) * 2 * HALF;
    for (const r of [rIn, rOut]) {
      const x = cx + r * Math.cos(a);
      const y = cy + r * Math.sin(a);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  const x = Math.floor(minX - 2);
  const y = Math.floor(minY - 2);
  return { x, y, w: Math.ceil(maxX + 2) - x, h: Math.ceil(maxY + 2) - y };
}

export function layoutWindow(panes, cx, cy, radius) {
  const gap = Math.max(2.5, radius * 0.022);
  const cusps = new Path2D();
  const shapes = panes.map((pane) => {
    const band = BANDS[pane.ring];
    const angle = TOP + band.offset + pane.petal * 2 * HALF;
    const rIn = band.inner * radius;
    const rOut = band.outer * radius;
    let own = null;
    if (band.cusps.length > 0) {
      own = new Path2D();
      for (const fraction of band.cusps) {
        const cuspAngle = angle + fraction * HALF;
        addCusp(own, cx, cy, cuspAngle, rOut, band.cuspDepth * radius, gap);
        addCusp(cusps, cx, cy, cuspAngle, rOut, band.cuspDepth * radius, gap);
      }
    }
    const mid = rIn + (rOut - rIn) * 0.55;
    return {
      path: cellPath(cx, cy, angle, band, radius, gap),
      cusps: own,
      bbox: cellBounds(cx, cy, angle, rIn, rOut + gap),
      lightX: cx + mid * Math.cos(angle),
      lightY: cy + mid * Math.sin(angle),
      reach: (rOut - rIn) * 0.95,
      pan: clamp((mid * Math.cos(angle)) / radius, -0.85, 0.85),
    };
  });
  const foilExtent = (OCULUS.lobeCentre + OCULUS.lobeRadius) * radius;
  const oculusBox = Math.floor(foilExtent + 2);
  const oculus = {
    path: foilPath(cx, cy, radius),
    cusps: null,
    bbox: { x: Math.floor(cx - oculusBox), y: Math.floor(cy - oculusBox), w: oculusBox * 2 + 1, h: oculusBox * 2 + 1 },
    lightX: cx,
    lightY: cy,
    reach: foilExtent * 1.1,
    pan: 0,
  };
  return {
    cx,
    cy,
    radius,
    gap,
    shapes,
    oculus,
    cusps,
    lead: Math.max(0.8, radius * 0.004),
    incised: INCISED.map((fraction) => fraction * radius),
  };
}

// Finds what lies under a point. `pane` is lenient (bands and sectors meet with
// no dead zone); `core` is true only well inside a pane, for drag hysteresis.
export function locate(layout, x, y, out) {
  const dx = x - layout.cx;
  const dy = y - layout.cy;
  const r = Math.hypot(dx, dy) / layout.radius;
  out.pane = -1;
  out.core = false;
  out.oculus = false;
  if (r < OCULUS.hit) {
    out.oculus = true;
    return out;
  }
  if (r > HIT_EDGES[HIT_EDGES.length - 1]) return out;
  const ring = r < HIT_EDGES[0] ? 0 : r < HIT_EDGES[1] ? 1 : 2;
  const band = BANDS[ring];
  const theta = Math.atan2(dy, dx) - TOP - band.offset;
  const sector = Math.round(theta / (2 * HALF));
  const offAxis = Math.abs(theta - sector * 2 * HALF);
  const petal = ((sector % PETALS) + PETALS) % PETALS;
  out.pane = ring * PETALS + petal;
  const lower = ring === 0 ? OCULUS.hit : HIT_EDGES[ring - 1];
  out.core =
    r > lower + CORE_MARGIN &&
    r < HIT_EDGES[ring] - CORE_MARGIN &&
    offAxis < HALF - CORE_MARGIN / r;
  return out;
}
