import { SCALES } from "./shared/engine.js";
import { getSession, ROOTS, SCALE_IDS } from "./shared/session.js";

// Created before any room frame loads, so rooms find it on their parent.
const session = getSession();

const ROOM_PAGES = { water: "water/", plate: "plate/", rose: "rose/", notes: "notes.html" };

const frames = Array.from(document.querySelectorAll(".stage iframe"));
const roomButtons = Array.from(document.querySelectorAll(".rooms button"));
const startButton = document.getElementById("start");
const soundToggle = document.getElementById("sound-toggle");
const soundPanel = document.getElementById("sound");

function loadFrame(frame) {
  const page = ROOM_PAGES[frame.dataset.room];
  if (page && !frame.getAttribute("src")) frame.setAttribute("src", page);
}

function showRoom(room) {
  if (!ROOM_PAGES[room]) return;
  document.body.dataset.room = room;
  frames.forEach((frame) => {
    const active = frame.dataset.room === room;
    if (active) loadFrame(frame);
    frame.classList.toggle("active", active);
  });
  roomButtons.forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.room === room));
  });
  session.set("room", room);
  if (startButton) startButton.hidden = room === "notes" || session.started;
}

function fillSegmented(container, options, key) {
  if (!container) return;
  options.forEach((option) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = option.label;
    button.dataset.value = String(option.value);
    container.append(button);
  });
  bindSegmented(container, key, (value) => (key === "root" ? Number(value) : value));
}

function bindSegmented(container, key, parse) {
  if (!container) return;
  const buttons = Array.from(container.querySelectorAll("button"));
  const refresh = () => {
    buttons.forEach((button) => {
      button.setAttribute("aria-pressed", String(parse(button.dataset.value) === session.settings[key]));
    });
  };
  buttons.forEach((button) => {
    button.addEventListener("click", () => session.set(key, parse(button.dataset.value)));
  });
  session.on((type, detail) => {
    if (type === "setting" && detail.key === key) refresh();
  });
  refresh();
}

function bindRange(input, key) {
  if (!(input instanceof HTMLInputElement)) return;
  input.value = String(session.settings[key]);
  input.addEventListener("input", () => session.set(key, Number(input.value)));
}

fillSegmented(
  document.getElementById("root"),
  ROOTS.map((root) => ({ label: root.id, value: root.freq })),
  "root",
);
fillSegmented(
  document.getElementById("scale"),
  SCALE_IDS.map((id) => ({ label: SCALES[id].label, value: id })),
  "scale",
);
bindSegmented(document.getElementById("timbre"), "timbre", (value) => value);
bindRange(document.getElementById("drone"), "drone");
bindRange(document.getElementById("space"), "space");

roomButtons.forEach((button) => {
  button.addEventListener("click", () => showRoom(button.dataset.room ?? ""));
});

if (soundToggle && soundPanel) {
  soundToggle.addEventListener("click", () => {
    const open = soundPanel.hidden;
    soundPanel.hidden = !open;
    soundToggle.setAttribute("aria-expanded", String(open));
  });
}

if (startButton) {
  startButton.addEventListener("click", async () => {
    await session.start();
    startButton.classList.add("leaving");
    window.setTimeout(() => {
      startButton.hidden = true;
    }, 700);
  });
}

// Load the playable rooms up front so switching is instant and their sound
// carries on; the notes page loads when first opened.
frames.filter((frame) => frame.dataset.room !== "notes").forEach(loadFrame);
showRoom("water");
