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
      this.moodEyeLayers = {};
      this.startedAt = performance.now();
      this.nextBlinkT = null;
      this.blinkUntilT = 0;
      this.blinkDuration = 0.15;
      this.moodBlinkScale = 1;
      this.lastMood = "calm";
      this.moodChangedT = 0;
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
        const shape = ["focused", "anxious", "weary", "happy"].includes(mood) ? mood : "calm";
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
      const faceRect = this.coverRect(this.images.base, w, h);

      ctx.clearRect(0, 0, w, h);
      this.drawCoverImage(this.images.base, faceRect);

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
      let glow = 0.74 + motion.pop * 0.28 + (moodGlow[this.state.mood] || 0);
      let squash = this.blinkSquash(t, primary);
      let scale = 1;

      if (primary === "listening") {
        glow += 0.12 + 0.06 * Math.sin(t * 5);
        scale = 1.01;
      } else if (primary === "thinking") {
        dy -= 4 * (faceRect.h / 1080);
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

      this.drawEye("leftEye", dx, dy, Math.max(0.06, squash), scale, glow, faceRect);
      this.drawEye("rightEye", dx, dy, Math.max(0.06, squash), scale, glow, faceRect);
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

    drawEye(key, dx, dy, squash, scale, glow, faceRect) {
      const ctx = this.ctx;
      const img = this.eyeLayerFor(key);
      const p = this.eyePlacement(key, faceRect);
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
      ctx.globalAlpha = 0.94;
      ctx.filter = `brightness(${Math.max(0.7, 1.02 + glow * 0.12)})`;
      ctx.drawImage(img, x, y, dw, dh);
      ctx.restore();
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
