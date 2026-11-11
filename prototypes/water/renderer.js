// WebGL renderer for the pool. The surface is analytic: every ripple, sung
// bowl and stone arrives as a uniform and the fragment shader sums them into a
// height field, derives a normal and shades it against a moonlit sky.

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
uniform vec4 uRippleA[MAX_RIPPLES];
uniform vec4 uRippleB[MAX_RIPPLES];
uniform int uRippleCount;
uniform vec4 uStoneA[MAX_STONES];
uniform vec4 uStoneB[MAX_STONES];
uniform int uStoneCount;
uniform vec4 uSing[MAX_SINGS];
uniform int uSingCount;

const float HEIGHT = 0.0032;
const float RING = 0.28;
const float BURST_RATE = 3.0;
const float SPREAD = 0.05;
const vec3 EYE = vec3(0.0, 0.0, 1.4);
const vec3 MOON = vec3(-0.2, 0.3, 0.9327);
const vec3 LIGHT = vec3(-0.42, 0.55, 0.7219);
const vec3 MOONLIGHT = vec3(0.80, 0.86, 0.97);
const vec3 AMBER = vec3(1.0, 0.64, 0.30);

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

// Fine standing waves where a bowl is being sung, with two lobes that follow
// the circling pointer and a gentle outward train.
float singHeight(vec2 q, vec4 s) {
  float r2 = dot(q, q);
  if (r2 > 0.07) return 0.0;
  float r = sqrt(r2);
  float c2 = 0.0;
  float s2 = 0.0;
  if (r > 0.0001) {
    c2 = (q.x * q.x - q.y * q.y) / r2;
    s2 = 2.0 * q.x * q.y / r2;
  }
  float lobes = (c2 * cos(2.0 * s.w) + s2 * sin(2.0 * s.w)) * smoothstep(0.0, 0.02, r);
  float t = uTime;
  float env = exp(-r2 / 0.008);
  float standing = cos(r * 250.0) * sin(t * 8.0) * (0.6 + 0.4 * lobes)
    + 0.55 * cos(r * 390.0 + 1.3) * sin(t * 11.0 + 1.0);
  float outward = sin(r * 170.0 - t * 4.6) * exp(-r / 0.1) * smoothstep(0.0, 0.03, r)
    * (1.0 - smoothstep(0.17, 0.26, r));
  return s.z * (standing * env + 0.4 * outward);
}

float singField(vec2 p) {
  float total = 0.0;
  for (int i = 0; i < MAX_SINGS; i++) {
    if (i >= uSingCount) break;
    total += singHeight(p - uSing[i].xy, uSing[i]);
  }
  return total;
}

vec3 skyColor(vec3 r) {
  float elevation = clamp(r.z, 0.0, 1.0);
  vec3 zenith = vec3(0.014, 0.020, 0.062);
  vec3 horizon = vec3(0.36, 0.45, 0.66);
  float tilt = clamp(pow(1.0 - elevation, 1.7) * 12.0, 0.0, 1.0);
  vec3 col = mix(zenith, horizon, tilt);
  float m = max(dot(r, MOON), 0.0);
  col += MOONLIGHT * (pow(m, 30.0) * 0.12 + pow(m, 240.0) * 0.28 + pow(m, 1400.0) * 1.1);
  return col;
}

void main() {
  vec2 p = (gl_FragCoord.xy / uResolution * 2.0 - 1.0) * uHalf;
  float h = 0.0;
  float warm = 0.0;
  vec2 g = swell(p);
  addRipples(p, h, g, warm);

  if (uSingCount > 0) {
    float e = 0.0015;
    float s0 = singField(p);
    float sx = singField(p + vec2(e, 0.0));
    float sy = singField(p + vec2(0.0, e));
    h += s0 * HEIGHT;
    g += vec2(sx - s0, sy - s0) / e * HEIGHT;
  }

  float shade = 1.0;
  float stoneMask = 0.0;
  vec3 stoneColor = vec3(0.0);
  for (int i = 0; i < MAX_STONES; i++) {
    if (i >= uStoneCount) break;
    vec4 a = uStoneA[i];
    vec4 b = uStoneB[i];
    vec2 q = p - a.xy;
    float rad = a.z;
    float dist = length(q);
    if (dist > rad * 3.2) continue;
    vec2 lq = vec2(b.x * q.x + b.y * q.y, b.x * q.y - b.y * q.x);
    lq.y /= b.z;
    float ang = atan(lq.y, lq.x + 0.000001);
    float wobble = 1.0 + 0.07 * sin(ang * 3.0 + b.w) + 0.035 * sin(ang * 5.0 + b.w * 1.7);
    float ds = length(lq) / (rad * wobble);
    float outside = max(ds - 1.0, 0.0);
    vec2 dir = q / max(dist, 0.00001);
    g -= dir * 0.2 * exp(-outside * 5.0) * step(1.0, ds);
    shade *= mix(0.74, 1.0, smoothstep(1.0, 1.9, ds));
    warm += a.w * exp(-outside * 2.6) * 0.45;
    float line = ds + clamp(h / HEIGHT, -1.0, 1.0) * 0.05;
    float edge = uPixel / rad * 1.5;
    float mask = 1.0 - smoothstep(1.0 - edge, 1.0 + edge, line);
    if (mask > 0.0) {
      vec2 local = lq / (rad * wobble);
      float nz = sqrt(max(1.0 - dot(local, local), 0.0));
      vec3 ln = normalize(vec3(local * 0.9, nz * 0.75 + 0.12));
      vec3 sn = vec3(b.x * ln.x - b.y * ln.y, b.y * ln.x + b.x * ln.y, ln.z);
      float tone = hash(vec2(b.w, 3.7));
      vec3 base = mix(vec3(0.46, 0.49, 0.55), vec3(0.64, 0.66, 0.70), tone);
      base *= 0.85 + 0.25 * noise(local * 2.6 + b.w * 7.0);
      float diffuse = max(dot(sn, LIGHT), 0.0);
      vec3 lit = base * (0.12 + 0.7 * diffuse);
      lit *= mix(1.0, 0.5, smoothstep(0.6, 1.0, ds));
      vec3 sv = normalize(EYE - vec3(p, 0.0));
      float sheen = pow(max(dot(reflect(-sv, sn), MOON), 0.0), 24.0);
      lit += MOONLIGHT * sheen * 0.28;
      lit += AMBER * a.w * 0.3 * (0.5 + 0.5 * nz);
      stoneColor = lit;
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
  vec3 deep = mix(vec3(0.008, 0.010, 0.036), vec3(0.020, 0.028, 0.105), uDepth);
  deep *= 0.7 + 0.6 * bed;
  float rim = length(p / uHalf);
  deep *= mix(1.1, 0.55, smoothstep(0.35, 1.25, rim));
  vec3 col = mix(deep, skyColor(r), reflectivity) * shade;
  col += AMBER * (1.0 - exp(-warm * 1.5)) * 0.45;
  col = mix(col, stoneColor, stoneMask);
  col *= mix(1.0, 0.72, smoothstep(0.6, 1.35, rim));
  col = 1.0 - exp(-col * 1.15);
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
  rippleA: "uRippleA[0]",
  rippleB: "uRippleB[0]",
  rippleCount: "uRippleCount",
  stoneA: "uStoneA[0]",
  stoneB: "uStoneB[0]",
  stoneCount: "uStoneCount",
  sing: "uSing[0]",
  singCount: "uSingCount",
};

// Vectors used by everything except the ripple arrays, with some headroom.
const RESERVED_UNIFORM_VECTORS = 32;

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

// Returns { renderer, error }. `renderer` is null when WebGL is unavailable or
// the shader cannot be built; `error` then explains why in plain words.
export function createRenderer(canvas, limits) {
  const gl = canvas.getContext("webgl", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: "high-performance",
  });
  if (!gl) return { renderer: null, error: "WebGL is not available in this browser, so the water cannot be drawn." };

  const uniformVectors = Number(gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS)) || 64;
  const capacity = {
    ripples: Math.max(4, Math.min(limits.ripples, Math.floor((uniformVectors - RESERVED_UNIFORM_VECTORS) / 2))),
    stones: limits.stones,
    sings: limits.sings,
  };
  const fragmentSource =
    `#define MAX_RIPPLES ${capacity.ripples}\n` +
    `#define MAX_STONES ${capacity.stones}\n` +
    `#define MAX_SINGS ${capacity.sings}\n` +
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
    gl.uniform4fv(u.rippleA, frame.rippleA);
    gl.uniform4fv(u.rippleB, frame.rippleB);
    gl.uniform1i(u.rippleCount, frame.rippleCount);
    gl.uniform4fv(u.stoneA, frame.stoneA);
    gl.uniform4fv(u.stoneB, frame.stoneB);
    gl.uniform1i(u.stoneCount, frame.stoneCount);
    gl.uniform4fv(u.sing, frame.sing);
    gl.uniform1i(u.singCount, frame.singCount);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  return { renderer: { capacity, resize, render }, error: "" };
}
