// Sand grains on the plate: a particle simulation driven by the mode field of
// the selected harmonic, drawn with WebGL points (2D canvas fallback).
// Positions are in plate units: the plate is the unit disc, y points down.

import { GRID_SIZE, HARMONIC_COUNT, buildModeField } from "./modes.js";
import { mixPalette } from "./theme.js";

export const MAX_PLOUGHS = 4;
const PLOUGH_STRIDE = 8;
const MAX_IMPULSES = 6;
const IMPULSE_STRIDE = 3;
const MAX_RINGS = 6;
const RING_STRIDE = 2;
const TAU = Math.PI * 2;

const EDGE = 0.982;
const SHAKE = 0.0085;
const SHAKE_FLOOR = 0.09;
const DRIFT = 0.0026;
const DAMPING = 0.8;
// The figure eases back after a disturbance at REST_DRIFT, and forms faster
// for a few seconds after the harmonic changes.
const REST_DRIFT = 0.55;
const SETTLE_DRIFT = 2.2;
const SETTLE_TIME = 2.2;
// A short burst of agitation when the figure changes shakes every grain loose,
// including grains on lines the old and new figures share.
const BURST_SHAKE = 2;
const BURST_TIME = 0.3;
const PATTERN_TIME = 0.12;
const WEIGHT_FLOOR = 0.004;
// A fraction of grains are dust: they jostle evenly instead of gathering on
// the still lines, so the plate keeps a light bed that a finger can plough
// through and that slowly smooths over again.
const DUST_FRACTION = 0.45;
const DUST_DRIFT = 0.02;
const DUST_JOSTLE = 0.42;
// A finger clears a furrow of this radius (plate units), wider when fast,
// and throws the grains it meets outward in proportion to its speed.
const PLOUGH_RADIUS = 0.085;
const PLOUGH_SPEED_RADIUS = 0.05;
const PLOUGH_PILE = 0.22;
const PLOUGH_THROW = 0.009;
const PLOUGH_SPILL = 0.004;
const IMPULSE_RADIUS = 0.2;
const IMPULSE_KICK = 0.02;
const IMPULSE_TIME = 0.16;
const IMPULSE_FLOOR = 0.02;
const RING_WIDTH = 0.07;
const RING_KICK = 0.014;

const VERTEX_SOURCE = `
attribute vec2 a_position;
attribute vec2 a_grain;
uniform vec2 u_center;
uniform float u_radius;
uniform vec2 u_resolution;
uniform float u_grainScale;
varying float v_shade;
void main() {
  vec2 pixel = u_center + a_position * u_radius;
  vec2 clip = pixel / u_resolution * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  gl_PointSize = a_grain.x * u_grainScale;
  v_shade = a_grain.y;
}
`;

// u_strong is the colour of the densest grains, u_faint of the lightest dust;
// u_alpha is (alpha of the densest grains, fade towards the dust); u_warm
// shifts each grain a little warmer or cooler.
const FRAGMENT_SOURCE = `
precision mediump float;
uniform vec3 u_strong;
uniform vec3 u_faint;
uniform vec2 u_alpha;
uniform vec3 u_warm;
varying float v_shade;
void main() {
  float distance = length(gl_PointCoord - 0.5);
  float coverage = 1.0 - smoothstep(0.3, 0.5, distance);
  float tone = fract(v_shade * 53.0) * 2.0 - 1.0;
  vec3 color = clamp(mix(u_strong, u_faint, v_shade) + u_warm * tone, 0.0, 1.0);
  float alpha = coverage * (u_alpha.x - u_alpha.y * v_shade);
  gl_FragColor = vec4(color * alpha, alpha);
}
`;

const FALLBACK_BUCKETS = 3;

// Shader colours from a theme palette (channels 0–255).
function toTint(palette) {
  const unit = (colour) => [colour[0] / 255, colour[1] / 255, colour[2] / 255];
  return {
    strong: unit(palette.sandStrong),
    faint: unit(palette.sandFaint),
    alpha: [palette.sandAlpha[0], palette.sandAlpha[1]],
    warm: unit(palette.sandWarm),
  };
}

function fallbackColours(tint) {
  const colours = [];
  for (let bucket = 0; bucket < FALLBACK_BUCKETS; bucket += 1) {
    const shade = (bucket + 0.5) / FALLBACK_BUCKETS;
    const channel = (index) => Math.round(255 * (tint.strong[index] + (tint.faint[index] - tint.strong[index]) * shade));
    const alpha = tint.alpha[0] - tint.alpha[1] * shade;
    colours.push(`rgba(${channel(0)}, ${channel(1)}, ${channel(2)}, ${alpha.toFixed(3)})`);
  }
  return colours;
}

let randomState = 0x2f6b9e1d;
function random() {
  randomState ^= randomState << 13;
  randomState ^= randomState >>> 17;
  randomState ^= randomState << 5;
  return (randomState >>> 0) / 4294967296;
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (shader === null) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createGlRenderer(canvas, positions, grains, count, tint) {
  const gl = canvas.getContext("webgl", {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "low-power",
  });
  if (gl === null) return null;

  const view = { centerX: 0, centerY: 0, radius: 1, grainScale: 1 };

  function setup() {
    const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SOURCE);
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SOURCE);
    const program = gl.createProgram();
    if (vertex === null || fragment === null || program === null) return null;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;

    const positionBuffer = gl.createBuffer();
    const grainBuffer = gl.createBuffer();
    const positionAttribute = gl.getAttribLocation(program, "a_position");
    const grainAttribute = gl.getAttribLocation(program, "a_grain");
    const center = gl.getUniformLocation(program, "u_center");
    const radius = gl.getUniformLocation(program, "u_radius");
    const resolution = gl.getUniformLocation(program, "u_resolution");
    const grainScale = gl.getUniformLocation(program, "u_grainScale");
    const strong = gl.getUniformLocation(program, "u_strong");
    const faint = gl.getUniformLocation(program, "u_faint");
    const alpha = gl.getUniformLocation(program, "u_alpha");
    const warm = gl.getUniformLocation(program, "u_warm");
    if (
      positionBuffer === null ||
      grainBuffer === null ||
      positionAttribute < 0 ||
      grainAttribute < 0 ||
      center === null ||
      radius === null ||
      resolution === null ||
      grainScale === null ||
      strong === null ||
      faint === null ||
      alpha === null ||
      warm === null
    ) {
      return null;
    }

    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, grainBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, grains, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(grainAttribute);
    gl.vertexAttribPointer(grainAttribute, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(positionAttribute);
    gl.vertexAttribPointer(positionAttribute, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);
    return { positionBuffer, uniforms: { center, radius, resolution, grainScale, strong, faint, alpha, warm } };
  }

  let resources = setup();
  if (resources === null) return null;

  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    resources = null;
  });
  canvas.addEventListener("webglcontextrestored", () => {
    resources = setup();
  });

  return {
    kind: "webgl",
    setTint(next) {
      Object.assign(tint, next);
    },
    resize(layout, sizeScale) {
      canvas.width = Math.round(layout.width * layout.dpr);
      canvas.height = Math.round(layout.height * layout.dpr);
      view.centerX = layout.cx * layout.dpr;
      view.centerY = layout.cy * layout.dpr;
      view.radius = layout.plateRadius * layout.dpr;
      view.grainScale = layout.dpr * sizeScale;
    },
    draw() {
      if (resources === null || gl.isContextLost()) return;
      const { uniforms } = resources;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindBuffer(gl.ARRAY_BUFFER, resources.positionBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, positions);
      gl.uniform2f(uniforms.center, view.centerX, view.centerY);
      gl.uniform1f(uniforms.radius, view.radius);
      gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
      gl.uniform1f(uniforms.grainScale, view.grainScale);
      gl.uniform3fv(uniforms.strong, tint.strong);
      gl.uniform3fv(uniforms.faint, tint.faint);
      gl.uniform2fv(uniforms.alpha, tint.alpha);
      gl.uniform3fv(uniforms.warm, tint.warm);
      gl.drawArrays(gl.POINTS, 0, count);
    },
  };
}

function createCanvasRenderer(canvas, positions, grains, count, tint) {
  const context = canvas.getContext("2d");
  if (context === null) return null;

  // Draw grains grouped by tone so the fill colour changes only three times.
  const bucketCount = FALLBACK_BUCKETS;
  let colours = fallbackColours(tint);
  const order = new Uint32Array(count);
  const starts = new Int32Array(bucketCount + 1);
  const bucketOf = (index) => Math.min(bucketCount - 1, Math.floor(grains[index * 2 + 1] * bucketCount));
  for (let index = 0; index < count; index += 1) starts[bucketOf(index) + 1] += 1;
  for (let bucket = 0; bucket < bucketCount; bucket += 1) starts[bucket + 1] += starts[bucket];
  const cursor = starts.slice(0, bucketCount);
  for (let index = 0; index < count; index += 1) {
    const bucket = bucketOf(index);
    order[cursor[bucket]] = index;
    cursor[bucket] += 1;
  }

  const view = { centerX: 0, centerY: 0, radius: 1, grainScale: 1 };
  return {
    kind: "canvas",
    setTint(next) {
      colours = fallbackColours(next);
    },
    resize(layout, sizeScale) {
      canvas.width = Math.round(layout.width * layout.dpr);
      canvas.height = Math.round(layout.height * layout.dpr);
      view.centerX = layout.cx * layout.dpr;
      view.centerY = layout.cy * layout.dpr;
      view.radius = layout.plateRadius * layout.dpr;
      view.grainScale = layout.dpr * sizeScale;
    },
    draw() {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
      for (let bucket = 0; bucket < bucketCount; bucket += 1) {
        context.fillStyle = colours[bucket];
        for (let slot = starts[bucket]; slot < starts[bucket + 1]; slot += 1) {
          const index = order[slot];
          const size = grains[index * 2] * view.grainScale;
          const x = view.centerX + positions[index * 2] * view.radius;
          const y = view.centerY + positions[index * 2 + 1] * view.radius;
          context.fillRect(x - size / 2, y - size / 2, size, size);
        }
      }
    },
  };
}

function replaceCanvas(canvas) {
  const next = document.createElement("canvas");
  next.id = canvas.id;
  next.className = canvas.className;
  next.setAttribute("aria-hidden", "true");
  canvas.replaceWith(next);
  return next;
}

export function createSand(canvas, count) {
  const fields = [];
  for (let index = 0; index < HARMONIC_COUNT; index += 1) fields.push(buildModeField(index));

  const positions = new Float32Array(count * 2);
  const velocities = new Float32Array(count * 2);
  // Per grain: drawn size in CSS pixels and tone (0 dark … 1 light).
  const grains = new Float32Array(count * 2);
  const mobility = new Float32Array(count);
  // Per grain: how much the local amplitude throws it, how much it is thrown
  // everywhere, and how strongly it walks down the slope to the lines.
  const amplitudeShake = new Float32Array(count);
  const baseShake = new Float32Array(count);
  const driftFactor = new Float32Array(count);
  const weights = new Float32Array(HARMONIC_COUNT);
  const targets = new Float32Array(HARMONIC_COUNT);
  const active = new Int32Array(HARMONIC_COUNT);
  // Per plough: from x, from y, to x, to y, radius, speed 0..1, direction x, y.
  const ploughs = new Float32Array(MAX_PLOUGHS * PLOUGH_STRIDE);
  const impulses = new Float32Array(MAX_IMPULSES * IMPULSE_STRIDE);
  const rings = new Float32Array(MAX_RINGS * RING_STRIDE);
  let activeCount = 0;
  let harmonic = 0;
  let burst = 0;
  let settling = 0;
  let ploughCount = 0;
  let impulseCursor = 0;
  let ringCursor = 0;

  for (let index = 0; index < count; index += 1) {
    const radius = Math.sqrt(random()) * EDGE;
    const angle = random() * TAU;
    const dust = random() < DUST_FRACTION;
    positions[index * 2] = Math.cos(angle) * radius;
    positions[index * 2 + 1] = Math.sin(angle) * radius;
    grains[index * 2] = dust ? 1.5 + 0.8 * random() : 1 + 1.35 * random() ** 2.4;
    grains[index * 2 + 1] = dust ? 0.55 + 0.4 * random() : random() ** 1.6;
    mobility[index] = 0.7 + 0.6 * random();
    amplitudeShake[index] = dust ? 0 : 1;
    baseShake[index] = dust ? DUST_JOSTLE : SHAKE_FLOOR;
    driftFactor[index] = dust ? DUST_DRIFT : 1;
  }

  const tint = toTint(mixPalette(1));
  const renderer =
    createGlRenderer(canvas, positions, grains, count, tint) ??
    createCanvasRenderer(replaceCanvas(canvas), positions, grains, count, tint);

  function collectActive() {
    activeCount = 0;
    for (let index = 0; index < HARMONIC_COUNT; index += 1) {
      if (weights[index] > WEIGHT_FLOOR) {
        active[activeCount] = index;
        activeCount += 1;
      }
    }
  }

  function step(scale, motion, impulsesLive, ringsLive, settleBoost) {
    const shake = SHAKE * motion * Math.sqrt(scale);
    const agitation = BURST_SHAKE * burst;
    const drift = DRIFT * motion * scale * settleBoost;
    const damping = DAMPING ** scale;
    const half = (GRID_SIZE - 1) / 2;
    const lastCell = GRID_SIZE - 2;
    const impulseRadiusSquared = IMPULSE_RADIUS * IMPULSE_RADIUS;
    const edgeSquared = EDGE * EDGE;

    for (let index = 0; index < count; index += 1) {
      const xIndex = index * 2;
      const yIndex = xIndex + 1;
      let x = positions[xIndex];
      let y = positions[yIndex];

      // Bilinear sample of the blended field and its slope.
      const gridX = (x + 1) * half;
      const gridY = (y + 1) * half;
      const column = Math.min(lastCell, Math.max(0, gridX | 0));
      const row = Math.min(lastCell, Math.max(0, gridY | 0));
      const fractionX = gridX - column;
      const fractionY = gridY - row;
      const cell = row * GRID_SIZE + column;
      let a00 = 0;
      let a10 = 0;
      let a01 = 0;
      let a11 = 0;
      for (let slot = 0; slot < activeCount; slot += 1) {
        const field = fields[active[slot]];
        const weight = weights[active[slot]];
        a00 += weight * field[cell];
        a10 += weight * field[cell + 1];
        a01 += weight * field[cell + GRID_SIZE];
        a11 += weight * field[cell + GRID_SIZE + 1];
      }
      const top = a00 + (a10 - a00) * fractionX;
      const bottom = a01 + (a11 - a01) * fractionX;
      const amplitude = top + (bottom - top) * fractionY;
      const slopeX = ((a10 - a00) * (1 - fractionY) + (a11 - a01) * fractionY) * half;
      const slopeY = (bottom - top) * half;

      // Vibration throws grains about in proportion to the local amplitude;
      // the drift walks them down the slope towards the still lines.
      // The slope is normalised so broad low figures form about as quickly
      // as fine high ones.
      const throwSize =
        (Math.abs(amplitude) * amplitudeShake[index] + baseShake[index] + agitation) * shake * mobility[index];
      const pull = (amplitude * drift * driftFactor[index]) / (Math.sqrt(slopeX * slopeX + slopeY * slopeY) + 0.5);
      let vx = velocities[xIndex] * damping + (random() - 0.5) * throwSize - slopeX * pull;
      let vy = velocities[yIndex] * damping + (random() - 0.5) * throwSize - slopeY * pull;

      if (impulsesLive) {
        for (let impulse = 0; impulse < MAX_IMPULSES; impulse += 1) {
          const offset = impulse * IMPULSE_STRIDE;
          const strength = impulses[offset + 2];
          if (strength <= 0) continue;
          const dx = x - impulses[offset];
          const dy = y - impulses[offset + 1];
          const distanceSquared = dx * dx + dy * dy;
          if (distanceSquared < impulseRadiusSquared) {
            const kick = (1 - distanceSquared / impulseRadiusSquared) * strength * IMPULSE_KICK * scale * mobility[index];
            vx += (random() - 0.5) * kick + dx * kick * 1.5;
            vy += (random() - 0.5) * kick + dy * kick * 1.5;
          }
        }
      }

      if (ringsLive) {
        const radius = Math.sqrt(x * x + y * y) + 1e-6;
        for (let ring = 0; ring < MAX_RINGS; ring += 1) {
          const offset = ring * RING_STRIDE;
          const strength = rings[offset + 1];
          if (strength <= 0) continue;
          const away = Math.abs(radius - rings[offset]);
          if (away < RING_WIDTH) {
            const kick = (1 - away / RING_WIDTH) * strength * RING_KICK * scale * mobility[index];
            vx += (random() - 0.5) * kick + (x / radius) * kick * 0.4;
            vy += (random() - 0.5) * kick + (y / radius) * kick * 0.4;
          }
        }
      }

      x += vx;
      y += vy;

      // A finger clears every grain from the stretch it moved along this
      // frame and heaps them at the edges of the furrow.
      for (let plough = 0; plough < ploughCount; plough += 1) {
        const offset = plough * PLOUGH_STRIDE;
        const radius = ploughs[offset + 4];
        const fromX = ploughs[offset];
        const fromY = ploughs[offset + 1];
        const alongX = ploughs[offset + 2] - fromX;
        const alongY = ploughs[offset + 3] - fromY;
        const lengthSquared = alongX * alongX + alongY * alongY;
        const t = lengthSquared > 1e-10 ? clamp(((x - fromX) * alongX + (y - fromY) * alongY) / lengthSquared, 0, 1) : 0;
        let dx = x - (fromX + alongX * t);
        let dy = y - (fromY + alongY * t);
        const distanceSquared = dx * dx + dy * dy;
        if (distanceSquared >= radius * radius) continue;
        let distance = Math.sqrt(distanceSquared);
        if (distance < 1e-5) {
          dx = random() - 0.5;
          dy = random() - 0.5;
          distance = Math.sqrt(dx * dx + dy * dy) + 1e-6;
        }
        const nx = dx / distance;
        const ny = dy / distance;
        const speed = ploughs[offset + 5];
        const pile = radius * (1 + PLOUGH_PILE * random());
        x += nx * (pile - distance);
        y += ny * (pile - distance);
        const throwOut = PLOUGH_THROW * speed * mobility[index] * random();
        const spill = PLOUGH_SPILL * (0.3 + speed) * (random() - 0.5);
        vx = nx * throwOut - ny * spill + ploughs[offset + 6] * throwOut * 0.4;
        vy = ny * throwOut + nx * spill + ploughs[offset + 7] * throwOut * 0.4;
      }

      const radiusSquared = x * x + y * y;
      if (radiusSquared > edgeSquared) {
        const pull = EDGE / Math.sqrt(radiusSquared);
        x *= pull;
        y *= pull;
        vx *= -0.3;
        vy *= -0.3;
      }
      positions[xIndex] = x;
      positions[yIndex] = y;
      velocities[xIndex] = vx;
      velocities[yIndex] = vy;
    }
  }

  return {
    count,
    get renderer() {
      return renderer === null ? "none" : renderer.kind;
    },
    // Mode field for harmonic number 1–16, on a GRID_SIZE square grid.
    field(number) {
      return fields[clamp(Math.round(number), 1, HARMONIC_COUNT) - 1];
    },
    // Whole harmonic number 1–16. A change shakes the sand loose and lets
    // it settle quickly into the new figure.
    setHarmonic(number) {
      const next = clamp(Math.round(number), 1, HARMONIC_COUNT);
      if (next === harmonic) return;
      const first = harmonic === 0;
      harmonic = next;
      targets.fill(0);
      targets[next - 1] = 1;
      if (first) {
        weights.set(targets);
        return;
      }
      burst = 1;
      settling = 1;
    },
    // A finger moved from (fromX, fromY) to (toX, toY) this frame; speed 0..1.
    setPlough(index, fromX, fromY, toX, toY, speed) {
      if (index < 0 || index >= MAX_PLOUGHS) return;
      const offset = index * PLOUGH_STRIDE;
      const s = clamp(speed, 0, 1);
      const dx = toX - fromX;
      const dy = toY - fromY;
      const length = Math.sqrt(dx * dx + dy * dy);
      ploughs[offset] = fromX;
      ploughs[offset + 1] = fromY;
      ploughs[offset + 2] = toX;
      ploughs[offset + 3] = toY;
      ploughs[offset + 4] = PLOUGH_RADIUS + PLOUGH_SPEED_RADIUS * s;
      ploughs[offset + 5] = s;
      ploughs[offset + 6] = length > 1e-6 ? dx / length : 0;
      ploughs[offset + 7] = length > 1e-6 ? dy / length : 0;
    },
    setPloughCount(value) {
      ploughCount = clamp(value, 0, MAX_PLOUGHS);
    },
    addImpulse(x, y, strength) {
      const offset = impulseCursor * IMPULSE_STRIDE;
      impulses[offset] = x;
      impulses[offset + 1] = y;
      impulses[offset + 2] = strength;
      impulseCursor = (impulseCursor + 1) % MAX_IMPULSES;
    },
    // Make the grains jump in a thin ring at this radius (plate units).
    addRing(radius, strength) {
      const offset = ringCursor * RING_STRIDE;
      rings[offset] = radius;
      rings[offset + 1] = strength;
      ringCursor = (ringCursor + 1) % MAX_RINGS;
    },
    // Run the simulation ahead with the current figure fully formed.
    settle(steps) {
      weights.set(targets);
      burst = 0;
      settling = 0;
      collectActive();
      for (let index = 0; index < steps; index += 1) step(1, 1, false, false, 1);
      velocities.fill(0);
    },
    // Advance by dt seconds; motion 0..1 is how strongly the plate vibrates.
    // Returns whether any grain may have moved.
    update(dt, motion) {
      const ease = 1 - Math.exp(-dt / PATTERN_TIME);
      for (let index = 0; index < HARMONIC_COUNT; index += 1) {
        weights[index] += (targets[index] - weights[index]) * ease;
      }
      collectActive();
      burst *= Math.exp(-dt / BURST_TIME);
      settling *= Math.exp(-dt / SETTLE_TIME);

      const decay = Math.exp(-dt / IMPULSE_TIME);
      let impulsesLive = false;
      for (let impulse = 0; impulse < MAX_IMPULSES; impulse += 1) {
        const offset = impulse * IMPULSE_STRIDE + 2;
        impulses[offset] = impulses[offset] * decay > IMPULSE_FLOOR ? impulses[offset] * decay : 0;
        if (impulses[offset] > 0) impulsesLive = true;
      }
      let ringsLive = false;
      for (let ring = 0; ring < MAX_RINGS; ring += 1) {
        const offset = ring * RING_STRIDE + 1;
        rings[offset] = rings[offset] * decay > IMPULSE_FLOOR ? rings[offset] * decay : 0;
        if (rings[offset] > 0) ringsLive = true;
      }

      if (motion <= 0 && ploughCount === 0 && !impulsesLive && !ringsLive) return false;
      const boost = REST_DRIFT + (SETTLE_DRIFT - REST_DRIFT) * settling;
      step(Math.min(3, dt * 60), motion, impulsesLive, ringsLive, boost);
      return true;
    },
    // Grain colours from a theme palette.
    setPalette(palette) {
      if (renderer !== null) renderer.setTint(toTint(palette));
    },
    resize(layout) {
      if (renderer === null) return;
      renderer.resize(layout, clamp(layout.plateRadius / 260, 0.85, 1.35));
    },
    draw() {
      if (renderer !== null) renderer.draw();
    },
  };
}
