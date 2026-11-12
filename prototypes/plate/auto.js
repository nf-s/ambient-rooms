// Auto play: invisible hands that draw slow curved strokes through the sand,
// now and then move the ring to another overtone, and sometimes tap. They act
// through the same calls a finger does. Positions are in plate units (the
// plate is the unit disc).

const MAX_HANDS = 2;
const STROKE_REACH = 0.82;
const CONTROL_REACH = 0.88;
const TAP_REACH = 0.75;
// Seconds between events at activity 0.05, 0.4 and 1, interpolated in log.
const EVENT_GAPS = [
  [0, 32],
  [0.05, 25],
  [0.4, 5.2],
  [1, 1.5],
];
// Least seconds between overtone changes at the same activity points.
const RING_GAPS = [
  [0, 90],
  [0.05, 70],
  [0.4, 28],
  [1, 14],
];
const TAP_SHARE = 0.16;
const RING_HOLD = 0.6;
const RING_MAX_HARMONIC = 16;
// How willing auto play is to land on each overtone: consonant low ones most.
const OVERTONE_WEIGHTS = [0.55, 1, 1, 1, 0.8, 0.9, 0.3, 0.65, 0.35, 0.45, 0.12, 0.4, 0.08, 0.16, 0.1, 0.25];

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function interpolateLog(points, value) {
  const x = clamp(value, points[0][0], points[points.length - 1][0]);
  for (let index = 1; index < points.length; index += 1) {
    const [x1, y1] = points[index];
    const [x0, y0] = points[index - 1];
    if (x <= x1) {
      const t = (x - x0) / (x1 - x0);
      return Math.exp(Math.log(y0) + (Math.log(y1) - Math.log(y0)) * t);
    }
  }
  return points[points.length - 1][1];
}

function jitter(seconds) {
  return seconds * (0.8 + 0.4 * Math.random());
}

function pointInDisc(reach) {
  const radius = Math.sqrt(Math.random()) * reach;
  const angle = Math.random() * Math.PI * 2;
  return [Math.cos(angle) * radius, Math.sin(angle) * radius];
}

function intoDisc(point, reach) {
  const length = Math.hypot(point[0], point[1]);
  return length <= reach ? point : [(point[0] * reach) / length, (point[1] * reach) / length];
}

function bezier(curve, t) {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return [
    a * curve[0] + b * curve[2] + c * curve[4] + d * curve[6],
    a * curve[1] + b * curve[3] + c * curve[5] + d * curve[7],
  ];
}

// A cubic curve whose control points all lie inside the plate, so the whole
// stroke stays on it. It bends into a C or an S.
function makeCurve() {
  const start = pointInDisc(STROKE_REACH);
  let end = pointInDisc(STROKE_REACH);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const distance = Math.hypot(end[0] - start[0], end[1] - start[1]);
    if (distance > 0.5 && distance < 1.25) break;
    end = pointInDisc(STROKE_REACH);
  }
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const bendA = (Math.random() - 0.5) * 0.9;
  const bendB = Math.random() < 0.5 ? bendA : -bendA * (0.5 + Math.random() * 0.5);
  const first = intoDisc([start[0] + dx / 3 - dy * bendA, start[1] + dy / 3 + dx * bendA], CONTROL_REACH);
  const second = intoDisc([start[0] + (2 * dx) / 3 - dy * bendB, start[1] + (2 * dy) / 3 + dx * bendB], CONTROL_REACH);
  const curve = [start[0], start[1], first[0], first[1], second[0], second[1], end[0], end[1]];
  let length = 0;
  let previous = start;
  for (let step = 1; step <= 16; step += 1) {
    const point = bezier(curve, step / 16);
    length += Math.hypot(point[0] - previous[0], point[1] - previous[1]);
    previous = point;
  }
  return { curve, length };
}

// Next overtone: near the current one, preferring consonant low numbers.
function chooseOvertone(current) {
  let total = 0;
  const weights = OVERTONE_WEIGHTS.map((weight, index) => {
    const harmonic = index + 1;
    if (harmonic === current || harmonic > RING_MAX_HARMONIC) return 0;
    const value = weight * Math.exp(-Math.abs(harmonic - current) / 1.7);
    total += value;
    return value;
  });
  let pick = Math.random() * total;
  for (let index = 0; index < weights.length; index += 1) {
    pick -= weights[index];
    if (pick <= 0 && weights[index] > 0) return index + 1;
  }
  return current === 1 ? 2 : current - 1;
}

// actions: pressDown(slot, x, y) -> boolean, pressMove(slot, x, y),
// pressUp(slot), tap(x, y), ringFree() -> boolean, ringStart(),
// ringMove(harmonic), ringEnd(), harmonic() -> number. `slot` is 0..MAX_HANDS-1.
export function createAutoPlayer(actions) {
  const hands = Array.from({ length: MAX_HANDS }, () => ({ live: false, curve: null, start: 0, duration: 0 }));
  const ring = { live: false, from: 1, to: 1, start: 0, duration: 0 };
  const counts = { strokes: 0, rings: 0, taps: 0 };
  let nextEvent = 0;
  let lastRing = -Infinity;
  let running = false;

  function freeHand() {
    for (let slot = 0; slot < MAX_HANDS; slot += 1) {
      if (!hands[slot].live) return slot;
    }
    return -1;
  }

  function startStroke(now, activity) {
    const slot = freeHand();
    if (slot < 0) return false;
    const { curve, length } = makeCurve();
    if (!actions.pressDown(slot, curve[0], curve[1])) return false;
    const speed = (0.28 + 0.32 * activity) * (0.8 + 0.4 * Math.random());
    const hand = hands[slot];
    hand.live = true;
    hand.curve = curve;
    hand.start = now;
    hand.duration = clamp(length / speed, 1.6, 7);
    counts.strokes += 1;
    return true;
  }

  function startRing(now) {
    if (!actions.ringFree()) return false;
    const from = Math.round(actions.harmonic());
    const to = chooseOvertone(from);
    ring.live = true;
    ring.from = from;
    ring.to = to;
    ring.start = now;
    ring.duration = 0.8 + 0.5 * Math.abs(to - from);
    lastRing = now;
    actions.ringStart();
    counts.rings += 1;
    return true;
  }

  function tap() {
    const [x, y] = pointInDisc(TAP_REACH);
    actions.tap(x, y);
    counts.taps += 1;
  }

  function endHand(slot) {
    if (!hands[slot].live) return;
    hands[slot].live = false;
    actions.pressUp(slot);
  }

  function endRing() {
    if (!ring.live) return;
    ring.live = false;
    actions.ringEnd();
  }

  function fire(now, activity) {
    const ringDue = now - lastRing > jitter(interpolateLog(RING_GAPS, activity));
    if (ringDue && Math.random() < 0.6 && startRing(now)) return;
    if (Math.random() < TAP_SHARE) {
      tap();
      return;
    }
    startStroke(now, activity);
  }

  function updateHands(now) {
    for (let slot = 0; slot < MAX_HANDS; slot += 1) {
      const hand = hands[slot];
      if (!hand.live || hand.curve === null) continue;
      const t = clamp((now - hand.start) / hand.duration, 0, 1);
      // Slow in, slow out, like a hand drawing through sand.
      const [x, y] = bezier(hand.curve, 0.5 - 0.5 * Math.cos(Math.PI * t));
      actions.pressMove(slot, x, y);
      if (t >= 1) endHand(slot);
    }
  }

  function updateRing(now) {
    if (!ring.live) return;
    const t = clamp((now - ring.start) / ring.duration, 0, 1);
    const eased = 0.5 - 0.5 * Math.cos(Math.PI * t);
    actions.ringMove(ring.from + (ring.to - ring.from) * eased);
    if (now - ring.start >= ring.duration + RING_HOLD) endRing();
  }

  return {
    counts,
    get ringLive() {
      return ring.live;
    },
    // Call every frame while auto play is on and the room is on screen.
    update(now, activity) {
      const level = clamp(activity, 0, 1);
      if (!running) {
        running = true;
        nextEvent = now + Math.min(2, jitter(interpolateLog(EVENT_GAPS, level)));
      }
      updateHands(now);
      updateRing(now);
      if (now >= nextEvent) {
        fire(now, level);
        nextEvent = now + jitter(interpolateLog(EVENT_GAPS, level));
      }
    },
    // The ring was taken by a finger: stop steering it without letting go.
    yieldRing() {
      ring.live = false;
    },
    stop() {
      for (let slot = 0; slot < MAX_HANDS; slot += 1) endHand(slot);
      endRing();
      running = false;
    },
    // The room let go of every press itself.
    forget() {
      hands.forEach((hand) => {
        hand.live = false;
      });
      ring.live = false;
      running = false;
    },
  };
}
