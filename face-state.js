// Public semantic state only. Never connect the browser to the private dashboard.
const PRIMARY = [
  "idle",
  "listening",
  "speaking",
  "thinking",
  "working",
  "sleeping",
  "waking_up",
  "unwell",
];
const MOOD = [
  "calm",
  "content",
  "curious",
  "focused",
  "alert",
  "anxious",
  "weary",
  "happy",
];
const ENERGY = ["fresh", "normal", "drowsy", "exhausted"];
const EFFECTS = ["sparkle", "surprise", "beacon", "ack"];
export function cleanState(value) {
  if (
    !value ||
    !PRIMARY.includes(value.primary) ||
    !MOOD.includes(value.mood) ||
    !ENERGY.includes(value.energy) ||
    !Array.isArray(value.effects) ||
    value.effects.some((x) => !EFFECTS.includes(x))
  )
    return null;
  return {
    primary: value.primary,
    mood: value.mood,
    energy: value.energy,
    effects: [...new Set(value.effects)],
  };
}
export function livePacket(data, now = Date.now()) {
  const received = Date.parse(data?.received_at),
    observed = Date.parse(data?.observed_at);
  return data?.type === "state" &&
    data.schema === "somnia.face-state.v1" &&
    data.live === true &&
    Number.isFinite(received) &&
    Number.isFinite(observed) &&
    received <= now + 5000 &&
    observed <= now + 5000 &&
    now - received <= 35000 &&
    now - observed <= 35000
    ? cleanState(data.state)
    : null;
}
export function freshStats(data, now = Date.now()) {
  const age = now - Date.parse(data?.generated_at);
  return Number.isFinite(age) &&
    age >= -300000 &&
    age <= 1800000 &&
    Number.isFinite(data.days_alive) &&
    data.days_alive >= 0 &&
    Number.isFinite(data.sleep_cycles) &&
    data.sleep_cycles >= 0
    ? {
        days: Math.floor(data.days_alive),
        sleeps: Math.floor(data.sleep_cycles),
      }
    : null;
}
export class FaceFeed {
  constructor(onState, onLive) {
    this.onState = onState;
    this.onLive = onLive;
    this.base = "https://somnia-face-relay.somnia-ai.workers.dev";
    this.lastReceived = 0;
    this.lastObserved = 0;
    this.live = false;
    this.delay = 1000;
    this.closed = false;
    this.socket = null;
    this.reconnect = null;
    this.fetching = false;
  }
  accept(data) {
    const state = livePacket(data);
    if (!state) {
      if (data?.live === false) this.expire(true);
      return false;
    }
    const observed = Date.parse(data.observed_at);
    if (observed < this.lastObserved) return false;
    this.lastObserved = observed;
    this.lastReceived = Date.parse(data.received_at);
    this.live = true;
    this.onState(state);
    this.onLive(true);
    return true;
  }
  expire(force = false) {
    if (force || Date.now() - this.lastReceived > 35000) {
      this.live = false;
      this.onLive(false);
    }
  }
  async refresh() {
    if (this.closed || this.fetching) return;
    this.fetching = true;
    try {
      const r = await fetch(this.base + "/v1/state", {
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
      });
      if (r.ok) this.accept(await r.json());
      else this.expire();
    } catch {
      this.expire();
    } finally {
      this.fetching = false;
    }
  }
  connect() {
    if (this.closed || this.socket) return;
    try {
      const socket = new WebSocket(
        this.base.replace("https:", "wss:") + "/v1/stream",
      );
      this.socket = socket;
      socket.onopen = () => {
        this.delay = 1000;
      };
      socket.onmessage = (event) => {
        try {
          this.accept(JSON.parse(event.data));
        } catch {
          /* Freshness watchdog handles malformed packets. */
        }
      };
      socket.onerror = () => socket.close();
      socket.onclose = () => {
        if (this.socket === socket) this.socket = null;
        this.expire();
        this.schedule();
      };
    } catch {
      this.schedule();
    }
  }
  schedule() {
    if (this.closed || this.reconnect) return;
    this.reconnect = setTimeout(
      () => {
        this.reconnect = null;
        this.connect();
      },
      this.delay + Math.random() * 400,
    );
    this.delay = Math.min(30000, this.delay * 2);
  }
  start() {
    this.onLive(false, true);
    this.refresh();
    this.connect();
    this.watchdog = setInterval(() => {
      this.expire();
      if (!this.live) this.refresh();
    }, 5000);
  }
  stop() {
    this.closed = true;
    clearTimeout(this.reconnect);
    clearInterval(this.watchdog);
    this.socket?.close();
  }
}
