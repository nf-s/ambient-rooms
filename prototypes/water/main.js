import { buildLadder } from "../shared/engine.js";
import { getSession, isEmbedded } from "../shared/session.js";
import { createRenderer } from "./renderer.js";

// Pool units: 1 unit is the shorter side of the viewport, origin at the
// centre, y pointing up. The shader uses the same space.

const ROOM_ID = "water";
const OCTAVES = 3;
const SOUNDS = [
  { id: "bowl", label: "Bowl" },
  { id: "rin", label: "Rin" },
  { id: "temple", label: "Temple bell" },
  { id: "tingsha", label: "Tingsha" },
];

const LIMITS = { ripples: 24, stones: 8, sings: 4 };
const TWO_PI = Math.PI * 2;

// Must match the shader.
const RING = 0.28;
const BURST_RATE = 3;
const SPREAD = 0.05;

const RIPPLE_SPEED = 0.17;
const PHASE_RATIO = 0.8;
const RIPPLE_VISIBLE = 0.004;
const MAX_GENERATION = 2;
const STONE_COUNT = 6;
const STONE_COOLDOWN = 1.8;
const STONE_THRESHOLD = 0.05;
const STONE_DRIFT = 0.0015;
const CASCADE_RATE = 2.5;
const CASCADE_BURST = 3;
const TAP_MAX_SECONDS = 0.3;
const TAP_TRAVEL_PX = 12;
const RUB_UPDATE_SECONDS = 0.05;
const MIN_QUALITY = 0.4;
const FOREIGN_SPREAD = 0.5;
const FOREIGN_MAX_DELAY = 8;

const canvas = requireElement("water");
const fallback = requireElement("fallback");
const startLayer = requireElement("start-layer");
const startButton = requireElement("start");
const backLink = requireElement("back");
const hud = requireElement("hud");
const soundGroup = requireElement("sound");

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

function wrapAngle(angle) {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function spreadAt(distance) {
  return 1 / Math.sqrt(1 + distance / SPREAD);
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
  stoneMinX: -0.4,
  stoneMaxX: 0.4,
  stoneMinY: -0.4,
  stoneMaxY: 0.4,
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

const sings = Array.from({ length: capacity.sings }, () => ({
  active: false,
  x: 0,
  y: 0,
  amp: 0,
  spin: 0,
  releaseTau: 0.4,
  gesture: null,
}));

const stones = [];
const gestures = [];
const pendingRings = Array.from({ length: STONE_COUNT * 2 }, () => ({ stone: null, energy: 0, generation: 0 }));

const state = {
  started: false,
  time: 0,
  visualDepth: settings.depth,
  cascadeTokens: CASCADE_BURST,
  ladder: buildLadder(session.settings.root, session.settings.scale, OCTAVES),
  settings,
  view,
  ripples,
  stones,
  sings,
  gestures,
};

const frameData = {
  time: 0,
  halfW: 0.5,
  halfH: 0.5,
  depth: settings.depth,
  rippleA: new Float32Array(capacity.ripples * 4),
  rippleB: new Float32Array(capacity.ripples * 4),
  rippleCount: 0,
  stoneA: new Float32Array(capacity.stones * 4),
  stoneB: new Float32Array(capacity.stones * 4),
  stoneCount: 0,
  sing: new Float32Array(capacity.sings * 4),
  singCount: 0,
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

function ladderIndexAt(x, y) {
  const norm = Math.hypot(x / (view.halfW * 0.92), y / (view.halfH * 0.92));
  return Math.round(clamp(norm, 0, 1) * (state.ladder.length - 1));
}

function waveNumberFor(index) {
  const position = index / Math.max(1, state.ladder.length - 1);
  return TWO_PI / (0.044 - 0.024 * position);
}

function panFor(x) {
  return clamp(x / view.halfW, -1, 1) * 0.7;
}

// ---------------------------------------------------------------- stones

function createStones() {
  let seed = 11;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const count = Math.min(STONE_COUNT, capacity.stones);
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * TWO_PI + 0.5 + random() * 0.7;
    const distance = 0.13 + random() * 0.22;
    stones.push({
      x: Math.cos(angle) * distance,
      y: Math.sin(angle) * distance,
      radius: 0.026,
      targetRadius: 0.026,
      freq: session.settings.root,
      ladderIndex: 0,
      rank: 0,
      angle: random() * Math.PI,
      spin: (random() - 0.5) * 0.02,
      aspect: 0.72 + random() * 0.2,
      seed: random() * 10,
      glow: 0,
      readyAt: 0,
      dragging: false,
      vx: 0,
      vy: 0,
    });
  }
  // Inner stones take the lower notes, matching the tap mapping.
  const order = stones.slice().sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y));
  order.forEach((stone, rank) => {
    stone.rank = rank;
  });
}

function assignStonePitches() {
  const ladder = state.ladder;
  const triad = [];
  ladder.forEach((note, index) => {
    if (note.triad && index > 0) triad.push(index);
  });
  const last = ladder.length - 1;
  stones.forEach((stone) => {
    const pick = Math.round(((stone.rank + 0.5) / stones.length) * (triad.length - 1));
    const index = triad[clamp(pick, 0, triad.length - 1)] ?? Math.round(last / 2);
    stone.ladderIndex = index;
    stone.freq = ladder[index].freq;
    stone.targetRadius = 0.034 - (0.014 * index) / last;
  });
}

function stoneAt(clientX, clientY) {
  let nearest = null;
  let nearestDistance = Infinity;
  for (const stone of stones) {
    if (stone.dragging) continue;
    const sx = view.width / 2 + stone.x * view.minDim;
    const sy = view.height / 2 - stone.y * view.minDim;
    const distance = Math.hypot(clientX - sx, clientY - sy);
    const reach = Math.max(stone.radius * view.minDim * 1.8, 24);
    if (distance < reach && distance < nearestDistance) {
      nearest = stone;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function ringStone(stone, energy, generation) {
  stone.glow = Math.min(1, stone.glow + 0.35 + energy);
  const velocity = clamp((0.1 + energy * 1.4) * (generation === 1 ? 1 : 0.65), 0.08, 0.5);
  const options = { velocity, pan: panFor(stone.x), decay: 0.8 };
  const decay = session.started ? session.strike(settings.sound, stone.freq, options, ROOM_ID) : 3;
  addRipple(stone.x, stone.y, clamp(energy * 1.2, 0.08, 0.35), decay, waveNumberFor(stone.ladderIndex), generation, stone);
}

function updateStones(dt) {
  for (let index = 0; index < stones.length; index += 1) {
    const stone = stones[index];
    stone.glow *= Math.exp(-dt / 1.6);
    stone.radius += (stone.targetRadius - stone.radius) * (1 - Math.exp(-dt / 0.8));
    stone.angle += dt * stone.spin;
    if (stone.dragging) {
      stone.vx = 0;
      stone.vy = 0;
      continue;
    }
    const heading = stone.seed * 1.7 + Math.sin(state.time * 0.011 + stone.seed) * 2.2 + state.time * 0.003;
    let ax = Math.cos(heading) * STONE_DRIFT;
    let ay = Math.sin(heading) * STONE_DRIFT;
    if (stone.x < view.stoneMinX) ax += (view.stoneMinX - stone.x) * 0.4;
    if (stone.x > view.stoneMaxX) ax -= (stone.x - view.stoneMaxX) * 0.4;
    if (stone.y < view.stoneMinY) ay += (view.stoneMinY - stone.y) * 0.4;
    if (stone.y > view.stoneMaxY) ay -= (stone.y - view.stoneMaxY) * 0.4;
    for (let other = 0; other < stones.length; other += 1) {
      if (other === index) continue;
      const dx = stone.x - stones[other].x;
      const dy = stone.y - stones[other].y;
      const distance = Math.hypot(dx, dy);
      const gap = (stone.radius + stones[other].radius) * 2.6 + 0.04;
      if (distance < gap && distance > 1e-6) {
        const push = (gap - distance) * 0.25;
        ax += (dx / distance) * push;
        ay += (dy / distance) * push;
      }
    }
    const blend = 1 - Math.exp(-dt / 4);
    stone.vx += (ax - stone.vx) * blend;
    stone.vy += (ay - stone.vy) * blend;
    stone.x += stone.vx * dt;
    stone.y += stone.vy * dt;
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
        if (stone === ripple.source || stone.dragging) continue;
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

// ---------------------------------------------------------------- sung bowls

function claimSing(gesture) {
  let choice = null;
  for (const sing of sings) {
    if (!sing.active) {
      choice = sing;
      break;
    }
    if (!sing.gesture && (!choice || sing.amp < choice.amp)) choice = sing;
  }
  if (!choice) return null;
  if (!choice.active) choice.amp = 0;
  choice.active = true;
  choice.x = gesture.x;
  choice.y = gesture.y;
  choice.spin = 0;
  choice.gesture = gesture;
  return choice;
}

function updateSings(dt) {
  for (const sing of sings) {
    if (!sing.active) continue;
    const gesture = sing.gesture;
    if (gesture) {
      sing.x = gesture.centreX;
      sing.y = gesture.centreY;
      sing.spin = Math.atan2(gesture.y - gesture.centreY, gesture.x - gesture.centreX);
      const target = 0.14 + 0.86 * gesture.pressure;
      sing.amp += (target - sing.amp) * (1 - Math.exp(-dt / 0.25));
    } else {
      sing.amp *= Math.exp(-dt / sing.releaseTau);
      if (sing.amp < 0.003) sing.active = false;
    }
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

function strikeAt(x, y, velocity) {
  if (!session.started) return;
  const index = ladderIndexAt(x, y);
  const note = state.ladder[index];
  const decay = session.strike(settings.sound, note.freq, { velocity, pan: panFor(x) }, ROOM_ID);
  addRipple(x, y, 0.3 + 0.7 * velocity, decay, waveNumberFor(index), 0, null);
}

// A strike from another room: a ripple at the radius of its pitch, toward the
// side of its pan. Generation MAX_GENERATION keeps it from ringing stones.
function showForeignStrike(strike) {
  if (!state.started || !isActive()) return;
  const position = clamp(Math.log2(strike.freq / session.settings.root) / OCTAVES, 0, 1);
  const side = Math.random() < 0.5 ? 1 : -1;
  const angle = side * (Math.acos(clamp(strike.pan, -1, 1)) + (Math.random() - 0.5) * FOREIGN_SPREAD);
  const x = Math.cos(angle) * position * view.halfW * 0.92;
  const y = Math.sin(angle) * position * view.halfH * 0.92;
  const index = Math.round(position * (state.ladder.length - 1));
  const amp = 0.2 + 0.6 * clamp(strike.velocity, 0, 1);
  addRipple(x, y, amp, strike.decay, waveNumberFor(index), MAX_GENERATION, null);
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

function tapVelocity(gesture, duration) {
  const timed = clamp(0.9 - ((duration - 0.04) / 0.26) * 0.5, 0.35, 0.9);
  if (!gesture.forceAware) return timed;
  return clamp(0.5 * timed + 0.5 * (0.25 + gesture.maxForce * 0.7), 0.2, 0.92);
}

function readForce(gesture, event) {
  if (event.pointerType === "mouse") return;
  if (event.pressure > 0 && event.pressure !== 0.5) {
    gesture.forceAware = true;
    gesture.maxForce = Math.max(gesture.maxForce, event.pressure);
  }
}

function onPointerDown(event) {
  if (!state.started || !session.started || !isActive()) return;
  event.preventDefault();
  if (findGesture(event.pointerId)) return;
  canvas.setPointerCapture(event.pointerId);
  const now = performance.now() / 1000;
  const point = toPool(event.clientX, event.clientY);
  const stone = stoneAt(event.clientX, event.clientY);
  const gesture = {
    id: event.pointerId,
    kind: stone ? "stone" : "water",
    downAt: now,
    downX: point.x,
    downY: point.y,
    x: point.x,
    y: point.y,
    clientStartX: event.clientX,
    clientStartY: event.clientY,
    anchorX: event.clientX,
    anchorY: event.clientY,
    anchorAt: now,
    travel: 0,
    heading: Number.NaN,
    speed: 0,
    turn: 0,
    lastMoveAt: now,
    centreX: point.x,
    centreY: point.y,
    pressure: 0,
    peak: 0,
    held: false,
    rub: null,
    lastRubAt: 0,
    freq: state.ladder[ladderIndexAt(point.x, point.y)].freq,
    sing: null,
    stone,
    offsetX: stone ? stone.x - point.x : 0,
    offsetY: stone ? stone.y - point.y : 0,
    forceAware: false,
    maxForce: 0,
  };
  if (stone) {
    stone.dragging = true;
  } else {
    readForce(gesture, event);
    gesture.sing = claimSing(gesture);
  }
  gestures.push(gesture);
}

function onPointerMove(event) {
  const gesture = findGesture(event.pointerId);
  if (!gesture) return;
  const now = performance.now() / 1000;
  const point = toPool(event.clientX, event.clientY);
  gesture.x = point.x;
  gesture.y = point.y;
  gesture.travel = Math.max(
    gesture.travel,
    Math.hypot(event.clientX - gesture.clientStartX, event.clientY - gesture.clientStartY),
  );

  if (gesture.kind === "stone" && gesture.stone) {
    gesture.stone.x = clamp(point.x + gesture.offsetX, view.stoneMinX, view.stoneMaxX);
    gesture.stone.y = clamp(point.y + gesture.offsetY, view.stoneMinY, view.stoneMaxY);
    return;
  }

  readForce(gesture, event);
  const dx = event.clientX - gesture.anchorX;
  const dy = event.clientY - gesture.anchorY;
  const length = Math.hypot(dx, dy);
  if (length < 3) return;
  const elapsed = Math.max(now - gesture.anchorAt, 0.008);
  const heading = Math.atan2(-dy, dx);
  gesture.speed += (length / view.minDim / elapsed - gesture.speed) * (1 - Math.exp(-elapsed / 0.12));
  if (!Number.isNaN(gesture.heading)) {
    const rate = clamp(wrapAngle(heading - gesture.heading) / elapsed, -20, 20);
    gesture.turn += (rate - gesture.turn) * (1 - Math.exp(-elapsed / 0.35));
  }
  gesture.heading = heading;
  gesture.anchorX = event.clientX;
  gesture.anchorY = event.clientY;
  gesture.anchorAt = now;
  gesture.lastMoveAt = now;
}

function finishGesture(gesture, cancelled) {
  const position = gestures.indexOf(gesture);
  if (position < 0) return;
  gestures.splice(position, 1);

  if (gesture.kind === "stone" && gesture.stone) {
    const stone = gesture.stone;
    stone.dragging = false;
    stone.readyAt = state.time + STONE_COOLDOWN;
    const tapped = performance.now() / 1000 - gesture.downAt < TAP_MAX_SECONDS && gesture.travel < TAP_TRAVEL_PX;
    if (tapped && !cancelled) {
      ringStone(stone, 0.3, 1);
    } else {
      addRipple(stone.x, stone.y, 0.22, 2.5, waveNumberFor(stone.ladderIndex), MAX_GENERATION, stone);
    }
    return;
  }

  const duration = performance.now() / 1000 - gesture.downAt;
  if (!cancelled) {
    if (!gesture.held) {
      strikeAt(gesture.downX, gesture.downY, tapVelocity(gesture, duration));
    } else if (gesture.peak < 0.12 && gesture.travel < TAP_TRAVEL_PX * 2) {
      strikeAt(gesture.downX, gesture.downY, 0.3);
    }
  }
  if (gesture.rub) gesture.rub.release();
  if (gesture.sing) {
    gesture.sing.gesture = null;
    gesture.sing.releaseTau = gesture.rub && gesture.peak > 0.12 ? 1.8 : 0.35;
  }
}

function onPointerEnd(event) {
  const gesture = findGesture(event.pointerId);
  if (gesture) finishGesture(gesture, event.type !== "pointerup");
}

function releaseAllGestures() {
  for (let index = gestures.length - 1; index >= 0; index -= 1) finishGesture(gestures[index], true);
}

function updateGestures(now, dt) {
  for (const gesture of gestures) {
    if (gesture.kind !== "water") continue;
    if (now - gesture.lastMoveAt > 0.08) {
      gesture.speed *= Math.exp(-dt / 0.18);
      gesture.turn *= Math.exp(-dt / 0.35);
    }
    if (!gesture.held && (now - gesture.downAt > TAP_MAX_SECONDS || gesture.travel > TAP_TRAVEL_PX)) {
      gesture.held = true;
    }
    if (gesture.held) {
      const follow = 1 - Math.exp(-dt / 0.45);
      gesture.centreX += (gesture.x - gesture.centreX) * follow;
      gesture.centreY += (gesture.y - gesture.centreY) * follow;
    } else {
      gesture.centreX = gesture.x;
      gesture.centreY = gesture.y;
    }

    // Steady circling sings fully; any slow movement sings a little.
    const motion = smoothstep(0.03, 0.22, gesture.speed);
    const circling = clamp(Math.abs(gesture.turn) / 4, 0, 1);
    const target = gesture.held ? motion * (0.3 + 0.7 * circling) : 0;
    const easing = target > gesture.pressure ? 0.7 : 0.45;
    gesture.pressure += (target - gesture.pressure) * (1 - Math.exp(-dt / easing));
    gesture.peak = Math.max(gesture.peak, gesture.pressure);

    if (gesture.held && !gesture.rub && target > 0.05) {
      gesture.rub = session.rub(settings.sound, gesture.freq, { pan: panFor(gesture.centreX) });
    }
    if (gesture.rub && now - gesture.lastRubAt > RUB_UPDATE_SECONDS) {
      gesture.rub.set(gesture.pressure, clamp(gesture.speed / 0.6, 0, 1));
      gesture.rub.setPan(panFor(gesture.centreX));
      gesture.lastRubAt = now;
    }
  }
}

// ---------------------------------------------------------------- frame

function packFrame() {
  frameData.time = state.time;
  frameData.halfW = view.halfW;
  frameData.halfH = view.halfH;
  frameData.depth = state.visualDepth;

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
  for (const stone of stones) {
    if (count >= capacity.stones) break;
    const offset = count * 4;
    frameData.stoneA[offset] = stone.x;
    frameData.stoneA[offset + 1] = stone.y;
    frameData.stoneA[offset + 2] = stone.radius;
    frameData.stoneA[offset + 3] = stone.glow;
    frameData.stoneB[offset] = Math.cos(stone.angle);
    frameData.stoneB[offset + 1] = Math.sin(stone.angle);
    frameData.stoneB[offset + 2] = stone.aspect;
    frameData.stoneB[offset + 3] = stone.seed;
    count += 1;
  }
  frameData.stoneCount = count;

  count = 0;
  for (const sing of sings) {
    if (!sing.active || count >= capacity.sings) continue;
    const offset = count * 4;
    frameData.sing[offset] = sing.x;
    frameData.sing[offset + 1] = sing.y;
    frameData.sing[offset + 2] = sing.amp;
    frameData.sing[offset + 3] = sing.spin;
    count += 1;
  }
  frameData.singCount = count;
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
  state.visualDepth += (settings.depth - state.visualDepth) * (1 - Math.exp(-dt / 1.2));

  updateGestures(nowMs / 1000, dt);
  updateSings(dt);
  updateStones(dt);
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

function updateActivity() {
  if (isActive()) {
    startLoop();
  } else {
    stopLoop();
    releaseAllGestures();
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

  const hudTop = hud.getBoundingClientRect().top;
  const reserved = hudTop > 0 && hudTop < height ? height - hudTop : 0;
  view.stoneMinX = -view.halfW + 0.07;
  view.stoneMaxX = view.halfW - 0.07;
  view.stoneMaxY = view.halfH - 0.08;
  view.stoneMinY = Math.min(-view.halfH + reserved / view.minDim + 0.06, view.stoneMaxY - 0.2);

  if (renderer) renderer.resize(width, height, Math.min(window.devicePixelRatio || 1, 2) * view.quality);
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

buildSegmented(soundGroup, SOUNDS, settings.sound, (id) => {
  settings.sound = id;
});

function rebuildLadder() {
  state.ladder = buildLadder(session.settings.root, session.settings.scale, OCTAVES);
  assignStonePitches();
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
    if (detail.key === "root" || detail.key === "scale") rebuildLadder();
    if (detail.key === "drone") settings.depth = depthForDrone(session.settings.drone);
    if (detail.key === "room") updateActivity();
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
    releaseAllGestures();
  } else {
    startLoop();
  }
});

// The session can outlive this page when it belongs to the shell, so let go of
// held rubs and stop listening when the page goes away.
let unsubscribe = session.on(onSessionEvent);
window.addEventListener("pagehide", () => {
  releaseAllGestures();
  unsubscribe();
});
window.addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  unsubscribe();
  unsubscribe = session.on(onSessionEvent);
  if (session.started) goLive();
  rebuildLadder();
  settings.depth = depthForDrone(session.settings.drone);
  updateActivity();
});

if (typeof ResizeObserver === "function") {
  new ResizeObserver(applySize).observe(canvas);
} else {
  window.addEventListener("resize", applySize);
}

hud.inert = true;
createStones();
assignStonePitches();
stones.forEach((stone) => {
  stone.radius = stone.targetRadius;
});
if (embedded) {
  startLayer.remove();
  backLink.remove();
  if (session.started) goLive();
}
applySize();
startLoop();
