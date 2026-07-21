import { reset, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

const ORIGIN = "https://takeofflab.github.io";
const TOKEN = "test-publish-token";

function payload(overrides: Record<string, unknown> = {}) {
  return {
    schema: "somnia.face-state.v1",
    instance_id: "somnia",
    session_id: "session-test-0001",
    sequence: 1,
    observed_at: new Date().toISOString(),
    state: {
      primary: "working",
      energy: "normal",
      mood: "focused",
      effects: [] as string[],
    },
    ...overrides,
  };
}

async function publish(body: unknown, token = TOKEN) {
  return SELF.fetch("https://relay.test/v1/publish", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("websocket message timeout")), 2000);
    socket.addEventListener("message", (event) => {
      clearTimeout(timer);
      resolve(String(event.data));
    }, { once: true });
  });
}

afterEach(async () => {
  await reset();
});

describe("Somnia face relay", () => {
  it("rejects unauthenticated publishing", async () => {
    const response = await publish(payload(), "wrong-token");
    expect(response.status).toBe(401);
  });

  it("accepts a valid publisher envelope and exposes only public state", async () => {
    const accepted = await publish(payload());
    expect(accepted.status).toBe(202);

    const response = await SELF.fetch("https://relay.test/v1/state", {
      headers: { Origin: ORIGIN },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    const body = await response.json<Record<string, unknown>>();
    expect(body.live).toBe(true);
    expect(body.state).toEqual({
      primary: "working",
      energy: "normal",
      mood: "focused",
      effects: [],
    });
    expect(body).not.toHaveProperty("session_id");
    expect(body).not.toHaveProperty("sequence");
  });

  it("deduplicates repeated sequence numbers within a publisher session", async () => {
    expect((await publish(payload())).status).toBe(202);
    const duplicate = await publish(payload());
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({ accepted: false, duplicate: true });
  });

  it("rejects stale observations from an older session", async () => {
    const now = Date.now();
    expect((await publish(payload({ observed_at: new Date(now).toISOString() }))).status).toBe(202);
    const stale = await publish(payload({
      session_id: "session-test-0002",
      observed_at: new Date(now - 1000).toISOString(),
    }));
    expect(stale.status).toBe(409);
  });

  it("rejects private or unknown state fields", async () => {
    const body = payload();
    body.state = { ...body.state, badges: ["pinned_notes"] } as typeof body.state;
    expect((await publish(body)).status).toBe(400);
  });

  it("rejects internal primary vocabulary", async () => {
    const body = payload();
    body.state = { ...body.state, primary: "monitoring_opencode" };
    expect((await publish(body)).status).toBe(400);
  });

  it("accepts semantic ack but rejects renderer-specific effects", async () => {
    const ack = payload();
    ack.state = { ...ack.state, effects: ["ack"] };
    expect((await publish(ack)).status).toBe(202);

    const rendererEffect = payload({ sequence: 2 });
    rendererEffect.state = { ...rendererEffect.state, effects: ["ring"] };
    expect((await publish(rendererEffect)).status).toBe(400);

    const response = await SELF.fetch("https://relay.test/v1/state", {
      headers: { Origin: ORIGIN },
    });
    const body = await response.json<{ state: { effects: string[] } }>();
    expect(body.state.effects).toEqual(["ack"]);
  });

  it("rejects disallowed browser origins", async () => {
    const response = await SELF.fetch("https://relay.test/v1/state", {
      headers: { Origin: "https://evil.example" },
    });
    expect(response.status).toBe(403);
  });

  it("broadcasts accepted state to connected WebSocket clients", async () => {
    const response = await SELF.fetch("https://relay.test/v1/stream", {
      headers: { Origin: ORIGIN, Upgrade: "websocket" },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    expect(socket).not.toBeNull();
    socket!.accept();

    const initial = JSON.parse(await nextMessage(socket!));
    expect(initial.live).toBe(false);
    expect(initial.state).toBeNull();

    const updatePromise = nextMessage(socket!);
    expect((await publish(payload())).status).toBe(202);
    const update = JSON.parse(await updatePromise);
    expect(update.live).toBe(true);
    expect(update.state.primary).toBe("working");
    socket!.close(1000, "test complete");
  });

  it("marks state stale when heartbeats stop", async () => {
    expect((await publish(payload())).status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 2100));
    const response = await SELF.fetch("https://relay.test/v1/state", {
      headers: { Origin: ORIGIN },
    });
    const body = await response.json<{ live: boolean }>();
    expect(body.live).toBe(false);
  });

  it("returns a public health response", async () => {
    const response = await SELF.fetch("https://relay.test/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      service: "somnia-face-relay",
      schema: "somnia.face-state.v1",
    });
  });
});
