import assert from "node:assert/strict";
import test from "node:test";
import { createReportingHandler } from "../src/reporting/handler.ts";
import { checkedProfiles, profileQuery } from "../src/reporting/profiles.ts";
import { createProfileHandler, PROFILE_REVISION } from "../src/telemetry/profiles.ts";
import { reportingFixtureAuth, usageFixture } from "./fixtures/reporting.ts";
import { profileFixture } from "./fixtures/profiles.ts";
const target = "https://stats.example/v1/admin/profiles?from=2026-10-01&until=2026-10-28";
test("profile overlap is authenticated, bounded, and excludes raw identities", async () => {
  let calls = 0;
  const handler = createReportingHandler(
    () => ({
      usage: async (q) => usageFixture(q),
      profiles: async (q) => {
        calls++;
        return {
          ...profileFixture(q),
          profile_id: "secret",
          combinations: profileFixture(q).combinations.map((row) => ({
            ...row,
            profile_ids: ["secret"],
          })),
        };
      },
    }),
    reportingFixtureAuth(),
  );
  assert.equal((await handler(new Request(target))).status, 401);
  assert.equal(calls, 0);
  const response = await handler(
    new Request(target, { headers: { cookie: "reporting-fixture=active" } }),
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control")!, /private.*no-store/);
  assert.ok(!JSON.stringify(await response.json()).includes("secret"));
  for (const suffix of ["&profile=x", "&tool=dalo", "&mode=ci", "&from=2026-10-02"])
    assert.throws(() => profileQuery(new URL(target + suffix)));
  assert.throws(() =>
    profileQuery(new URL("https://example.test/?from=2026-01-01&until=2026-10-01")),
  );
  const query = profileQuery(new URL(target)),
    fixture = profileFixture(query);
  assert.throws(() =>
    checkedProfiles({ ...fixture, totals: { ...fixture.totals, profiles: "31" } }, query),
  );
  assert.throws(() =>
    checkedProfiles(
      { ...fixture, combinations: [{ tools: ["palamedes", "dalo"], profiles: "30" }] },
      query,
    ),
  );
});
test("profile linking has a separate strict permission scope and cannot send a profile in an ordinary receipt", async () => {
  const id = "a".repeat(64),
    profile = "b".repeat(64),
    token = "c".repeat(64),
    at = Date.now();
  let calls = 0;
  const handler = createProfileHandler({
    async setProfileLink(tool, received, hash, enabled, changed, receivedProfile, profileHash) {
      calls++;
      assert.equal(tool, "dalo");
      assert.equal(received, id);
      assert.notEqual(hash, token);
      assert.notEqual(profileHash, token);
      return {
        result: { status: "updated", enabled, changed_at: changed, profile_id: receivedProfile },
      };
    },
    async resetProfile() {
      calls++;
      return { result: { status: "deleted" } };
    },
  });
  const body = {
    schema_version: 1,
    revision: PROFILE_REVISION,
    enabled: true,
    changed_at: at,
    profile_id: profile,
    profile_token: token,
  };
  const request = (payload: unknown = body, extra: Record<string, string> = {}) =>
    new Request(`https://api.example/v1/profile-links/events/${id}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "App-Tracking-Tool": "dalo",
        ...extra,
      },
      body: typeof payload === "string" ? payload : JSON.stringify(payload),
    });
  assert.equal((await handler(request(body, { Cookie: "ambient" }))).status, 400);
  assert.equal((await handler(request({ ...body, enabled: false }))).status, 400);
  assert.equal((await handler(request({ ...body, revision: "telemetry-v1" }))).status, 400);
  assert.equal((await handler(request('{"enabled":true,"enabled":false}'))).status, 400);
  assert.equal(calls, 0);
  const response = await handler(request());
  assert.equal(response.status, 200);
  const { profile_token: _, ...expected } = body;
  assert.deepEqual(await response.json(), expected);
  const reset = await handler(
    new Request(`https://api.example/v1/shared-profiles/${profile}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
  assert.equal(
    (
      await handler(
        new Request(`https://api.example/v1/shared-profiles/${profile}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
          body: "not-empty",
        }),
      )
    ).status,
    400,
  );
  assert.equal(reset.status, 200);
  assert.deepEqual(await reset.json(), {
    schema_version: 1,
    revision: PROFILE_REVISION,
    profile_id: profile,
    status: "deleted",
  });
});

test("the runtime profile switch blocks new grants while withdrawal remains available", async () => {
  let calls = 0;
  const handler = createProfileHandler(
    {
      async setProfileLink(_tool, _id, _hash, enabled, changed_at, profile_id) {
        calls++;
        return { result: { status: "updated", enabled, changed_at, profile_id } };
      },
      async resetProfile() {
        throw new Error("not used");
      },
    },
    false,
  );
  const send = (enabled: boolean) =>
    handler(
      new Request("https://api.example/v1/profile-links/events/" + "a".repeat(64), {
        method: "PUT",
        headers: {
          "App-Tracking-Tool": "dalo",
          Authorization: "Bearer " + "b".repeat(64),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          schema_version: 1,
          revision: PROFILE_REVISION,
          enabled,
          changed_at: Date.now(),
          profile_id: enabled ? "c".repeat(64) : null,
          profile_token: enabled ? "d".repeat(64) : null,
        }),
      }),
    );
  assert.equal((await send(true)).status, 404);
  assert.equal(calls, 0);
  assert.equal((await send(false)).status, 200);
  assert.equal(calls, 1);
});
