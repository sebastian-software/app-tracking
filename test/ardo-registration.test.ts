import assert from "node:assert/strict";
import test from "node:test";
import { checkedEvents, eventQuery } from "../src/reporting/events.ts";
import { checkedHistory, checkedPublicUsage, historyQuery } from "../src/reporting/history.ts";
import { checkedProfiles } from "../src/reporting/profiles.ts";
import { serviceQuery } from "../src/reporting/service-requests.ts";
import { createHistoryPermissionHandler } from "../src/telemetry/history.ts";
import { createProfileHandler } from "../src/telemetry/profiles.ts";
import { eventFixture } from "./fixtures/events.ts";
import { historyFixture, publicUsageFixture } from "./fixtures/history.ts";
import { profileFixture } from "./fixtures/profiles.ts";

test("Ardo reporting accepts generic invocations and version requests, but no legacy stream", () => {
  const query = eventQuery(
    new URL(
      "https://example.test/?from=2026-10-01&until=2026-10-02&tool=ardo&metric=cli.invocation",
    ),
  );
  const events = checkedEvents(eventFixture(query), query);
  assert.equal(events.dimensions[0]!.value, "build");
  assert.equal(events.versions[0]!.tool_id, "ardo");
  const historyURL = new URL(
    "https://example.test/?from=2026-01-01&until=2026-10-01&tool=ardo&stream=events&metric=cli.invocation",
  );
  const history = historyQuery(historyURL);
  assert.ok(
    checkedHistory(historyFixture(history), history).months.every((row) => row.tool_id === "ardo"),
  );
  historyURL.searchParams.set("stream", "legacy");
  assert.throws(() => historyQuery(historyURL));
  assert.equal(
    serviceQuery(new URL("https://example.test/?from=2026-10-01&until=2026-10-02&tool=ardo")).tool,
    "ardo",
  );
});

test("profile reports accommodate all combinations of the four registered tools", () => {
  const query = { from: "2026-10-01", until: "2026-10-02" };
  const tools = ["ardo", "dalo", "ferriki", "palamedes"];
  const combinations = Array.from({ length: 15 }, (_, i) => ({
    tools: tools.filter((_, bit) => ((i + 1) & (1 << bit)) !== 0),
    profiles: "1",
  }));
  const value = {
    ...profileFixture(query),
    combinations,
    totals: { profiles: "15", installations: "32", projects: "0" },
  };
  assert.equal(checkedProfiles(value, query).combinations.length, 15);
  assert.throws(() =>
    checkedProfiles({ ...value, combinations: [...combinations, combinations[0]] }, query),
  );
});

test("the public projection can validate 24 months of every registered stream and context", () => {
  const fixture = publicUsageFixture();
  const scopes = [
    ["dalo", "legacy", "cli.invocation"],
    ["palamedes", "legacy", "cli.invocation"],
    ["ardo", "events", "cli.invocation"],
    ["dalo", "events", "cli.invocation"],
    ["palamedes", "events", "cli.invocation"],
    ["ferriki", "events", "language.use"],
    ["ferriki", "events", "resource.download"],
  ];
  const series = scopes.flatMap(([tool_id, stream, metric]) =>
    ["local", "ci"].flatMap((mode) =>
      Array.from({ length: 24 }, (_, i) => ({
        ...fixture.series[0]!,
        tool_id: tool_id!,
        stream: stream!,
        metric: metric!,
        mode,
        month: new Date(Date.UTC(2024, i, 1)).toISOString().slice(0, 10),
      })),
    ),
  );
  assert.equal(checkedPublicUsage({ ...fixture, series }).series.length, 336);
});

test("Ardo has the same independent history, publication, and profile permission routes", async () => {
  const id = "a".repeat(64),
    token = "b".repeat(64),
    profile = "c".repeat(64),
    at = Date.now();
  const request = (path: string, revision: string, extra = {}) =>
    new Request(`https://example.test/v1/${path}/events/${id}`, {
      method: "PUT",
      headers: {
        "App-Tracking-Tool": "ardo",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        schema_version: 1,
        revision,
        enabled: true,
        changed_at: at,
        ...extra,
      }),
    });
  let calls = 0;
  const storage = {
    async setHistoryPermission(
      tool: string,
      stream: string,
      received: string,
      _hash: string,
      enabled: boolean,
      changed_at: number,
    ) {
      calls++;
      assert.equal(tool, "ardo");
      assert.equal(stream, "events");
      assert.equal(received, id);
      return { result: { status: "updated", enabled, changed_at } };
    },
  };
  for (const kind of ["history", "public"] as const) {
    const revision = kind === "history" ? "monthly-history-v1" : "public-usage-v1";
    const response = await createHistoryPermissionHandler(
      storage,
      true,
      kind,
    )(request(`${kind}-permissions`, revision));
    assert.equal(response.status, 200);
  }
  assert.equal(calls, 2);
  const handler = createProfileHandler({
    async setProfileLink(tool, _id, _hash, enabled, changed_at, profile_id) {
      calls++;
      assert.equal(tool, "ardo");
      return { result: { status: "updated", enabled, changed_at, profile_id } };
    },
    async resetProfile() {
      throw new Error("Must not reset a shared profile");
    },
  });
  assert.equal(
    (
      await handler(
        request("profile-links", "profile-linking-v1", {
          profile_id: profile,
          profile_token: token,
        }),
      )
    ).status,
    200,
  );
  assert.equal(calls, 3);
});
