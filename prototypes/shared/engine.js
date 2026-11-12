// Shared Web Audio engine for the ambient prototypes.
// Modal (additive) bells and bowls, a rubbed-bowl voice, a harmonic drone
// with an overtone focus, and a long generated reverb.

const TAU_60DB = 6.91;

// Partial tables: r = frequency ratio to the played note, a = relative level,
// d = seconds to fall 60 dB at 220 Hz, beat = Hz between the two halves of a
// split mode pair (0 = single mode).
export const PROFILES = {
  // Rim modes (n,0) of a thin ring, close to measured Himalayan bowls.
  bowl: {
    label: "Singing bowl",
    attack: 0.006,
    thud: 0.1,
    partials: [
      { r: 1, a: 1, d: 26, beat: 0.7 },
      { r: 2.8, a: 0.5, d: 14, beat: 1.5 },
      { r: 5.35, a: 0.25, d: 7.5, beat: 2.6 },
      { r: 8.6, a: 0.1, d: 4, beat: 3.8 },
      { r: 12.5, a: 0.04, d: 2, beat: 0 },
    ],
  },
  rin: {
    label: "Rin",
    attack: 0.003,
    thud: 0.06,
    partials: [
      { r: 1, a: 1, d: 30, beat: 0.35 },
      { r: 2.83, a: 0.36, d: 15, beat: 0.9 },
      { r: 5.42, a: 0.15, d: 7, beat: 1.6 },
      { r: 8.77, a: 0.05, d: 3, beat: 0 },
    ],
  },
  // Bonsho: a short bright impact, a middle resonance and a long low tail
  // with the slow throb measured on large East Asian bells (about 0.34 Hz).
  temple: {
    label: "Temple bell",
    attack: 0.012,
    thud: 0.3,
    partials: [
      { r: 1, a: 0.6, d: 38, beat: 0.34 },
      { r: 2.1, a: 1, d: 22, beat: 0.7 },
      { r: 2.85, a: 0.63, d: 14, beat: 1.2 },
      { r: 3.9, a: 0.4, d: 8, beat: 0 },
      { r: 5.3, a: 0.25, d: 4.5, beat: 0 },
      { r: 7, a: 0.16, d: 2.4, beat: 0 },
      { r: 9, a: 0.1, d: 1.4, beat: 0 },
    ],
  },
  // Hum, prime, tierce (the minor third), quint, nominal and upper partials
  // of a true-harmonic bell. The played note is the prime.
  church: {
    label: "Church bell",
    attack: 0.004,
    thud: 0.18,
    partials: [
      { r: 0.5, a: 0.4, d: 30, beat: 0.4 },
      { r: 1, a: 0.5, d: 18, beat: 0.6 },
      { r: 1.183, a: 0.63, d: 14, beat: 0 },
      { r: 1.506, a: 0.2, d: 7, beat: 0 },
      { r: 2, a: 1, d: 10, beat: 0 },
      { r: 2.514, a: 0.4, d: 5.5, beat: 0 },
      { r: 2.662, a: 0.2, d: 4.5, beat: 0 },
      { r: 3.011, a: 0.32, d: 3.5, beat: 0 },
      { r: 4.166, a: 0.2, d: 2.2, beat: 0 },
      { r: 5.433, a: 0.1, d: 1.4, beat: 0 },
    ],
  },
  tingsha: {
    label: "Tingsha",
    attack: 0.002,
    thud: 0,
    partials: [
      { r: 1, a: 1, d: 11, beat: 5.5 },
      { r: 2.4, a: 0.4, d: 5, beat: 8 },
      { r: 4.1, a: 0.2, d: 2.4, beat: 0 },
      { r: 5.9, a: 0.08, d: 1, beat: 0 },
    ],
  },
  glass: {
    label: "Glass",
    attack: 0.03,
    thud: 0,
    partials: [
      { r: 1, a: 1, d: 10, beat: 0.5 },
      { r: 2, a: 0.22, d: 6, beat: 0.9 },
      { r: 3, a: 0.08, d: 3, beat: 0 },
      { r: 4.2, a: 0.03, d: 2, beat: 0 },
    ],
  },
};

// Just-intonation scales as ratios above the root.
export const SCALES = {
  bhoopali: { label: "Bhoopali", ratios: [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3] },
  malkauns: { label: "Malkauns", ratios: [1, 6 / 5, 4 / 3, 8 / 5, 9 / 5] },
  yaman: {
    label: "Yaman",
    ratios: [1, 9 / 8, 5 / 4, 45 / 32, 3 / 2, 5 / 3, 15 / 8],
  },
  bhairav: {
    label: "Bhairav",
    ratios: [1, 16 / 15, 5 / 4, 4 / 3, 3 / 2, 8 / 5, 15 / 8],
  },
  dorian: {
    label: "Dorian",
    ratios: [1, 9 / 8, 6 / 5, 4 / 3, 3 / 2, 5 / 3, 9 / 5],
  },
  aeolian: {
    label: "Aeolian",
    ratios: [1, 9 / 8, 6 / 5, 4 / 3, 3 / 2, 8 / 5, 9 / 5],
  },
  in: { label: "In", ratios: [1, 16 / 15, 4 / 3, 3 / 2, 8 / 5] },
  yo: { label: "Yo", ratios: [1, 9 / 8, 4 / 3, 3 / 2, 27 / 16] },
  harmonic: {
    label: "Harmonic series",
    ratios: [1, 9 / 8, 5 / 4, 11 / 8, 3 / 2, 13 / 8, 7 / 4, 15 / 8],
  },
};

// A raga family for the local hour, following the prahar convention loosely.
export function scaleForHour(hour) {
  if (hour >= 5 && hour < 10) return "bhairav";
  if (hour >= 10 && hour < 17) return "bhoopali";
  if (hour >= 17 && hour < 22) return "yaman";
  return "malkauns";
}

// Every scale note across a range of octaves, low to high. `triad` marks the
// root, third and fifth-like degrees used by the tintinnabuli voice.
export function buildLadder(root, scaleId, octaves = 3) {
  const ratios = SCALES[scaleId].ratios;
  const triadDegrees = new Set(
    ratios.length >= 7 ? [0, 2, 4] : [0, Math.floor(ratios.length / 2), 3],
  );
  const ladder = [];
  for (let octave = 0; octave < octaves; octave += 1) {
    ratios.forEach((ratio, degree) => {
      ladder.push({
        freq: root * ratio * 2 ** octave,
        degree,
        octave,
        triad: triadDegrees.has(degree),
      });
    });
  }
  ladder.push({ freq: root * 2 ** octaves, degree: 0, octave: octaves, triad: true });
  return ladder;
}

// Arvo Pärt's tintinnabuli rule: for a melody note at `index`, the T-voice is
// the nearest triad note strictly above (position 1) or below (position -1).
export function tVoice(ladder, index, position = 1) {
  for (
    let cursor = index + position;
    cursor >= 0 && cursor < ladder.length;
    cursor += position
  ) {
    if (ladder[cursor].triad) return cursor;
  }
  return index;
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function makeNoise(context, seconds) {
  const buffer = context.createBuffer(1, Math.floor(context.sampleRate * seconds), context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < data.length; index += 1) data[index] = Math.random() * 2 - 1;
  return buffer;
}

// Decaying noise whose top end dies faster than its low end, like stone.
function makeImpulse(context, seconds, damping) {
  const rate = context.sampleRate;
  const length = Math.floor(rate * seconds);
  const buffer = context.createBuffer(2, length, rate);
  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel);
    let low = 0;
    for (let index = 0; index < length; index += 1) {
      const t = index / length;
      const coefficient = clamp(0.9 * (1 - t) ** damping + 0.02, 0.02, 1);
      low += coefficient * (Math.random() * 2 - 1 - low);
      const onset = Math.min(1, index / (rate * 0.04));
      data[index] = low * onset * Math.exp((-TAU_60DB * index) / length);
    }
  }
  return buffer;
}

const ROOMS = {
  hall: { seconds: 4.5, damping: 2.2 },
  cathedral: { seconds: 10, damping: 3 },
  cave: { seconds: 7, damping: 5 },
};

function harmonicWave(context, weight, count = 32) {
  const real = new Float32Array(count + 1);
  const imag = new Float32Array(count + 1);
  for (let n = 1; n <= count; n += 1) imag[n] = weight(n);
  return context.createPeriodicWave(real, imag);
}

const DRONE_WAVES = {
  tanpura: (n) => 1 / n ** 0.75,
  // Both keep a quiet tail of upper harmonics so the overtone focus has
  // something to bring forward.
  organ: (n) => ({ 1: 1, 2: 0.6, 3: 0.3, 4: 0.35, 6: 0.12, 8: 0.1 })[n] ?? 0.05 / Math.sqrt(n),
  pure: (n) => 1 / n ** 2.2,
};

export function createEngine() {
  const AudioContextClass = window.AudioContext ?? window.webkitAudioContext;
  const context = new AudioContextClass({ latencyHint: "interactive" });

  const input = context.createGain();
  const dry = context.createGain();
  const send = context.createGain();
  const convolver = context.createConvolver();
  const wet = context.createGain();
  const limiter = context.createDynamicsCompressor();
  const master = context.createGain();
  const analyser = context.createAnalyser();

  limiter.threshold.value = -14;
  limiter.knee.value = 12;
  limiter.ratio.value = 8;
  limiter.attack.value = 0.005;
  limiter.release.value = 0.4;
  master.gain.value = 0.8;
  send.gain.value = 0.5;
  wet.gain.value = 0.9;
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.85;

  input.connect(dry).connect(limiter);
  input.connect(send).connect(convolver).connect(wet).connect(limiter);
  limiter.connect(master).connect(analyser).connect(context.destination);

  const noise = makeNoise(context, 2);
  const voices = [];
  const MAX_VOICES = 22;
  let room = "";

  function setRoom(id) {
    if (id === room || !ROOMS[id]) return;
    room = id;
    convolver.buffer = makeImpulse(context, ROOMS[id].seconds, ROOMS[id].damping);
  }
  setRoom("hall");

  function output(pan) {
    const bus = context.createGain();
    const panner = context.createStereoPanner();
    panner.pan.value = clamp(pan, -1, 1);
    bus.connect(panner).connect(input);
    return { bus, panner };
  }

  function partialOscillators(partial, freq, target, when) {
    const centre = freq * partial.r;
    if (centre > 15000) return [];
    const offsets = partial.beat > 0 ? [-partial.beat / 2, partial.beat / 2] : [0];
    return offsets.map((offset) => {
      const oscillator = context.createOscillator();
      const level = context.createGain();
      oscillator.frequency.value = centre + offset;
      level.gain.value = 1 / offsets.length;
      oscillator.connect(level).connect(target);
      oscillator.start(when);
      return oscillator;
    });
  }

  function decayFor(partial, freq) {
    return clamp(partial.d * Math.sqrt(220 / freq), 0.4, 40);
  }

  // Strike a bell or bowl. Returns the time in seconds until it is inaudible.
  function strike(profileId, freq, options = {}) {
    const profile = PROFILES[profileId] ?? PROFILES.bowl;
    const velocity = clamp(options.velocity ?? 0.7, 0.05, 1);
    const when = Math.max(context.currentTime, options.when ?? 0) + 0.005;
    const decayScale = options.decay ?? 1;
    const { bus, panner } = output(options.pan ?? 0);
    const sources = [];
    let longest = 0;

    bus.gain.value = 0.22 * velocity ** 1.4;
    profile.partials.forEach((partial, index) => {
      const envelope = context.createGain();
      const decay = decayFor(partial, freq) * decayScale;
      // Harder strikes excite the upper modes more.
      const level = partial.a * velocity ** (index * 0.55);
      envelope.gain.setValueAtTime(0, when);
      envelope.gain.linearRampToValueAtTime(level, when + profile.attack);
      envelope.gain.setTargetAtTime(0, when + profile.attack, decay / TAU_60DB);
      envelope.connect(bus);
      sources.push(...partialOscillators(partial, freq, envelope, when));
      longest = Math.max(longest, decay);
    });

    if (profile.thud > 0) {
      const source = context.createBufferSource();
      const filter = context.createBiquadFilter();
      const envelope = context.createGain();
      source.buffer = noise;
      filter.type = "bandpass";
      filter.frequency.value = clamp(freq * 2.5, 200, 6000);
      filter.Q.value = 0.8;
      envelope.gain.setValueAtTime(profile.thud * velocity, when);
      envelope.gain.exponentialRampToValueAtTime(0.0001, when + 0.07);
      source.connect(filter).connect(envelope).connect(bus);
      source.start(when, Math.random());
      source.stop(when + 0.1);
    }

    const end = when + longest + 0.2;
    sources.forEach((source) => source.stop(end));
    const voice = { bus, end, sources };
    voices.push(voice);
    window.setTimeout(
      () => {
        panner.disconnect();
        const position = voices.indexOf(voice);
        if (position >= 0) voices.splice(position, 1);
      },
      (end - context.currentTime) * 1000 + 100,
    );
    while (voices.length > MAX_VOICES) {
      const oldest = voices.shift();
      if (oldest) {
        const time = context.currentTime;
        oldest.bus.gain.setTargetAtTime(0, time, 0.12);
        oldest.sources.forEach((source) => source.stop(time + 1));
      }
    }
    return longest;
  }

  // A bowl sung with the rim stick: sustained while pressure is applied.
  function rub(profileId, freq, options = {}) {
    const profile = PROFILES[profileId] ?? PROFILES.bowl;
    const partials = profile.partials.slice(0, 3);
    const now = context.currentTime;
    const { bus, panner } = output(options.pan ?? 0);
    const chatter = context.createGain();
    const chatterLfo = context.createOscillator();
    const chatterDepth = context.createGain();
    const envelopes = [];
    const sources = [];

    bus.gain.value = 0.2;
    chatter.gain.value = 1;
    chatterLfo.frequency.value = 5;
    chatterDepth.gain.value = 0;
    chatterLfo.connect(chatterDepth).connect(chatter.gain);
    chatterLfo.start(now);
    chatter.connect(bus);
    partials.forEach((partial) => {
      const envelope = context.createGain();
      envelope.gain.value = 0;
      envelope.connect(chatter);
      envelopes.push(envelope);
      sources.push(...partialOscillators(partial, freq, envelope, now));
    });

    let released = false;
    return {
      // pressure 0..1 sets loudness and how many upper modes speak;
      // speed 0..1 is how fast the stick circles the rim.
      set(pressure, speed = 0.5) {
        if (released) return;
        const p = clamp(pressure, 0, 1);
        const time = context.currentTime;
        envelopes.forEach((envelope, index) => {
          envelope.gain.setTargetAtTime(partials[index].a * p ** (1 + index * 1.2), time, 0.7);
        });
        chatterLfo.frequency.setTargetAtTime(2 + speed * 9, time, 0.3);
        chatterDepth.gain.setTargetAtTime(0.12 * speed, time, 0.3);
      },
      setPan(pan) {
        panner.pan.setTargetAtTime(clamp(pan, -1, 1), context.currentTime, 0.1);
      },
      release() {
        if (released) return;
        released = true;
        const time = context.currentTime;
        const decay = decayFor(partials[0], freq);
        envelopes.forEach((envelope, index) => {
          envelope.gain.cancelScheduledValues(time);
          envelope.gain.setTargetAtTime(0, time, decayFor(partials[index], freq) / TAU_60DB);
        });
        chatterDepth.gain.setTargetAtTime(0, time, 0.2);
        sources.forEach((source) => source.stop(time + decay + 0.2));
        chatterLfo.stop(time + decay + 0.2);
        window.setTimeout(() => panner.disconnect(), (decay + 0.4) * 1000);
      },
    };
  }

  // A continuous drone on the root and a second string (a fifth by default),
  // with a resonant focus that picks out one harmonic, as in overtone singing.
  // The tanpura timbre adds a slow cycle of plucks with a falling shimmer.
  function drone(options = {}) {
    const timbre = DRONE_WAVES[options.timbre] ? options.timbre : "tanpura";
    const wave = harmonicWave(context, DRONE_WAVES[timbre]);
    const now = context.currentTime;
    const { bus, panner } = output(0);
    const tilt = context.createBiquadFilter();
    const body = context.createGain();
    const focus = context.createBiquadFilter();
    const focusLevel = context.createGain();
    const sub = context.createOscillator();
    const subLevel = context.createGain();
    let root = options.root ?? 110;
    let second = options.second ?? 3 / 2;
    let harmonic = 6;
    let stopped = false;
    let pluckTimer = 0;
    let pluckIndex = 0;

    bus.gain.value = 0;
    tilt.type = "lowpass";
    tilt.frequency.value = 1400;
    tilt.Q.value = 0.3;
    body.gain.value = 0.5;
    focus.type = "bandpass";
    focus.Q.value = 14;
    focus.frequency.value = root * harmonic;
    focusLevel.gain.value = 1.2;
    sub.frequency.value = root / 2;
    subLevel.gain.value = 0.25;

    const strings = [
      { ratio: () => 1, detune: -3, level: 0.5 },
      { ratio: () => 1, detune: 3, level: 0.5 },
      { ratio: () => second, detune: 0, level: 0.34 },
      { ratio: () => 2, detune: 2, level: 0.22 },
    ].map((string) => {
      const oscillator = context.createOscillator();
      const level = context.createGain();
      oscillator.setPeriodicWave(wave);
      oscillator.frequency.value = root * string.ratio();
      oscillator.detune.value = string.detune;
      level.gain.value = string.level * 0.12;
      oscillator.connect(level);
      level.connect(tilt);
      level.connect(focus);
      oscillator.start(now);
      return { ...string, oscillator };
    });

    tilt.connect(body).connect(bus);
    focus.connect(focusLevel).connect(bus);
    sub.connect(subLevel).connect(bus);
    sub.start(now);

    function pluck() {
      if (stopped) return;
      const order = [second, 2, 2.004, 1];
      const ratio = order[pluckIndex % order.length];
      pluckIndex += 1;
      const time = context.currentTime + 0.02;
      const oscillator = context.createOscillator();
      const shimmer = context.createBiquadFilter();
      const envelope = context.createGain();
      const frequency = root * ratio;
      oscillator.setPeriodicWave(wave);
      oscillator.frequency.value = frequency;
      shimmer.type = "peaking";
      shimmer.Q.value = 5;
      shimmer.gain.value = 16;
      shimmer.frequency.setValueAtTime(Math.min(frequency * 14, 9000), time);
      shimmer.frequency.exponentialRampToValueAtTime(frequency * 3, time + 2.6);
      envelope.gain.setValueAtTime(0, time);
      envelope.gain.linearRampToValueAtTime(0.035, time + 0.03);
      envelope.gain.setTargetAtTime(0, time + 0.03, 1.1);
      oscillator.connect(shimmer).connect(envelope).connect(bus);
      oscillator.start(time);
      oscillator.stop(time + 7);
      pluckTimer = window.setTimeout(pluck, 1150 + Math.random() * 120);
    }
    if (timbre === "tanpura") pluck();

    return {
      setLevel(level, seconds = 1.5) {
        bus.gain.setTargetAtTime(clamp(level, 0, 1) * 0.9, context.currentTime, seconds / 3);
      },
      setRoot(freq, glide = 0.6) {
        root = freq;
        const time = context.currentTime;
        strings.forEach((string) =>
          string.oscillator.frequency.setTargetAtTime(root * string.ratio(), time, glide / 3),
        );
        sub.frequency.setTargetAtTime(root / 2, time, glide / 3);
        focus.frequency.setTargetAtTime(clamp(root * harmonic, 60, 12000), time, glide / 3);
      },
      // Ratio of the second string: 3/2 (Pa), 4/3 (Ma) or 1 for a unison.
      setSecond(ratio) {
        second = ratio;
        strings[2].oscillator.frequency.setTargetAtTime(root * ratio, context.currentTime, 0.3);
      },
      // Harmonic number to bring forward (fractional values glide between).
      setFocus(number, amount = 1) {
        harmonic = clamp(number, 1, 24);
        const time = context.currentTime;
        focus.frequency.setTargetAtTime(clamp(root * harmonic, 60, 12000), time, 0.08);
        focusLevel.gain.setTargetAtTime(clamp(amount, 0, 1) * 1.6, time, 0.15);
      },
      setBrightness(amount) {
        tilt.frequency.setTargetAtTime(300 + clamp(amount, 0, 1) ** 2 * 5000, context.currentTime, 0.2);
      },
      setPan(pan) {
        panner.pan.setTargetAtTime(clamp(pan, -1, 1), context.currentTime, 0.2);
      },
      get root() {
        return root;
      },
      stop(seconds = 3) {
        if (stopped) return;
        stopped = true;
        window.clearTimeout(pluckTimer);
        const time = context.currentTime;
        bus.gain.setTargetAtTime(0, time, seconds / 4);
        strings.forEach((string) => string.oscillator.stop(time + seconds + 0.5));
        sub.stop(time + seconds + 0.5);
        window.setTimeout(() => panner.disconnect(), (seconds + 1) * 1000);
      },
    };
  }

  // A plain sustained tone with a little vibrato, silent until given a level.
  function tone(freq) {
    const now = context.currentTime;
    const { bus, panner } = output(0);
    const oscillator = context.createOscillator();
    const vibrato = context.createOscillator();
    const vibratoDepth = context.createGain();
    bus.gain.value = 0;
    oscillator.frequency.value = freq;
    vibrato.frequency.value = 4.6;
    vibratoDepth.gain.value = freq * 0.0025;
    vibrato.connect(vibratoDepth).connect(oscillator.frequency);
    oscillator.connect(bus);
    oscillator.start(now);
    vibrato.start(now);
    return {
      setFrequency(value, glide = 0.15) {
        const target = clamp(value, 20, 12000);
        const time = context.currentTime;
        oscillator.frequency.setTargetAtTime(target, time, glide / 3);
        vibratoDepth.gain.setTargetAtTime(target * 0.0025, time, glide / 3);
      },
      setLevel(level, seconds = 0.5) {
        bus.gain.setTargetAtTime(clamp(level, 0, 1) * 0.14, context.currentTime, seconds / 3);
      },
      stop() {
        const time = context.currentTime;
        bus.gain.setTargetAtTime(0, time, 0.1);
        oscillator.stop(time + 1);
        vibrato.stop(time + 1);
        window.setTimeout(() => panner.disconnect(), 1200);
      },
    };
  }

  const spectrum = new Uint8Array(analyser.frequencyBinCount);
  const waveform = new Float32Array(analyser.fftSize);

  return {
    context,
    analyser,
    strike,
    rub,
    drone,
    tone,
    setRoom,
    // Call from a user gesture before making sound.
    resume() {
      return context.state === "running" ? Promise.resolve() : context.resume();
    },
    // Reverb amount 0..1.
    setSpace(amount) {
      const value = clamp(amount, 0, 1);
      send.gain.setTargetAtTime(value * 0.9, context.currentTime, 0.1);
      dry.gain.setTargetAtTime(1 - value * 0.45, context.currentTime, 0.1);
    },
    setLevel(level) {
      master.gain.setTargetAtTime(clamp(level, 0, 1), context.currentTime, 0.05);
    },
    // Overall output level 0..1, for visuals.
    level() {
      analyser.getFloatTimeDomainData(waveform);
      let sum = 0;
      for (let index = 0; index < waveform.length; index += 1) sum += waveform[index] ** 2;
      return Math.min(1, Math.sqrt(sum / waveform.length) * 4);
    },
    spectrum() {
      analyser.getByteFrequencyData(spectrum);
      return spectrum;
    },
  };
}
