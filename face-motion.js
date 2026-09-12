// Port of desktop src/viewer/expressive_motion.py. Keep pose values and envelopes aligned.
export const MOODS = {
  calm: [0, 0, 0, 1, 1, 0, 1],
  content: [0.05, 0, 0.25, 1.02, 0.98, 0.01, 1.06],
  curious: [0, 0, 0, 1.02, 1.08, -0.028, 1.14],
  focused: [0.25, 0.17, 0, 1.02, 0.94, 0, 1.04],
  alert: [0.06, 0.03, 0, 0.97, 1.1, 0, 1.16],
  anxious: [0.24, -0.29, 0, 0.97, 0.96, -0.018, 0.91],
  weary: [0.43, -0.04, 0, 1.02, 0.91, 0.012, 0.72],
  happy: [0, 0, 0.61, 1.05, 1.03, 0.022, 1.2],
};
const FIELDS = ["lid", "slant", "smile", "width", "height", "tilt", "light"];
const ENERGY = { fresh: 1.15, normal: 1, drowsy: 0.7, exhausted: 0.48 };
export const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
export const smooth = (x) => {
  const u = clamp(x);
  return u * u * (3 - 2 * u);
};
export function blinkOpen(t, d = 0.24) {
  if (t < 0 || t >= d) return 1;
  const u = t / d;
  return u < 0.32
    ? 1 - 0.96 * smooth(u / 0.32)
    : u < 0.43
      ? 0.04
      : 0.04 + 0.96 * smooth((u - 0.43) / 0.57);
}
export class Spring {
  constructor(value) {
    this.value = value;
    this.velocity = 0;
  }
  step(target, dt, response = 13) {
    if (dt <= 0) return this.value;
    const offset = this.value - target,
      momentum = this.velocity + response * offset,
      decay = Math.exp(-response * dt);
    this.value = target + (offset + momentum * dt) * decay;
    this.velocity = (this.velocity - response * momentum * dt) * decay;
    return this.value;
  }
}
export class ExpressiveMotion {
  constructor(random = Math.random) {
    this.random = random;
    this.last = null;
    this.time = 0;
    this.primary = "idle";
    this.initialized = false;
    this.mood = null;
    this.effects = new Set();
    this.fired = {};
    this.channels = {};
    FIELDS.forEach(
      (name, i) => (this.channels[name] = new Spring(MOODS.calm[i])),
    );
    Object.entries({
      x: 0,
      y: 0,
      open: 1,
      energy: 1,
      gaze_gain: 1,
      awake: 1,
      asymmetry: 0,
      speech: 0,
    }).forEach(([n, v]) => (this.channels[n] = new Spring(v)));
    this.gaze = [0, 0];
    this.nextGaze = 1.4;
    this.nextBlink = this.rand(2, 4);
    this.blinkSince = -100;
    this.blinkDuration = 0.24;
  }
  rand(a, b) {
    return a + this.random() * (b - a);
  }
  event(n, d) {
    const age = this.time - (this.fired[n] ?? -100);
    return age >= 0 && age < d ? Math.sin((Math.PI * age) / d) ** 2 : 0;
  }
  effectFrame() {
    const result = {};
    if (this.primary === "sleeping") return result;
    for (const [name, d] of [
      ["surprise", 1.25],
      ["sparkle", 1.9],
      ["happy", 1.9],
      ["ack", 1.25],
    ]) {
      const age = this.time - (this.fired[name] ?? -100);
      result[name] =
        age >= 0 && age < d
          ? [
              smooth(age / 0.12) * (1 - smooth((age - d * 0.36) / (d * 0.64))),
              age / d,
            ]
          : [0, 0];
    }
    result.celebration =
      result.happy[0] > result.sparkle[0] ? result.happy : result.sparkle;
    result.beacon = [
      this.effects.has("beacon") ? 1 : 0,
      ((this.time - (this.fired.beacon ?? this.time)) / 1.8) % 1,
    ];
    return result;
  }
  sample(state, now) {
    const dt = this.last === null ? 0 : clamp(now - this.last, 0, 0.05);
    this.last = now;
    const ch = this.channels,
      step = (n, v, r) => ch[n].step(v, dt, r),
      speed = step("energy", ENERGY[state.energy] ?? 1, 4);
    this.time += dt * speed;
    const t = this.time,
      primary = state.primary,
      mood = MOODS[state.mood] ? state.mood : "calm";
    if (!this.initialized) {
      this.primary = primary;
      if (primary === "sleeping") {
        ch.open.value = 0.045;
        ch.awake.value = 0;
      }
      this.initialized = true;
    }
    if (primary !== this.primary) {
      if (this.primary === "sleeping") this.fired.wake = t;
      this.primary = primary;
      this.nextGaze = Math.min(this.nextGaze, t + 0.35);
    }
    if (mood !== this.mood) {
      if (this.mood !== null && ["happy", "curious"].includes(mood))
        this.fired[mood] = t;
      this.mood = mood;
    }
    const effects = new Set(state.effects || []);
    for (const name of effects)
      if (!this.effects.has(name)) this.fired[name] = t;
    this.effects = effects;
    const sleeping = primary === "sleeping",
      unwell = primary === "unwell",
      awake = step("awake", sleeping ? 0 : 1, 7);
    if (t >= this.nextGaze && !sleeping) {
      let [rx, ry] = mood === "curious" ? [48, 20] : [35, 14];
      if (mood === "focused") [rx, ry] = [18, 8];
      this.gaze = [this.rand(-rx, rx), this.rand(-ry, ry)];
      let hold = this.rand(1.2, 3.2);
      if (mood === "anxious") hold *= 0.6;
      else if (["focused", "weary"].includes(mood)) hold *= 1.5;
      this.nextGaze = t + hold;
    }
    const surprise = this.event("surprise", 0.85),
      ackAge = t - (this.fired.ack ?? -100),
      ack = this.event("ack", 0.85),
      delight = Math.max(this.event("happy", 1.15), this.event("sparkle", 1.1)),
      curious = this.event("curious", 0.9),
      wakeAge = t - (this.fired.wake ?? -100),
      wakeOpen = wakeAge >= 0 && wakeAge < 1.5 ? smooth(wakeAge / 1.5) : 1;
    const target = Object.fromEntries(
      FIELDS.map((n, i) => [n, MOODS[mood][i]]),
    );
    let [gx, gy] = this.gaze,
      gain = 1;
    if (["listening", "speaking"].includes(primary)) {
      gain = 0.24;
      gy -= 5;
    } else if (primary === "thinking") {
      gx = gx * 0.65 + 24;
      gy = gy * 0.6 - 19;
      target.lid += 0.09;
      target.tilt -= 0.025;
    } else if (primary === "working") {
      gx += 13 * Math.sin(t * 0.8);
      target.lid += 0.05;
    } else if (unwell) {
      gain = 0.12;
      gy += 16;
      target.lid = Math.max(0.35, target.lid);
      target.slant = -0.16;
      target.light = 0.6;
    }
    if (sleeping) {
      gx = 0;
      gy = 10;
      Object.assign(target, {
        lid: 0,
        smile: 0.12,
        slant: 0,
        tilt: 0,
        light: 0.42,
      });
    }
    const drowsy = clamp(1 - speed) * awake;
    target.lid += drowsy * 0.22;
    target.light *= 1 - drowsy * 0.3;
    gain = step("gaze_gain", gain * (1 - surprise * 0.93), 20);
    const x = step("x", gx * gain, 22 * Math.max(0.65, speed));
    let y = step("y", gy * gain, 17 * Math.max(0.65, speed));
    target.height += surprise * 0.12 + curious * 0.05;
    target.width -= surprise * 0.045;
    target.lid *= 1 - surprise * 0.8;
    target.smile = Math.max(target.smile, delight * 0.5);
    target.lid *= 1 - delight * 0.72;
    target.slant *= 1 - delight * 0.72;
    const values = Object.fromEntries(
      Object.entries(target).map(([n, v]) => [n, step(n, v, 11)]),
    );
    if (!sleeping && !unwell && t >= this.nextBlink) {
      this.blinkSince = t;
      this.blinkDuration = this.rand(0.21, 0.27);
      let interval = this.rand(2.6, 5.2);
      if (primary === "thinking" || mood === "anxious") interval *= 0.65;
      if (primary === "speaking") interval *= 1.3;
      this.nextBlink = t + (this.random() < 0.12 ? 0.4 : interval);
    }
    if (sleeping) this.nextBlink = t + 2.2;
    const blink = blinkOpen(t - this.blinkSince, this.blinkDuration),
      baseOpen = step("open", sleeping ? 0.045 : wakeOpen, 9),
      openness = Math.max(0.035, baseOpen * blink),
      breath = Math.sin(t * (sleeping ? 1 : 1.35)),
      bodyY = breath * (1.8 + 1.4 * awake),
      speechGain = step("speech", primary === "speaking" ? 1 : 0, 9),
      speech =
        speechGain * (0.55 * Math.sin(t * 6.2) + 0.3 * Math.sin(t * 9.7));
    y += bodyY + ack * 10 - delight * 9 + speech * 3.2;
    values.height += speech * 0.018;
    values.tilt += Math.sin(t * 0.67) * 0.005 * awake;
    values.light += breath * 0.045 + surprise * 0.15;
    if (effects.has("beacon"))
      values.light += 0.24 * (0.5 + 0.5 * Math.sin(t * 3.5)) ** 3;
    const left = {
      ...values,
      x,
      y,
      openness,
      light: clamp(values.light, 0.25, 1.5),
      sparkle: Math.max(this.event("sparkle", 1.2), delight * 0.65) * awake,
    };
    const right = {
      ...left,
      y: y + values.tilt * 140,
      openness: Math.max(
        0.035,
        Math.min(openness, blinkOpen(ackAge - 0.1, 0.34)),
      ),
    };
    right.lid +=
      0.075 * step("asymmetry", mood === "curious" ? 1 : 0, 9) * awake;
    return [left, right];
  }
}
