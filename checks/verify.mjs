import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const moduleFrom = async (path) =>
  import(
    "data:text/javascript;base64," +
      Buffer.from(
        await readFile(new URL(path, import.meta.url), "utf8"),
      ).toString("base64")
  );
const { ExpressiveMotion, Spring, MOODS } =
  await moduleFrom("../face-motion.js");
const { livePacket, freshStats, cleanState, FaceFeed } =
  await moduleFrom("../face-state.js");
let seed = 123456;
const random = () => {
  seed = (1664525 * seed + 1013904223) >>> 0;
  return seed / 4294967296;
};
const motion = new ExpressiveMotion(random),
  reference = JSON.parse(
    await readFile(
      new URL("./desktop-motion-reference.json", import.meta.url),
      "utf8",
    ),
  );
let largest = 0,
  count = 0;
for (const segment of reference)
  for (const sample of segment.samples) {
    const actual = motion.sample(segment.state, sample.now);
    for (let i = 0; i < 2; i++)
      for (const key of Object.keys(sample.poses[i])) {
        const error = Math.abs(actual[i][key] - sample.poses[i][key]);
        largest = Math.max(largest, error);
        assert.ok(error < 1e-9, `${key} at ${sample.now}: ${error}`);
      }
    count++;
  }
const atFps = (fps) => {
  const s = new Spring(0);
  for (let i = 0; i < fps; i++) s.step(1, 1 / fps);
  return s.value;
};
assert.ok(Math.abs(atFps(30) - atFps(120)) < 1e-12);
const now = Date.now(),
  valid = {
    primary: "listening",
    mood: "curious",
    energy: "fresh",
    effects: ["ack"],
  },
  packet = {
    type: "state",
    schema: "somnia.face-state.v1",
    live: true,
    state: valid,
    received_at: new Date(now).toISOString(),
    observed_at: new Date(now).toISOString(),
  };
assert.deepEqual(livePacket(packet, now), valid);
for (const age of [36000, -6000])
  assert.equal(
    livePacket(
      { ...packet, observed_at: new Date(now - age).toISOString() },
      now,
    ),
    null,
  );
assert.equal(livePacket({ ...packet, live: false }, now), null);
assert.equal(cleanState({ ...valid, primary: "delegating" }), null);
assert.equal(cleanState({ ...valid, effects: ["private"] }), null);
assert.deepEqual(
  Object.keys(cleanState({ ...valid, debug: "private" })).sort(),
  ["effects", "energy", "mood", "primary"],
);
assert.equal(
  freshStats(
    {
      generated_at: new Date(now - 1800001).toISOString(),
      days_alive: 1,
      sleep_cycles: 1,
    },
    now,
  ),
  null,
);
const events = [],
  feed = new FaceFeed(
    (s) => events.push(s.primary),
    (live) => events.push(live),
  );
feed.expire(true);
assert.equal(events.at(-1), false);
assert.equal(feed.accept(packet), true);
assert.equal(events.at(-1), true);
feed.expire(true);
assert.equal(events.at(-1), false);
assert.equal(
  feed.accept({ ...packet, observed_at: new Date(now - 1000).toISOString() }),
  false,
);
assert.equal(feed.accept(packet), true);
assert.equal(events.at(-1), true);
console.log(
  JSON.stringify(
    {
      desktopMotionFrames: count,
      maxPoseError: largest,
      moods: Object.keys(MOODS).length,
      frameRateIndependent: true,
      publicStateAndReconnectChecks: "passed",
    },
    null,
    2,
  ),
);
