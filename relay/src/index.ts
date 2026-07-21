import { DurableObject } from "cloudflare:workers";

const SCHEMA = "somnia.face-state.v1";
const PUBLIC_PRIMARIES = new Set([
  "idle",
  "listening",
  "speaking",
  "thinking",
  "working",
  "sleeping",
  "waking_up",
  "unwell",
]);
const ENERGIES = new Set(["fresh", "normal", "drowsy", "exhausted"]);
const MOODS = new Set([
  "calm",
  "content",
  "curious",
  "focused",
  "alert",
  "anxious",
  "weary",
  "happy",
]);
const EFFECTS = new Set(["sparkle", "surprise", "beacon", "ack"]);
const TOP_LEVEL_KEYS = new Set([
  "schema",
  "instance_id",
  "session_id",
  "sequence",
  "observed_at",
  "state",
]);
const STATE_KEYS = new Set(["primary", "energy", "mood", "effects"]);
const MAX_BODY_BYTES = 4096;

interface Env {
  FACE_RELAY: DurableObjectNamespace<FaceRelay>;
  PUBLISH_TOKEN: string;
  ALLOWED_INSTANCES?: string;
  ALLOWED_ORIGINS?: string;
  DEFAULT_INSTANCE?: string;
  LIVE_TTL_MS?: string;
  MAX_PUBLISH_AGE_MS?: string;
  MAX_FUTURE_SKEW_MS?: string;
}

interface FaceState {
  primary: string;
  energy: string;
  mood: string;
  effects: string[];
}

interface PublishEnvelope {
  schema: typeof SCHEMA;
  instance_id: string;
  session_id: string;
  sequence: number;
  observed_at: string;
  state: FaceState;
}

interface StoredState {
  public: PublicState;
  session_id: string;
  sequence: number;
  observed_ms: number;
}

interface PublicState {
  type: "state";
  schema: typeof SCHEMA;
  instance_id: string;
  observed_at: string;
  received_at: string;
  stale_after_ms: number;
  state: FaceState;
}

type ValidationResult =
  | { ok: true; envelope: PublishEnvelope; observedMs: number }
  | { ok: false; error: string };

function numberSetting(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function csvSetting(value: string | undefined): Set<string> {
  return new Set((value || "").split(",").map((item) => item.trim()).filter(Boolean));
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validInstance(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
}

function validateEnvelope(value: unknown, env: Env, now = Date.now()): ValidationResult {
  if (!isRecord(value) || !hasOnlyKeys(value, TOP_LEVEL_KEYS)) {
    return { ok: false, error: "invalid top-level object" };
  }
  if (value.schema !== SCHEMA) return { ok: false, error: "unsupported schema" };
  if (!validInstance(value.instance_id)) return { ok: false, error: "invalid instance_id" };
  if (!csvSetting(env.ALLOWED_INSTANCES || "somnia").has(value.instance_id)) {
    return { ok: false, error: "instance_id is not allowed" };
  }
  if (typeof value.session_id !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(value.session_id)) {
    return { ok: false, error: "invalid session_id" };
  }
  if (!Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1) {
    return { ok: false, error: "invalid sequence" };
  }
  if (typeof value.observed_at !== "string") return { ok: false, error: "invalid observed_at" };
  const observedMs = Date.parse(value.observed_at);
  if (!Number.isFinite(observedMs)) return { ok: false, error: "invalid observed_at" };

  const maxAge = numberSetting(env.MAX_PUBLISH_AGE_MS, 300_000);
  const maxFuture = numberSetting(env.MAX_FUTURE_SKEW_MS, 300_000);
  if (observedMs < now - maxAge) return { ok: false, error: "observed_at is too old" };
  if (observedMs > now + maxFuture) return { ok: false, error: "observed_at is in the future" };

  if (!isRecord(value.state) || !hasOnlyKeys(value.state, STATE_KEYS)) {
    return { ok: false, error: "invalid state object" };
  }
  const state = value.state;
  if (typeof state.primary !== "string" || !PUBLIC_PRIMARIES.has(state.primary)) {
    return { ok: false, error: "invalid primary" };
  }
  if (typeof state.energy !== "string" || !ENERGIES.has(state.energy)) {
    return { ok: false, error: "invalid energy" };
  }
  if (typeof state.mood !== "string" || !MOODS.has(state.mood)) {
    return { ok: false, error: "invalid mood" };
  }
  if (
    !Array.isArray(state.effects)
    || state.effects.some((effect) => typeof effect !== "string" || !EFFECTS.has(effect))
    || new Set(state.effects).size !== state.effects.length
  ) {
    return { ok: false, error: "invalid effects" };
  }

  return {
    ok: true,
    observedMs,
    envelope: value as unknown as PublishEnvelope,
  };
}

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex",
      ...headers,
    },
  });
}

function allowedOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  return csvSetting(env.ALLOWED_ORIGINS).has(origin) ? origin : "";
}

function corsHeaders(origin: string | null): HeadersInit {
  if (!origin) return {};
  return {
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

async function secretMatches(request: Request, expected: string): Promise<boolean> {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ") || !expected) return false;
  const supplied = auth.slice(7);
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) diff |= (a[i] || 0) ^ (b[i] || 0);
  return diff === 0;
}

function instanceFromRequest(url: URL, env: Env): string | null {
  const instance = url.searchParams.get("instance") || env.DEFAULT_INSTANCE || "somnia";
  return validInstance(instance) && csvSetting(env.ALLOWED_INSTANCES || "somnia").has(instance)
    ? instance
    : null;
}

async function proxyToObject(env: Env, instance: string, path: string, init?: RequestInit): Promise<Response> {
  const id = env.FACE_RELAY.idFromName(instance);
  return env.FACE_RELAY.get(id).fetch(new Request(`https://relay.internal${path}`, init));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = allowedOrigin(request, env);

    if (request.method === "OPTIONS") {
      if (origin === "") return json({ error: "origin is not allowed" }, 403);
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true, service: "somnia-face-relay", schema: SCHEMA });
    }

    if (url.pathname === "/v1/publish" && request.method === "POST") {
      if (!(await secretMatches(request, env.PUBLISH_TOKEN))) {
        return json({ error: "unauthorized" }, 401);
      }
      const contentLength = Number(request.headers.get("Content-Length") || "0");
      if (contentLength > MAX_BODY_BYTES) return json({ error: "payload too large" }, 413);
      const bodyText = await request.text();
      if (new TextEncoder().encode(bodyText).byteLength > MAX_BODY_BYTES) {
        return json({ error: "payload too large" }, 413);
      }
      let body: unknown;
      try {
        body = JSON.parse(bodyText);
      } catch {
        return json({ error: "invalid JSON" }, 400);
      }
      const checked = validateEnvelope(body, env);
      if (!checked.ok) return json({ error: checked.error }, 400);

      const response = await proxyToObject(env, checked.envelope.instance_id, "/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ envelope: checked.envelope, observedMs: checked.observedMs }),
      });
      return new Response(response.body, { status: response.status, headers: response.headers });
    }

    if ((url.pathname === "/v1/state" || url.pathname === "/v1/stream") && request.method === "GET") {
      if (origin === "") return json({ error: "origin is not allowed" }, 403);
      const instance = instanceFromRequest(url, env);
      if (!instance) return json({ error: "instance is not allowed" }, 404, corsHeaders(origin));

      if (url.pathname === "/v1/stream") {
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
          return json({ error: "websocket upgrade required" }, 426, corsHeaders(origin));
        }
        return proxyToObject(env, instance, "/stream", {
          headers: { Upgrade: "websocket" },
        });
      }

      const response = await proxyToObject(env, instance, "/state");
      const headers = new Headers(response.headers);
      Object.entries(corsHeaders(origin)).forEach(([key, value]) => headers.set(key, String(value)));
      return new Response(response.body, { status: response.status, headers });
    }

    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;

export class FaceRelay extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  private async latest(): Promise<StoredState | undefined> {
    return this.ctx.storage.get<StoredState>("latest");
  }

  private liveView(stored: StoredState | undefined): Record<string, unknown> {
    if (!stored) {
      return { type: "state", schema: SCHEMA, live: false, state: null };
    }
    const ttl = stored.public.stale_after_ms;
    const receivedMs = Date.parse(stored.public.received_at);
    const ageMs = Math.max(0, Date.now() - receivedMs);
    return { ...stored.public, live: ageMs <= ttl, age_ms: ageMs };
  }

  private broadcast(message: Record<string, unknown>): void {
    const encoded = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(encoded);
      } catch {
        try { socket.close(1011, "broadcast failed"); } catch { /* already closed */ }
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/publish" && request.method === "POST") {
      const input = await request.json<{ envelope: PublishEnvelope; observedMs: number }>();
      const previous = await this.latest();
      const { envelope, observedMs } = input;

      if (previous?.session_id === envelope.session_id && envelope.sequence <= previous.sequence) {
        return json({ accepted: false, duplicate: true }, 200);
      }
      if (previous && observedMs < previous.observed_ms) {
        return json({ accepted: false, error: "stale observation" }, 409);
      }

      const receivedAt = new Date().toISOString();
      const stored: StoredState = {
        session_id: envelope.session_id,
        sequence: envelope.sequence,
        observed_ms: observedMs,
        public: {
          type: "state",
          schema: SCHEMA,
          instance_id: envelope.instance_id,
          observed_at: envelope.observed_at,
          received_at: receivedAt,
          stale_after_ms: numberSetting(this.env.LIVE_TTL_MS, 30_000),
          state: envelope.state,
        },
      };
      await this.ctx.storage.put("latest", stored);
      this.broadcast(this.liveView(stored));
      return json({ accepted: true }, 202);
    }

    if (url.pathname === "/state" && request.method === "GET") {
      const stored = await this.latest();
      return json(this.liveView(stored), stored ? 200 : 404);
    }

    if (url.pathname === "/stream" && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify(this.liveView(await this.latest())));
      return new Response(null, { status: 101, webSocket: client });
    }

    return json({ error: "not found" }, 404);
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message === "string" && message === "ping") {
      socket.send(JSON.stringify({ type: "pong", at: new Date().toISOString() }));
    }
  }

  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    socket.close(code, reason);
  }

  webSocketError(socket: WebSocket): void {
    try { socket.close(1011, "websocket error"); } catch { /* already closed */ }
  }
}
