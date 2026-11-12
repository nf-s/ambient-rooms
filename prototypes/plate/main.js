import { SCALES, buildLadder } from "../shared/engine.js";
import { getSession, isEmbedded } from "../shared/session.js";
import { GRID_SIZE, HARMONIC_COUNT } from "./modes.js";
import { MAX_PLOUGHS, createSand } from "./sand.js";
import { createGuide, createPlateView } from "./plate-view.js";
import { createAutoPlayer } from "./auto.js";
import { css, mixPalette } from "./theme.js";

const ROOM_ID = "plate";
const SECOND_RATIOS = { pa: 3 / 2, ma: 4 / 3 };

const BREATH_PERIOD = 11; // seconds per cycle, about 5.5 a minute
const BREATH_WIDTH = 0.3;
// Extra drone level on top of the shell's resting level.
const TOUCH_SWELL = 0.3;
const BREATH_SWELL = 0.45;
const BOW_ATTACK = 1.1;
const BOW_RELEASE = 3.4;
const TAP_TRAVEL = 10;
const TAP_TIME = 0.4;
const HARMONIC_GLIDE = 0.3;
const HELD_GLIDE = 0.05;
// While the ring moves, the overtone sticks to each whole number within this
// distance, then glides quickly to the next.
const DETENT = 0.2;
// Level of the plain overtone tone while the ring is played, and the quiet
// level it falls back to after release.
const WHISTLE_PLAY = 0.9;
const WHISTLE_SUSTAIN = 0.2;
const WHISTLE_ATTACK = 0.04;
const WHISTLE_SWELL = 0.8;
const WHISTLE_RELEASE = 1.1;
const WHISTLE_PULSE = 0.6;
const THEME_FADE = 0.8;
const AUTO_POINTER = -10;
const FOCUS_REST = 0.5;
const FOCUS_TOUCH = 0.25;
const FOCUS_RING = 0.6;
const OVERTONE_BELL_CEILING = 1400;
const LEVEL_GLIDE = 0.3;
const HIDDEN_LEVEL_GLIDE = 1.2;
const AUDIO_INTERVAL = 0.05;
const TIMER_INTERVAL_MS = 250;
const SETTLE_STEPS = 220;
const MAX_PRESSES = 6;
// Finger speed in plate radii per second: below RUB_MIN the finger counts as
// still, at RUB_FULL it presses as hard as it can.
const RUB_PROFILE = "glass";
const RUB_MIN = 0.08;
const RUB_FULL = 2.2;
const RUB_STOP_TIME = 0.18;
const RUB_STEP_GAP = 0.12;
const RUB_UPDATE = 0.06;
const RUB_SLOTS = 14;
const SPEED_SMOOTHING = 0.07;
const PLOUGH_FULL = 3;
const MAX_PENDING = 8;
const PENDING_STRIDE = 3;
const FOREIGN_MAX_DELAY = 2;

// What each overtone is, measured from the root.
const OVERTONE_NAMES = [
  "root",
  "octave",
  "octave + fifth",
  "two octaves",
  "two octaves + major third",
  "two octaves + fifth",
  "two octaves + flat seventh",
  "three octaves",
  "three octaves + major second",
  "three octaves + major third",
  "three octaves + sharp fourth",
  "three octaves + fifth",
  "three octaves + flat sixth",
  "three octaves + flat seventh",
  "three octaves + major seventh",
  "four octaves",
];

const session = getSession();
const embedded = isEmbedded();

function initialHarmonic() {
  const value = Math.round(session.voice.harmonic);
  return Number.isFinite(value) ? Math.min(HARMONIC_COUNT, Math.max(1, value)) : 6;
}

const state = {
  started: false,
  active: !embedded || session.settings.room === ROOM_ID,
  secondName: Math.abs(session.voice.second - SECOND_RATIOS.ma) < 0.01 ? "ma" : "pa",
  breathOn: false,
  harmonicTarget: initialHarmonic(),
  harmonic: initialHarmonic(),
  bow: 0,
  breath: 0,
  swell: 0,
  focus: FOCUS_REST,
  brightness: 0.4,
  brightnessTarget: 0.4,
  overtoneOn: true,
  whistle: 0,
  theme: session.settings.theme === "light" ? 0 : 1,
  auto: null,
};

window.prototype = {
  get engine() {
    return session.engine;
  },
  state,
};

const plateCanvas = document.getElementById("plate-layer");
const guideCanvas = document.getElementById("guide-layer");
const sandCanvas = document.getElementById("sand-layer");
const ringCanvas = document.getElementById("ring-layer");
const startButton = document.getElementById("start");
const crumb = document.getElementById("crumb");
const dock = document.getElementById("dock");
const notice = document.getElementById("notice");
const readoutName = document.getElementById("readout-name");
const readoutMeaning = document.getElementById("readout-meaning");
const readoutFrequency = document.getElementById("readout-frequency");
const breathButton = document.getElementById("breath");
const overtoneButton = document.getElementById("overtone");
const themeColour = document.querySelector('meta[name="theme-color"]');

let ladder = [];
let breathMix = 0;
let breathClock = 0;
let ringEmphasis = 0;
let ringFocus = 0;
let ringPointerId = null;
let ringPosition = 0;
let ringDownAt = 0;
let autoRingHeld = false;
let whistleHoldUntil = 0;
let themeShown = -1;
const themeFade = { from: state.theme, to: state.theme, start: -1 };
let lastTick = 0;
let lastFrame = 0;
let rafId = 0;
let timerId = 0;
let layoutPending = false;
let sandDirty = true;
let figureStale = false;
let layout = null;

const sent = {
  time: -1,
  harmonic: session.voice.harmonic,
  amount: session.voice.amount,
  brightness: -1,
  swell: -1,
  whistle: -1,
  bell: 0,
};
const ringShown = { position: -1, width: -1, emphasis: -1, harmonic: -1 };
const readoutShown = { harmonic: -1, frequency: -1 };
// Audio time at which each rub voice slot is free again; Infinity while held.
const rubSlots = new Float64Array(RUB_SLOTS);
// Strikes heard from other rooms, waiting for their sound: when, radius, strength.
const pending = new Float64Array(MAX_PENDING * PENDING_STRIDE);

const presses = Array.from({ length: MAX_PRESSES }, () => ({
  active: false,
  pointerId: -1,
  x: 0,
  y: 0,
  lastX: 0,
  lastY: 0,
  startX: 0,
  startY: 0,
  downAt: 0,
  moved: false,
  speed: 0,
  still: 0,
  rub: null,
  rubSlot: -1,
  rubIndex: -1,
  rubChangedAt: 0,
  rubSentAt: 0,
}));

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function approach(current, target, dt, seconds) {
  return current + (target - current) * (1 - Math.exp(-dt / seconds));
}

function showNotice(text) {
  if (notice === null) return;
  notice.textContent = text;
  notice.hidden = false;
}

function audioTime() {
  return session.engine === null ? 0 : session.engine.context.currentTime;
}

// ---------------------------------------------------------------- layout

function measureLayout() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const top = 44;
  const dockTop = dock === null ? height : dock.getBoundingClientRect().top;
  const bottom = Math.max(top + 160, dockTop - 6);
  const available = bottom - top;
  const ringRadius = Math.max(70, Math.min(width / 2 - 38, available / 2 - 34, 400));
  return {
    width,
    height,
    dpr,
    cx: width / 2,
    cy: top + available / 2,
    plateRadius: ringRadius / 1.13,
    ringRadius,
    strokeWidth: clamp(ringRadius * 0.032, 5, 12),
  };
}

function grainCount(next) {
  return Math.round(clamp(Math.PI * next.plateRadius ** 2 * 0.24, 12000, 24000));
}

// ---------------------------------------------------------------- setup

layout = measureLayout();
const view = plateCanvas !== null && ringCanvas !== null ? createPlateView(plateCanvas, ringCanvas) : null;
const sand = view === null || sandCanvas === null ? null : createSand(sandCanvas, grainCount(layout));
const guide = sand === null || guideCanvas === null ? null : createGuide(guideCanvas, sand.field, GRID_SIZE);

function applyLayout(next) {
  layoutPending = false;
  if (next.width <= 0 || next.height <= 0) return;
  layout = next;
  if (view === null || sand === null) return;
  view.resize(next);
  sand.resize(next);
  sandDirty = true;
  ringShown.position = -1;
  if (guide !== null) {
    guide.resize(next);
    guide.draw();
  }
  if (startButton !== null) {
    startButton.style.left = `${next.cx}px`;
    startButton.style.top = `${next.cy}px`;
  }
}

// ---------------------------------------------------------------- sound

function rebuildLadder() {
  const scale = session.settings.scale in SCALES ? session.settings.scale : "bhoopali";
  ladder = buildLadder(session.settings.root * 2, scale, 2);
}

// Scale step for a distance from the centre: centre low, rim high.
function ladderIndex(distance) {
  return Math.min(ladder.length - 1, Math.floor(clamp(distance, 0, 0.999) * ladder.length));
}

// The inverse: the radius at which a pitch sits on this plate.
function radiusForFreq(freq) {
  const low = ladder[0].freq;
  const high = ladder[ladder.length - 1].freq;
  const position = (Math.log(freq / low) / Math.log(high / low)) * (ladder.length - 1);
  return clamp((position + 0.5) / ladder.length, 0.05, 0.95);
}

function sendFocus(harmonic, amount) {
  sent.harmonic = harmonic;
  sent.amount = amount;
  session.setFocus(harmonic, amount);
}

function sendSwell(force) {
  const glide = document.hidden || !state.active ? HIDDEN_LEVEL_GLIDE : LEVEL_GLIDE;
  if (!force && Math.abs(state.swell - sent.swell) <= 0.003) return;
  sent.swell = state.swell;
  session.swell(state.swell, glide, "plate");
}

function sendAudio() {
  if (!state.started) return;
  const time = audioTime();
  if (time - sent.time < AUDIO_INTERVAL) return;
  sent.time = time;
  sendSwell(false);
  if (!state.active) return;
  if (Math.round(state.harmonic) !== sent.harmonic || Math.abs(state.focus - sent.amount) > 0.01) {
    sendFocus(Math.round(state.harmonic), state.focus);
  }
  if (Math.abs(state.brightness - sent.brightness) > 0.004) {
    sent.brightness = state.brightness;
    session.setBrightness(state.brightness);
  }
  if (Math.abs(state.whistle - sent.whistle) > 0.004 || Math.round(state.harmonic) !== sent.bell) {
    sendWhistle(state.whistle);
  }
}

// The ring sounds each overtone as one soft bell when it arrives on it. There
// is no sustained or gliding tone: `level` only says whether the ring is
// being played.
function sendWhistle(level) {
  sent.whistle = level;
  const overtone = Math.round(state.harmonic);
  if (!state.overtoneOn || level <= sustainLevel() + 0.05 || overtone === sent.bell) return;
  sent.bell = overtone;
  let freq = session.settings.root * overtone;
  while (freq > OVERTONE_BELL_CEILING) freq /= 2;
  session.strike("glass", freq, { velocity: 0.4 }, "plate");
}

function sustainLevel() {
  return state.overtoneOn ? WHISTLE_SUSTAIN : 0;
}

function strikeAt(x, y) {
  if (!state.started) return;
  const index = ladderIndex(Math.hypot(x, y));
  session.strike("rin", ladder[index].freq, { velocity: 0.32 + Math.random() * 0.1, pan: x * 0.5 }, ROOM_ID);
  if (sand !== null) sand.addImpulse(x, y, 1);
}

function takeRubSlot() {
  const time = audioTime();
  for (let slot = 0; slot < RUB_SLOTS; slot += 1) {
    if (rubSlots[slot] <= time) return slot;
  }
  return -1;
}

function releaseRub(press) {
  if (press.rub === null) return;
  press.rub.release();
  if (press.rubSlot >= 0) {
    const freq = ladder[Math.max(0, press.rubIndex)].freq;
    // The engine keeps a released voice for its decay (glass: 10 s at 220 Hz).
    rubSlots[press.rubSlot] = audioTime() + clamp(10 * Math.sqrt(220 / freq), 0.4, 40) + 0.3;
  }
  press.rub = null;
  press.rubSlot = -1;
  press.rubIndex = -1;
}

function rubPressure(speed) {
  return 0.35 + 0.65 * speed ** 0.6;
}

function startRub(press, index, speed, pan, now) {
  const slot = takeRubSlot();
  if (slot < 0) return;
  const freq = ladder[index].freq;
  const voice = session.rub(RUB_PROFILE, freq, { pan });
  if (voice === null) return;
  // Reach full pressure for a moment so the note speaks at once, then follow
  // the finger.
  voice.set(1, speed);
  rubSlots[slot] = Infinity;
  press.rub = voice;
  press.rubSlot = slot;
  press.rubIndex = index;
  press.rubChangedAt = now;
  press.rubSentAt = now;
  session.strike(RUB_PROFILE, freq, { velocity: 0.1 + 0.3 * speed, pan }, ROOM_ID);
}

// A finger moving through the sand sings at the pitch for its distance from
// the centre, louder and rougher the faster it moves.
function updateRub(press, now, dt) {
  const x = unitX(press.x);
  const y = unitY(press.y);
  const speed = clamp(press.speed / RUB_FULL, 0, 1);
  const moving = press.moved && press.speed > RUB_MIN;
  press.still = moving ? 0 : press.still + dt;
  if (press.rub !== null && press.still > RUB_STOP_TIME) releaseRub(press);
  if (!moving || !state.started) return;
  const pan = clamp(x * 0.6, -1, 1);
  const index = ladderIndex(Math.hypot(x, y));
  if (press.rub === null) {
    startRub(press, index, speed, pan, now);
    return;
  }
  if (index !== press.rubIndex && now - press.rubChangedAt > RUB_STEP_GAP) {
    releaseRub(press);
    startRub(press, index, speed, pan, now);
    return;
  }
  if (now - press.rubSentAt > RUB_UPDATE && now - press.rubChangedAt > RUB_UPDATE * 2) {
    press.rubSentAt = now;
    press.rub.set(rubPressure(speed), speed);
    press.rub.setPan(pan);
  }
}

// ---------------------------------------------------------------- envelopes

function unitX(x) {
  return (x - layout.cx) / layout.plateRadius;
}

function unitY(y) {
  return (y - layout.cy) / layout.plateRadius;
}

function setBrightnessFrom(y) {
  const relative = (y - (layout.cy - layout.plateRadius)) / (layout.plateRadius * 2);
  state.brightnessTarget = clamp(0.95 - relative * 0.85, 0.1, 0.95);
}

function ringHeld() {
  return ringPointerId !== null || autoRingHeld;
}

// The sticky ladder: a raw overtone position settles on each whole number as
// it passes, then moves quickly on to the next.
function detent(raw) {
  const whole = Math.round(raw);
  const offset = raw - whole;
  const travel = (Math.max(0, Math.abs(offset) - DETENT) / (0.5 - DETENT)) * 0.5;
  return clamp(whole + Math.sign(offset) * travel, 1, HARMONIC_COUNT);
}

function tick(now) {
  const dt = lastTick === 0 ? 0 : Math.min(1, now - lastTick);
  lastTick = now;

  let touching = false;
  for (let index = 0; index < MAX_PRESSES; index += 1) {
    if (presses[index].active) touching = true;
  }
  const held = ringHeld();

  state.harmonic = approach(state.harmonic, state.harmonicTarget, dt, held ? HELD_GLIDE : HARMONIC_GLIDE);
  state.bow = approach(state.bow, touching ? 1 : 0, dt, touching ? BOW_ATTACK : BOW_RELEASE);
  breathMix = approach(breathMix, state.breathOn ? 1 : 0, dt, 1.6);
  if (breathMix > 0.001) breathClock += dt;
  const breathWave = 0.5 - 0.5 * Math.cos((Math.PI * 2 * breathClock) / BREATH_PERIOD);
  state.breath = breathMix * breathWave;
  state.swell = 1 - (1 - TOUCH_SWELL * state.bow) * (1 - BREATH_SWELL * state.breath);
  state.brightness = approach(state.brightness, clamp(state.brightnessTarget + 0.12 * state.breath, 0, 1), dt, 0.5);
  ringEmphasis = approach(ringEmphasis, held ? 1 : 0, dt, 0.2);
  ringFocus = approach(ringFocus, held ? 1 : 0, dt, held ? 0.15 : 2);
  const resting = FOCUS_REST + FOCUS_TOUCH * state.bow;
  state.focus = resting + (FOCUS_RING - resting) * ringFocus;
  // The overtone sounds clearly while the ring is played, then falls to a
  // quiet sustain over a few seconds.
  const playing = held || now < whistleHoldUntil;
  const whistleTarget = playing ? WHISTLE_PLAY : sustainLevel();
  const whistleTime = whistleTarget < state.whistle ? WHISTLE_RELEASE : playing ? WHISTLE_ATTACK : WHISTLE_SWELL;
  if (state.active) state.whistle = approach(state.whistle, whistleTarget, dt, whistleTime);

  sendAudio();
}

// ---------------------------------------------------------------- frame loop

function updatePresses(now, dt) {
  if (sand === null) return;
  let count = 0;
  for (let index = 0; index < MAX_PRESSES; index += 1) {
    const press = presses[index];
    if (!press.active) continue;
    const fromX = unitX(press.lastX);
    const fromY = unitY(press.lastY);
    const toX = unitX(press.x);
    const toY = unitY(press.y);
    const distance = Math.hypot(toX - fromX, toY - fromY);
    press.speed = approach(press.speed, dt > 0 ? distance / dt : 0, dt, SPEED_SMOOTHING);
    press.lastX = press.x;
    press.lastY = press.y;
    if (count < MAX_PLOUGHS) {
      sand.setPlough(count, fromX, fromY, toX, toY, press.speed / PLOUGH_FULL);
      count += 1;
    }
    updateRub(press, now, dt);
  }
  sand.setPloughCount(count);
}

function firePending() {
  if (sand === null) return;
  const time = audioTime();
  for (let slot = 0; slot < MAX_PENDING; slot += 1) {
    const offset = slot * PENDING_STRIDE;
    if (pending[offset + 2] <= 0 || pending[offset] > time) continue;
    sand.addRing(pending[offset + 1], pending[offset + 2]);
    pending[offset + 2] = 0;
  }
}

function drawRing() {
  if (view === null) return;
  const position = (state.harmonic - 1) / (HARMONIC_COUNT - 1);
  const width = 1 + BREATH_WIDTH * (state.breath - 0.5 * breathMix);
  const harmonic = Math.round(state.harmonicTarget);
  if (
    Math.abs(position - ringShown.position) < 1e-4 &&
    Math.abs(width - ringShown.width) < 1e-4 &&
    Math.abs(ringEmphasis - ringShown.emphasis) < 1e-3 &&
    harmonic === ringShown.harmonic
  ) {
    return;
  }
  view.drawRing(position, width, ringEmphasis, harmonic);
  ringShown.position = position;
  ringShown.width = width;
  ringShown.emphasis = ringEmphasis;
  ringShown.harmonic = harmonic;
}

function updateReadout() {
  const harmonic = clamp(Math.round(state.harmonicTarget), 1, HARMONIC_COUNT);
  const frequency = Math.round(session.settings.root * harmonic);
  if (harmonic === readoutShown.harmonic && frequency === readoutShown.frequency) return;
  if (readoutName !== null) readoutName.textContent = `Overtone ${harmonic}`;
  if (readoutMeaning !== null) readoutMeaning.textContent = OVERTONE_NAMES[harmonic - 1];
  if (readoutFrequency !== null) readoutFrequency.textContent = `${frequency} Hz`;
  readoutShown.harmonic = harmonic;
  readoutShown.frequency = frequency;
}

// ---------------------------------------------------------------- theme

function themeTarget() {
  return session.settings.theme === "light" ? 0 : 1;
}

function applyThemeAttribute() {
  const name = themeTarget() === 1 ? "dark" : "light";
  document.documentElement.dataset.theme = name;
  if (themeColour !== null) themeColour.setAttribute("content", css(mixPalette(themeTarget()).pageEdge));
}

// Recolour the canvas layers for a theme blend (0 light, 1 dark).
function applyPalette(force) {
  const eased = state.theme * state.theme * (3 - 2 * state.theme);
  if (!force && Math.abs(eased - themeShown) < 1e-4) return;
  themeShown = eased;
  const palette = mixPalette(eased);
  if (view !== null) view.setPalette(palette);
  if (sand !== null) sand.setPalette(palette);
  if (guide !== null) {
    guide.setColour(palette.guide);
    guide.draw();
  }
  sandDirty = true;
  ringShown.position = -1;
}

// The fade runs on the clock, so slow frames do not let it fall behind the
// page's own colour transition.
function updateTheme(now) {
  if (state.theme === themeFade.to) return;
  if (themeFade.start < 0) themeFade.start = now;
  const progress = Math.min(1, (now - themeFade.start) / THEME_FADE);
  state.theme = progress >= 1 ? themeFade.to : themeFade.from + (themeFade.to - themeFade.from) * progress;
  applyPalette(false);
}

function onThemeSetting() {
  applyThemeAttribute();
  themeFade.from = state.theme;
  themeFade.to = themeTarget();
  themeFade.start = -1;
  if (state.active && !document.hidden && rafId !== 0) return;
  state.theme = themeFade.to;
  applyPalette(true);
}

function frame(timeMs) {
  rafId = window.requestAnimationFrame(frame);
  const now = timeMs / 1000;
  if (layoutPending) applyLayout(measureLayout());
  const frameDt = lastFrame === 0 ? 1 / 60 : Math.min(0.05, Math.max(0, now - lastFrame));
  lastFrame = now;
  updateTheme(now);
  if (autoPlaying()) autoPlayer.update(now, Number(session.settings.activity) || 0);
  updatePresses(now, frameDt);
  tick(now);

  const figure = Math.round(state.harmonicTarget);
  if (sand !== null) {
    if (figureStale && !state.started) {
      sand.setHarmonic(figure);
      sand.settle(SETTLE_STEPS);
      sandDirty = true;
    }
    figureStale = false;
    sand.setHarmonic(figure);
    firePending();
    const motion = state.started ? Math.min(1, 0.7 + 0.3 * Math.max(state.bow, state.breath)) : 0;
    const moved = sand.update(frameDt, motion);
    if (moved || sandDirty) {
      sand.draw();
      sandDirty = false;
    }
  }
  if (guide !== null) {
    guide.setHarmonic(figure);
    if (guide.update(frameDt)) guide.draw();
  }
  drawRing();
  updateReadout();
}

// Animation runs only while this room is on screen; otherwise a slow timer
// keeps the breath moving the drone, and the release of a held swell while
// the page is merely hidden.
function needsTimer() {
  return state.started && (state.breathOn || breathMix > 0.001 || (state.active && state.bow > 0.002));
}

function timerTick() {
  tick(performance.now() / 1000);
  if (needsTimer()) return;
  window.clearInterval(timerId);
  timerId = 0;
  if (sent.swell !== 0) {
    state.swell = 0;
    sendSwell(true);
  }
}

function updateLoop() {
  if (view === null || sand === null) return;
  const visible = state.active && !document.hidden;
  if (visible) {
    window.clearInterval(timerId);
    timerId = 0;
    if (rafId === 0) {
      lastFrame = 0;
      rafId = window.requestAnimationFrame(frame);
    }
    return;
  }
  window.cancelAnimationFrame(rafId);
  rafId = 0;
  if (timerId === 0 && needsTimer()) timerId = window.setInterval(timerTick, TIMER_INTERVAL_MS);
}

// ---------------------------------------------------------------- pointer input

function findPress(pointerId) {
  for (let index = 0; index < MAX_PRESSES; index += 1) {
    if (presses[index].active && presses[index].pointerId === pointerId) return presses[index];
  }
  return null;
}

function freePress() {
  for (let index = 0; index < MAX_PRESSES; index += 1) {
    if (!presses[index].active) return presses[index];
  }
  return null;
}

function moveRing(x, y, fresh) {
  if (view === null) return;
  ringPosition = view.ringPosition(x, y, fresh ? null : ringPosition);
  state.harmonicTarget = detent(1 + ringPosition * (HARMONIC_COUNT - 1));
}

// A short tap on the ring still sounds its overtone for a moment.
function releaseRing() {
  ringPointerId = null;
  state.harmonicTarget = Math.round(state.harmonicTarget);
  whistleHoldUntil = Math.max(whistleHoldUntil, ringDownAt + WHISTLE_PULSE);
}

function beginPress(press, pointerId, x, y) {
  press.active = true;
  press.pointerId = pointerId;
  press.x = x;
  press.y = y;
  press.lastX = x;
  press.lastY = y;
  press.startX = x;
  press.startY = y;
  press.downAt = performance.now() / 1000;
  press.moved = false;
  press.speed = 0;
  press.still = 0;
  setBrightnessFrom(y);
}

function endPress(press) {
  releaseRub(press);
  press.active = false;
  press.pointerId = -1;
}

// ---------------------------------------------------------------- auto play

function screenX(x) {
  return layout.cx + x * layout.plateRadius;
}

function screenY(y) {
  return layout.cy + y * layout.plateRadius;
}

const autoPlayer = createAutoPlayer({
  pressDown(slot, x, y) {
    const press = freePress();
    if (press === null) return false;
    beginPress(press, AUTO_POINTER - slot, screenX(x), screenY(y));
    press.moved = true;
    return true;
  },
  pressMove(slot, x, y) {
    const press = findPress(AUTO_POINTER - slot);
    if (press === null) return;
    press.x = screenX(x);
    press.y = screenY(y);
    setBrightnessFrom(press.y);
  },
  pressUp(slot) {
    const press = findPress(AUTO_POINTER - slot);
    if (press !== null) endPress(press);
  },
  tap(x, y) {
    strikeAt(x, y);
  },
  ringFree() {
    return ringPointerId === null;
  },
  ringStart() {
    autoRingHeld = true;
  },
  ringMove(harmonic) {
    if (!autoRingHeld) return;
    ringPosition = (harmonic - 1) / (HARMONIC_COUNT - 1);
    state.harmonicTarget = detent(harmonic);
  },
  ringEnd() {
    if (!autoRingHeld) return;
    autoRingHeld = false;
    state.harmonicTarget = Math.round(state.harmonicTarget);
  },
  harmonic() {
    return state.harmonicTarget;
  },
});
state.auto = autoPlayer.counts;

function autoPlaying() {
  return session.settings.auto === true && state.active && state.started && view !== null && sand !== null;
}

function updateAuto() {
  if (!autoPlaying()) autoPlayer.stop();
}

function releaseAllPointers() {
  autoPlayer.stop();
  for (let index = 0; index < MAX_PRESSES; index += 1) {
    if (presses[index].active) endPress(presses[index]);
  }
  if (ringPointerId !== null) releaseRing();
  if (sand !== null) sand.setPloughCount(0);
}

function onPointerDown(event) {
  if (!state.started || !state.active || view === null) return;
  const zone = view.hitTest(event.clientX, event.clientY);
  if (zone === null) return;
  event.preventDefault();
  ringCanvas.setPointerCapture(event.pointerId);
  if (zone === "ring") {
    if (ringPointerId !== null) return;
    if (autoRingHeld) {
      autoPlayer.yieldRing();
      autoRingHeld = false;
    }
    ringPointerId = event.pointerId;
    ringDownAt = performance.now() / 1000;
    moveRing(event.clientX, event.clientY, true);
    ringCanvas.style.cursor = "grabbing";
    return;
  }
  const press = freePress();
  if (press === null) return;
  beginPress(press, event.pointerId, event.clientX, event.clientY);
}

function onPointerMove(event) {
  if (view === null) return;
  if (event.pointerId === ringPointerId) {
    moveRing(event.clientX, event.clientY, false);
    return;
  }
  const press = findPress(event.pointerId);
  if (press !== null) {
    press.x = event.clientX;
    press.y = event.clientY;
    if (!press.moved && Math.hypot(press.x - press.startX, press.y - press.startY) > TAP_TRAVEL) press.moved = true;
    if (press.moved) setBrightnessFrom(press.y);
    return;
  }
  if (event.pointerType === "mouse" && ringPointerId === null) {
    const zone = state.started && state.active ? view.hitTest(event.clientX, event.clientY) : null;
    const cursor = zone === "ring" ? "grab" : zone === "plate" ? "crosshair" : "default";
    if (ringCanvas.style.cursor !== cursor) ringCanvas.style.cursor = cursor;
  }
}

function onPointerEnd(event, cancelled) {
  if (event.pointerId === ringPointerId) {
    releaseRing();
    ringCanvas.style.cursor = "grab";
    return;
  }
  const press = findPress(event.pointerId);
  if (press === null) return;
  const quick = performance.now() / 1000 - press.downAt < TAP_TIME;
  if (!cancelled && !press.moved && quick) {
    strikeAt(unitX(press.startX), unitY(press.startY));
  }
  endPress(press);
}

document.addEventListener("keydown", (event) => {
  if (!state.started || !state.active) return;
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLButtonElement) return;
  const step = event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : 0;
  if (step === 0) return;
  event.preventDefault();
  if (ringHeld()) return;
  state.harmonicTarget = clamp(Math.round(state.harmonicTarget) + step, 1, HARMONIC_COUNT);
  whistleHoldUntil = performance.now() / 1000 + WHISTLE_PULSE;
});

// ---------------------------------------------------------------- strip controls

function bindChoice(name, onChange) {
  const group = document.querySelector(`[data-control="${name}"]`);
  if (group === null) return () => {};
  const buttons = Array.from(group.querySelectorAll("button"));
  const render = (value) => {
    buttons.forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.value === value)));
  };
  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      const value = button.dataset.value;
      if (value === undefined) return;
      render(value);
      onChange(value);
    });
  });
  return render;
}

const renderSecond = bindChoice("second", (value) => {
  if (!(value in SECOND_RATIOS)) return;
  state.secondName = value;
  session.setSecond(SECOND_RATIOS[value]);
});
renderSecond(state.secondName);

if (breathButton !== null) {
  breathButton.addEventListener("click", () => {
    state.breathOn = !state.breathOn;
    // Begin a fresh cycle from the bottom of the breath unless one is still fading.
    if (state.breathOn && breathMix < 0.05) breathClock = 0;
    breathButton.setAttribute("aria-pressed", String(state.breathOn));
    updateLoop();
  });
}

if (overtoneButton !== null) {
  overtoneButton.addEventListener("click", () => {
    state.overtoneOn = !state.overtoneOn;
    overtoneButton.setAttribute("aria-pressed", String(state.overtoneOn));
  });
}

// ---------------------------------------------------------------- session

function goLive() {
  if (state.started) return;
  state.started = true;
  document.body.classList.add("started");
  if (startButton !== null) {
    startButton.classList.add("leaving");
    window.setTimeout(() => startButton.remove(), 800);
  }
  sent.swell = -1;
  updateLoop();
}

function updateActivity() {
  const active = !embedded || session.settings.room === ROOM_ID;
  if (active === state.active) return;
  state.active = active;
  if (active) {
    layoutPending = true;
    sent.swell = -1;
    sent.brightness = -1;
    sent.time = -1;
    state.secondName = Math.abs(session.voice.second - SECOND_RATIOS.ma) < 0.01 ? "ma" : "pa";
    renderSecond(state.secondName);
    sent.whistle = -1;
  } else {
    releaseAllPointers();
    pending.fill(0);
    // Leave the overtone at its quiet sustain for the next room.
    whistleHoldUntil = 0;
    if (state.started) {
      state.whistle = sustainLevel();
      sendWhistle(state.whistle, 2.5);
    }
    // Hand the swell back now unless the breath is still running, so the
    // next room is not overridden while a touch swell fades.
    state.bow = 0;
    if (state.started && !state.breathOn && breathMix <= 0.001 && sent.swell !== 0) {
      state.swell = 0;
      sendSwell(true);
    }
  }
  updateLoop();
}

function onFocus(detail) {
  if (Math.abs(detail.harmonic - sent.harmonic) < 1e-6 && Math.abs(detail.amount - sent.amount) < 1e-6) return;
  sent.harmonic = detail.harmonic;
  sent.amount = detail.amount;
  if (state.active && ringHeld()) return;
  const harmonic = clamp(Math.round(detail.harmonic), 1, HARMONIC_COUNT);
  if (harmonic !== Math.round(state.harmonicTarget)) figureStale = true;
  state.harmonicTarget = harmonic;
  state.harmonic = harmonic;
}

function onStrike(detail) {
  if (detail.source === ROOM_ID || !state.active || !state.started || ladder.length === 0) return;
  const freq = Number(detail.freq);
  if (!(freq > 0)) return;
  const velocity = clamp(Number(detail.velocity) || 0.5, 0, 1);
  const time = audioTime();
  const when = Math.min(Number(detail.when) || time, time + FOREIGN_MAX_DELAY);
  // A free slot, or else the one waiting longest.
  let slot = 0;
  for (let index = 0; index < MAX_PENDING; index += 1) {
    if (pending[index * PENDING_STRIDE + 2] <= 0) {
      slot = index;
      break;
    }
    if (pending[index * PENDING_STRIDE] < pending[slot * PENDING_STRIDE]) slot = index;
  }
  const offset = slot * PENDING_STRIDE;
  pending[offset] = when;
  pending[offset + 1] = radiusForFreq(freq);
  pending[offset + 2] = 0.35 + 0.65 * velocity;
}

function onSessionEvent(type, detail) {
  if (type === "started") {
    goLive();
  } else if (type === "setting") {
    if (detail.key === "root" || detail.key === "scale") rebuildLadder();
    if (detail.key === "room") updateActivity();
    if (detail.key === "theme") onThemeSetting();
    if (detail.key === "auto") updateAuto();
  } else if (type === "focus") {
    onFocus(detail);
  } else if (type === "strike") {
    onStrike(detail);
  }
}

async function start() {
  if (state.started || startButton === null) return;
  startButton.disabled = true;
  try {
    await session.start();
  } catch {
    showNotice("Audio could not start. Reload the page to try again.");
    return;
  }
  goLive();
}

// ---------------------------------------------------------------- lifecycle

rebuildLadder();

if (embedded) {
  if (startButton !== null) startButton.remove();
  if (crumb !== null) crumb.remove();
}

applyThemeAttribute();

if (view === null || sand === null || ringCanvas === null) {
  showNotice("Canvas drawing is not available in this browser.");
  if (startButton !== null) startButton.hidden = true;
} else {
  applyPalette(true);
  sand.setHarmonic(state.harmonicTarget);
  sand.settle(SETTLE_STEPS);
  applyLayout(layout);
  ringCanvas.addEventListener("pointerdown", onPointerDown);
  ringCanvas.addEventListener("pointermove", onPointerMove);
  ringCanvas.addEventListener("pointerup", (event) => onPointerEnd(event, false));
  ringCanvas.addEventListener("pointercancel", (event) => onPointerEnd(event, true));
  ringCanvas.addEventListener("contextmenu", (event) => event.preventDefault());
  if (startButton !== null && !embedded) startButton.addEventListener("click", start);
  window.addEventListener("resize", () => {
    layoutPending = true;
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      releaseAllPointers();
      whistleHoldUntil = 0;
      if (state.started && state.active) {
        state.whistle = sustainLevel();
        sendWhistle(state.whistle, 1.5);
      }
    }
    updateLoop();
  });
  updateLoop();
}

// The session can outlive this page when it belongs to the shell, so let go of
// held rubs and stop listening when the page goes away.
let unsubscribe = session.on(onSessionEvent);
window.addEventListener("pagehide", () => {
  releaseAllPointers();
  unsubscribe();
});
window.addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  unsubscribe();
  unsubscribe = session.on(onSessionEvent);
  rebuildLadder();
  updateActivity();
  onThemeSetting();
  if (session.started) goLive();
});
if (session.started) goLive();
