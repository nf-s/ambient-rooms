// Auto play in the manner of Arvo Pärt's melody voice. Each phrase moves by
// step from or towards a central pane of one ring (ascending away, descending
// away, descending towards, ascending towards), phrase lengths grow by one
// note at a time and then start again after a longer rest. Scheduled on the
// audio clock so it keeps time when timers are throttled.

const LOOKAHEAD = 1.2;
const TICK_MS = 250;
const RESUME_DELAY = 1.5;
const CYCLE_REST = 1.5;
const RING_MOVE = 0.4;
const SWELL_CHANCE = 0.18;
const SWELL_RISE = 5;
const SWELL_FALL = 8;
const SWELL_HOLD = 2.5;

// [activity, seconds] points, interpolated in log time.
const GAPS = [
  [0.05, 24],
  [0.2, 4.5],
  [0.4, 2],
  [0.7, 1.2],
  [1, 0.85],
];
const RESTS = [
  [0.05, 23],
  [0.2, 12],
  [0.4, 7],
  [0.7, 4.5],
  [1, 3],
];

const MODES = ["up-away", "down-away", "down-towards", "up-towards"];

function interpolate(points, value) {
  if (value <= points[0][0]) return points[0][1];
  for (let index = 1; index < points.length; index += 1) {
    const [x1, y1] = points[index];
    const [x0, y0] = points[index - 1];
    if (value <= x1) {
      const t = (value - x0) / (x1 - x0);
      return Math.exp(Math.log(y0) + (Math.log(y1) - Math.log(y0)) * t);
    }
  }
  return points[points.length - 1][1];
}

// Seconds between notes, seconds of rest after a phrase and the longest
// phrase, for an activity of 0..1. `sparse` thins it out when the window is
// also ringing changes.
export function pace(activity, sparse) {
  const thin = sparse ? 1 : 0;
  return {
    gap: interpolate(GAPS, activity) * (1 + 0.3 * thin),
    rest: interpolate(RESTS, activity) * (1 + thin),
    longest: activity < 0.15 ? 2 : activity < 0.6 ? 3 : 4,
    // The longer rest after a full cycle, kept short when single bells are
    // already far apart.
    cycleRest: 1 + (CYCLE_REST - 1) * Math.min(1, activity / 0.3),
  };
}

// Petals of one phrase around `centre`.
export function phrase(centre, length, mode) {
  return Array.from({ length }, (_, step) => {
    if (mode === "up-away") return centre + step;
    if (mode === "down-away") return centre - step;
    if (mode === "down-towards") return centre + (length - 1 - step);
    return centre - (length - 1 - step);
  });
}

function jitter(amount) {
  return 1 + (Math.random() * 2 - 1) * amount;
}

// play(ring, petal, velocity, when) sounds a note; swell(on, seconds) raises
// or lets fall the drone; now() is audio time; options() returns
// { activity, sparse }; pickRing(current, sparse) and centreOf(ring) choose
// where the melody lives.
export function createAutoPlayer({ now, options, play, swell, pickRing, centreOf }) {
  let timer = 0;
  let ring = -1;
  let centre = 0;
  let length = 0;
  let modeIndex = 0;
  let notes = [];
  // Time of the last note, the wait after it in units of the current pace,
  // and its random spread, so a change of activity can shorten a long rest.
  let lastTime = 0;
  let nextTime = 0;
  let wait = { kind: "rest", factor: 1, spread: 1 };
  let swelling = false;
  let releaseAt = 0;

  function interval(current) {
    const base = wait.kind === "gap" ? current.gap : current.rest;
    return base * wait.factor * wait.spread;
  }

  function planPhrase(current) {
    if (ring < 0) {
      ring = pickRing(-1, current.sparse);
      centre = centreOf(ring);
    }
    length += 1;
    if (length > current.longest) length = 1;
    const mode = MODES[modeIndex % MODES.length];
    modeIndex += 1;
    const petals = phrase(centre, length, mode);
    const base = 0.32 + Math.random() * 0.1;
    notes = petals.map((petal, step) => ({
      petal,
      velocity: base + 0.08 * Math.sin((Math.PI * (step + 0.5)) / length) + (Math.random() - 0.5) * 0.04,
    }));
    if (!swelling && length >= 2 && Math.random() < SWELL_CHANCE) {
      swelling = true;
      releaseAt = 0;
      swell(true, SWELL_RISE);
    }
  }

  function endPhrase(current) {
    const cycleDone = length >= current.longest;
    wait = { kind: "rest", factor: cycleDone ? current.cycleRest : 1, spread: jitter(0.15) };
    if (swelling) releaseAt = lastTime + SWELL_HOLD;
    if (cycleDone && Math.random() < RING_MOVE) {
      ring = pickRing(ring, current.sparse);
      centre = centreOf(ring);
    }
  }

  function tick() {
    const time = now();
    if (swelling && releaseAt > 0 && time >= releaseAt) {
      swelling = false;
      releaseAt = 0;
      swell(false, SWELL_FALL);
    }
    if (nextTime < time - 0.05) nextTime = time + 0.05;
    while (nextTime < time + LOOKAHEAD) {
      const settings = options();
      const current = { ...pace(settings.activity, settings.sparse), sparse: settings.sparse };
      if (notes.length === 0) planPhrase(current);
      const note = notes.shift();
      if (!note) return;
      play(ring, note.petal, note.velocity, nextTime);
      lastTime = nextTime;
      if (notes.length > 0) wait = { kind: "gap", factor: 1, spread: jitter(0.15) };
      else endPhrase(current);
      nextTime = lastTime + interval(current);
    }
  }

  return {
    get running() {
      return timer !== 0;
    },
    start() {
      if (timer !== 0) return;
      // A phrase cut off by a pause starts again from its first note.
      notes = [];
      length = Math.max(0, length - 1);
      lastTime = now();
      nextTime = lastTime + RESUME_DELAY;
      wait = { kind: "rest", factor: 1, spread: 1 };
      tick();
      timer = window.setInterval(tick, TICK_MS);
    },
    stop() {
      if (timer === 0) return;
      window.clearInterval(timer);
      timer = 0;
      if (swelling) {
        swelling = false;
        releaseAt = 0;
        swell(false, SWELL_FALL);
      }
    },
    // Re-reads activity: a pending wait is measured again at the new pace.
    refresh() {
      if (timer === 0) return;
      const settings = options();
      const current = pace(settings.activity, settings.sparse);
      nextTime = Math.max(now() + 0.3, lastTime + interval(current));
    },
  };
}
