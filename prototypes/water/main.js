import { buildLadder, SCALES } from "../shared/engine.js";
import { getSession, isEmbedded } from "../shared/session.js";
import { createRenderer } from "./renderer.js";

// Pool units: 1 unit is the shorter side of the viewport, origin at the
// centre, y pointing up. The shader uses the same space. The water fills the
// view above the shore line; the shelf of unused stones lies below it.
//
// Each stone is one note, as in tuned stone chimes (bianqing, kei, sanukite).
// The stones set in the water are the notes the water can sound: a finger
// moving through the water makes nearby stones resonate, and ripples strike
// the stones they reach.

const ROOM_ID = "water";
const SOUNDS = [
  { id: "bowl", label: "Bowl" },
  { id: "rin", label: "Rin" },
  { id: "temple", label: "Temple bell" },
  { id: "tingsha", label: "Tingsha" },
];

const LIMITS = { ripples: 24, wake: 48, stones: 12 };
const TWO_PI = Math.PI * 2;

// Must match the shader.
const RING = 0.28;
const BURST_RATE = 3;
const SPREAD = 0.05;

const RIPPLE_SPEED = 0.17;
const PHASE_RATIO = 0.8;
const RIPPLE_VISIBLE = 0.004;
const MAX_GENERATION = 2;
const STONE_COOLDOWN = 1.8;
const STONE_THRESHOLD = 0.05;
const CASCADE_RATE = 2.5;
const CASCADE_BURST = 3;
const TAP_MAX_SECONDS = 0.3;
const TAP_TRAVEL_PX = 12;
const MIN_QUALITY = 0.4;
const FOREIGN_OCTAVES = 3;
const FOREIGN_SPREAD = 0.5;
const FOREIGN_MAX_DELAY = 8;

// Stones and the shelf.
const STONE_RADIUS_LOW = 0.038;
const STONE_RADIUS_HIGH = 0.02;
const STONE_RADIUS_LOW_PX = 14;
const STONE_RADIUS_HIGH_PX = 8;
const BANK_SIDE_PX = 16;
const BANK_GAP_PX = 14;
const BANK_TOUCH_PX = 44;
const BANK_PADDING_PX = 26;
const POOL_MARGIN = 0.014;
const RETURN_SECONDS = 0.45;

// Resonance: each stone in the water is a sustained voice whose pressure
// follows how close and how fast a finger passes it.
const MAX_RUB_VOICES = 8;
const REACH = 0.15;
const RESONANCE_MAX = 0.8;
const RESONANCE_RISE = 0.12;
const RESONANCE_FALL = 0.9;
const VOICE_LEVEL_TAU = 0.7;
const VOICE_START = 0.06;
const VOICE_QUIET = 0.015;
const VOICE_HOLD = 3;
const RUB_UPDATE_SECONDS = 0.05;

// Wake.
const WAKE_SPACING = 0.016;
const WAKE_LIFE = 1.8;
const WAKE_MAX_PER_FRAME = 8;

// A tap on open water.
const DROP_VELOCITY = 0.16;
const DROP_DECAY = 0.08;
const DROP_RIPPLE_SECONDS = 4;

// Hands are fingers in the water: the user's pointers and auto play's strokes.
const MAX_HANDS = 8;
const MAX_AUTO_HANDS = 3;
const AUTO_FIRST_DELAY = 1.5;
const AUTO_MOVE_SPACING = 12;

const THEME_SECONDS = 0.8;

const canvas = requireElement("water");
const fallback = requireElement("fallback");
const startLayer = requireElement("start-layer");
const startButton = requireElement("start");
const backLink = requireElement("back");
const hud = requireElement("hud");
const soundGroup = requireElement("sound");
const themeColor = document.querySelector('meta[name="theme-color"]');

const session = getSession();
const embedded = isEmbedded();

function requireElement(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element;
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function smoothstep(edge0, edge1, value) {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function spreadAt(distance) {
  return 1 / Math.sqrt(1 + distance / SPREAD);
}

function ease(dt, tau) {
  return 1 - Math.exp(-dt / tau);
}

function randomBetween(low, high) {
  return low + Math.random() * (high - low);
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

const { renderer, error: rendererError } = createRenderer(canvas, LIMITS);
if (!renderer) {
  fallback.textContent = rendererError;
  fallback.hidden = false;
}
const capacity = renderer ? renderer.capacity : LIMITS;

// The water darkens with the shared drone level.
function depthForDrone(level) {
  return clamp(level / 0.85, 0, 1);
}

function themeValue() {
  return session.settings.theme === "light" ? 1 : 0;
}

const settings = {
  sound: "bowl",
  depth: depthForDrone(session.settings.drone),
};

const view = {
  width: 1,
  height: 1,
  minDim: 1,
  halfW: 0.5,
  halfH: 0.5,
  quality: (window.devicePixelRatio || 1) >= 2 ? 0.7 : 1,
  shoreY: -0.3,
  radiusLow: STONE_RADIUS_LOW,
  radiusHigh: STONE_RADIUS_HIGH,
  bankStartX: 0,
  bankPitch: 0.08,
  bankRowY: -0.4,
  bankZig: 0,
};

const ripples = Array.from({ length: capacity.ripples }, () => ({
  active: false,
  x: 0,
  y: 0,
  born: 0,
  amp: 0,
  decay: 1,
  ringRate: 1,
  damping: 1,
  speed: RIPPLE_SPEED,
  k: 200,
  generation: 0,
  source: null,
  prevFront: 0,
}));

const wakes = Array.from({ length: capacity.wake }, () => ({ active: false, x: 0, y: 0, born: 0, amp: 0 }));

function makeStone(index) {
  let seed = 11 + index * 7919;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  random();
  return {
    index,
    active: false,
    freq: 220,
    tone: 0,
    pitch: 0,
    x: 0,
    y: 0,
    slotX: 0,
    slotY: 0,
    radius: STONE_RADIUS_LOW,
    targetRadius: STONE_RADIUS_LOW,
    angle: random() * Math.PI,
    aspect: 0.74 + random() * 0.18,
    seed: 1 + Math.floor(random() * 60),
    inPool: false,
    held: false,
    lifted: false,
    wasInPool: false,
    lift: 0,
    wet: 0,
    glow: 0,
    readyAt: 0,
    glideActive: false,
    glideFromX: 0,
    glideFromY: 0,
    glideToX: 0,
    glideToY: 0,
    glideStart: 0,
    glideDuration: 1,
    glideIntoPool: false,
    glideRing: false,
    resonance: 0,
    level: 0,
    motion: 0,
    voice: null,
    quietFor: 0,
    voiceUpdatedAt: 0,
  };
}

const stones = Array.from({ length: capacity.stones }, (_, index) => makeStone(index));

function makeHand() {
  return {
    active: false,
    auto: false,
    x: 0,
    y: 0,
    prevX: 0,
    prevY: 0,
    speed: 0,
    wakeCarry: 0,
    fresh: true,
    inWater: true,
    start: 0,
    duration: 1,
    path: new Float32Array(8),
  };
}

const hands = Array.from({ length: MAX_HANDS }, makeHand);
const gestures = [];
const pendingRings = Array.from({ length: capacity.stones * 2 }, () => ({ stone: null, energy: 0, generation: 0 }));

const auto = {
  running: false,
  nextAt: 0,
  lastMoveAt: -Infinity,
  events: 0,
  strokes: 0,
  drops: 0,
  moves: 0,
};

const state = {
  started: false,
  time: 0,
  visualDepth: settings.depth,
  visualTheme: themeValue(),
  cascadeTokens: CASCADE_BURST,
  stoneCount: 0,
  root: session.settings.root,
  wakeNext: 0,
  get voiceCount() {
    let count = 0;
    for (const stone of stones) if (stone.voice) count += 1;
    return count;
  },
  settings,
  view,
  ripples,
  wakes,
  stones,
  hands,
  gestures,
  auto,
};

const frameData = {
  time: 0,
  halfW: 0.5,
  halfH: 0.5,
  depth: settings.depth,
  theme: state.visualTheme,
  shore: -0.3,
  bank: new Float32Array(4),
  bankSize: new Float32Array(4),
  rippleA: new Float32Array(capacity.ripples * 4),
  rippleB: new Float32Array(capacity.ripples * 4),
  rippleCount: 0,
  wake: new Float32Array(capacity.wake * 4),
  wakeCount: 0,
  stoneA: new Float32Array(capacity.stones * 4),
  stoneB: new Float32Array(capacity.stones * 4),
  stoneC: new Float32Array(capacity.stones * 4),
  stoneCount: 0,
};

window.prototype = {
  get engine() {
    return session.engine;
  },
  state,
};

function isActive() {
  return !embedded || session.settings.room === ROOM_ID;
}

// ---------------------------------------------------------------- pitch

function waveNumberFor(position) {
  return TWO_PI / (0.044 - 0.024 * clamp(position, 0, 1));
}

function panFor(x) {
  return clamp(x / view.halfW, -1, 1) * 0.7;
}

function currentScale() {
  return SCALES[session.settings.scale] ? session.settings.scale : "bhoopali";
}

function nearestDegree(ratios, target, skip) {
  let best = 0;
  let bestDistance = Infinity;
  ratios.forEach((ratio, degree) => {
    if (degree === 0 || degree === skip) return;
    const distance = Math.abs(Math.log2(ratio / target));
    if (distance < bestDistance) {
      best = degree;
      bestDistance = distance;
    }
  });
  return best;
}

// The stones cover the scale from one octave above the root, for about two
// octaves: lower notes are bigger and darker.
function assignStonePitches() {
  const scaleId = currentScale();
  const root = session.settings.root;
  const ratios = SCALES[scaleId].ratios;
  const ladder = buildLadder(root, scaleId, 3);
  const count = Math.min(capacity.stones, ratios.length * 2 + 1);
  state.stoneCount = count;
  state.root = root;
  stones.forEach((stone, index) => {
    stone.active = index < count;
    if (!stone.active) return;
    const note = ladder[ratios.length + index];
    stone.freq = note.freq;
    stone.pitch = Math.log2(note.freq / root);
    stone.tone = count > 1 ? index / (count - 1) : 0;
  });
}

function radiusFor(stone) {
  return view.radiusLow + (view.radiusHigh - view.radiusLow) * stone.tone;
}

// ---------------------------------------------------------------- layout

function clampToPool(stone) {
  const margin = stone.radius + POOL_MARGIN;
  stone.x = clamp(stone.x, -view.halfW + margin, view.halfW - margin);
  stone.y = clamp(stone.y, view.shoreY + margin, Math.max(view.shoreY + margin, view.halfH - margin));
}

function layoutBank() {
  const count = Math.max(1, state.stoneCount);
  const minDim = view.minDim;
  view.radiusLow = Math.max(STONE_RADIUS_LOW, STONE_RADIUS_LOW_PX / minDim);
  view.radiusHigh = Math.max(STONE_RADIUS_HIGH, STONE_RADIUS_HIGH_PX / minDim);
  const lowPx = view.radiusLow * minDim;
  const usable = Math.max(1, view.width - BANK_SIDE_PX * 2);
  const single = 2 * lowPx + BANK_GAP_PX;
  let pitch = usable / count;
  let zig = 0;
  if (pitch >= single) {
    pitch = Math.min(pitch, 2 * lowPx + 34);
  } else {
    // Too narrow for one row: alternate stones up and down so neighbours
    // stay a finger apart while the order still reads left to right.
    const diagonal = Math.max(single, BANK_TOUCH_PX);
    zig = Math.sqrt(Math.max(0, diagonal * diagonal - pitch * pitch)) / 2;
  }
  const hudRect = hud.getBoundingClientRect();
  const hudTop = hudRect.height > 0 && hudRect.top > 0 && hudRect.top < view.height ? hudRect.top : view.height;
  const band = 2 * lowPx + 2 * zig + BANK_PADDING_PX;
  const shorePx = Math.max(view.height * 0.35, hudTop - 4 - band);
  const rowPx = shorePx + band / 2;
  view.shoreY = (view.height / 2 - shorePx) / minDim;
  view.bankRowY = (view.height / 2 - rowPx) / minDim;
  view.bankZig = zig / minDim;
  view.bankPitch = pitch / minDim;
  view.bankStartX = (-(count - 1) / 2) * view.bankPitch;

  for (const stone of stones) {
    stone.slotX = view.bankStartX + stone.index * view.bankPitch;
    stone.slotY = view.bankRowY + (stone.index % 2 === 0 ? -view.bankZig : view.bankZig);
    stone.targetRadius = radiusFor(stone);
    if (!stone.active || stone.held) continue;
    if (stone.glideActive && !stone.glideIntoPool) {
      stone.glideToX = stone.slotX;
      stone.glideToY = stone.slotY;
    } else if (stone.inPool) {
      clampToPool(stone);
    } else if (!stone.glideActive) {
      stone.x = stone.slotX;
      stone.y = stone.slotY;
    }
  }
}

// ---------------------------------------------------------------- stones

function stoneAt(clientX, clientY) {
  let nearest = null;
  let nearestDistance = Infinity;
  for (const stone of stones) {
    if (!stone.active || stone.held) continue;
    const sx = view.width / 2 + stone.x * view.minDim;
    const sy = view.height / 2 - stone.y * view.minDim;
    const distance = Math.hypot(clientX - sx, clientY - sy);
    const reach = Math.max(stone.radius * view.minDim * 1.5, 22);
    if (distance < reach && distance < nearestDistance) {
      nearest = stone;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function sounding(stone) {
  return stone.active && stone.inPool && !stone.held && !stone.glideActive;
}

function poolCount() {
  let count = 0;
  for (const stone of stones) if (stone.active && (stone.inPool || (stone.glideActive && stone.glideIntoPool))) count += 1;
  return count;
}

function ringStone(stone, energy, generation) {
  stone.glow = Math.min(1, stone.glow + 0.35 + energy);
  const velocity = clamp((0.1 + energy * 1.4) * (generation === 1 ? 1 : 0.65), 0.08, 0.5);
  const options = { velocity, pan: panFor(stone.x), decay: 0.8 };
  const decay = session.started ? session.strike(settings.sound, stone.freq, options, ROOM_ID) : 3;
  addRipple(stone.x, stone.y, clamp(energy * 1.2, 0.08, 0.35), decay, waveNumberFor(stone.tone), generation, stone);
}

// A stone on the shelf sounds dry: no ripple.
function strikeDry(stone) {
  stone.glow = Math.min(1, stone.glow + 0.5);
  if (session.started) session.strike(settings.sound, stone.freq, { velocity: 0.3, pan: panFor(stone.x), decay: 0.6 }, ROOM_ID);
}

// Set a stone into the water. Its ring does not cascade, so adding a stone
// stays a single soft note.
function placeInPool(stone, ring) {
  clampToPool(stone);
  stone.inPool = true;
  stone.readyAt = state.time + STONE_COOLDOWN;
  if (ring) {
    ringStone(stone, 0.12, MAX_GENERATION);
  } else {
    addRipple(stone.x, stone.y, 0.18, 2.5, waveNumberFor(stone.tone), MAX_GENERATION, stone);
  }
}

function startGlide(stone, toX, toY, seconds, intoPool, ring) {
  stone.glideActive = true;
  stone.glideFromX = stone.x;
  stone.glideFromY = stone.y;
  stone.glideToX = toX;
  stone.glideToY = toY;
  stone.glideStart = state.time;
  stone.glideDuration = Math.max(0.05, seconds);
  stone.glideIntoPool = intoPool;
  stone.glideRing = ring;
}

function finishGlide(stone) {
  stone.glideActive = false;
  stone.x = stone.glideToX;
  stone.y = stone.glideToY;
  if (stone.glideIntoPool) placeInPool(stone, stone.glideRing);
}

function returnToBank(stone, seconds) {
  stone.inPool = false;
  startGlide(stone, stone.slotX, stone.slotY, seconds, false, false);
}

// Lifting a stone out of the water silences it and leaves a small ripple.
function liftStone(stone) {
  stone.lifted = true;
  stone.wasInPool = stone.inPool;
  if (stone.inPool) {
    addRipple(stone.x, stone.y, 0.16, 2.5, waveNumberFor(stone.tone), MAX_GENERATION, stone);
    stone.inPool = false;
  }
}

function inWaterAt(stone) {
  return stone.y - stone.radius * 0.2 > view.shoreY;
}

function updateStones(dt) {
  const count = state.stoneCount;
  for (let index = 0; index < count; index += 1) {
    const stone = stones[index];
    stone.glow *= Math.exp(-dt / 1.6);
    stone.radius += (stone.targetRadius - stone.radius) * ease(dt, 0.5);
    if (stone.glideActive) {
      const t = clamp((state.time - stone.glideStart) / stone.glideDuration, 0, 1);
      const u = t * t * (3 - 2 * t);
      stone.x = stone.glideFromX + (stone.glideToX - stone.glideFromX) * u;
      stone.y = stone.glideFromY + (stone.glideToY - stone.glideFromY) * u;
      if (t >= 1) finishGlide(stone);
    }
    const raised = (stone.held && stone.lifted) || stone.glideActive;
    stone.lift += ((raised ? 1 : 0) - stone.lift) * ease(dt, 0.12);
    stone.wet += ((stone.inPool && !raised ? 1 : 0) - stone.wet) * ease(dt, 0.25);
    if (!sounding(stone)) continue;
    // Stones set too close drift apart until they no longer touch.
    for (let other = 0; other < count; other += 1) {
      const neighbour = stones[other];
      if (other === index || !sounding(neighbour)) continue;
      const dx = stone.x - neighbour.x;
      const dy = stone.y - neighbour.y;
      const distance = Math.hypot(dx, dy);
      const gap = stone.radius + neighbour.radius + 0.012;
      if (distance < gap && distance > 1e-6) {
        const push = (gap - distance) * 0.5 * Math.min(1, dt * 4);
        stone.x += (dx / distance) * push;
        stone.y += (dy / distance) * push;
      }
    }
    clampToPool(stone);
  }
}

// ---------------------------------------------------------------- resonance

function releaseVoice(stone) {
  if (stone.voice) stone.voice.release();
  stone.voice = null;
  stone.quietFor = 0;
}

function releaseAllVoices() {
  for (const stone of stones) {
    releaseVoice(stone);
    stone.resonance = 0;
    stone.level = 0;
  }
}

function updateResonance(dt) {
  let voices = state.voiceCount;
  for (const stone of stones) {
    let target = 0;
    let motion = 0;
    if (sounding(stone)) {
      for (const hand of hands) {
        if (!hand.active || !hand.inWater) continue;
        const gap = Math.max(0, Math.hypot(hand.x - stone.x, hand.y - stone.y) - stone.radius);
        if (gap > REACH * 2.5) continue;
        const moving = smoothstep(0.02, 0.45, hand.speed);
        const amount = Math.exp(-((gap / REACH) ** 2)) * moving;
        target += amount;
        motion = Math.max(motion, moving);
      }
      target = Math.min(1, target) * RESONANCE_MAX;
    }
    stone.resonance += (target - stone.resonance) * ease(dt, target > stone.resonance ? RESONANCE_RISE : RESONANCE_FALL);
    stone.motion += (motion - stone.motion) * ease(dt, 0.3);

    if (!stone.voice && target > VOICE_START && voices < MAX_RUB_VOICES && session.started) {
      stone.voice = session.rub(settings.sound, stone.freq, { pan: panFor(stone.x) });
      stone.quietFor = 0;
      stone.voiceUpdatedAt = 0;
      if (stone.voice) voices += 1;
    }
    if (stone.voice) {
      stone.quietFor = stone.resonance < VOICE_QUIET && target < VOICE_QUIET ? stone.quietFor + dt : 0;
      if (stone.quietFor > VOICE_HOLD || !sounding(stone)) {
        releaseVoice(stone);
        voices -= 1;
      } else if (state.time - stone.voiceUpdatedAt > RUB_UPDATE_SECONDS) {
        stone.voice.set(stone.resonance, 0.08 + 0.25 * stone.motion);
        stone.voice.setPan(panFor(stone.x));
        stone.voiceUpdatedAt = state.time;
      }
    }
    // The glow follows the voice's own envelope, which the engine eases.
    const heard = stone.voice ? stone.resonance : 0;
    stone.level += (heard - stone.level) * ease(dt, VOICE_LEVEL_TAU);
  }
}

// ---------------------------------------------------------------- ripples

function rippleLevel(ripple, age) {
  return ripple.amp * Math.exp(-age * ripple.damping);
}

function addRipple(x, y, amp, decay, k, generation, source) {
  let slot = null;
  let weakest = Infinity;
  for (const ripple of ripples) {
    if (!ripple.active) {
      slot = ripple;
      break;
    }
    const strength = rippleLevel(ripple, state.time - ripple.born);
    if (strength < weakest) {
      weakest = strength;
      slot = ripple;
    }
  }
  if (!slot) return;
  const length = Math.max(decay, 0.5);
  slot.active = true;
  slot.x = x;
  slot.y = y;
  slot.born = state.time;
  slot.amp = amp;
  slot.decay = length;
  slot.ringRate = 3 / length;
  slot.damping = 0.12 + 1.2 / length;
  slot.speed = RIPPLE_SPEED;
  slot.k = k;
  slot.generation = generation;
  slot.source = source;
  slot.prevFront = 0;
}

function updateRipples(dt, cascadeEnabled) {
  state.cascadeTokens = Math.min(CASCADE_BURST, state.cascadeTokens + dt * CASCADE_RATE);
  let pendingCount = 0;
  for (const ripple of ripples) {
    if (!ripple.active) continue;
    const age = state.time - ripple.born;
    const level = rippleLevel(ripple, age);
    const front = ripple.speed * age;
    const far = Math.hypot(view.halfW + Math.abs(ripple.x), view.halfH + Math.abs(ripple.y));
    const frontLevel = front < far + 0.1 ? spreadAt(front) : 0;
    const tailLevel = RING * Math.exp(-age * ripple.ringRate) + (1 - RING) * Math.exp(-age * BURST_RATE);
    if (level * Math.max(frontLevel, tailLevel) < RIPPLE_VISIBLE) {
      ripple.active = false;
      continue;
    }
    if (cascadeEnabled && ripple.generation < MAX_GENERATION) {
      for (const stone of stones) {
        if (stone === ripple.source || !sounding(stone)) continue;
        const distance = Math.max(0, Math.hypot(stone.x - ripple.x, stone.y - ripple.y) - stone.radius);
        if (ripple.prevFront >= distance || front < distance) continue;
        const energy = level * spreadAt(distance);
        if (energy < STONE_THRESHOLD || state.time < stone.readyAt) continue;
        if (state.cascadeTokens < 1 || pendingCount >= pendingRings.length) continue;
        state.cascadeTokens -= 1;
        stone.readyAt = state.time + STONE_COOLDOWN;
        const pending = pendingRings[pendingCount];
        pending.stone = stone;
        pending.energy = energy;
        pending.generation = ripple.generation + 1;
        pendingCount += 1;
      }
    }
    ripple.prevFront = front;
  }
  for (let index = 0; index < pendingCount; index += 1) {
    const pending = pendingRings[index];
    if (pending.stone) ringStone(pending.stone, pending.energy, pending.generation);
    pending.stone = null;
  }
}

// A single drop: a ripple that strikes the stones it reaches, and a very
// soft short note of its own an octave above the nearest stone.
function dropAt(x, y) {
  let nearest = null;
  let nearestDistance = Infinity;
  for (const stone of stones) {
    if (!sounding(stone)) continue;
    const distance = Math.hypot(stone.x - x, stone.y - y);
    if (distance < nearestDistance) {
      nearest = stone;
      nearestDistance = distance;
    }
  }
  const base = nearest ? nearest.freq : session.settings.root * 2;
  const freq = base * 2 > 1400 ? base : base * 2;
  if (session.started) {
    session.strike("glass", freq, { velocity: DROP_VELOCITY, pan: panFor(x), decay: DROP_DECAY }, ROOM_ID);
  }
  addRipple(x, y, 0.5, DROP_RIPPLE_SECONDS, waveNumberFor(0.8), 0, null);
}

// ---------------------------------------------------------------- wake

function addWake(x, y, amp) {
  if (wakes.length === 0) return;
  const wake = wakes[state.wakeNext];
  state.wakeNext = (state.wakeNext + 1) % wakes.length;
  wake.active = true;
  wake.x = x;
  wake.y = y;
  wake.born = state.time;
  wake.amp = amp;
}

function updateWakes() {
  for (const wake of wakes) {
    if (wake.active && state.time - wake.born > WAKE_LIFE) wake.active = false;
  }
}

// ---------------------------------------------------------------- hands

function claimHand(isAuto) {
  for (const hand of hands) {
    if (hand.active) continue;
    hand.active = true;
    hand.auto = isAuto;
    hand.speed = 0;
    hand.wakeCarry = 0;
    hand.fresh = true;
    hand.inWater = true;
    return hand;
  }
  return null;
}

function autoHandCount() {
  let count = 0;
  for (const hand of hands) if (hand.active && hand.auto) count += 1;
  return count;
}

function bezier(path, t, offset) {
  const u = 1 - t;
  return (
    u * u * u * path[offset] + 3 * u * u * t * path[offset + 2] + 3 * u * t * t * path[offset + 4] + t * t * t * path[offset + 6]
  );
}

function updateHands(dt) {
  for (const hand of hands) {
    if (!hand.active) continue;
    if (hand.auto) {
      const t = (state.time - hand.start) / hand.duration;
      if (t >= 1) {
        hand.active = false;
        continue;
      }
      const u = 0.5 - 0.5 * Math.cos(Math.PI * clamp(t, 0, 1));
      hand.x = bezier(hand.path, u, 0);
      hand.y = bezier(hand.path, u, 1);
      hand.inWater = hand.y > view.shoreY;
    }
    if (hand.fresh) {
      hand.prevX = hand.x;
      hand.prevY = hand.y;
      hand.fresh = false;
      continue;
    }
    const dx = hand.x - hand.prevX;
    const dy = hand.y - hand.prevY;
    const distance = Math.hypot(dx, dy);
    hand.speed += (distance / Math.max(dt, 0.001) - hand.speed) * ease(dt, 0.08);
    if (distance > 1e-5 && hand.inWater) {
      const spacing = Math.max(WAKE_SPACING, distance / WAKE_MAX_PER_FRAME);
      const amp = 0.12 + 0.58 * smoothstep(0.03, 0.6, hand.speed);
      hand.wakeCarry += distance;
      while (hand.wakeCarry >= spacing) {
        hand.wakeCarry -= spacing;
        const along = 1 - hand.wakeCarry / distance;
        addWake(hand.prevX + dx * along, hand.prevY + dy * along, amp);
      }
    }
    hand.prevX = hand.x;
    hand.prevY = hand.y;
  }
}

// ---------------------------------------------------------------- gestures

function toPool(clientX, clientY) {
  return {
    x: (clientX - view.width / 2) / view.minDim,
    y: (view.height / 2 - clientY) / view.minDim,
  };
}

function findGesture(id) {
  for (const gesture of gestures) if (gesture.id === id) return gesture;
  return null;
}

// A strike from another room: a ripple at the radius of its pitch, toward the
// side of its pan. Generation MAX_GENERATION keeps it from ringing stones.
function showForeignStrike(strike) {
  if (!state.started || !isActive()) return;
  const position = clamp(Math.log2(strike.freq / session.settings.root) / FOREIGN_OCTAVES, 0, 1);
  const side = Math.random() < 0.5 ? 1 : -1;
  const angle = side * (Math.acos(clamp(strike.pan, -1, 1)) + (Math.random() - 0.5) * FOREIGN_SPREAD);
  const poolHalfH = (view.halfH - view.shoreY) / 2;
  const x = Math.cos(angle) * position * view.halfW * 0.92;
  const y = view.shoreY + poolHalfH + Math.sin(angle) * position * poolHalfH * 0.92;
  const amp = 0.2 + 0.6 * clamp(strike.velocity, 0, 1);
  addRipple(x, y, amp, strike.decay, waveNumberFor(position), MAX_GENERATION, null);
}

function onForeignStrike(detail) {
  if (!state.started || !isActive() || !session.engine) return;
  const strike = {
    freq: Number(detail.freq),
    pan: Number(detail.pan) || 0,
    velocity: Number(detail.velocity) || 0.5,
    decay: Number(detail.decay) || 3,
  };
  if (!(strike.freq > 0)) return;
  const delay = Math.min(Number(detail.when) - session.engine.context.currentTime, FOREIGN_MAX_DELAY);
  if (delay > 0.01) {
    window.setTimeout(() => showForeignStrike(strike), delay * 1000);
  } else {
    showForeignStrike(strike);
  }
}

function onPointerDown(event) {
  if (!state.started || !session.started || !isActive()) return;
  event.preventDefault();
  if (findGesture(event.pointerId)) return;
  const point = toPool(event.clientX, event.clientY);
  const stone = stoneAt(event.clientX, event.clientY);
  if (!stone && point.y <= view.shoreY) return;
  canvas.setPointerCapture(event.pointerId);
  const gesture = {
    id: event.pointerId,
    kind: stone ? "stone" : "water",
    downAt: performance.now() / 1000,
    downX: point.x,
    downY: point.y,
    clientStartX: event.clientX,
    clientStartY: event.clientY,
    travel: 0,
    stone,
    hand: null,
    offsetX: stone ? stone.x - point.x : 0,
    offsetY: stone ? stone.y - point.y : 0,
  };
  if (stone) {
    if (stone.glideActive) {
      stone.glideActive = false;
      stone.inPool = false;
    }
    stone.held = true;
    stone.lifted = false;
    stone.wasInPool = stone.inPool;
  } else {
    gesture.hand = claimHand(false);
    if (gesture.hand) {
      gesture.hand.x = point.x;
      gesture.hand.y = point.y;
    }
    addWake(point.x, point.y, 0.35);
  }
  gestures.push(gesture);
}

function onPointerMove(event) {
  const gesture = findGesture(event.pointerId);
  if (!gesture) return;
  const point = toPool(event.clientX, event.clientY);
  gesture.travel = Math.max(
    gesture.travel,
    Math.hypot(event.clientX - gesture.clientStartX, event.clientY - gesture.clientStartY),
  );
  const stone = gesture.stone;
  if (stone) {
    if (!stone.lifted && gesture.travel > TAP_TRAVEL_PX) liftStone(stone);
    if (stone.lifted) {
      stone.x = clamp(point.x + gesture.offsetX, -view.halfW + stone.radius, view.halfW - stone.radius);
      stone.y = clamp(point.y + gesture.offsetY, -view.halfH + stone.radius, view.halfH - stone.radius);
    }
    return;
  }
  if (gesture.hand) {
    gesture.hand.x = point.x;
    gesture.hand.y = point.y;
    gesture.hand.inWater = point.y > view.shoreY;
  }
}

function finishGesture(gesture, cancelled) {
  const position = gestures.indexOf(gesture);
  if (position < 0) return;
  gestures.splice(position, 1);
  const tapped =
    !cancelled && performance.now() / 1000 - gesture.downAt < TAP_MAX_SECONDS && gesture.travel < TAP_TRAVEL_PX;

  const stone = gesture.stone;
  if (stone) {
    stone.held = false;
    if (!stone.lifted) {
      if (tapped && stone.inPool) {
        stone.readyAt = state.time + STONE_COOLDOWN;
        ringStone(stone, 0.3, 1);
      } else if (tapped) {
        strikeDry(stone);
      }
      if (!stone.inPool) returnToBank(stone, RETURN_SECONDS);
      return;
    }
    stone.lifted = false;
    if (inWaterAt(stone)) {
      placeInPool(stone, !stone.wasInPool && !cancelled);
    } else {
      returnToBank(stone, RETURN_SECONDS);
    }
    return;
  }

  if (gesture.hand) gesture.hand.active = false;
  if (tapped) dropAt(gesture.downX, gesture.downY);
}

function onPointerEnd(event) {
  const gesture = findGesture(event.pointerId);
  if (gesture) finishGesture(gesture, event.type !== "pointerup");
}

function releaseAllGestures() {
  for (let index = gestures.length - 1; index >= 0; index -= 1) finishGesture(gestures[index], true);
}

// ---------------------------------------------------------------- auto play
// Auto play uses the same hands, drops and stone moves as a finger, so
// everything it does is visible. It never touches a stone the user holds.

function autoEnabled() {
  return session.settings.auto === true && isActive() && state.started && session.started;
}

function activity() {
  return clamp(Number(session.settings.activity) || 0, 0, 1);
}

// Seconds between events: about 25 at activity 0.05, 8 at 0.4, 1.6 at 1.
function autoInterval() {
  const a = activity();
  const base = a <= 0.4 ? 25 * (8 / 25) ** ((Math.max(a, 0.05) - 0.05) / 0.35) : 8 * (1.6 / 8) ** ((a - 0.4) / 0.6);
  return base * randomBetween(0.8, 1.2);
}

function stopAuto() {
  auto.running = false;
  for (const hand of hands) if (hand.auto) hand.active = false;
}

function poolInterior(margin) {
  return {
    minX: -view.halfW + margin,
    maxX: view.halfW - margin,
    minY: view.shoreY + margin,
    maxY: Math.max(view.shoreY + margin, view.halfH - margin),
  };
}

function startAutoStroke() {
  if (autoHandCount() >= MAX_AUTO_HANDS) return false;
  const hand = claimHand(true);
  if (!hand) return false;
  const inside = poolInterior(0.06);
  const poolStones = stones.filter(sounding);
  let cx = randomBetween(inside.minX, inside.maxX);
  let cy = randomBetween(inside.minY, inside.maxY);
  if (poolStones.length >= 2 && Math.random() < 0.4) {
    const first = pick(poolStones);
    const second = pick(poolStones.filter((stone) => stone !== first));
    cx = (first.x + second.x) / 2;
    cy = (first.y + second.y) / 2;
  } else if (poolStones.length > 0) {
    const target = pick(poolStones);
    cx = target.x;
    cy = target.y;
  }
  const angle = Math.random() * TWO_PI;
  const dirX = Math.cos(angle);
  const dirY = Math.sin(angle);
  const side = (Math.random() < 0.5 ? -1 : 1) * randomBetween(0.04, 0.1);
  const before = randomBetween(0.18, 0.36);
  const after = randomBetween(0.18, 0.36);
  const points = [
    [-before, side * 0.4],
    [-before * 0.35, side],
    [after * 0.35, side],
    [after, side * 0.2 + randomBetween(-0.08, 0.08)],
  ];
  let length = 0;
  points.forEach(([along, across], index) => {
    const x = clamp(cx + dirX * along - dirY * across, inside.minX, inside.maxX);
    const y = clamp(cy + dirY * along + dirX * across, inside.minY, inside.maxY);
    if (index > 0) length += Math.hypot(x - hand.path[index * 2 - 2], y - hand.path[index * 2 - 1]);
    hand.path[index * 2] = x;
    hand.path[index * 2 + 1] = y;
  });
  const speed = 0.09 + 0.15 * activity();
  hand.start = state.time;
  hand.duration = clamp((length * 0.85) / speed, 2, 9);
  hand.x = hand.path[0];
  hand.y = hand.path[1];
  auto.strokes += 1;
  return true;
}

function startAutoDrop() {
  const inside = poolInterior(0.08);
  dropAt(randomBetween(inside.minX, inside.maxX), randomBetween(inside.minY, inside.maxY));
  auto.drops += 1;
  return true;
}

// The open spot farthest from the stones already in the water.
function openSpot(stone) {
  const inside = poolInterior(stone.radius + 0.08);
  let bestX = (inside.minX + inside.maxX) / 2;
  let bestY = (inside.minY + inside.maxY) / 2;
  let bestRoom = -Infinity;
  for (let attempt = 0; attempt < 14; attempt += 1) {
    const x = randomBetween(inside.minX, inside.maxX);
    const y = randomBetween(inside.minY, inside.maxY);
    let room = Infinity;
    for (const other of stones) {
      if (other === stone || !other.active) continue;
      if (!other.inPool && !(other.glideActive && other.glideIntoPool)) continue;
      const ox = other.glideActive ? other.glideToX : other.x;
      const oy = other.glideActive ? other.glideToY : other.y;
      room = Math.min(room, Math.hypot(ox - x, oy - y));
    }
    room = Math.min(room, 0.3) - Math.hypot(x, y - (inside.minY + inside.maxY) / 2) * 0.1;
    if (room > bestRoom) {
      bestRoom = room;
      bestX = x;
      bestY = y;
    }
  }
  return { x: bestX, y: bestY };
}

function startAutoMove() {
  const count = poolCount();
  const free = (stone) => stone.active && !stone.held && !stone.glideActive;
  const onShelf = stones.filter((stone) => free(stone) && !stone.inPool);
  const inWater = stones.filter((stone) => free(stone) && stone.inPool && stone.resonance < 0.2);
  const add = count <= 2 || (count < 6 && Math.random() < 0.5);
  if (add && onShelf.length > 0) {
    const stone = pick(onShelf);
    const spot = openSpot(stone);
    startGlide(stone, spot.x, spot.y, randomBetween(1.6, 2.4), true, true);
  } else if (!add && inWater.length > 0) {
    const stone = pick(inWater);
    stone.inPool = false;
    addRipple(stone.x, stone.y, 0.16, 2.5, waveNumberFor(stone.tone), MAX_GENERATION, stone);
    startGlide(stone, stone.slotX, stone.slotY, randomBetween(1.6, 2.4), false, false);
  } else {
    return false;
  }
  auto.lastMoveAt = state.time;
  auto.moves += 1;
  return true;
}

function runAutoEvent() {
  const roll = Math.random();
  let done = false;
  if (poolCount() === 0 || (roll < 0.12 && state.time - auto.lastMoveAt > AUTO_MOVE_SPACING)) done = startAutoMove();
  if (!done && roll < 0.3) done = startAutoDrop();
  if (!done) done = startAutoStroke();
  if (!done) done = startAutoDrop();
  auto.events += 1;
}

function updateAuto() {
  if (!autoEnabled()) {
    if (auto.running) stopAuto();
    return;
  }
  if (!auto.running) {
    auto.running = true;
    auto.nextAt = state.time + AUTO_FIRST_DELAY;
  }
  if (state.time < auto.nextAt) return;
  runAutoEvent();
  auto.nextAt = state.time + autoInterval();
}

// ---------------------------------------------------------------- frame

function packStone(stone, count) {
  const offset = count * 4;
  frameData.stoneA[offset] = stone.x;
  frameData.stoneA[offset + 1] = stone.y;
  frameData.stoneA[offset + 2] = stone.radius;
  frameData.stoneA[offset + 3] = Math.min(1.2, stone.glow + stone.level * 1.1);
  frameData.stoneB[offset] = Math.cos(stone.angle);
  frameData.stoneB[offset + 1] = Math.sin(stone.angle);
  frameData.stoneB[offset + 2] = stone.aspect;
  frameData.stoneB[offset + 3] = stone.seed + stone.tone * 0.98;
  frameData.stoneC[offset] = stone.level;
  frameData.stoneC[offset + 1] = stone.wet;
  frameData.stoneC[offset + 2] = stone.lift;
  frameData.stoneC[offset + 3] = 0;
}

function packFrame() {
  frameData.time = state.time;
  frameData.halfW = view.halfW;
  frameData.halfH = view.halfH;
  frameData.depth = state.visualDepth;
  frameData.theme = state.visualTheme;
  frameData.shore = view.shoreY;
  frameData.bank[0] = view.bankStartX;
  frameData.bank[1] = view.bankPitch;
  frameData.bank[2] = view.bankRowY;
  frameData.bank[3] = view.bankZig;
  frameData.bankSize[0] = view.radiusLow;
  frameData.bankSize[1] = view.radiusHigh;
  frameData.bankSize[2] = state.stoneCount;
  frameData.bankSize[3] = 0;

  let count = 0;
  for (const ripple of ripples) {
    if (!ripple.active || count >= capacity.ripples) continue;
    const age = state.time - ripple.born;
    const offset = count * 4;
    frameData.rippleA[offset] = ripple.x;
    frameData.rippleA[offset + 1] = ripple.y;
    frameData.rippleA[offset + 2] = age;
    frameData.rippleA[offset + 3] = rippleLevel(ripple, age);
    frameData.rippleB[offset] = ripple.ringRate;
    frameData.rippleB[offset + 1] = ripple.speed;
    frameData.rippleB[offset + 2] = ripple.k;
    frameData.rippleB[offset + 3] = (ripple.k * ripple.speed * PHASE_RATIO * age) % TWO_PI;
    count += 1;
  }
  frameData.rippleCount = count;

  count = 0;
  for (const wake of wakes) {
    if (!wake.active) continue;
    const age = state.time - wake.born;
    const offset = count * 4;
    frameData.wake[offset] = wake.x;
    frameData.wake[offset + 1] = wake.y;
    frameData.wake[offset + 2] = age;
    // Rings grow in over the first moments so the trail reads as one wake.
    const grow = smoothstep(0, 0.3, age);
    frameData.wake[offset + 3] = wake.amp * grow * Math.exp(-age * 1.4) * (1 - age / WAKE_LIFE);
    count += 1;
  }
  frameData.wakeCount = count;

  // Raised stones are drawn last so they pass over the others.
  count = 0;
  for (let pass = 0; pass < 2; pass += 1) {
    for (const stone of stones) {
      if (!stone.active || count >= capacity.stones) continue;
      const raised = stone.lift > 0.02;
      if (raised !== (pass === 1)) continue;
      packStone(stone, count);
      count += 1;
    }
  }
  frameData.stoneCount = count;
}

const timing = { last: -1, sum: 0, frames: 0, best: Infinity };

function adaptQuality(interval) {
  if (interval <= 0 || interval > 100) return;
  timing.best = Math.min(timing.best, interval);
  timing.sum += interval;
  timing.frames += 1;
  if (timing.frames < 90) return;
  const average = timing.sum / timing.frames;
  timing.sum = 0;
  timing.frames = 0;
  if (average > Math.max(timing.best * 1.35, 19) && view.quality > MIN_QUALITY) {
    view.quality = Math.max(MIN_QUALITY, view.quality - 0.12);
    applySize();
  }
}

let rafId = 0;

function frame(nowMs) {
  rafId = window.requestAnimationFrame(frame);
  const interval = timing.last < 0 ? 1000 / 60 : nowMs - timing.last;
  timing.last = nowMs;
  adaptQuality(interval);
  const dt = Math.min(interval / 1000, 0.1);
  state.time += dt;
  state.visualDepth += (settings.depth - state.visualDepth) * ease(dt, 1.2);
  const theme = themeValue();
  state.visualTheme += clamp(theme - state.visualTheme, -dt / THEME_SECONDS, dt / THEME_SECONDS);

  updateAuto();
  updateHands(dt);
  updateWakes();
  updateStones(dt);
  updateResonance(dt);
  updateRipples(dt, interval < 250);

  if (renderer) {
    packFrame();
    renderer.render(frameData);
  }
}

function startLoop() {
  if (rafId || document.hidden || !isActive()) return;
  timing.last = -1;
  rafId = window.requestAnimationFrame(frame);
}

function stopLoop() {
  if (!rafId) return;
  window.cancelAnimationFrame(rafId);
  rafId = 0;
}

// Let go of everything that sounds: held pointers, auto strokes, stone voices.
function silence() {
  releaseAllGestures();
  stopAuto();
  for (const hand of hands) hand.active = false;
  releaseAllVoices();
}

function updateActivity() {
  if (isActive()) {
    startLoop();
  } else {
    stopLoop();
    silence();
  }
}

// ---------------------------------------------------------------- layout

function applySize() {
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);
  view.width = width;
  view.height = height;
  view.minDim = Math.min(width, height);
  view.halfW = width / 2 / view.minDim;
  view.halfH = height / 2 / view.minDim;
  layoutBank();
  if (renderer) renderer.resize(width, height, Math.min(window.devicePixelRatio || 1, 2) * view.quality);
}

// ---------------------------------------------------------------- stones in the water

// Start with the root, a fifth-like degree and a third-like degree an octave
// up, so the water sounds at once.
function placeInitialStones() {
  const ratios = SCALES[currentScale()].ratios;
  const fifth = nearestDegree(ratios, 3 / 2, -1);
  const third = nearestDegree(ratios, 5 / 4, fifth);
  const picks = [
    { index: 0, x: -0.13, y: -0.06 },
    { index: fifth, x: 0.15, y: 0.03 },
    { index: ratios.length + third, x: -0.02, y: 0.16 },
  ];
  const poolHalfH = (view.halfH - view.shoreY) / 2;
  const centreY = view.shoreY + poolHalfH;
  const scale = clamp(Math.min(view.halfW, poolHalfH) / 0.4, 0.6, 1.2);
  for (const choice of picks) {
    const stone = stones[choice.index];
    if (!stone || !stone.active) continue;
    stone.radius = stone.targetRadius;
    stone.x = choice.x * scale;
    stone.y = centreY + choice.y * scale;
    clampToPool(stone);
    stone.inPool = true;
    stone.wet = 1;
  }
}

// A new root or scale retunes the stones. Stones in the water stay where they
// are, each becoming the nearest note of the new set.
function retuneStones() {
  releaseAllGestures();
  releaseAllVoices();
  const kept = [];
  for (const stone of stones) {
    if (!stone.active) continue;
    const entering = stone.glideActive && stone.glideIntoPool;
    if (stone.inPool || entering) {
      kept.push({
        pitch: stone.pitch,
        x: entering ? stone.glideToX : stone.x,
        y: entering ? stone.glideToY : stone.y,
      });
    }
    stone.inPool = false;
    stone.glideActive = false;
  }
  assignStonePitches();
  layoutBank();
  for (const entry of kept) {
    let best = null;
    let bestDistance = Infinity;
    for (const stone of stones) {
      if (!stone.active || stone.inPool) continue;
      const distance = Math.abs(stone.pitch - entry.pitch);
      if (distance < bestDistance) {
        best = stone;
        bestDistance = distance;
      }
    }
    if (!best) continue;
    best.x = entry.x;
    best.y = entry.y;
    best.inPool = true;
    clampToPool(best);
  }
  for (const stone of stones) {
    if (!stone.active || stone.inPool) continue;
    startGlide(stone, stone.slotX, stone.slotY, 0.5, false, false);
  }
}

// ---------------------------------------------------------------- controls

function buildSegmented(container, options, current, onSelect) {
  const buttons = options.map((option) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = option.label;
    button.setAttribute("aria-pressed", String(option.id === current));
    button.addEventListener("click", () => {
      for (const other of buttons) other.setAttribute("aria-pressed", String(other === button));
      onSelect(option.id);
    });
    container.append(button);
    return button;
  });
}

// The sound is what the stones are made of; voices already sounding are let
// go so the next touch uses the new material.
buildSegmented(soundGroup, SOUNDS, settings.sound, (id) => {
  if (settings.sound === id) return;
  settings.sound = id;
  for (const stone of stones) releaseVoice(stone);
});

function applyTheme() {
  const light = themeValue() === 1;
  document.documentElement.dataset.theme = light ? "light" : "dark";
  if (themeColor) themeColor.setAttribute("content", light ? "#dde2e8" : "#04060d");
}

function goLive() {
  if (state.started) return;
  state.started = true;
  startLayer.classList.add("is-leaving");
  window.setTimeout(() => startLayer.remove(), 1400);
  hud.inert = false;
  hud.removeAttribute("aria-hidden");
  hud.classList.add("is-visible");
}

function onSessionEvent(type, detail) {
  if (type === "started") {
    goLive();
  } else if (type === "setting") {
    if (detail.key === "root" || detail.key === "scale") retuneStones();
    if (detail.key === "drone") settings.depth = depthForDrone(session.settings.drone);
    if (detail.key === "room") updateActivity();
    if (detail.key === "theme") applyTheme();
    if (detail.key === "auto" && session.settings.auto !== true) stopAuto();
    if (detail.key === "activity" && auto.running) auto.nextAt = Math.min(auto.nextAt, state.time + autoInterval());
  } else if (type === "strike" && detail.source !== ROOM_ID) {
    onForeignStrike(detail);
  }
}

startButton.addEventListener("click", async () => {
  if (state.started) return;
  goLive();
  try {
    await session.start();
  } catch {
    fallback.textContent = "Audio could not be started in this browser.";
    fallback.hidden = false;
  }
});

// ---------------------------------------------------------------- wiring

canvas.addEventListener("pointerdown", onPointerDown);
canvas.addEventListener("pointermove", onPointerMove);
canvas.addEventListener("pointerup", onPointerEnd);
canvas.addEventListener("pointercancel", onPointerEnd);
canvas.addEventListener("lostpointercapture", onPointerEnd);
canvas.addEventListener("contextmenu", (event) => event.preventDefault());

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopLoop();
    silence();
  } else {
    startLoop();
  }
});

// The session can outlive this page when it belongs to the shell, so let go of
// sounding stones and stop listening when the page goes away.
let unsubscribe = session.on(onSessionEvent);
window.addEventListener("pagehide", () => {
  silence();
  unsubscribe();
});
window.addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  unsubscribe();
  unsubscribe = session.on(onSessionEvent);
  if (session.started) goLive();
  retuneStones();
  settings.depth = depthForDrone(session.settings.drone);
  applyTheme();
  updateActivity();
});

if (typeof ResizeObserver === "function") {
  const observer = new ResizeObserver(applySize);
  observer.observe(canvas);
  observer.observe(hud);
} else {
  window.addEventListener("resize", applySize);
}

hud.inert = true;
applyTheme();
assignStonePitches();
if (embedded) {
  startLayer.remove();
  backLink.remove();
  if (session.started) goLive();
}
applySize();
for (const stone of stones) stone.radius = stone.targetRadius;
placeInitialStones();
startLoop();
