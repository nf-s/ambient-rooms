// Change ringing: plain hunt, scheduled ahead on the audio clock so it keeps
// time when timers are throttled.

const LOOKAHEAD = 1.4;
const TICK_MS = 200;
const BEAT = 1.3;
const BEAT_SPREAD = 0.3;

// Every row of a plain course, starting from rounds. Bell 1 is the treble.
export function plainHuntCourse(bells) {
  const rounds = Array.from({ length: bells }, (_, index) => index + 1);
  const rows = [rounds];
  let row = rounds;
  let cross = true;
  for (;;) {
    const next = row.slice();
    for (let place = cross ? 0 : 1; place + 1 < bells; place += 2) {
      next[place] = row[place + 1];
      next[place + 1] = row[place];
    }
    cross = !cross;
    if (next.every((bell, index) => bell === index + 1)) return rows;
    rows.push(next);
    row = next;
  }
}

// `ring(bell, when)` is called for each blow; `now()` returns audio time.
export function createRinger({ bells, now, ring }) {
  const rows = plainHuntCourse(bells);
  let timer = 0;
  let nextTime = 0;
  let rowIndex = 0;
  let place = 0;
  let rowsRung = 0;

  function beat() {
    return BEAT + (Math.random() - 0.5) * BEAT_SPREAD;
  }

  function tick() {
    const time = now();
    if (nextTime < time - 0.05) nextTime = time + 0.05;
    while (nextTime < time + LOOKAHEAD) {
      ring(rows[rowIndex][place], nextTime);
      place += 1;
      let gap = beat();
      if (place === bells) {
        place = 0;
        rowIndex = (rowIndex + 1) % rows.length;
        rowsRung += 1;
        // The open handstroke lead: a pause before every handstroke row.
        if (rowsRung % 2 === 0) gap += beat();
      }
      nextTime += gap;
    }
  }

  return {
    start() {
      if (timer !== 0) return;
      rowIndex = 0;
      place = 0;
      rowsRung = 0;
      nextTime = now() + 0.4;
      tick();
      timer = window.setInterval(tick, TICK_MS);
    },
    stop() {
      window.clearInterval(timer);
      timer = 0;
    },
  };
}
