// Circular plate mode shapes, one per drone harmonic.
// Each figure is cos(m·θ + phase) · J_m(k·r): a free-edge membrane
// approximation where m is the number of nodal diameters and k is the root of
// J_m' that gives the requested number of nodal circles with a still slope at
// the rim. Fields are sampled on a square grid spanning the unit disc.

export const GRID_SIZE = 192;
export const HARMONIC_COUNT = 16;

// [nodal diameters, nodal circles, turn] for harmonics 1–16, rising in
// complexity. turn 0 runs a nodal diameter straight up through the top of the
// plate; turn 1 rotates the figure by half a sector so an antinode sits there.
// Turns are chosen so neighbouring harmonics share no diameters, otherwise
// sand already resting on a shared line would hold the old figure in place.
const HARMONIC_MODES = [
  [0, 1, 0],
  [2, 0, 1],
  [3, 0, 0],
  [1, 1, 1],
  [4, 0, 1],
  [2, 1, 0],
  [0, 2, 0],
  [5, 0, 0],
  [3, 1, 1],
  [1, 2, 0],
  [6, 0, 1],
  [4, 1, 1],
  [2, 2, 1],
  [0, 3, 0],
  [5, 1, 1],
  [3, 2, 0],
];

const QUADRATURE_STEPS = 96;
const TABLE_SIZE = 1024;
// The grid corners sit at √2 from the centre.
const TABLE_RADIUS = 1.45;
const SCAN_STEP = 0.05;
// Above the largest root the table needs (j'₃,₃ ≈ 11.35).
const SCAN_LIMIT = 16;
const REFINE_STEPS = 40;

// Bessel's integral, J_n(x) = (1/π) ∫₀^π cos(nτ − x sin τ) dτ, by the
// trapezoid rule (exact to float precision here because the integrand is
// smooth and periodic).
function besselJ(order, x) {
  let sum = 0;
  for (let step = 0; step <= QUADRATURE_STEPS; step += 1) {
    const tau = (Math.PI * step) / QUADRATURE_STEPS;
    const weight = step === 0 || step === QUADRATURE_STEPS ? 0.5 : 1;
    sum += weight * Math.cos(order * tau - x * Math.sin(tau));
  }
  return sum / QUADRATURE_STEPS;
}

function besselSlope(order, x) {
  return (besselJ(order - 1, x) - besselJ(order + 1, x)) / 2;
}

function refineRoot(order, low, high) {
  let left = low;
  let right = high;
  let leftValue = besselSlope(order, left);
  for (let step = 0; step < REFINE_STEPS; step += 1) {
    const middle = (left + right) / 2;
    const middleValue = besselSlope(order, middle);
    if (leftValue * middleValue <= 0) {
      right = middle;
    } else {
      left = middle;
      leftValue = middleValue;
    }
  }
  return (left + right) / 2;
}

// The index-th positive root of J_m' (index counts from 1).
function slopeRoot(order, index) {
  let found = 0;
  let previousX = SCAN_STEP;
  let previousValue = besselSlope(order, previousX);
  for (let step = 2; step * SCAN_STEP < SCAN_LIMIT; step += 1) {
    const x = step * SCAN_STEP;
    const value = besselSlope(order, x);
    if (previousValue * value < 0) {
      found += 1;
      if (found === index) return refineRoot(order, previousX, x);
    }
    previousX = x;
    previousValue = value;
  }
  return SCAN_LIMIT;
}

// Raise a signed value to a power below 1: zeros stay where they are, but the
// field climbs away from them faster, so the still lines are narrower.
function sharpen(value, power) {
  return Math.sign(value) * Math.abs(value) ** power;
}

// J_m(kr) grows like r^m near the centre, which leaves a broad still patch
// where sand would heap, and with one diameter the rim is weak. Taking roots
// keeps every nodal circle in place while the diameters run cleanly from the
// centre to the rim.
const ANGULAR_POWER = 0.7;
function radialPower(diameters) {
  if (diameters === 0) return 1;
  return diameters === 1 ? 0.7 : 1 / diameters;
}

// Amplitude field for harmonic number (index + 1), normalised so the largest
// magnitude inside the plate is 1.
export function buildModeField(index) {
  const [diameters, circles, turn] = HARMONIC_MODES[index];
  const wavenumber = slopeRoot(diameters, diameters === 0 ? circles : circles + 1);
  const radial = new Float32Array(TABLE_SIZE + 2);
  for (let sample = 0; sample <= TABLE_SIZE + 1; sample += 1) {
    radial[sample] = besselJ(diameters, (wavenumber * sample * TABLE_RADIUS) / TABLE_SIZE);
  }

  const phase = (diameters * Math.PI) / 2 + (turn === 0 ? Math.PI / 2 : 0);
  const field = new Float32Array(GRID_SIZE * GRID_SIZE);
  const last = GRID_SIZE - 1;
  let peak = 0;
  for (let row = 0; row < GRID_SIZE; row += 1) {
    const y = (2 * row) / last - 1;
    for (let column = 0; column < GRID_SIZE; column += 1) {
      const x = (2 * column) / last - 1;
      const radius = Math.sqrt(x * x + y * y);
      const position = (radius / TABLE_RADIUS) * TABLE_SIZE;
      const lower = Math.min(TABLE_SIZE, Math.floor(position));
      const fraction = position - lower;
      const radialValue = radial[lower] + (radial[lower + 1] - radial[lower]) * fraction;
      const angular = diameters === 0 ? 1 : sharpen(Math.cos(diameters * Math.atan2(y, x) + phase), ANGULAR_POWER);
      const value = angular * sharpen(radialValue, radialPower(diameters));
      field[row * GRID_SIZE + column] = value;
      if (radius <= 1 && Math.abs(value) > peak) peak = Math.abs(value);
    }
  }

  const scale = peak > 0 ? 1 / peak : 1;
  for (let cell = 0; cell < field.length; cell += 1) field[cell] *= scale;
  return field;
}
