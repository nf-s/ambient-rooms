// The plate face (static layer) and the brushed ring with its marker
// (dynamic layer). Coordinates are CSS pixels; canvases are scaled by dpr.

const TAU = Math.PI * 2;
const SAMPLES = 400;
const GAP = 0.36;
const GAP_CENTER = -Math.PI / 2 + 0.17;
const START = GAP_CENTER + GAP / 2;
const SWEEP = TAU - GAP;
const BODY_END = Math.round(SAMPLES * 0.92);
const BRISTLE_COUNT = 7;
const BRISTLE_SEGMENT = 12;
const INK = "rgb(30, 38, 50)";
const TICK = "rgba(71, 85, 105, 0.38)";
const NUMERAL = "rgba(71, 85, 105, 0.72)";
const NUMERAL_CURRENT = "rgb(30, 41, 59)";
const OCTAVE_HARMONICS = new Set([1, 2, 4, 8, 16]);
const HARMONIC_COUNT = 16;
const GUIDE_COLOUR = [71, 85, 105];
const GUIDE_ALPHA = 0.2;
const GUIDE_FADE = 0.25;

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function smoothstep(edge0, edge1, value) {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function waves(random, list) {
  return list.map(([frequency, amplitude]) => ({ frequency, amplitude, phase: random() * TAU }));
}

function sumWaves(list, t) {
  let sum = 0;
  for (const wave of list) sum += wave.amplitude * Math.sin(TAU * wave.frequency * t + wave.phase);
  return sum;
}

// One ensō stroke: a fixed, slightly uneven shape sampled along its length.
// `envelope` is the full stroke width (relative), `body` the solid part that
// gives way to dry bristle streaks near the tail.
function createEnso() {
  const random = seededRandom(11);
  const widthNoise = waves(random, [
    [2.3, 0.08],
    [5.1, 0.06],
    [11.7, 0.04],
    [23, 0.025],
  ]);
  const radiusNoise = waves(random, [
    [1.6, 0.004],
    [3.2, 0.003],
    [7.4, 0.0015],
  ]);
  const cos = new Float32Array(SAMPLES + 1);
  const sin = new Float32Array(SAMPLES + 1);
  const radius = new Float32Array(SAMPLES + 1);
  const envelope = new Float32Array(SAMPLES + 1);
  const body = new Float32Array(SAMPLES + 1);

  for (let sample = 0; sample <= SAMPLES; sample += 1) {
    const t = sample / SAMPLES;
    const angle = START + t * SWEEP;
    cos[sample] = Math.cos(angle);
    sin[sample] = Math.sin(angle);
    const landing = 0.6 + 0.4 * smoothstep(0, 0.035, t);
    const press = 1 + 0.22 * Math.exp(-(((t - 0.045) / 0.045) ** 2));
    const swell = 1 + 0.28 * Math.exp(-(((t - 0.38) / 0.16) ** 2));
    const lift = 1 - 0.45 * smoothstep(0.5, 0.95, t);
    const tip = 0.15 + 0.85 * (1 - smoothstep(0.9, 1, t));
    envelope[sample] = landing * press * swell * lift * tip * (1 + sumWaves(widthNoise, t));
    body[sample] = envelope[sample] * (1 - smoothstep(0.68, 0.9, t));
    radius[sample] = 1 + sumWaves(radiusNoise, t) + 0.01 * (t - 0.5);
  }

  const bristles = [];
  for (let index = 0; index < BRISTLE_COUNT; index += 1) {
    const offset = -0.4 + (0.8 * index) / (BRISTLE_COUNT - 1) + (random() - 0.5) * 0.08;
    const width = 0.09 + random() * 0.07;
    const alpha = 0.5 + random() * 0.35;
    const from = Math.round(SAMPLES * (0.6 + random() * 0.08));
    const to = Math.round(SAMPLES * Math.min(1, 0.84 + random() * 0.18));
    const gapFrequency = 9 + random() * 14;
    const gapPhase = random() * TAU;
    const ranges = [];
    const alphas = [];
    let runStart = -1;
    for (let sample = from; sample <= to; sample += 1) {
      const t = sample / SAMPLES;
      const dry = t > 0.78 && Math.sin(TAU * gapFrequency * t + gapPhase) > 0.86;
      const closeRun = runStart >= 0 && (dry || sample === to || sample - runStart >= BRISTLE_SEGMENT);
      if (closeRun) {
        const end = dry ? sample - 1 : sample;
        if (end > runStart) {
          ranges.push(runStart, end);
          alphas.push(alpha * (1 - 0.6 * smoothstep(0.75, 1, (runStart + end) / 2 / SAMPLES)));
        }
        runStart = dry ? -1 : sample;
      } else if (runStart < 0 && !dry) {
        runStart = sample;
      }
    }
    bristles.push({ offset, width, ranges: Int16Array.from(ranges), alphas: Float32Array.from(alphas) });
  }

  return { cos, sin, radius, envelope, body, bristles };
}

export function createPlateView(plateCanvas, ringCanvas) {
  const plateContext = plateCanvas.getContext("2d");
  const ringContext = ringCanvas.getContext("2d");
  if (plateContext === null || ringContext === null) return null;

  const enso = createEnso();
  let layout = null;

  function sizeCanvas(canvas, next) {
    canvas.width = Math.round(next.width * next.dpr);
    canvas.height = Math.round(next.height * next.dpr);
  }

  function radiusAt(position) {
    const exact = clamp(position, 0, 1) * SAMPLES;
    const lower = Math.min(SAMPLES - 1, Math.floor(exact));
    return enso.radius[lower] + (enso.radius[lower + 1] - enso.radius[lower]) * (exact - lower);
  }

  function drawPlate() {
    if (layout === null) return;
    const { cx, cy, plateRadius, ringRadius, strokeWidth, dpr } = layout;
    const context = plateContext;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, layout.width, layout.height);

    context.save();
    context.shadowColor = "rgba(30, 41, 59, 0.14)";
    context.shadowBlur = plateRadius * 0.12;
    context.shadowOffsetY = plateRadius * 0.025;
    context.beginPath();
    context.arc(cx, cy, plateRadius, 0, TAU);
    context.fillStyle = "#f4f5f7";
    context.fill();
    context.restore();

    const face = context.createRadialGradient(
      cx - plateRadius * 0.25,
      cy - plateRadius * 0.3,
      plateRadius * 0.1,
      cx,
      cy,
      plateRadius,
    );
    face.addColorStop(0, "#fdfdfe");
    face.addColorStop(0.7, "#f6f7f9");
    face.addColorStop(1, "#eceef2");
    context.beginPath();
    context.arc(cx, cy, plateRadius, 0, TAU);
    context.fillStyle = face;
    context.fill();

    context.lineWidth = 1;
    context.strokeStyle = "rgba(100, 116, 139, 0.32)";
    context.beginPath();
    context.arc(cx, cy, plateRadius - 0.5, 0, TAU);
    context.stroke();
    context.strokeStyle = "rgba(255, 255, 255, 0.9)";
    context.beginPath();
    context.arc(cx, cy, plateRadius - 2.5, 0, TAU);
    context.stroke();

    // The centre bolt that holds a Chladni plate.
    const bolt = Math.max(3, plateRadius * 0.018);
    context.beginPath();
    context.arc(cx, cy, bolt, 0, TAU);
    context.fillStyle = "#e3e7ec";
    context.fill();
    context.strokeStyle = "rgba(100, 116, 139, 0.3)";
    context.stroke();

    // Harmonic ticks outside the ring; octaves of the root are a little longer.
    context.strokeStyle = TICK;
    context.lineWidth = 1;
    context.beginPath();
    for (let harmonic = 1; harmonic <= HARMONIC_COUNT; harmonic += 1) {
      const position = (harmonic - 1) / (HARMONIC_COUNT - 1);
      const angle = START + position * SWEEP;
      const inner = ringRadius * radiusAt(position) + strokeWidth * 0.75 + 5;
      const outer = inner + (OCTAVE_HARMONICS.has(harmonic) ? 8 : 5);
      context.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
      context.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
    }
    context.stroke();
  }

  // Numerals beyond the ticks: the octaves of the root always, and the
  // selected harmonic in darker type.
  function drawNumerals(current, emphasis) {
    const { cx, cy, ringRadius, strokeWidth } = layout;
    const context = ringContext;
    const size = clamp(ringRadius * 0.034, 10, 12);
    context.textAlign = "center";
    context.textBaseline = "middle";
    for (let harmonic = 1; harmonic <= HARMONIC_COUNT; harmonic += 1) {
      const selected = harmonic === current;
      if (!selected && !OCTAVE_HARMONICS.has(harmonic)) continue;
      const position = (harmonic - 1) / (HARMONIC_COUNT - 1);
      const angle = START + position * SWEEP;
      const distance = ringRadius * radiusAt(position) + strokeWidth * 0.75 + 15 + size * 0.7;
      context.globalAlpha = 1;
      context.fillStyle = selected ? NUMERAL_CURRENT : NUMERAL;
      context.font = `${selected ? 600 : 400} ${selected ? size * (1.1 + 0.15 * emphasis) : size}px -apple-system, BlinkMacSystemFont, "Helvetica Neue", "Segoe UI", Roboto, Arial, sans-serif`;
      context.fillText(String(harmonic), cx + Math.cos(angle) * distance, cy + Math.sin(angle) * distance);
    }
  }

  return {
    resize(next) {
      layout = next;
      sizeCanvas(plateCanvas, next);
      sizeCanvas(ringCanvas, next);
      drawPlate();
    },

    // "ring", "plate" or null for a point in CSS pixels.
    hitTest(x, y) {
      if (layout === null) return null;
      const distance = Math.hypot(x - layout.cx, y - layout.cy);
      const reach = Math.max(26, layout.strokeWidth * 1.8);
      const ringInner = Math.max(layout.plateRadius + 2, layout.ringRadius - reach);
      if (distance >= ringInner && distance <= layout.ringRadius + reach) return "ring";
      if (distance < layout.plateRadius) return "plate";
      return null;
    },

    // Position 0..1 along the stroke for a point. Inside the gap, or when a
    // drag jumps across it, the position holds at the nearer end.
    ringPosition(x, y, previous) {
      if (layout === null) return 0;
      let angle = Math.atan2(y - layout.cy, x - layout.cx) - START;
      angle = ((angle % TAU) + TAU) % TAU;
      let position = angle / SWEEP;
      if (position > 1) {
        const across = (angle - SWEEP) / GAP;
        position = previous === null ? (across < 0.5 ? 1 : 0) : previous > 0.5 ? 1 : 0;
      }
      if (previous !== null && Math.abs(position - previous) > 0.6) position = previous > 0.5 ? 1 : 0;
      return position;
    },

    // position 0..1 of the marker, widthScale for breathing, emphasis 0..1
    // while the ring is held, current the selected whole harmonic.
    drawRing(position, widthScale, emphasis, current) {
      if (layout === null) return;
      const { cx, cy, ringRadius, strokeWidth, dpr } = layout;
      const context = ringContext;
      const width = strokeWidth * widthScale;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, layout.width, layout.height);

      context.fillStyle = INK;
      context.globalAlpha = 0.9;
      context.beginPath();
      for (let sample = 0; sample <= BODY_END; sample += 1) {
        const r = ringRadius * enso.radius[sample] + width * enso.body[sample] * 0.5;
        const x = cx + r * enso.cos[sample];
        const y = cy + r * enso.sin[sample];
        if (sample === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      for (let sample = BODY_END; sample >= 0; sample -= 1) {
        const r = ringRadius * enso.radius[sample] - width * enso.body[sample] * 0.5;
        context.lineTo(cx + r * enso.cos[sample], cy + r * enso.sin[sample]);
      }
      context.closePath();
      context.fill();
      context.beginPath();
      context.arc(
        cx + ringRadius * enso.radius[0] * enso.cos[0],
        cy + ringRadius * enso.radius[0] * enso.sin[0],
        width * enso.body[0] * 0.5,
        0,
        TAU,
      );
      context.fill();

      context.strokeStyle = INK;
      context.lineCap = "butt";
      context.lineJoin = "round";
      for (let index = 0; index < enso.bristles.length; index += 1) {
        const bristle = enso.bristles[index];
        context.lineWidth = Math.max(0.6, width * bristle.width);
        for (let range = 0; range < bristle.alphas.length; range += 1) {
          const from = bristle.ranges[range * 2];
          const to = bristle.ranges[range * 2 + 1];
          context.globalAlpha = bristle.alphas[range];
          context.beginPath();
          for (let sample = from; sample <= to; sample += 1) {
            const r = ringRadius * enso.radius[sample] + width * enso.envelope[sample] * bristle.offset;
            const x = cx + r * enso.cos[sample];
            const y = cy + r * enso.sin[sample];
            if (sample === from) context.moveTo(x, y);
            else context.lineTo(x, y);
          }
          context.stroke();
        }
      }

      const angle = START + clamp(position, 0, 1) * SWEEP;
      const markerRadius = ringRadius * radiusAt(position);
      const markerX = cx + Math.cos(angle) * markerRadius;
      const markerY = cy + Math.sin(angle) * markerRadius;
      const size = clamp(strokeWidth * 0.62, 5, 10) * (1 + 0.25 * emphasis);
      context.globalAlpha = 0.35 + 0.2 * emphasis;
      context.fillStyle = "#ffffff";
      context.beginPath();
      context.arc(markerX, markerY, size * 2, 0, TAU);
      context.fill();
      context.globalAlpha = 1;
      context.beginPath();
      context.arc(markerX, markerY, size, 0, TAU);
      context.fill();
      context.lineWidth = 1.25;
      context.strokeStyle = "rgba(51, 65, 85, 0.85)";
      context.stroke();

      drawNumerals(current, emphasis);
    },
  };
}

// Faint nodal lines of the selected figure, drawn under the sand so the
// destination is visible while the grains travel. `fieldFor(harmonic)` returns
// a mode field sampled on a gridSize square grid over the unit disc.
export function createGuide(canvas, fieldFor, gridSize) {
  const context = canvas.getContext("2d");
  if (context === null) return null;
  const images = new Map();
  let layout = null;
  let imageSize = 0;
  let current = 0;
  let previous = 0;
  let mix = 1;

  function sample(field, x, y) {
    const half = (gridSize - 1) / 2;
    const gridX = clamp((x + 1) * half, 0, gridSize - 1.001);
    const gridY = clamp((y + 1) * half, 0, gridSize - 1.001);
    const column = gridX | 0;
    const row = gridY | 0;
    const fx = gridX - column;
    const fy = gridY - row;
    const cell = row * gridSize + column;
    const top = field[cell] + (field[cell + 1] - field[cell]) * fx;
    const bottom = field[cell + gridSize] + (field[cell + gridSize + 1] - field[cell + gridSize]) * fx;
    return top + (bottom - top) * fy;
  }

  function build(harmonic) {
    const image = document.createElement("canvas");
    image.width = imageSize;
    image.height = imageSize;
    const imageContext = image.getContext("2d");
    if (imageContext === null) return image;
    const field = fieldFor(harmonic);
    const data = imageContext.createImageData(imageSize, imageSize);
    const pixel = 2 / imageSize;
    for (let row = 0; row < imageSize; row += 1) {
      const y = (row + 0.5) * pixel - 1;
      for (let column = 0; column < imageSize; column += 1) {
        const x = (column + 0.5) * pixel - 1;
        if (x * x + y * y > 0.97) continue;
        const value = sample(field, x, y);
        const slopeX = sample(field, x + pixel, y) - sample(field, x - pixel, y);
        const slopeY = sample(field, x, y + pixel) - sample(field, x, y - pixel);
        const slope = Math.sqrt(slopeX * slopeX + slopeY * slopeY) / 2;
        // Distance to the nearest still line, in image pixels.
        const distance = Math.abs(value) / (slope + 1e-6);
        const alpha = 1 - smoothstep(0.5, 1.5, distance);
        if (alpha <= 0) continue;
        const offset = (row * imageSize + column) * 4;
        data.data[offset] = GUIDE_COLOUR[0];
        data.data[offset + 1] = GUIDE_COLOUR[1];
        data.data[offset + 2] = GUIDE_COLOUR[2];
        data.data[offset + 3] = Math.round(alpha * 255);
      }
    }
    imageContext.putImageData(data, 0, 0);
    return image;
  }

  function imageFor(harmonic) {
    let image = images.get(harmonic);
    if (image === undefined) {
      image = build(harmonic);
      images.set(harmonic, image);
    }
    return image;
  }

  function drawImage(harmonic, alpha) {
    if (harmonic === 0 || alpha <= 0.002) return;
    const { cx, cy, plateRadius } = layout;
    context.globalAlpha = alpha;
    context.drawImage(imageFor(harmonic), cx - plateRadius, cy - plateRadius, plateRadius * 2, plateRadius * 2);
  }

  return {
    resize(next) {
      layout = next;
      canvas.width = Math.round(next.width * next.dpr);
      canvas.height = Math.round(next.height * next.dpr);
      const size = Math.round(clamp(next.plateRadius * 2 * Math.min(next.dpr, 1.5), 240, 760));
      if (size !== imageSize) {
        imageSize = size;
        images.clear();
      }
    },
    setHarmonic(harmonic) {
      if (harmonic === current) return;
      previous = mix > 0.5 ? current : previous;
      current = harmonic;
      mix = 0;
    },
    // Advance the cross-fade; returns whether the layer needs drawing.
    update(dt) {
      if (mix >= 1) return false;
      mix = Math.min(1, mix + dt / GUIDE_FADE);
      return true;
    },
    draw() {
      if (layout === null) return;
      context.setTransform(layout.dpr, 0, 0, layout.dpr, 0, 0);
      context.clearRect(0, 0, layout.width, layout.height);
      context.imageSmoothingEnabled = true;
      if (mix < 1) drawImage(previous, GUIDE_ALPHA * (1 - mix));
      drawImage(current, GUIDE_ALPHA * mix);
      context.globalAlpha = 1;
    },
  };
}
