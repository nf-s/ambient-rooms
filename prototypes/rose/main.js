import { buildLadder, tVoice, SCALES } from "../shared/engine.js";
import { getSession, isEmbedded } from "../shared/session.js";
import { PETALS, RINGS, createPanes, layoutWindow, locate } from "./geometry.js";
import { createRenderer } from "./render.js";
import { createRinger } from "./changes.js";
import { createAutoPlayer } from "./auto.js";

const ROOM = "rose";
const MIDDLE_RING = 1;
const CHANGE_BELLS = 8;
// The engine keeps at most this many struck voices and fades the oldest.
const ENGINE_VOICES = 22;
const T_DELAY = 0.12;
const T_DELAY_SPREAD = 0.13;
const ATTACK = 0.16;
const STOLEN_FADE = 0.35;
const TAP_MS = 320;
const TAP_SLOP = 14;
const SWELL_HELD = 0.75;
const SWELL_LATCHED = 0.3;
const SWELL_AUTO = 0.35;
// Matches the session's default smoothing for drone changes made elsewhere.
const DRONE_TAU = 0.5;
const BREATH_SECONDS = 11;
const MAX_RATIO = 2;
const TOP_MARGIN = 46;

const canvas = document.getElementById("window");
const dock = document.getElementById("dock");
const strip = document.getElementById("strip");
const startLayer = document.getElementById("start-layer");
const startButton = document.getElementById("start");
const notice = document.getElementById("notice");
const changesButton = document.getElementById("changes");
const homeLink = document.querySelector(".home");

const session = getSession();
const embedded = isEmbedded();

function createLight() {
  return { start: 0, decay: 0, peak: 0, from: 0, token: 0, stolenAt: 0 };
}

const state = {
  started: false,
  active: !embedded || session.settings.room === ROOM,
  bell: "church",
  tVoice: "above",
  changes: false,
  // Notes per octave in the current scale.
  span: 7,
  ladder: [],
  panes: createPanes().map((pane) => ({ ...pane, melody: createLight(), tvoice: createLight() })),
  oculus: { level: 0, target: 0, tau: DRONE_TAU, nextTau: DRONE_TAU, latched: false, holds: 0, auto: 0, shown: 0 },
  theme: session.settings.theme === "light" ? "light" : "dark",
};

let ringer = null;
let autoPlayer = null;
let layout = null;
window.prototype = {
  get engine() {
    return session.engine;
  },
  state,
};

const renderer = canvas instanceof HTMLCanvasElement ? createRenderer(canvas) : null;

function showNotice(text) {
  if (!notice) return;
  notice.textContent = text;
  notice.hidden = false;
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

// ---- Ladder ----------------------------------------------------------------

// Each ring starts on the root an octave above the ring below and holds eight
// consecutive ladder notes, so a five-note ring runs past its octave.
function rebuildLadder() {
  const scale = SCALES[session.settings.scale];
  if (!scale) return;
  const span = scale.ratios.length;
  const needed = (RINGS - 1) * span + PETALS;
  const octaves = Math.ceil((needed - 1) / span);
  state.span = span;
  state.ladder = buildLadder(session.settings.root, session.settings.scale, octaves).slice(0, needed);
  state.panes.forEach((pane) => {
    pane.ladderIndex = pane.ring * span + pane.petal;
  });
}

rebuildLadder();

// ---- Light envelopes -------------------------------------------------------

// Brightness follows the bell: a soft rise, then the strike's own decay,
// mapped to roughly the square root of its amplitude so the fade reads evenly.
function brightness(light, time) {
  if (light.decay <= 0) return 0;
  const age = time - light.start;
  if (age <= 0) return light.from;
  if (age >= light.decay) {
    light.decay = 0;
    return 0;
  }
  const progress = age / light.decay;
  const envelope = Math.exp(-3.8 * progress) * (1 - progress ** 6);
  const rise = age >= ATTACK ? 1 : (age / ATTACK) * (age / ATTACK) * (3 - (2 * age) / ATTACK);
  const top = Math.max(light.from, light.peak);
  let value = envelope * (light.from + (top - light.from) * rise);
  if (light.stolenAt > 0 && time > light.stolenAt) value *= Math.exp(-(time - light.stolenAt) / STOLEN_FADE);
  return value;
}

const pending = [];
const voices = [];
let token = 0;

function applyLight(item) {
  const light = state.panes[item.pane][item.kind];
  light.from = brightness(light, item.when);
  light.start = item.when;
  light.decay = item.decay;
  light.peak = item.peak;
  light.token = item.token;
  light.stolenAt = item.stolenAt;
}

function applyDueLights(time) {
  while (pending.length > 0 && pending[0].when <= time) {
    const item = pending.shift();
    if (item) applyLight(item);
  }
}

function queueLight(item) {
  let index = pending.length;
  while (index > 0 && pending[index - 1].when > item.when) index -= 1;
  pending.splice(index, 0, item);
}

// Mirrors the engine's voice limit so a pane whose bell was cut short by a
// newer strike also lets its light go.
function trackVoice(item, now) {
  for (let index = voices.length - 1; index >= 0; index -= 1) {
    if (voices[index].end + 0.1 < now) voices.splice(index, 1);
  }
  voices.push(item);
  while (voices.length > ENGINE_VOICES) {
    const oldest = voices.shift();
    if (!oldest) break;
    const light = state.panes[oldest.pane][oldest.kind];
    if (light.token === oldest.token) light.stolenAt = now;
    else oldest.stolenAt = now;
  }
}

// ---- Sound -----------------------------------------------------------------

// The pane sounding a ladder note, preferring the given ring, else the nearest
// ring that holds it. Returns -1 if no pane does.
function paneForLadderIndex(ladderIndex, preferredRing) {
  let best = -1;
  let bestDistance = Infinity;
  for (let ring = 0; ring < RINGS; ring += 1) {
    const petal = ladderIndex - ring * state.span;
    const distance = Math.abs(ring - preferredRing);
    if (petal >= 0 && petal < PETALS && distance < bestDistance) {
      best = ring * PETALS + petal;
      bestDistance = distance;
    }
  }
  return best;
}

function addLight(paneIndex, kind, when, decay, peak, now) {
  token += 1;
  const item = { pane: paneIndex, kind, when, decay, peak, token, stolenAt: 0, end: when + decay + 0.2 };
  applyDueLights(now);
  trackVoice(item, now);
  queueLight(item);
}

function strikePane(paneIndex, kind, velocity, when) {
  const engine = session.engine;
  if (!engine || !layout || paneIndex < 0) return;
  const pane = state.panes[paneIndex];
  const note = state.ladder[pane.ladderIndex];
  if (!note) return;
  const decay = session.strike(state.bell, note.freq, { velocity, pan: layout.shapes[paneIndex].pan, when }, ROOM);
  const peak = kind === "melody" ? 0.25 + 0.65 * velocity : 0.2 + 0.6 * Math.min(1, velocity * 1.6);
  addLight(paneIndex, kind, when, decay, peak, engine.context.currentTime);
}

// A strike from another room: light the pane nearest in pitch. It also takes
// one of the engine's voices, so it is tracked like our own.
function showForeignStrike(detail) {
  const engine = session.engine;
  if (!engine || !Number.isFinite(detail.freq) || detail.freq <= 0) return;
  const target = Math.log(detail.freq);
  let best = -1;
  let bestDistance = Infinity;
  state.panes.forEach((pane, index) => {
    const note = state.ladder[pane.ladderIndex];
    if (!note) return;
    const distance = Math.abs(Math.log(note.freq) - target);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  if (best < 0) return;
  const velocity = clamp(detail.velocity, 0, 1);
  const now = engine.context.currentTime;
  addLight(best, "melody", Math.max(now, detail.when), Math.max(0, detail.decay), 0.2 + 0.55 * velocity, now);
}

// A melody note and, unless switched off, its tintinnabuli answer.
function ringPane(paneIndex, velocity, when) {
  if (!session.engine) return;
  strikePane(paneIndex, "melody", velocity, when);
  if (state.tVoice === "off") return;
  const pane = state.panes[paneIndex];
  const answer = tVoice(state.ladder, pane.ladderIndex, state.tVoice === "above" ? 1 : -1);
  if (answer === pane.ladderIndex) return;
  const delay = T_DELAY + Math.random() * T_DELAY_SPREAD;
  strikePane(paneForLadderIndex(answer, pane.ring), "tvoice", velocity * 0.5, when + delay);
}

function audioTime() {
  const engine = session.engine;
  return engine ? engine.context.currentTime : 0;
}

// ---- Drone -----------------------------------------------------------------

// The oculus swells the shared drone; its glow follows the drone's level.
// A held or latched oculus and auto play each ask for a swell; the larger wins.
function applySwell(seconds) {
  const oculus = state.oculus;
  const own = oculus.holds > 0 ? SWELL_HELD : oculus.latched ? SWELL_LATCHED : 0;
  session.swell(Math.max(own, oculus.auto), seconds, ROOM);
  oculus.nextTau = seconds / 3;
}

function pressDrone() {
  if (!session.engine) return;
  state.oculus.holds += 1;
  applySwell(6);
}

function releaseDrone(tap) {
  const oculus = state.oculus;
  oculus.holds = Math.max(0, oculus.holds - 1);
  if (tap) oculus.latched = !oculus.latched;
  if (oculus.holds > 0) return;
  applySwell(oculus.latched ? 4 : 7);
}

// ---- Pointer input ---------------------------------------------------------

const pointers = new Map();
const hit = { pane: -1, core: false, oculus: false };
const hover = { x: 0, y: 0, time: 0, speed: 0 };

function tapVelocity(event) {
  const pressure = event.pressure;
  let velocity = 0.6;
  if (event.pointerType === "pen" && pressure > 0) {
    velocity = 0.25 + 0.7 * pressure;
  } else if (event.pointerType === "touch") {
    if (pressure > 0 && pressure !== 0.5 && pressure !== 1) velocity = 0.25 + 0.7 * pressure;
    else if (event.width > 1 && event.height > 1) {
      velocity = clamp(0.4 + (Math.sqrt(event.width * event.height) - 20) / 60, 0.4, 0.85);
    }
  } else {
    // A mouse has no pressure: a quicker approach strikes harder.
    velocity = 0.5 + Math.min(0.35, hover.speed * 0.2);
  }
  return clamp(velocity + (Math.random() - 0.5) * 0.06, 0.15, 0.95);
}

function dragVelocity(pointer) {
  if (!layout) return 0.4;
  const radiiPerSecond = (pointer.speed * 1000) / layout.radius;
  return clamp(0.2 + 0.15 * radiiPerSecond, 0.18, 0.85);
}

function visit(pointer, x, y) {
  if (!layout) return;
  locate(layout, x, y, hit);
  if (hit.oculus || hit.pane < 0) {
    pointer.pane = -1;
    return;
  }
  if (hit.pane === pointer.pane) return;
  // Near a boundary, stay with the pane already sounding until well inside the next.
  if (pointer.pane >= 0 && !hit.core) return;
  pointer.pane = hit.pane;
  ringPane(hit.pane, dragVelocity(pointer), audioTime());
}

function onPointerDown(event) {
  if (!state.started || !state.active || !layout) return;
  event.preventDefault();
  if (session.engine) session.engine.resume();
  // Throws for a pointer that is no longer active, such as a cancelled one.
  try {
    canvas.setPointerCapture(event.pointerId);
  } catch {
    return;
  }
  locate(layout, event.clientX, event.clientY, hit);
  const pointer = {
    mode: hit.oculus ? "drone" : "panes",
    pane: -1,
    x: event.clientX,
    y: event.clientY,
    time: event.timeStamp,
    downX: event.clientX,
    downY: event.clientY,
    downTime: event.timeStamp,
    speed: 0,
  };
  pointers.set(event.pointerId, pointer);
  if (hit.oculus) {
    pressDrone();
    return;
  }
  if (hit.pane >= 0) {
    pointer.pane = hit.pane;
    ringPane(hit.pane, tapVelocity(event), audioTime());
  }
}

function onPointerMove(event) {
  const pointer = pointers.get(event.pointerId);
  if (!pointer) {
    if (event.pointerType === "mouse") {
      const elapsed = Math.max(1, event.timeStamp - hover.time);
      const distance = Math.hypot(event.clientX - hover.x, event.clientY - hover.y);
      hover.speed = elapsed > 200 ? 0 : hover.speed * 0.6 + (distance / elapsed) * 0.4;
      hover.x = event.clientX;
      hover.y = event.clientY;
      hover.time = event.timeStamp;
    }
    return;
  }
  if (pointer.mode !== "panes" || !layout) return;
  const dx = event.clientX - pointer.x;
  const dy = event.clientY - pointer.y;
  const distance = Math.hypot(dx, dy);
  const elapsed = Math.max(1, event.timeStamp - pointer.time);
  pointer.speed = pointer.speed * 0.6 + (distance / elapsed) * 0.4;
  // Walk the segment so a quick stroke still passes through every pane.
  const steps = Math.max(1, Math.ceil(distance / (layout.radius * 0.035)));
  for (let step = 1; step <= steps; step += 1) {
    visit(pointer, pointer.x + (dx * step) / steps, pointer.y + (dy * step) / steps);
  }
  pointer.x = event.clientX;
  pointer.y = event.clientY;
  pointer.time = event.timeStamp;
}

function onPointerEnd(event) {
  const pointer = pointers.get(event.pointerId);
  if (!pointer) return;
  pointers.delete(event.pointerId);
  if (pointer.mode !== "drone") return;
  const tap =
    event.type === "pointerup" &&
    event.timeStamp - pointer.downTime < TAP_MS &&
    Math.hypot(event.clientX - pointer.downX, event.clientY - pointer.downY) < TAP_SLOP;
  releaseDrone(tap);
}

function releasePointers() {
  pointers.forEach((pointer, pointerId) => {
    if (canvas instanceof HTMLCanvasElement && canvas.hasPointerCapture(pointerId)) {
      canvas.releasePointerCapture(pointerId);
    }
    if (pointer.mode === "drone") releaseDrone(false);
  });
  pointers.clear();
}

// ---- Layout and frames -----------------------------------------------------

const melody = new Float32Array(state.panes.length);
const tvoice = new Float32Array(state.panes.length);
const view = { melody, tvoice, oculus: 0, droneOff: true, total: 0 };
let frameId = 0;
let dirty = true;
let wasLit = false;
let resizeTimer = 0;

function relayout() {
  if (!renderer || !(canvas instanceof HTMLCanvasElement)) return;
  const width = window.innerWidth;
  const height = window.innerHeight;
  const ratio = Math.min(MAX_RATIO, window.devicePixelRatio || 1);
  const stripTop = strip ? strip.getBoundingClientRect().top : height;
  const hintTop = dock ? dock.getBoundingClientRect().top : height;
  const bottom = Math.min(stripTop, hintTop, height) - 10;
  const available = Math.max(120, bottom - TOP_MARGIN);
  const radius = Math.max(60, Math.min((width - 24) / 2, available / 2) / 1.08);
  const cx = width / 2;
  const cy = TOP_MARGIN + available / 2;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  layout = layoutWindow(state.panes, cx, cy, radius);
  renderer.resize(layout, width, height, ratio, state.panes, state.theme);
  document.documentElement.style.setProperty("--window-x", `${cx}px`);
  document.documentElement.style.setProperty("--window-y", `${cy}px`);
  dirty = true;
}

function scheduleRelayout() {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(relayout, 120);
}

let oculusClock = 0;

// Mirrors the drone's gain smoothing; uses wall time so it stays in step
// across frames skipped while the tab is hidden or another room is shown.
function updateOculus(wallSeconds) {
  const oculus = state.oculus;
  const drone = session.settings.drone;
  const target = session.started && drone > 0 ? clamp(drone + session.voice.swell, 0, 1) : 0;
  if (target !== oculus.target) {
    oculus.target = target;
    oculus.tau = oculus.nextTau;
    oculus.nextTau = DRONE_TAU;
  }
  const seconds = oculusClock > 0 ? wallSeconds - oculusClock : 0;
  oculusClock = wallSeconds;
  oculus.level += (oculus.target - oculus.level) * (1 - Math.exp(-seconds / oculus.tau));
  if (oculus.level < 0.002 && oculus.target === 0) {
    oculus.shown = 0;
    return;
  }
  const breath = 0.82 + 0.18 * Math.sin((wallSeconds * Math.PI * 2) / BREATH_SECONDS);
  oculus.shown = oculus.level ** 0.8 * breath;
}

function frame(timestamp) {
  frameId = window.requestAnimationFrame(frame);
  if (!renderer) return;
  const time = audioTime();
  applyDueLights(time);
  updateOculus(timestamp / 1000);
  let total = state.oculus.shown;
  for (let index = 0; index < state.panes.length; index += 1) {
    const pane = state.panes[index];
    melody[index] = brightness(pane.melody, time);
    tvoice[index] = brightness(pane.tvoice, time);
    total += melody[index] + tvoice[index];
  }
  view.oculus = state.oculus.shown;
  view.droneOff = !session.started || session.settings.drone <= 0;
  view.total = total;
  const lit = total > 0.003;
  if (!lit && !wasLit && !dirty) return;
  const fading = renderer.draw(view, timestamp);
  wasLit = lit;
  dirty = fading;
}

function startFrames() {
  if (frameId !== 0 || !renderer || !state.active || document.hidden) return;
  dirty = true;
  frameId = window.requestAnimationFrame(frame);
}

function stopFrames() {
  window.cancelAnimationFrame(frameId);
  frameId = 0;
}

// ---- Controls --------------------------------------------------------------

function selectSegment(group, value) {
  group.querySelectorAll("button").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.value === value));
  });
}

const controlHandlers = {
  bell(value) {
    state.bell = value;
  },
  tvoice(value) {
    state.tVoice = value;
  },
};

document.querySelectorAll("[data-control]").forEach((group) => {
  if (!(group instanceof HTMLElement)) return;
  const name = group.dataset.control;
  const handler = name ? controlHandlers[name] : undefined;
  if (!handler) return;
  group.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("button") : null;
    const value = target ? target.dataset.value : undefined;
    if (!value) return;
    handler(value);
    selectSegment(group, value);
  });
});

function setChanges(on) {
  state.changes = on;
  if (changesButton) {
    changesButton.setAttribute("aria-pressed", String(on));
    changesButton.textContent = on ? "On" : "Off";
  }
  if (autoPlayer) autoPlayer.refresh();
  if (!ringer) return;
  if (on) ringer.start();
  else ringer.stop();
}

if (changesButton) changesButton.addEventListener("click", () => setChanges(!state.changes));

// ---- Auto play -------------------------------------------------------------

// The petal nearest the middle of a ring, preferring a triad note, so phrases
// of up to four notes fit either side of it.
function centreOf(ring) {
  const candidates = [4, 3];
  const triad = candidates.find((petal) => {
    const note = state.ladder[ring * state.span + petal];
    return note !== undefined && note.triad;
  });
  return triad ?? 3;
}

// A neighbouring ring, or any ring to begin with. Ringing changes keeps the
// middle ring, so auto play leaves it alone then.
function pickRing(current, sparse) {
  const allowed = [];
  for (let ring = 0; ring < RINGS; ring += 1) {
    if (sparse && ring === MIDDLE_RING) continue;
    if (current >= 0 && (ring === current || (!sparse && Math.abs(ring - current) > 1))) continue;
    allowed.push(ring);
  }
  if (allowed.length === 0) return current >= 0 ? current : 0;
  return allowed[Math.floor(Math.random() * allowed.length)];
}

function autoSwell(on, seconds) {
  state.oculus.auto = on ? SWELL_AUTO : 0;
  applySwell(seconds);
}

// Auto play runs only while this room is the one on screen.
function syncAuto() {
  if (!autoPlayer) return;
  if (state.started && state.active && session.settings.auto === true) autoPlayer.start();
  else autoPlayer.stop();
}

// ---- Theme -----------------------------------------------------------------

function applyTheme() {
  const theme = session.settings.theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "light" ? "#d9d4cb" : "#0a0807");
  if (theme === state.theme) return;
  state.theme = theme;
  if (renderer && layout) renderer.setTheme(theme, state.active && !document.hidden);
  dirty = true;
}

applyTheme();

// ---- Session ---------------------------------------------------------------

function setActive(active) {
  if (active === state.active) return;
  state.active = active;
  syncAuto();
  if (active) {
    startFrames();
    return;
  }
  releasePointers();
  stopFrames();
}

// Called once the shared engine is running, from this page or the shell.
function goLive() {
  const engine = session.engine;
  if (state.started || !engine) return;
  ringer = createRinger({
    bells: CHANGE_BELLS,
    now: () => engine.context.currentTime,
    ring(bell, when) {
      // Bell 1 (the treble) is the highest pane of the middle ring.
      const petal = CHANGE_BELLS - bell;
      const velocity = 0.3 + Math.random() * 0.07 + (bell === CHANGE_BELLS ? 0.04 : 0);
      ringPane(MIDDLE_RING * PETALS + petal, velocity, when);
    },
  });
  if (state.changes) ringer.start();
  autoPlayer = createAutoPlayer({
    now: () => engine.context.currentTime,
    options: () => ({ activity: clamp(Number(session.settings.activity) || 0, 0, 1), sparse: state.changes }),
    play(ring, petal, velocity, when) {
      ringPane(ring * PETALS + petal, velocity, when);
    },
    swell: autoSwell,
    pickRing,
    centreOf,
  });
  state.started = true;
  syncAuto();
  if (dock) dock.dataset.visible = "true";
  if (startLayer && !embedded) {
    startLayer.dataset.hidden = "true";
    window.setTimeout(() => startLayer.remove(), 900);
  }
}

async function start() {
  if (session.started) {
    goLive();
    return;
  }
  try {
    await session.start();
  } catch {
    showNotice("Web Audio is not available in this browser.");
    return;
  }
  goLive();
}

const unsubscribe = session.on((type, detail) => {
  if (type === "started") goLive();
  else if (type === "setting") {
    if (detail.key === "root" || detail.key === "scale") rebuildLadder();
    else if (detail.key === "room" && embedded) setActive(detail.value === ROOM);
    else if (detail.key === "auto") syncAuto();
    else if (detail.key === "activity" && autoPlayer) autoPlayer.refresh();
    else if (detail.key === "theme") applyTheme();
  } else if (type === "strike" && detail.source !== ROOM) showForeignStrike(detail);
});
window.addEventListener("pagehide", () => {
  unsubscribe();
  if (autoPlayer) autoPlayer.stop();
  if (ringer) ringer.stop();
});

if (embedded) {
  if (startLayer) startLayer.remove();
  if (homeLink) homeLink.remove();
}

if (!renderer) {
  showNotice("Canvas drawing is not available in this browser.");
} else {
  relayout();
  startFrames();
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerEnd);
  canvas.addEventListener("pointercancel", onPointerEnd);
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  window.addEventListener("resize", scheduleRelayout);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopFrames();
    else startFrames();
  });
}

if (startButton && !embedded) startButton.addEventListener("click", start);
if (session.started) goLive();
