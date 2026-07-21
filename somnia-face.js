(() => {
  const FACE_DEBUG = new URLSearchParams(window.location.search).has("face-debug");
  if (FACE_DEBUG) window.somniaFaceScriptLoaded = true;
  const RELAY_BASE = "https://somnia-face-relay.somnia-ai.workers.dev";
  const RELAY_STATE_API = `${RELAY_BASE}/v1/state`;
  const RELAY_STREAM = RELAY_BASE.replace("https://", "wss://") + "/v1/stream";
  const RELAY_STALE_MS = 35 * 1000;
  const STATUS_API = "https://raw.githubusercontent.com/TakeOffLab/somnia-site/status/status.json";
  const STATUS_MAX_AGE_MS = 30 * 60 * 1000;
  const STATUS_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
  const ASSET_BASE = "assets/face/base/";
  const GLITCH_BURST_SEC = 0.4;
  const CRT_DARK_HOLD_OFF = 0.2;
  const CRT_DARK_HOLD_ON = 0.1;

  const statusIsFresh = (data) => {
    const generatedAt = Date.parse(data?.generated_at);
    if (!Number.isFinite(generatedAt)) return false;
    const age = Date.now() - generatedAt;
    return age >= -STATUS_FUTURE_TOLERANCE_MS && age <= STATUS_MAX_AGE_MS;
  };

  const setLiveBadge = (isLive, label = isLive ? "LIVE" : "更新待ち") => {
    const badge = document.querySelector(".face-live-badge");
    if (!badge) return;
    badge.classList.toggle("is-stale", !isLive);
    badge.setAttribute(
      "aria-label",
      isLive ? "背景に表示しているSomniaの現在の表情" : "SomniaのLIVE状態を更新できません",
    );
    const textNode = [...badge.childNodes].find((node) => node.nodeType === Node.TEXT_NODE);
    if (textNode) textNode.nodeValue = label;
  };

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
    curious: 0.20,
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
    working: "working",
    using_tool: "thinking",
    delegating: "working",
    monitoring_opencode: "working",
    answering_opencode: "working",
    sleeping: "sleeping",
    waking_up: "waking_up",
    unwell: "unwell",
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
      this.moodEyeLayers = {};
      this.startedAt = performance.now();
      this.nextBlinkT = null;
      this.blinkUntilT = 0;
      this.blinkDuration = 0.15;
      this.moodBlinkScale = 1;
      this.moodChangedT = 0;
      this.primaryChangedT = 0;
      this.effectStartedAt = new Map();
      this.stateInitialized = false;
      this.crtMode = null;
      this.crtStartedT = 0;
      this.relaySocket = null;
      this.relayReconnectTimer = null;
      this.relayReconnectDelay = 1000;
      this.relayLastLiveAt = 0;
      this.relayLive = false;
      this.fallbackRefresh = null;
      this.lastFallbackAt = 0;
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
      this.moodEyeLayers.leftEye = this.createMoodEyeLayers(this.eyeLayers.leftEye, "leftEye");
      this.moodEyeLayers.rightEye = this.createMoodEyeLayers(this.eyeLayers.rightEye, "rightEye");
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
      let minX = canvas.width;
      let minY = canvas.height;
      let maxX = -1;
      let maxY = -1;
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
          const alpha = Math.max(0, Math.min(255, 255 * s * v * 1.9));
          data[i + 3] = alpha;
          if (alpha > 8) {
            const p = i / 4;
            const x = p % canvas.width;
            const y = Math.floor(p / canvas.width);
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
          }
        } else {
          data[i + 3] = 0;
        }
      }
      ctx.putImageData(frame, 0, 0);
      canvas.alphaBox = maxX >= 0
        ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
        : { x: 0, y: 0, w: canvas.width, h: canvas.height };
      return canvas;
    }

    createMoodEyeLayers(layer, key) {
      const moods = ["calm", "content", "curious", "focused", "alert", "anxious", "weary", "happy"];
      const layers = {};
      const normal = this.cloneCanvas(layer);
      normal.alphaBox = layer.alphaBox;
      for (const mood of moods) {
        const shape = ["focused", "anxious", "weary", "happy", "content", "alert"].includes(mood) ? mood : "calm";
        layers[mood] = shape === "calm" ? normal : this.shapeEyeLayer(layer, key, shape);
      }
      return layers;
    }

    cloneCanvas(source) {
      const canvas = document.createElement("canvas");
      canvas.width = source.width;
      canvas.height = source.height;
      canvas.getContext("2d").drawImage(source, 0, 0);
      return canvas;
    }

    shapeEyeLayer(layer, key, mood) {
      const canvas = this.cloneCanvas(layer);
      canvas.alphaBox = layer.alphaBox;
      const ctx = canvas.getContext("2d");
      const box = layer.alphaBox || { x: 0, y: 0, w: layer.width, h: layer.height };
      const le = box.x;
      const te = box.y;
      const ri = box.x + box.w;
      const bo = box.y + box.h;
      const w = box.w;
      const h = box.h;
      const pad = Math.max(4, Math.round(layer.width * 0.005));
      const outer = key === "leftEye" ? "left" : "right";

      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      ctx.beginPath();
      if (mood === "focused") {
        const inner = te + h * 0.30;
        const outerY = te + h * 0.18;
        if (outer === "left") {
          ctx.moveTo(le - pad, te - pad);
          ctx.lineTo(ri + pad, te - pad);
          ctx.lineTo(ri + pad, inner);
          ctx.lineTo(le - pad, outerY);
        } else {
          ctx.moveTo(le - pad, te - pad);
          ctx.lineTo(ri + pad, te - pad);
          ctx.lineTo(ri + pad, outerY);
          ctx.lineTo(le - pad, inner);
        }
      } else if (mood === "weary") {
        ctx.rect(le - pad, te - pad, w + pad * 2, h * 0.45 + pad);
      } else if (mood === "anxious") {
        const hi = te + h * 0.08;
        const lo = te + h * 0.42;
        if (outer === "left") {
          ctx.moveTo(le - pad, te - pad);
          ctx.lineTo(ri + pad, te - pad);
          ctx.lineTo(ri + pad, hi);
          ctx.lineTo(le - pad, lo);
        } else {
          ctx.moveTo(le - pad, te - pad);
          ctx.lineTo(ri + pad, te - pad);
          ctx.lineTo(ri + pad, lo);
          ctx.lineTo(le - pad, hi);
        }
      } else if (mood === "happy") {
        const ex = le - w * 0.15;
        const ey = te + h * 0.52;
        const ew = w * 1.30;
        const eh = h * 1.38;
        ctx.ellipse(ex + ew / 2, ey + eh / 2, ew / 2, eh / 2, 0, 0, Math.PI * 2);
      } else if (mood === "content") {
        const ex = le - w * 0.10;
        const ey = bo - h * 0.22;
        const ew = w * 1.20;
        const eh = h * 1.42;
        ctx.ellipse(ex + ew / 2, ey + eh / 2, ew / 2, eh / 2, 0, 0, Math.PI * 2);
      } else if (mood === "alert") {
        ctx.rect(le - pad, te - pad, w + pad * 2, h * 0.12 + pad);
      }
      ctx.closePath();
      ctx.fill();
      ctx.restore();
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
      const now = (performance.now() - this.startedAt) / 1000;
      const previous = this.state;
      const previousEffects = new Set(previous.effects || []);
      const effects = Array.isArray(next.effects) ? [...new Set(next.effects)] : [];
      if (next.beacon && !effects.includes("beacon")) effects.push("beacon");
      const state = {
        primary: next.primary || "idle",
        energy: next.energy || "normal",
        mood: next.mood || "calm",
        effects,
      };

      if (!this.stateInitialized || state.mood !== previous.mood) {
        this.moodChangedT = now;
      }
      const previousPrimary = faceOfPrimary[previous.primary] || "idle";
      const nextPrimary = faceOfPrimary[state.primary] || "idle";
      if (!this.stateInitialized || nextPrimary !== previousPrimary) {
        this.primaryChangedT = now;
        if (this.stateInitialized && nextPrimary === "sleeping") {
          this.crtMode = "off";
          this.crtStartedT = now;
        } else if (this.stateInitialized && previousPrimary === "sleeping") {
          this.crtMode = "on";
          this.crtStartedT = now;
        }
      }

      const nextEffects = new Set(effects);
      for (const effect of nextEffects) {
        if (!previousEffects.has(effect)) this.effectStartedAt.set(effect, now);
      }
      for (const effect of previousEffects) {
        if (!nextEffects.has(effect)) this.effectStartedAt.delete(effect);
      }

      this.state = state;
      this.stateInitialized = true;
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
      const debugState = this.debugStateFromLocation();
      if (debugState) {
        this.setState(debugState);
        setLiveBadge(false, "PREVIEW");
      } else {
        this.refreshRelay();
        this.connectRelay();
        setInterval(() => this.refreshRelay(), 15 * 1000);
        setInterval(() => this.checkRelayStaleness(), 5 * 1000);
      }
    }

    debugStateFromLocation() {
      const params = new URLSearchParams(window.location.search);
      if (!params.has("face-debug")) return null;
      if (!params.has("face-primary") && !params.has("face-mood")) return null;
      return {
        primary: params.get("face-primary") || "idle",
        energy: params.get("face-energy") || "normal",
        mood: params.get("face-mood") || "calm",
        effects: params.get("face-effects") ? params.get("face-effects").split(",").filter(Boolean) : [],
        beacon: params.get("face-beacon") === "1",
      };
    }

    applyRelayState(data) {
      if (
        data?.type !== "state"
        || data?.schema !== "somnia.face-state.v1"
        || data.live !== true
        || !data.state
      ) {
        this.markRelayStale(true);
        return false;
      }

      this.relayLastLiveAt = Date.now();
      this.relayLive = true;
      this.setState(data.state);
      setLiveBadge(true);
      return true;
    }

    async refreshRelay() {
      try {
        const response = await fetch(RELAY_STATE_API, { cache: "no-store" });
        if (!response.ok) throw new Error("relay unavailable");
        const data = await response.json();
        this.applyRelayState(data);
      } catch (_e) {
        this.markRelayStale(false);
      }
    }

    connectRelay() {
      if (this.relaySocket?.readyState === WebSocket.OPEN || this.relaySocket?.readyState === WebSocket.CONNECTING) return;

      try {
        const socket = new WebSocket(RELAY_STREAM);
        this.relaySocket = socket;
        socket.addEventListener("open", () => {
          this.relayReconnectDelay = 1000;
        });
        socket.addEventListener("message", (event) => {
          try {
            this.applyRelayState(JSON.parse(event.data));
          } catch (_e) {
            // Ignore malformed public messages and let the freshness watchdog handle it.
          }
        });
        socket.addEventListener("close", () => {
          if (this.relaySocket === socket) this.relaySocket = null;
          this.markRelayStale(false);
          this.scheduleRelayReconnect();
        });
        socket.addEventListener("error", () => socket.close());
      } catch (_e) {
        this.scheduleRelayReconnect();
      }
    }

    scheduleRelayReconnect() {
      if (this.relayReconnectTimer) return;
      const delay = this.relayReconnectDelay + Math.random() * 500;
      this.relayReconnectDelay = Math.min(this.relayReconnectDelay * 2, 30 * 1000);
      this.relayReconnectTimer = setTimeout(() => {
        this.relayReconnectTimer = null;
        this.connectRelay();
      }, delay);
    }

    checkRelayStaleness() {
      this.markRelayStale(false);
    }

    markRelayStale(force) {
      if (!force && this.relayLastLiveAt && Date.now() - this.relayLastLiveAt <= RELAY_STALE_MS) return;
      if (!this.relayLive && this.fallbackRefresh) return;
      if (!this.relayLive && Date.now() - this.lastFallbackAt < 60 * 1000) return;
      this.relayLive = false;
      setLiveBadge(false);
      this.refreshFallback();
    }

    async refreshFallback() {
      if (this.fallbackRefresh) return this.fallbackRefresh;
      this.lastFallbackAt = Date.now();
      this.fallbackRefresh = (async () => {
        try {
          const response = await fetch(STATUS_API, { cache: "no-store" });
          if (!response.ok) throw new Error("status unavailable");
          const data = await response.json();
          if (!statusIsFresh(data)) throw new Error("status stale");
          if (!this.relayLive) this.setState(data.face);
        } catch (_e) {
          if (!this.relayLive) {
            this.setState({ primary: "viewer_disconnected", energy: "drowsy", mood: "weary" });
          }
        } finally {
          this.fallbackRefresh = null;
        }
      })();
      return this.fallbackRefresh;
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

    flashWave(dt, { pulse = 0.18, count = 3, hi = 0.5, lo = -0.15 } = {}) {
      if (dt < 0) return 0;
      const total = pulse * 2 * count;
      if (dt >= total) return 0;
      return Math.floor(dt / pulse) % 2 === 0 ? hi : lo;
    }

    effectAge(effect, tRaw) {
      const startedAt = this.effectStartedAt.get(effect);
      return Number.isFinite(startedAt) ? tRaw - startedAt : Infinity;
    }

    snapWave(value) {
      const wave = Math.sin(value);
      return wave > 0.6 ? 1 : (wave < -0.6 ? -1 : 0);
    }

    winkSquash(tRaw) {
      const dt = this.effectAge("ack", tRaw);
      if (dt < 0 || dt >= this.blinkDuration) return 1;
      const progress = dt / this.blinkDuration;
      return progress < 0.5
        ? 1 - (progress / 0.5) * 0.9
        : 0.1 + ((progress - 0.5) / 0.5) * 0.9;
    }

    crtFrame(tRaw) {
      if (!this.crtMode) return { active: false, params: null };
      const dt = tRaw - this.crtStartedT;
      const d = this.blinkDuration;
      let params;

      if (this.crtMode === "off") {
        if (dt < d) {
          const u = dt / d;
          params = { sy: 1 - u * 0.95, sx: 1, gain: u * 0.9 };
        } else if (dt < d * 2) {
          const u = (dt - d) / d;
          params = { sy: 0.05, sx: 1 - u * 0.92, gain: 0.9 - u * 0.5 };
        } else if (dt < d * 2 + CRT_DARK_HOLD_OFF) {
          params = null;
        } else {
          this.crtMode = null;
          return { active: false, params: null };
        }
      } else if (dt < CRT_DARK_HOLD_ON) {
        params = null;
      } else if (dt - CRT_DARK_HOLD_ON < d) {
        const u = (dt - CRT_DARK_HOLD_ON) / d;
        params = { sy: 0.05, sx: 0.08 + u * 0.92, gain: 0.9 - u * 0.3 };
      } else if (dt - CRT_DARK_HOLD_ON < d * 2) {
        const u = (dt - CRT_DARK_HOLD_ON - d) / d;
        params = { sy: 0.05 + u * 0.95, sx: 1, gain: 0.6 - u * 0.6 };
      } else {
        this.crtMode = null;
        return { active: false, params: null };
      }
      return { active: true, params };
    }

    draw(tRaw) {
      if (!this.images.base) return;
      const ctx = this.ctx;
      const w = this.canvas.width;
      const h = this.canvas.height;
      const primary = this.faceState();
      const speed = speedByEnergy[this.state.energy] || 1;
      const t = tRaw * speed;
      const faceRect = this.coverRect(this.images.base, w, h);

      ctx.clearRect(0, 0, w, h);
      this.drawCoverImage(this.images.base, faceRect);

      const crt = this.crtFrame(tRaw);
      if (crt.active) {
        if (crt.params) {
          this.drawEye("leftEye", 0, 0, crt.params.sy, crt.params.sx, 1 + crt.params.gain, faceRect);
          this.drawEye("rightEye", 0, 0, crt.params.sy, crt.params.sx, 1 + crt.params.gain, faceRect);
        }
        return;
      }

      if (primary === "sleeping") {
        this.drawSleeping(t, faceRect);
        return;
      }

      const motion = this.saccade.current(t);
      if (this.saccade.blinkRequested) {
        this.saccade.blinkRequested = false;
        this.triggerBlink(t);
      }

      const range = stateRange[primary] || 1;
      let dx = motion.x * range * (faceRect.w / 1920);
      let dy = motion.y * range * (faceRect.h / 1080);
      const breath = Math.sin(t * 1.2) * 0.15;
      const micro = Math.sin(t * 0.37 + 0.7) * 0.05;
      let glow = 1 + breath + micro + motion.pop * 0.25 + (moodGlow[this.state.mood] || 0);
      let squash = this.blinkSquash(t, primary);
      let scale = 1;
      const unitX = faceRect.w / 1920;
      const unitY = faceRect.h / 1080;

      if (primary === "listening") {
        dy -= 3 * unitY;
        glow += 0.08;
      } else if (primary === "thinking") {
        dx += 8 * unitX;
        dy -= 9 * unitY;
      } else if (primary === "speaking") {
        glow += Math.floor(t * 5) % 2 ? 0.25 : 0;
      } else if (primary === "working") {
        dx += this.snapWave(t * 1.7) * 14 * unitX;
        glow += 0.06;
      } else if (primary === "waking_up") {
        const phase = Math.min(1, Math.max(0, tRaw - this.primaryChangedT) * 0.25);
        const step = Math.floor(phase * 5) / 5;
        squash = Math.min(squash, Math.max(0.22, step));
        glow -= 0.05;
      } else if (primary === "unwell") {
        dx *= 0.2;
        dy = dy * 0.2 + 8 * unitY;
        glow = 0.45;
        squash = Math.min(squash, 0.9);
      }

      if (["listening", "thinking", "speaking", "working"].includes(primary)) {
        glow += 0.12;
      }

      if (this.state.mood === "happy") {
        dy -= 4 * unitY;
        glow += this.flashWave(tRaw - this.moodChangedT);
      } else if (this.state.mood === "curious") {
        glow += this.flashWave(tRaw - this.moodChangedT, { pulse: 0.15, count: 1, hi: 0.45 });
      }

      if (this.state.effects?.includes("sparkle")) {
        const sparkle = this.flashWave(this.effectAge("sparkle", tRaw));
        glow += sparkle || 0.15;
      }
      if (this.state.effects?.includes("beacon")) {
        glow += Math.floor(tRaw / 0.5) % 2 === 0 ? 0.35 : -0.25;
      }

      const surpriseAge = this.effectAge("surprise", tRaw);
      if (this.state.effects?.includes("surprise")) {
        if (surpriseAge < 1.2) {
          dx *= 0.15;
          dy *= 0.15;
        }
        const surprise = this.flashWave(surpriseAge, { pulse: 0.14, count: 2, hi: 0.6 });
        glow += surprise || 0.08;
      }

      const leftSquash = Math.max(0.05, squash);
      const rightSquash = Math.max(0.05, Math.min(squash, this.winkSquash(tRaw)));
      const minSquash = Math.min(leftSquash, rightSquash);
      const eyeGlow = minSquash < 0.95
        ? glow * Math.max(0.4, 0.4 + 0.6 * minSquash)
        : glow;
      const glitchPhase = surpriseAge >= 0 && surpriseAge < GLITCH_BURST_SEC
        ? Math.floor(tRaw * 30)
        : null;

      this.drawEye("leftEye", dx, dy, leftSquash, scale, eyeGlow, faceRect, { glitchPhase });
      this.drawEye("rightEye", dx, dy, rightSquash, scale, eyeGlow, faceRect, { glitchPhase });
      this.drawStateEffects(primary, tRaw, dx, dy, faceRect);
    }

    coverRect(img, w, h) {
      const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
      return {
        x: (w - img.naturalWidth * scale) / 2,
        y: (h - img.naturalHeight * scale) / 2,
        w: img.naturalWidth * scale,
        h: img.naturalHeight * scale,
      };
    }

    drawCoverImage(img, rect) {
      this.ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h);
    }

    eyePlacement(key, faceRect) {
      const img = this.eyeLayerFor(key);
      const isLeft = key === "leftEye";
      const targetW = faceRect.w * 0.49;
      const sourceW = img.naturalWidth || img.width;
      const sourceH = img.naturalHeight || img.height;
      const targetH = targetW * (sourceH / sourceW);
      const cx = faceRect.x + faceRect.w * (isLeft ? 0.255 : 0.765);
      const cy = faceRect.y + faceRect.h * 0.59;
      return { x: cx - targetW / 2, y: cy - targetH / 2, w: targetW, h: targetH };
    }

    eyeLayerFor(key) {
      const mood = this.state.mood || "calm";
      return this.moodEyeLayers[key]?.[mood] || this.moodEyeLayers[key]?.calm || this.eyeLayers[key] || this.images[key];
    }

    eyeGeometry(key, dx, dy, squash, scale, faceRect) {
      const img = this.eyeLayerFor(key);
      const p = this.eyePlacement(key, faceRect);
      const cx = p.x + p.w / 2 + dx;
      const cy = p.y + p.h / 2 + dy;
      const dw = p.w * scale;
      const dh = p.h * squash;
      const x = cx - dw / 2;
      const y = cy - dh / 2;
      const box = img.alphaBox || { x: 0, y: 0, w: img.width, h: img.height };
      const content = {
        x: x + (box.x / img.width) * dw,
        y: y + (box.y / img.height) * dh,
        w: (box.w / img.width) * dw,
        h: (box.h / img.height) * dh,
      };
      return { img, x, y, dw, dh, content };
    }

    drawGlitchedEye(geometry, phase, glow) {
      const { img, x, y, dw, dh } = geometry;
      const ctx = this.ctx;
      const ghostShift = Math.max(3, this.canvas.width * 0.005);

      for (const [shift, hue] of [[-ghostShift, 115], [ghostShift, -35]]) {
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = 0.28;
        ctx.filter = `hue-rotate(${hue}deg) brightness(${1.1 + glow * 0.08})`;
        ctx.drawImage(img, x + shift, y, dw, dh);
        ctx.restore();
      }

      const sourceW = img.width;
      const sourceH = img.height;
      const bands = 12;
      for (let band = 0; band < bands; band += 1) {
        const sourceY = Math.floor(sourceH * band / bands);
        const nextSourceY = Math.floor(sourceH * (band + 1) / bands);
        const sourceBandH = Math.max(1, nextSourceY - sourceY);
        const destinationY = y + dh * band / bands;
        const destinationBandH = dh / bands + 1;
        const noise = Math.sin((phase + 1) * (band + 3) * 12.9898);
        const shift = noise * Math.max(4, this.canvas.width * 0.008);
        ctx.save();
        ctx.globalAlpha = 0.94;
        ctx.filter = `brightness(${Math.max(0.7, 1.02 + glow * 0.12)})`;
        ctx.drawImage(
          img,
          0,
          sourceY,
          sourceW,
          sourceBandH,
          x + shift,
          destinationY,
          dw,
          destinationBandH,
        );
        ctx.restore();
      }
    }

    drawEye(key, dx, dy, squash, scale, glow, faceRect, { glitchPhase = null } = {}) {
      const ctx = this.ctx;
      const geometry = this.eyeGeometry(key, dx, dy, squash, scale, faceRect);
      const { img, x, y, dw, dh } = geometry;

      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.filter = `blur(${Math.max(12, this.canvas.width * 0.018)}px) brightness(${Math.max(0.6, 1.1 + glow * 0.5)})`;
      ctx.globalAlpha = Math.max(0.16, Math.min(0.92, 0.42 + glow * 0.26));
      ctx.drawImage(img, x, y, dw, dh);
      ctx.restore();

      if (glitchPhase === null) {
        ctx.save();
        ctx.globalAlpha = 0.94;
        ctx.filter = `brightness(${Math.max(0.7, 1.02 + glow * 0.12)})`;
        ctx.drawImage(img, x, y, dw, dh);
        ctx.restore();
      } else {
        this.drawGlitchedEye(geometry, glitchPhase, glow);
      }
    }

    drawStateEffects(primary, tRaw, dx, dy, faceRect) {
      if (primary !== "thinking" && primary !== "working") return;
      const ctx = this.ctx;
      for (const key of ["leftEye", "rightEye"]) {
        const { content } = this.eyeGeometry(key, dx, dy, 1, 1, faceRect);
        const color = key === "leftEye" ? "84,212,230" : "183,164,255";

        if (primary === "thinking") {
          const margin = content.h / 8;
          const progress = (tRaw * 7 % 12) / 12;
          const y = content.y - margin + (content.h + margin * 2) * progress;
          ctx.save();
          ctx.beginPath();
          ctx.rect(content.x, content.y, content.w, content.h);
          ctx.clip();
          ctx.globalCompositeOperation = "lighter";
          ctx.fillStyle = `rgba(${color},.16)`;
          ctx.shadowColor = `rgba(${color},.34)`;
          ctx.shadowBlur = Math.max(2, content.h * 0.04);
          ctx.fillRect(content.x, y, content.w, Math.max(2, content.h / 18));
          ctx.restore();
        } else {
          const pad = content.w * 0.10;
          const angle = tRaw * Math.PI * 1.8;
          ctx.save();
          ctx.globalCompositeOperation = "lighter";
          ctx.strokeStyle = `rgba(${color},.72)`;
          ctx.lineWidth = Math.max(2, content.w * 0.025);
          ctx.lineCap = "round";
          ctx.shadowColor = `rgba(${color},.46)`;
          ctx.shadowBlur = Math.max(3, content.w * 0.03);
          ctx.beginPath();
          ctx.ellipse(
            content.x + content.w / 2,
            content.y + content.h / 2,
            content.w / 2 + pad,
            content.h / 2 + pad,
            0,
            angle,
            angle + Math.PI * 0.44,
          );
          ctx.stroke();
          ctx.restore();
        }
      }
    }

    drawSleeping(t, faceRect) {
      const ctx = this.ctx;
      const w = faceRect.w;
      const h = faceRect.h;
      const y = faceRect.y + h * 0.59 + Math.sin(t * 0.9) * h * 0.004;
      ctx.save();
      ctx.strokeStyle = "rgba(30, 55, 105, .82)";
      ctx.lineWidth = Math.max(4, w * 0.006);
      ctx.lineCap = "round";
      ctx.shadowColor = "rgba(92, 220, 255, .28)";
      ctx.shadowBlur = Math.max(8, w * 0.012);
      for (const x of [faceRect.x + w * 0.255, faceRect.x + w * 0.775]) {
        ctx.beginPath();
        ctx.ellipse(x, y, w * 0.105, h * 0.026, 0, Math.PI * 190 / 180, Math.PI * 350 / 180);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  async function boot() {
    try {
      if (FACE_DEBUG) window.somniaFaceBootCalled = true;
      const canvas = document.querySelector("[data-somnia-face]");
      if (!canvas) return;
      const face = new SomniaFace(canvas);
      await face.load();
      if (FACE_DEBUG) {
        window.somniaFace = face;
      }
      face.start();
    } catch (error) {
      if (FACE_DEBUG) {
        window.somniaFaceBootError = String(error?.stack || error);
      }
      console.error("Somnia face failed to start", error);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
