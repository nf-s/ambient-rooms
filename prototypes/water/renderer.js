// WebGL renderer for the pool. The surface is analytic: every ripple, wake
// ring and stone arrives as a uniform and the fragment shader sums them into a
// height field, derives a normal and shades it against a night or day sky.
// Below the shore line is the dry shelf where the unused stones rest.

const VERTEX_SOURCE = `
attribute vec2 aPosition;
void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

const FRAGMENT_BODY = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec2 uResolution;
uniform vec2 uHalf;
uniform float uTime;
uniform float uDepth;
uniform float uPixel;
uniform float uTheme;
uniform float uShore;
uniform vec4 uBank;
uniform vec4 uBankSize;
uniform vec4 uRippleA[MAX_RIPPLES];
uniform vec4 uRippleB[MAX_RIPPLES];
uniform int uRippleCount;
uniform vec4 uWake[MAX_WAKE];
uniform int uWakeCount;
uniform vec4 uStoneA[MAX_STONES];
uniform vec4 uStoneB[MAX_STONES];
uniform vec4 uStoneC[MAX_STONES];
uniform int uStoneCount;

const float HEIGHT = 0.0032;
const float RING = 0.28;
const float BURST_RATE = 3.0;
const float SPREAD = 0.05;
const float WAKE_SPEED = 0.11;
const float WAKE_K = 330.0;
const vec3 EYE = vec3(0.0, 0.0, 1.4);
const vec3 MOON = vec3(-0.2, 0.3, 0.9327);
const vec3 LIGHT = vec3(-0.42, 0.55, 0.7219);
const vec3 MOONLIGHT = vec3(0.80, 0.86, 0.97);
const vec3 AMBER = vec3(1.0, 0.64, 0.30);
const vec3 AMBER_DAY = vec3(0.86, 0.50, 0.18);
const vec2 SLOPE_LIGHT = vec2(-0.55, 0.83);

float hash(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 cell = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(cell);
  float b = hash(cell + vec2(1.0, 0.0));
  float c = hash(cell + vec2(0.0, 1.0));
  float d = hash(cell + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

vec2 waveSlope(vec2 p, float angle, float k, float w, float slope) {
  vec2 dir = vec2(cos(angle), sin(angle));
  return dir * (slope * cos(dot(dir, p) * k - uTime * w));
}

// A very slow ambient swell plus drifting patches of fine riffle.
vec2 swell(vec2 p) {
  float t = uTime;
  vec2 g = waveSlope(p, 0.7 + 0.5 * sin(t * 0.021), 6.0, 0.55, 0.012);
  g += waveSlope(p, 2.4 + 0.4 * sin(t * 0.017 + 1.3), 9.5, 0.7, 0.009);
  g += waveSlope(p, 4.0 + 0.6 * sin(t * 0.013 + 2.1), 14.0, 0.85, 0.006);
  g += waveSlope(p, 5.3 + 0.5 * sin(t * 0.019 + 0.4), 23.0, 1.1, 0.004);
  float gust = smoothstep(0.55, 0.88, noise(p * 1.4 + vec2(t * 0.018, -t * 0.011)));
  g += gust * waveSlope(p, 1.1 + 0.3 * sin(t * 0.05), 70.0, 2.4, 0.010);
  g += gust * waveSlope(p, 1.9, 95.0, 2.9, 0.007);
  return g;
}

// Each ripple is a ring wave packet. The wave at radius r left the origin at
// time (age - r / speed), so its strength is the source envelope at that
// moment: a short burst, then a quieter ringing that fades with the sound.
void addRipples(vec2 p, inout float h, inout vec2 g, inout float warm) {
  for (int i = 0; i < MAX_RIPPLES; i++) {
    if (i >= uRippleCount) break;
    vec4 a = uRippleA[i];
    vec4 b = uRippleB[i];
    vec2 d = p - a.xy;
    float r = length(d);
    float age = a.z;
    float amp = a.w;
    float ringRate = b.x;
    float speed = b.y;
    float k = b.z;
    float tau = age - r / speed;
    float frontWidth = 7.5 / (k * speed);
    float src;
    float dsrc;
    float burst = 0.0;
    if (tau < 0.0) {
      float x = tau / frontWidth;
      src = exp(-x * x);
      dsrc = -2.0 * x / frontWidth * src;
      burst = src;
    } else {
      burst = (1.0 - RING) * exp(-tau * BURST_RATE);
      float ring = RING * exp(-tau * ringRate);
      src = burst + ring;
      dsrc = -BURST_RATE * burst - ringRate * ring;
    }
    if (src < 0.002) continue;
    float spread = inversesqrt(1.0 + r / SPREAD);
    float dspread = -0.5 / SPREAD * spread * spread * spread;
    float r1 = 3.1416 / k;
    float nearE = exp(-(r * r) / (r1 * r1));
    float near = 1.0 - nearE;
    float dnear = 2.0 * r / (r1 * r1) * nearE;
    float phase = k * r - b.w;
    float sn = sin(phase);
    float cs = cos(phase);
    float env = amp * spread * near * src;
    h += HEIGHT * env * sn;
    float denv = amp * (dspread * near * src + spread * dnear * src - spread * near * dsrc / speed);
    float dhdr = HEIGHT * (denv * sn + env * k * cs);
    g += dhdr * d / max(r, 1e-5);
    warm += amp * spread * near * burst * max(sn, 0.0) * exp(-age * 0.9) * 0.6;
    warm += amp * exp(-age * 1.3) * exp(-r * r * 700.0);
  }
}

// A moving finger leaves a trail of small rings. Each is a short packet of
// fine capillary waves; slower than the finger, they overlap into a wake.
void addWake(vec2 p, inout float h, inout vec2 g) {
  for (int i = 0; i < MAX_WAKE; i++) {
    if (i >= uWakeCount) break;
    vec4 w = uWake[i];
    vec2 d = p - w.xy;
    float r = length(d);
    float width = 0.008 + w.z * 0.012;
    float x = r - w.z * WAKE_SPEED;
    if (abs(x) > width * 3.0) continue;
    float spread = inversesqrt(1.0 + r / 0.02);
    float env = w.w * spread * exp(-(x * x) / (width * width));
    float phase = WAKE_K * x;
    float sn = sin(phase);
    float dhdr = HEIGHT * env * (WAKE_K * cos(phase) - 2.0 * x / (width * width) * sn);
    h += HEIGHT * env * sn;
    g += dhdr * d / max(r, 1e-5);
  }
}

vec3 nightSky(vec3 r) {
  float elevation = clamp(r.z, 0.0, 1.0);
  vec3 zenith = vec3(0.014, 0.020, 0.062);
  vec3 horizon = vec3(0.36, 0.45, 0.66);
  float tilt = clamp(pow(1.0 - elevation, 1.7) * 12.0, 0.0, 1.0);
  vec3 col = mix(zenith, horizon, tilt);
  float m = max(dot(r, MOON), 0.0);
  col += MOONLIGHT * (pow(m, 30.0) * 0.12 + pow(m, 240.0) * 0.28 + pow(m, 1400.0) * 1.1);
  return col;
}

// Overcast daylight: a soft white sky with a faint bright patch.
vec3 daySky(vec3 r) {
  float elevation = clamp(r.z, 0.0, 1.0);
  float tilt = clamp(pow(1.0 - elevation, 1.7) * 10.0, 0.0, 1.0);
  vec3 col = mix(vec3(0.80, 0.84, 0.89), vec3(0.95, 0.96, 0.975), tilt);
  float m = max(dot(r, MOON), 0.0);
  col += vec3(1.0) * (pow(m, 16.0) * 0.06 + pow(m, 260.0) * 0.16);
  return col;
}

// Shallow recesses in the shelf, one per stone, so an empty one shows which
// note is in the water.
float slotShade(vec2 p) {
  float s = 1.0;
  float count = uBankSize.z;
  for (int i = 0; i < MAX_STONES; i++) {
    float fi = float(i);
    if (fi >= count) break;
    float lower = 1.0 - mod(fi, 2.0) * 2.0;
    vec2 c = vec2(uBank.x + fi * uBank.y, uBank.z - uBank.w * lower);
    float rad = mix(uBankSize.x, uBankSize.y, fi / max(count - 1.0, 1.0)) * 1.08;
    vec2 q = p - c;
    float d = length(q) / rad;
    if (d > 1.3) continue;
    float inside = 1.0 - smoothstep(0.92, 1.04, d);
    float wall = smoothstep(0.55, 1.0, d) * inside;
    float facing = dot(q / max(length(q), 1e-5), -SLOPE_LIGHT);
    s *= 1.0 - 0.13 * inside + 0.12 * wall * facing;
  }
  return s;
}

void main() {
  vec2 p = (gl_FragCoord.xy / uResolution * 2.0 - 1.0) * uHalf;
  float h = 0.0;
  float warm = 0.0;
  vec2 g = vec2(0.0);
  float lap = 0.0016 * sin(p.x * 31.0 + uTime * 0.7) + 0.0011 * sin(p.x * 57.0 - uTime * 1.1);
  float shoreline = p.y - uShore - lap;
  bool inWater = shoreline > -0.012;
  if (inWater) {
    g = swell(p);
    addRipples(p, h, g, warm);
    addWake(p, h, g);
  }

  float shade = 1.0;
  float stoneMask = 0.0;
  vec3 stoneNight = vec3(0.0);
  vec3 stoneDay = vec3(0.0);
  for (int i = 0; i < MAX_STONES; i++) {
    if (i >= uStoneCount) break;
    vec4 a = uStoneA[i];
    vec4 b = uStoneB[i];
    vec4 c = uStoneC[i];
    vec2 q = p - a.xy;
    float dist = length(q);
    float wet = c.y;
    float lift = c.z;
    float rad = a.z * (1.0 + 0.08 * lift);
    vec2 dir = q / max(dist, 0.00001);

    // Fine standing waves around a stone that is sounding.
    if (c.x > 0.004 && inWater) {
      float re = dist - rad;
      if (re > 0.0 && re < 0.12) {
        float env = c.x * wet * exp(-re / 0.03) * smoothstep(0.0, 0.006, re);
        float s1 = sin(uTime * 9.0);
        float wave = 0.9 * cos(re * 320.0) * s1 + 0.5 * sin(re * 210.0 - uTime * 5.0);
        float dwave = -288.0 * sin(re * 320.0) * s1 + 105.0 * cos(re * 210.0 - uTime * 5.0);
        h += HEIGHT * env * wave;
        g += HEIGHT * env * dwave * dir;
      }
    }

    if (dist > rad * 3.2 + 0.03) continue;
    vec2 lq = vec2(b.x * q.x + b.y * q.y, b.x * q.y - b.y * q.x);
    lq.y /= b.z;
    float seed = floor(b.w);
    float tone = fract(b.w);
    float ang = atan(lq.y, lq.x + 0.000001);
    float wobble = 1.0 + 0.07 * sin(ang * 3.0 + seed) + 0.035 * sin(ang * 5.0 + seed * 1.7);
    float ds = length(lq) / (rad * wobble);
    float outside = max(ds - 1.0, 0.0);
    g -= dir * 0.2 * exp(-outside * 5.0) * step(1.0, ds) * wet;
    vec2 shadowOffset = vec2(0.003, -0.005) * (1.0 + lift * 4.0);
    float sd = length(q - shadowOffset) / (rad * wobble);
    float dryShadow = mix(0.55 + 0.25 * lift, 1.0, smoothstep(0.85, 1.4 + lift * 0.8, sd));
    float wetShade = mix(0.74, 1.0, smoothstep(1.0, 1.9, ds));
    shade *= mix(dryShadow, wetShade, wet);
    warm += a.w * exp(-outside * 2.6) * 0.45;
    float line = ds + clamp(h / HEIGHT, -1.0, 1.0) * 0.05 * wet;
    float edge = uPixel / rad * 1.5;
    float mask = 1.0 - smoothstep(1.0 - edge, 1.0 + edge, line);
    if (mask > 0.0) {
      vec2 local = lq / (rad * wobble);
      float nz = sqrt(max(1.0 - dot(local, local), 0.0));
      vec3 ln = normalize(vec3(local * 0.9, nz * 0.75 + 0.12));
      vec3 sn = vec3(b.x * ln.x - b.y * ln.y, b.y * ln.x + b.x * ln.y, ln.z);
      float grain = 0.85 + 0.25 * noise(local * 2.6 + seed * 7.0);
      float diffuse = max(dot(sn, LIGHT), 0.0);
      float rimDark = smoothstep(0.6, 1.0, ds);
      vec3 sv = normalize(EYE - vec3(p, 0.0));
      float sheen = pow(max(dot(reflect(-sv, sn), MOON), 0.0), 24.0) * mix(0.1, 0.28, wet);
      float glow = clamp(a.w, 0.0, 1.2) * (0.5 + 0.5 * nz);
      vec3 nightBase = mix(vec3(0.23, 0.25, 0.30), vec3(0.78, 0.80, 0.84), tone) * grain;
      vec3 night = nightBase * (0.12 + 0.7 * diffuse) * mix(1.0, 0.5, rimDark);
      night += MOONLIGHT * sheen + AMBER * glow * 0.3;
      vec3 dayBase = mix(vec3(0.17, 0.19, 0.23), vec3(0.50, 0.53, 0.58), tone) * grain;
      vec3 day = dayBase * (0.55 + 0.6 * diffuse) * mix(1.0, 0.72, rimDark) + vec3(sheen * 0.5);
      day += AMBER_DAY * glow * 0.32;
      stoneNight = mix(stoneNight, night, mask);
      stoneDay = mix(stoneDay, day, mask);
      stoneMask = max(stoneMask, mask);
    }
  }

  vec3 n = normalize(vec3(-g, 1.0));
  vec3 v = normalize(EYE - vec3(p, h));
  vec3 r = reflect(-v, n);
  float facing = max(dot(n, v), 0.0);
  float reflectivity = 0.42 + 0.58 * pow(1.0 - facing, 3.0);
  vec2 bedPoint = p + g * 0.8;
  float bed = noise(bedPoint * 2.0 + 11.0) * 0.6 + noise(bedPoint * 5.0 - 4.0) * 0.4;
  float poolHalfH = max((uHalf.y - uShore) * 0.5, 0.05);
  vec2 poolCentre = vec2(0.0, uShore + poolHalfH);
  float poolRim = length((p - poolCentre) / vec2(uHalf.x, poolHalfH));
  float vignette = smoothstep(0.6, 1.35, length(p / uHalf));
  float glow = 1.0 - exp(-warm * 1.5);
  float waterMask = smoothstep(-0.0012, 0.0012, shoreline);
  float ledgeTex = 0.93 + 0.05 * noise(p * 70.0) + 0.05 * noise(p * 8.0 + 3.0);
  float slots = shoreline < 0.0 ? slotShade(p) : 1.0;
  float wetBand = 1.0 - 0.3 * (1.0 - smoothstep(0.0, 0.012, -shoreline));
  float lip = smoothstep(-0.006, -0.0015, shoreline) * (1.0 - waterMask);
  float ledgeShade = ledgeTex * slots * wetBand * shade;

  vec3 colNight = vec3(0.0);
  vec3 colDay = vec3(0.0);
  if (uTheme < 0.999) {
    vec3 deep = mix(vec3(0.008, 0.010, 0.036), vec3(0.020, 0.028, 0.105), uDepth);
    deep *= (0.7 + 0.6 * bed) * mix(1.1, 0.55, smoothstep(0.35, 1.25, poolRim));
    vec3 waterCol = mix(deep, nightSky(r), reflectivity) * shade;
    vec3 ledge = vec3(0.068, 0.075, 0.094) * ledgeShade + MOONLIGHT * lip * 0.05;
    vec3 col = mix(ledge, waterCol, waterMask);
    col += AMBER * glow * 0.45;
    col = mix(col, stoneNight, stoneMask);
    col *= mix(1.0, 0.72, vignette);
    colNight = 1.0 - exp(-col * 1.15);
  }
  if (uTheme > 0.001) {
    vec3 deep = mix(vec3(0.58, 0.65, 0.72), vec3(0.48, 0.56, 0.65), uDepth);
    deep *= (0.92 + 0.16 * bed) * mix(1.04, 0.9, smoothstep(0.35, 1.25, poolRim));
    vec3 waterCol = mix(deep, daySky(r), reflectivity * 0.85);
    waterCol *= 1.0 + clamp(dot(-g, SLOPE_LIGHT) * 1.8, -0.2, 0.2);
    waterCol *= shade;
    vec3 ledge = vec3(0.80, 0.815, 0.835) * ledgeShade + vec3(lip * 0.04);
    vec3 col = mix(ledge, waterCol, waterMask);
    col = mix(col, AMBER_DAY, glow * 0.4);
    col = mix(col, stoneDay, stoneMask);
    col *= mix(1.0, 0.9, vignette);
    colDay = clamp(col, 0.0, 1.0);
  }
  vec3 col = mix(colNight, colDay, uTheme);
  col += (hash(gl_FragCoord.xy + fract(uTime) * 61.0) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}
`;

const UNIFORM_NAMES = {
  resolution: "uResolution",
  half: "uHalf",
  time: "uTime",
  depth: "uDepth",
  pixel: "uPixel",
  theme: "uTheme",
  shore: "uShore",
  bank: "uBank",
  bankSize: "uBankSize",
  rippleA: "uRippleA[0]",
  rippleB: "uRippleB[0]",
  rippleCount: "uRippleCount",
  wake: "uWake[0]",
  wakeCount: "uWakeCount",
  stoneA: "uStoneA[0]",
  stoneB: "uStoneB[0]",
  stoneC: "uStoneC[0]",
  stoneCount: "uStoneCount",
};

// Vectors used by the scalar and small uniforms, with some headroom.
const RESERVED_UNIFORM_VECTORS = 16;
const STONE_VECTORS = 3;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) return { shader: null, log: "Could not create a shader." };
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "";
    gl.deleteShader(shader);
    return { shader: null, log };
  }
  return { shader, log: "" };
}

const CONTEXT_OPTIONS = {
  alpha: false,
  antialias: false,
  depth: false,
  stencil: false,
  preserveDrawingBuffer: false,
  powerPreference: "high-performance",
};

// Returns { renderer, error }. `renderer` is null when WebGL is unavailable or
// the shader cannot be built; `error` then explains why in plain words.
// WebGL 2 is preferred only for its larger uniform budget; the shader is
// GLSL ES 1.0 and runs on either.
export function createRenderer(canvas, limits) {
  const gl = canvas.getContext("webgl2", CONTEXT_OPTIONS) ?? canvas.getContext("webgl", CONTEXT_OPTIONS);
  if (!gl) return { renderer: null, error: "WebGL is not available in this browser, so the water cannot be drawn." };

  const uniformVectors = Number(gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS)) || 64;
  const spare = Math.max(0, uniformVectors - RESERVED_UNIFORM_VECTORS - limits.stones * STONE_VECTORS);
  const ripples = Math.max(4, Math.min(limits.ripples, Math.floor((spare * 0.55) / 2)));
  const capacity = {
    ripples,
    wake: Math.max(4, Math.min(limits.wake, spare - ripples * 2)),
    stones: limits.stones,
  };
  const fragmentSource =
    `#define MAX_RIPPLES ${capacity.ripples}\n` +
    `#define MAX_WAKE ${capacity.wake}\n` +
    `#define MAX_STONES ${capacity.stones}\n` +
    FRAGMENT_BODY;

  let program = null;
  let uniforms = null;
  let lost = false;

  function build() {
    const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SOURCE);
    const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
    if (!vertex.shader || !fragment.shader) return `The water shader could not be compiled. ${vertex.log}${fragment.log}`;
    const linked = gl.createProgram();
    if (!linked) return "The water shader could not be created.";
    gl.attachShader(linked, vertex.shader);
    gl.attachShader(linked, fragment.shader);
    gl.bindAttribLocation(linked, 0, "aPosition");
    gl.linkProgram(linked);
    if (!gl.getProgramParameter(linked, gl.LINK_STATUS)) {
      return `The water shader could not be linked. ${gl.getProgramInfoLog(linked) ?? ""}`;
    }
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const found = {};
    for (const [key, name] of Object.entries(UNIFORM_NAMES)) found[key] = gl.getUniformLocation(linked, name);
    gl.useProgram(linked);
    program = linked;
    uniforms = found;
    return "";
  }

  const error = build();
  if (error) return { renderer: null, error };

  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    lost = true;
    program = null;
    uniforms = null;
  });
  canvas.addEventListener("webglcontextrestored", () => {
    lost = false;
    build();
  });

  function resize(cssWidth, cssHeight, ratio) {
    const width = Math.max(1, Math.round(cssWidth * ratio));
    const height = Math.max(1, Math.round(cssHeight * ratio));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
  }

  function render(frame) {
    if (lost || !program || !uniforms) return;
    const u = uniforms;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(u.resolution, canvas.width, canvas.height);
    gl.uniform2f(u.half, frame.halfW, frame.halfH);
    gl.uniform1f(u.time, frame.time);
    gl.uniform1f(u.depth, frame.depth);
    gl.uniform1f(u.pixel, (frame.halfW * 2) / canvas.width);
    gl.uniform1f(u.theme, frame.theme);
    gl.uniform1f(u.shore, frame.shore);
    gl.uniform4fv(u.bank, frame.bank);
    gl.uniform4fv(u.bankSize, frame.bankSize);
    gl.uniform4fv(u.rippleA, frame.rippleA);
    gl.uniform4fv(u.rippleB, frame.rippleB);
    gl.uniform1i(u.rippleCount, frame.rippleCount);
    gl.uniform4fv(u.wake, frame.wake);
    gl.uniform1i(u.wakeCount, frame.wakeCount);
    gl.uniform4fv(u.stoneA, frame.stoneA);
    gl.uniform4fv(u.stoneB, frame.stoneB);
    gl.uniform4fv(u.stoneC, frame.stoneC);
    gl.uniform1i(u.stoneCount, frame.stoneCount);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  return { renderer: { capacity, resize, render }, error: "" };
}
