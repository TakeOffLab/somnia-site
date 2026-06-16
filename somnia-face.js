(() => {
  const STATUS_API = "https://raw.githubusercontent.com/TakeOffLab/somnia-site/status/status.json";
  const ASSET_BASE = "assets/face/base/";

  const speedByEnergy = {
    fresh: 1.4,
    normal: 1,
    drowsy: 0.55,
    exhausted: 0.3,
  };

  const moodMotion = {
    calm: [1, 1, 1, 1],
    content: [1.1, 1, 0.9, 1],
    curious: [0.7, 0.9, 1.3, 1],
    focused: [1.6, 1, 0.6, 1.1],
    alert: [0.85, 0.95, 1.1, 0.8],
    anxious: [0.5, 0.9, 1.1, 0.6],
    weary: [1.5, 1.6, 0.8, 1.4],
    happy: [0.8, 0.95, 1, 0.9],
  };

  const moodGlow = {
    calm: 0,
    content: 0.05,
    curious: 0.14,
    focused: 0.08,
    alert: 0.15,
    anxious: 0.05,
    weary: -0.18,
    happy: 0.22,
  };

  const stateRange = {
    idle: 1,
    listening: 1,
    thinking: 0.8,
    speaking: 0.4,
    working: 1.4,
    monitoring_opencode: 1.4,
    delegating: 1.4,
    answering_opencode: 1.4,
  };

  const blinkRanges = {
    idle: [2.5, 5.5],
    listening: [2.5, 5],
    thinking: [1.5, 3],
    speaking: [4, 7],
    working: [2, 4.5],
  };

  const faceOfPrimary = {
    idle: "idle",
    listening: "listening",
    speaking: "speaking",
    thinking: "thinking",
    using_tool: "thinking",
    delegating: "working",
    monitoring_opencode: "working",
    answering_opencode: "working",
    sleeping: "sleeping",
    waking_up: "waking_up",
    llm_offline: "unwell",
    viewer_disconnected: "unwell",
  };

  class SaccadePlanner {
    constructor() {
      this.holdScale = 1;
      this.durScale = 1;
      this.ampScale = 1;
      this.phase = "hold";
      this.pos = { x: 0, y: 0 };
      this.from = { x: 0, y: 0 };
      this.to = { x: 0, y: 0 };
      this.moveT0 = 0;
      this.moveDur = 0.1;
      this.holdUntil = null;
      this.pendingHop = false;
      this.landedAt = null;
      this.blinkRequested = false;
    }

    rand(min, max) {
      return min + Math.random() * (max - min);
    }

    pickTarget() {
      const rx = 42 * this.ampScale;
      const ry = 18 * this.ampScale;
      for (let i = 0; i < 8; i += 1) {
        const x = this.rand(-rx, rx);
        const y = this.rand(-ry, ry);
        if (Math.hypot(x - this.pos.x, y - this.pos.y) >= 14) return { x, y };
      }
      return { x: -this.pos.x * 0.8, y: -this.pos.y * 0.8 };
    }

    startMove(t, allowDouble = true) {
      this.from = { ...this.pos };
      this.to = this.pickTarget();
      this.moveT0 = t;
      this.moveDur = this.rand(0.09, 0.14) * this.durScale;
      this.phase = "move";
      this.pendingHop = allowDouble && Math.random() < 0.18;
    }

    easeOutBack(u) {
      const c1 = 1.70158;
      const c3 = c1 + 1;
      const v = Math.max(0, Math.min(1, u)) - 1;
      return 1 + c3 * v * v * v + c1 * v * v;
    }

    current(t) {
      if (this.holdUntil === null) this.holdUntil = t + this.rand(0.8, 3.5) * this.holdScale;

      if (this.phase === "hold") {
        if (t >= this.holdUntil) {
          this.startMove(t);
        } else {
          let pop = 0;
          if (this.landedAt !== null) {
            const dt = t - this.landedAt;
            if (dt < 0.08) pop = 1 - dt / 0.08;
          }
          return { x: this.pos.x, y: this.pos.y, pop };
        }
      }

      const u = this.moveDur > 0 ? (t - this.moveT0) / this.moveDur : 1;
      if (u >= 1) {
        this.pos = { ...this.to };
        this.landedAt = t;
        this.phase = "hold";
        if (this.pendingHop) {
          this.pendingHop = false;
          this.holdUntil = t + this.rand(0.06, 0.12);
        } else {
          if (Math.random() < 0.25) this.blinkRequested = true;
          this.holdUntil = t + (Math.random() < 0.12 ? this.rand(4, 6) : this.rand(0.8, 3.5)) * this.holdScale;
        }
        return { x: this.pos.x, y: this.pos.y, pop: 1 };
      }

      const e = this.easeOutBack(u);
      return {
        x: this.from.x + (this.to.x - this.from.x) * e,
        y: this.from.y + (this.to.y - this.from.y) * e,
        pop: 1,
      };
    }
  }

  class SomniaFace {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d", { alpha: true });
      this.state = { primary: "idle", energy: "normal", mood: "calm", effects: [] };
      this.saccade = new SaccadePlanner();
      this.images = {};
      this.eyeLayers = {};
      this.startedAt = performance.now();
      this.nextBlinkT = null;
      this.blinkUntilT = 0;
      this.blinkDuration = 0.15;
      this.moodBlinkScale = 1;
      this.lastMood = "calm";
      this.moodChangedT = 0;
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(canvas);
    }

    async load() {
      const entries = {
        base: "somnia_face_not_eye.png",
        leftEye: "somnia_eye_R.png",
        rightEye: "somnia_eye_L.png",
      };
      await Promise.all(Object.entries(entries).map(([key, file]) => new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => { this.images[key] = img; resolve(); };
        img.onerror = reject;
        img.src = ASSET_BASE + file;
      })));
      this.eyeLayers.leftEye = this.createEyeLayer(this.images.leftEye);
      this.eyeLayers.rightEye = this.createEyeLayer(this.images.rightEye);
      this.resize();
    }

    createEyeLayer(img) {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = frame.data;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i] / 255;
        const g = data[i + 1] / 255;
        const b = data[i + 2] / 255;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const delta = max - min;
        const s = max > 0 ? delta / max : 0;
        const v = max;
        let h = 0;
        if (delta > 0) {
          if (max === r) h = ((g - b) / delta) % 6;
          else if (max === g) h = (b - r) / delta + 2;
          else h = (r - g) / delta + 4;
          h /= 6;
          if (h < 0) h += 1;
        }
        const isCyan = h >= 0.46 && h <= 0.58 && s > 0.22 && v > 0.35;
        const isPurple = h >= 0.68 && h <= 0.84 && s > 0.22 && v > 0.35;
        if (isCyan || isPurple) {
          data[i + 3] = Math.max(0, Math.min(255, 255 * s * v * 1.9));
        } else {
          data[i + 3] = 0;
        }
      }
      ctx.putImageData(frame, 0, 0);
      return canvas;
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
      }
    }

    setState(next) {
      if (!next) return;
      const state = {
        primary: next.primary || "idle",
        energy: next.energy || "normal",
        mood: next.mood || "calm",
        effects: Array.isArray(next.effects) ? next.effects : [],
        beacon: Boolean(next.beacon),
      };
      this.state = state;
      const [hold, dur, amp, blink] = moodMotion[state.mood] || moodMotion.calm;
      this.saccade.holdScale = hold;
      this.saccade.durScale = dur;
      this.saccade.ampScale = amp;
      this.moodBlinkScale = blink;
    }

    start() {
      const tick = () => {
        this.draw((performance.now() - this.startedAt) / 1000);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      this.refresh();
      setInterval(() => this.refresh(), 5 * 60 * 1000);
    }

    async refresh() {
      try {
        const response = await fetch(STATUS_API, { cache: "no-store" });
        if (!response.ok) throw new Error("status unavailable");
        const data = await response.json();
        this.setState(data.face);
      } catch (_e) {
        this.setState({ primary: "viewer_disconnected", energy: "drowsy", mood: "weary" });
      }
    }

    faceState() {
      return faceOfPrimary[this.state.primary] || "idle";
    }

    blinkSquash(t, primary) {
      if (primary === "sleeping" || primary === "unwell") return 1;
      let key = primary;
      if (primary === "monitoring_opencode" || primary === "delegating" || primary === "answering_opencode") key = "working";
      const [baseLo, baseHi] = blinkRanges[key] || blinkRanges.idle;
      const lo = baseLo * this.moodBlinkScale;
      const hi = baseHi * this.moodBlinkScale;

      if (this.nextBlinkT === null) this.nextBlinkT = t + this.rand(lo, hi);
      if (t >= this.nextBlinkT && t >= this.blinkUntilT) {
        this.blinkUntilT = t + this.blinkDuration;
        this.nextBlinkT = Math.random() < 0.15 ? t + 0.32 : t + this.rand(lo, hi);
      }
      if (t >= this.blinkUntilT) return 1;

      const progress = (t - (this.blinkUntilT - this.blinkDuration)) / this.blinkDuration;
      const bell = Math.sin(Math.max(0, Math.min(1, progress)) * Math.PI);
      return 1 - bell * 0.9;
    }

    triggerBlink(t) {
      if (t < this.blinkUntilT) return;
      this.blinkUntilT = t + this.blinkDuration;
      if (this.nextBlinkT !== null) this.nextBlinkT = Math.max(this.nextBlinkT, t + 1.2);
    }

    rand(min, max) {
      return min + Math.random() * (max - min);
    }

    flashWave(dt) {
      if (dt < 0) return 0;
      const pulse = 0.18;
      const total = pulse * 2 * 3;
      if (dt >= total) return 0;
      return Math.floor(dt / pulse) % 2 === 0 ? 0.5 : -0.15;
    }

    draw(tRaw) {
      if (!this.images.base) return;
      const ctx = this.ctx;
      const w = this.canvas.width;
      const h = this.canvas.height;
      const primary = this.faceState();
      const speed = speedByEnergy[this.state.energy] || 1;
      const t = tRaw * speed;

      ctx.clearRect(0, 0, w, h);
      this.drawCoverImage(this.images.base, 0, 0, w, h);

      if (primary === "sleeping") {
        this.drawSleeping(t);
        return;
      }

      const motion = this.saccade.current(t);
      if (this.saccade.blinkRequested) {
        this.saccade.blinkRequested = false;
        this.triggerBlink(t);
      }

      const range = stateRange[primary] || 1;
      let dx = motion.x * range * (w / 1920);
      let dy = motion.y * range * (h / 1080);
      let glow = 0.74 + motion.pop * 0.28 + (moodGlow[this.state.mood] || 0);
      let squash = this.blinkSquash(t, primary);
      let scale = 1;

      if (primary === "listening") {
        glow += 0.12 + 0.06 * Math.sin(t * 5);
        scale = 1.01;
      } else if (primary === "thinking") {
        dy -= 4 * (h / 1080);
        squash = Math.min(squash, 0.78);
      } else if (primary === "speaking") {
        dx *= 0.35;
        dy *= 0.35;
        glow += 0.08 * Math.sin(t * 12);
      } else if (primary === "working") {
        glow += 0.12;
      } else if (primary === "waking_up") {
        const open = Math.min(1, t / 1.2);
        squash = Math.min(squash, 0.15 + 0.85 * open);
        glow *= open;
      } else if (primary === "unwell") {
        squash = Math.min(squash, 0.35);
        glow -= 0.26;
      }

      if (this.state.mood !== this.lastMood) {
        this.lastMood = this.state.mood;
        this.moodChangedT = t;
      }
      if (this.state.mood === "happy") glow += this.flashWave(t - this.moodChangedT);
      if (this.state.effects?.includes("beacon") || this.state.beacon) {
        glow += 0.18 + Math.max(0, Math.sin(t * Math.PI * 2)) * 0.14;
      }
      if (this.state.effects?.includes("sparkle")) {
        glow += 0.18 * Math.max(0, Math.sin(t * 18));
      }

      this.drawEye("leftEye", dx, dy, Math.max(0.06, squash), scale, glow);
      this.drawEye("rightEye", dx, dy, Math.max(0.06, squash), scale, glow);
    }

    drawCoverImage(img, x, y, w, h) {
      const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
      const sw = w / scale;
      const sh = h / scale;
      const sx = (img.naturalWidth - sw) / 2;
      const sy = (img.naturalHeight - sh) / 2;
      this.ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
    }

    eyePlacement(key) {
      const w = this.canvas.width;
      const h = this.canvas.height;
      const img = this.eyeLayers[key] || this.images[key];
      const isLeft = key === "leftEye";
      const targetW = w * 0.49;
      const sourceW = img.naturalWidth || img.width;
      const sourceH = img.naturalHeight || img.height;
      const targetH = targetW * (sourceH / sourceW);
      const cx = w * (isLeft ? 0.255 : 0.765);
      const cy = h * 0.59;
      return { x: cx - targetW / 2, y: cy - targetH / 2, w: targetW, h: targetH };
    }

    drawEye(key, dx, dy, squash, scale, glow) {
      const ctx = this.ctx;
      const img = this.eyeLayers[key] || this.images[key];
      const p = this.eyePlacement(key);
      const cx = p.x + p.w / 2 + dx;
      const cy = p.y + p.h / 2 + dy;
      const dw = p.w * scale;
      const dh = p.h * squash;
      const x = cx - dw / 2;
      const y = cy - dh / 2;

      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.filter = `blur(${Math.max(12, this.canvas.width * 0.018)}px) brightness(${Math.max(0.6, 1.1 + glow * 0.5)})`;
      ctx.globalAlpha = Math.max(0.16, Math.min(0.92, 0.42 + glow * 0.26));
      ctx.drawImage(img, x, y, dw, dh);
      ctx.restore();

      ctx.save();
      this.applyMoodClip(ctx, key, x, y, dw, dh);
      ctx.globalAlpha = 0.94;
      ctx.filter = `brightness(${Math.max(0.7, 1.02 + glow * 0.12)})`;
      ctx.drawImage(img, x, y, dw, dh);
      ctx.restore();
    }

    applyMoodClip(ctx, key, x, y, w, h) {
      const mood = this.state.mood;
      if (!["focused", "anxious", "happy", "weary"].includes(mood)) return;

      ctx.beginPath();
      if (mood === "happy") {
        ctx.rect(x, y, w, h * 0.72);
      } else if (mood === "focused") {
        ctx.rect(x, y + h * 0.2, w, h * 0.8);
      } else if (mood === "weary") {
        ctx.rect(x, y + h * 0.35, w, h * 0.65);
      } else if (mood === "anxious") {
        const outerHigh = key === "leftEye" ? "right" : "left";
        if (outerHigh === "left") {
          ctx.moveTo(x, y + h * 0.08);
          ctx.lineTo(x + w, y + h * 0.38);
          ctx.lineTo(x + w, y + h);
          ctx.lineTo(x, y + h);
        } else {
          ctx.moveTo(x, y + h * 0.38);
          ctx.lineTo(x + w, y + h * 0.08);
          ctx.lineTo(x + w, y + h);
          ctx.lineTo(x, y + h);
        }
      }
      ctx.closePath();
      ctx.clip();
    }

    drawSleeping(t) {
      const ctx = this.ctx;
      const w = this.canvas.width;
      const h = this.canvas.height;
      const y = h * (0.56 + Math.sin(t * 1.4) * 0.005);
      ctx.save();
      ctx.strokeStyle = "rgba(142, 229, 255, .78)";
      ctx.lineWidth = Math.max(4, w * 0.006);
      ctx.lineCap = "round";
      ctx.shadowColor = "rgba(92, 220, 255, .52)";
      ctx.shadowBlur = Math.max(12, w * 0.018);
      for (const x of [w * 0.31, w * 0.78]) {
        ctx.beginPath();
        ctx.moveTo(x - w * 0.07, y);
        ctx.quadraticCurveTo(x, y + h * 0.035, x + w * 0.07, y);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  async function boot() {
    const canvas = document.querySelector("[data-somnia-face]");
    if (!canvas) return;
    const face = new SomniaFace(canvas);
    await face.load();
    face.start();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
