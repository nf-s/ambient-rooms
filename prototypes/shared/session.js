// One sound session shared by every room: a single audio engine, one drone,
// one root and scale. The shell page owns it; rooms loaded in its frames reach
// it through the parent window. A room opened on its own gets a private one.

import { createEngine, scaleForHour } from "./engine.js";

export const ROOTS = [
  { id: "G", freq: 98 },
  { id: "A", freq: 110 },
  { id: "C", freq: 130.81 },
  { id: "D", freq: 146.83 },
];

export const SCALE_IDS = ["bhoopali", "yaman", "bhairav", "malkauns", "dorian", "aeolian", "in", "yo"];

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function createSession() {
  const listeners = new Set();
  const settings = {
    root: 110,
    scale: scaleForHour(new Date().getHours()),
    space: 0.6,
    drone: 0.25,
    timbre: "tanpura",
    room: "water",
    auto: false,
    activity: 0.4,
    theme: "dark",
  };
  const voice = { harmonic: 6, amount: 0.5, brightness: 0.5, second: 3 / 2, swell: 0, whistle: 0 };
  const swells = new Map();
  let engine = null;
  let drone = null;
  let overtone = null;

  function emit(type, detail) {
    // A listener from a room frame that has since unloaded can throw; drop it
    // so the remaining rooms still hear the event.
    listeners.forEach((listener) => {
      try {
        listener(type, detail);
      } catch {
        listeners.delete(listener);
      }
    });
  }

  // A drone level of 0 means off: held gestures do not bring it back.
  function applyLevel(seconds) {
    if (!drone) return;
    const level = settings.drone > 0 ? clamp(settings.drone + voice.swell, 0, 1) : 0;
    drone.setLevel(level, seconds);
  }

  // The overtone is a plain tone at root x harmonic. Higher ones are played
  // more quietly so they do not pierce.
  function applyOvertone(seconds, glide) {
    if (!overtone) return;
    const freq = settings.root * voice.harmonic;
    overtone.setFrequency(freq, glide);
    overtone.setLevel(voice.whistle * Math.min(1, Math.sqrt(500 / freq)), seconds);
  }

  function makeDrone() {
    if (!engine) return;
    const previous = drone;
    drone = engine.drone({ root: settings.root, timbre: settings.timbre, second: voice.second });
    drone.setFocus(voice.harmonic, voice.amount);
    drone.setBrightness(voice.brightness);
    applyLevel(2.5);
    if (previous) previous.stop(2.5);
  }

  function applySetting(key) {
    if (!engine) return;
    if (key === "root" && drone) drone.setRoot(settings.root, 1.2);
    if (key === "root") applyOvertone(0.5, 1.2);
    if (key === "space") engine.setSpace(settings.space);
    if (key === "drone") applyLevel(1.5);
    if (key === "timbre") makeDrone();
  }

  return {
    settings,
    get engine() {
      return engine;
    },
    get started() {
      return engine !== null;
    },
    // Call from a user gesture. Safe to call more than once.
    async start() {
      if (engine) return;
      engine = createEngine();
      engine.setRoom("cathedral");
      engine.setSpace(settings.space);
      makeDrone();
      overtone = engine.tone(settings.root * voice.harmonic);
      try {
        await engine.resume();
      } finally {
        emit("started", null);
      }
    },
    // listener(type, detail). Types: "started", "setting" {key, value},
    // "strike" {source, profile, freq, velocity, pan, decay, when},
    // "focus" {harmonic, amount}. Returns an unsubscribe function.
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // Keys: root (Hz), scale (id in SCALES), space 0..1, drone 0..1 (resting
    // drone level; 0 is off), timbre ("tanpura" | "organ" | "pure"), room
    // (active room id), auto (boolean: rooms play themselves), activity 0..1
    // (how busy auto play is), theme ("dark" | "light").
    set(key, value) {
      if (!(key in settings) || settings[key] === value) return;
      settings[key] = value;
      applySetting(key);
      emit("setting", { key, value });
    },
    // Play a bell or bowl and tell every room about it, so the room on screen
    // can show strikes made by another room. `source` is the calling room's id.
    strike(profile, freq, options = {}, source = "") {
      if (!engine) return 0;
      const decay = engine.strike(profile, freq, options);
      emit("strike", {
        source,
        profile,
        freq,
        velocity: options.velocity ?? 0.7,
        pan: options.pan ?? 0,
        decay,
        when: options.when ?? engine.context.currentTime,
      });
      return decay;
    },
    rub(profile, freq, options = {}) {
      return engine ? engine.rub(profile, freq, options) : null;
    },
    // Extra drone level on top of the resting level, for held gestures. Each
    // room passes its own id as `source`; the loudest request wins, so one
    // room's swell does not cancel another's.
    swell(amount, seconds = 1.5, source = "shared") {
      swells.set(source, clamp(amount, 0, 1));
      voice.swell = Math.max(...swells.values());
      applyLevel(seconds);
    },
    // Bring one harmonic of the drone forward.
    setFocus(harmonic, amount = voice.amount) {
      voice.harmonic = harmonic;
      voice.amount = amount;
      if (drone) drone.setFocus(harmonic, amount);
      applyOvertone(0.3, 0.12);
      emit("focus", { harmonic, amount });
    },
    // Level 0..1 of a plain tone at the focused overtone (root x harmonic).
    // It sounds whether or not the drone is on.
    whistle(level, seconds = 0.5) {
      voice.whistle = clamp(level, 0, 1);
      applyOvertone(seconds, 0.12);
    },
    setBrightness(amount) {
      voice.brightness = clamp(amount, 0, 1);
      if (drone) drone.setBrightness(voice.brightness);
    },
    // Ratio of the drone's second string: 3/2 or 4/3.
    setSecond(ratio) {
      voice.second = ratio;
      if (drone) drone.setSecond(ratio);
    },
    get voice() {
      return voice;
    },
    level() {
      return engine ? engine.level() : 0;
    },
    spectrum() {
      return engine ? engine.spectrum() : null;
    },
  };
}

function parentSession() {
  if (window.parent === window) return null;
  try {
    return window.parent.ambientSession ?? null;
  } catch {
    return null;
  }
}

// True when this page is a room inside the shell.
export function isEmbedded() {
  return parentSession() !== null;
}

export function getSession() {
  const shared = parentSession();
  if (shared) return shared;
  if (!window.ambientSession) window.ambientSession = createSession();
  return window.ambientSession;
}
