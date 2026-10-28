import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { psql, quote as q } from "../../scripts/storage/psql.ts";
import { createProfileHandler, PROFILE_REVISION } from "../../src/telemetry/profiles.ts";
import { checkedProfiles } from "../../src/reporting/profiles.ts";
import { sha256 } from "../../src/telemetry/contract.ts";

export async function profileIntegration(admin: string, runtime: string, reporter: string) {
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(admin).hostname))
    throw new Error("Profiles require disposable local fixtures");
  const sql = (text: string) => psql(admin, text);
  assert.equal(await sql("SELECT count(*) FROM app_tracking.shared_profiles_v1"), "0");
  assert.equal(
    await sql("SELECT enabled FROM app_tracking.profile_policy_v1 WHERE singleton"),
    "f",
  );
  const identities = ["dalo", "palamedes"].map((tool) => ({
    tool,
    id: randomBytes(32).toString("hex"),
    token: randomBytes(32).toString("hex"),
  }));
  const secondaryProfile = randomBytes(32).toString("hex");
  const capacityProfile = randomBytes(32).toString("hex");
  const capacityIds = Array.from({ length: 33 }, () => randomBytes(32).toString("hex"));
  const profileId = randomBytes(32).toString("hex"),
    profileToken = randomBytes(32).toString("hex");
  const execute = (text: string) =>
    psql(runtime, text).then((text) => ({ result: JSON.parse(text) }));
  const nullable = (value: string | null) => (value === null ? "NULL" : q(value));
  const handler = createProfileHandler({
    setProfileLink: (tool, id, token, enabled, at, profile, profileHash) =>
      execute(
        `SELECT app_tracking.set_profile_link_v1(${q(tool)},${q(id)},${q(token)},${enabled},${at},${nullable(profile)},${nullable(profileHash)})`,
      ),
    resetProfile: (id, token) =>
      execute(`SELECT app_tracking.reset_profile_v1(${q(id)},${q(token)})`),
  });
  const changedAt = Date.now() - 1000;
  const link = (index: number, enabled = true, at = changedAt, token = identities[index]!.token) =>
    handler(
      new Request(`https://api.example/v1/profile-links/events/${identities[index]!.id}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "App-Tracking-Tool": identities[index]!.tool,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          schema_version: 1,
          revision: PROFILE_REVISION,
          enabled,
          changed_at: at,
          profile_id: enabled ? profileId : null,
          profile_token: enabled ? profileToken : null,
        }),
      }),
    );
  const reset = (token = profileToken) =>
    handler(
      new Request(`https://api.example/v1/shared-profiles/${profileId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
  const from = await sql("SELECT (CURRENT_DATE-1)::text"),
    until = await sql("SELECT (CURRENT_DATE+1)::text"),
    query = { from, until };
  const view = async () =>
    checkedProfiles(
      JSON.parse(
        await psql(reporter, `SELECT app_tracking.admin_profiles_v1(${q(from)},${q(until)})`),
      ),
      query,
    );
  const simulateEarlierAcknowledgement = () =>
    sql(
      `UPDATE app_tracking.profile_links_v1 SET eligible_from=CURRENT_DATE-1 WHERE installation_id IN (${identities.map((i) => q(i.id)).join(",")})`,
    );
  try {
    for (const identity of identities) {
      await sql(`INSERT INTO app_tracking.event_installations_v1(tool_id,installation_id,token_hash,consented_at,mode) VALUES(${q(identity.tool)},${q(identity.id)},${q(await sha256(identity.token))},${changedAt - 86400000},'local');
        INSERT INTO app_tracking.event_batches_v1(tool_id,batch_id,content_hash,collection,installation_id,mode) VALUES(${q(identity.tool)},${q(identity.id)},repeat('a',64),'opt_in',${q(identity.id)},'local');
        INSERT INTO app_tracking.event_counts_v1 VALUES(${q(identity.tool)},${q(identity.id)},1,CURRENT_DATE-date '1970-01-01'-1,'cli.invocation','1.0.0','{"command":"other"}',NULL,1,repeat('b',64),1);`);
    }
    assert.equal((await link(0)).status, 404);
    assert.equal((await view()).enabled, false);
    await assert.rejects(sql("SELECT app_tracking.configure_profiles_v1(true,'')"));
    await sql("SELECT app_tracking.configure_profiles_v1(true,'synthetic-profile-review')");
    assert.equal((await link(0)).status, 200);
    assert.equal((await link(1)).status, 200);
    assert.equal((await view()).totals.profiles, "0"); // Client timestamps never make earlier observations eligible.
    assert.equal(
      await sql("SELECT bool_and(eligible_from=CURRENT_DATE+1) FROM app_tracking.profile_links_v1"),
      "t",
    );
    await simulateEarlierAcknowledgement();
    let value = await view();
    assert.deepEqual(value.totals, { profiles: "1", installations: "2", projects: "1" });
    assert.deepEqual(value.combinations, [{ tools: ["dalo", "palamedes"], profiles: "1" }]);
    for (const secret of [
      profileId,
      profileToken,
      ...identities.flatMap((identity) => [identity.id, identity.token]),
    ])
      assert.ok(!JSON.stringify(value).includes(secret));
    assert.equal((await link(1, true, changedAt, identities[0]!.token)).status, 401);
    assert.equal((await reset(identities[0]!.token)).status, 401);
    const denied = JSON.parse(
      await psql(
        runtime,
        `SELECT app_tracking.delete_events_v1('palamedes',${q(identities[1]!.id)},${q(await sha256(profileToken))})`,
      ),
    );
    assert.equal(denied.error, "unauthorized");
    assert.equal((await link(0, false, changedAt + 1)).status, 200);
    value = await view();
    assert.deepEqual(value.totals, { profiles: "1", installations: "1", projects: "1" });
    assert.deepEqual(value.combinations, [{ tools: ["palamedes"], profiles: "1" }]);
    assert.equal((await link(0, true, changedAt)).status, 409);
    assert.equal((await link(0, false, changedAt + 1)).status, 200);
    assert.equal(
      await sql(
        `SELECT count(*) FROM app_tracking.event_counts_v1 WHERE batch_id IN (${identities.map((i) => q(i.id)).join(",")})`,
      ),
      "2",
    );
    assert.equal((await link(0, true, changedAt + 2)).status, 200);
    assert.equal((await view()).totals.installations, "1"); // Renewal starts from its own acknowledgement.
    await simulateEarlierAcknowledgement();
    assert.equal((await view()).totals.installations, "2");
    assert.equal((await reset()).status, 200);
    const revokedAt = await sql(
      `SELECT revoked_at FROM app_tracking.shared_profiles_v1 WHERE profile_id=${q(profileId)}`,
    );
    assert.equal((await reset()).status, 200);
    assert.equal(
      await sql(
        `SELECT revoked_at FROM app_tracking.shared_profiles_v1 WHERE profile_id=${q(profileId)}`,
      ),
      revokedAt,
    );
    assert.equal((await view()).totals.profiles, "0");
    assert.equal((await link(1, true, Date.now())).status, 410);
    assert.equal(
      await sql(
        `SELECT count(*) FROM app_tracking.event_counts_v1 WHERE batch_id IN (${identities.map((i) => q(i.id)).join(",")})`,
      ),
      "2",
    );
    await sql(
      `UPDATE app_tracking.shared_profiles_v1 SET revoked_at=clock_timestamp()-interval '90 days' WHERE profile_id=${q(profileId)}`,
    );
    await sql("SELECT app_tracking.maintain_profiles_v1()");
    assert.equal(
      await sql(
        `SELECT count(*) FROM app_tracking.shared_profiles_v1 WHERE profile_id=${q(profileId)}`,
      ),
      "0",
    );
    // A stale affirmative request cannot recreate a profile after tombstone expiry.
    assert.equal((await link(1, true, Date.now() - 91 * 86400000)).status, 409);
    // Reconsented fresh profile: deleting one ordinary identity leaves the other tool linked.
    const renewedAt = Date.now() + 10;
    const secondaryHash = await sha256(
      `app-tracking-profile-v1\n${secondaryProfile}\n${profileToken}`,
    );
    for (const identity of identities) {
      assert.equal(
        JSON.parse(
          await psql(
            runtime,
            `SELECT app_tracking.set_profile_link_v1(${q(identity.tool)},${q(identity.id)},${q(await sha256(identity.token))},true,${renewedAt},${q(secondaryProfile)},${q(secondaryHash)})`,
          ),
        ).status,
        "updated",
      );
    }
    await simulateEarlierAcknowledgement();
    assert.equal((await view()).totals.installations, "2");
    await psql(
      runtime,
      `SELECT app_tracking.delete_events_v1('dalo',${q(identities[0]!.id)},${q(await sha256(identities[0]!.token))})`,
    );
    assert.deepEqual((await view()).combinations, [{ tools: ["palamedes"], profiles: "1" }]);
    assert.equal(
      await sql(
        `SELECT count(*) FROM app_tracking.profile_links_v1 WHERE installation_id=${q(identities[0]!.id)}`,
      ),
      "0",
    );
    // Logical identity expiry excludes overlap before physical cleanup.
    await sql(
      `UPDATE app_tracking.event_installations_v1 SET last_activity_at=clock_timestamp()-interval '90 days' WHERE installation_id=${q(identities[1]!.id)}`,
    );
    assert.equal((await view()).totals.profiles, "0");
    await psql(
      runtime,
      `SELECT app_tracking.delete_events_v1('palamedes',${q(identities[1]!.id)},${q(await sha256(identities[1]!.token))})`,
    );
    await sql(
      `UPDATE app_tracking.shared_profiles_v1 SET changed_at=clock_timestamp()-interval '90 days' WHERE profile_id=${q(secondaryProfile)}`,
    );
    await sql("SELECT app_tracking.maintain_profiles_v1()");
    assert.equal(
      await sql(
        `SELECT count(*) FROM app_tracking.shared_profiles_v1 WHERE profile_id=${q(secondaryProfile)}`,
      ),
      "0",
    );
    // A profile reset has a fixed upper bound, even for copied state or many installations.
    const capacityHash = await sha256(
      `app-tracking-profile-v1\n${capacityProfile}\n${profileToken}`,
    );
    for (const [index, id] of capacityIds.entries()) {
      await sql(
        `INSERT INTO app_tracking.event_installations_v1(tool_id,installation_id,token_hash,consented_at,mode) VALUES('ferriki',${q(id)},${q(await sha256(profileToken))},${changedAt},'local')`,
      );
      const response = JSON.parse(
        await psql(
          runtime,
          `SELECT app_tracking.set_profile_link_v1('ferriki',${q(id)},${q(await sha256(profileToken))},true,${changedAt},${q(capacityProfile)},${q(capacityHash)})`,
        ),
      );
      assert.equal(
        index < 32 ? response.status : response.error,
        index < 32 ? "updated" : "count_limit",
      );
    }
    assert.equal(
      JSON.parse(
        await psql(
          runtime,
          `SELECT app_tracking.reset_profile_v1(${q(capacityProfile)},${q(capacityHash)})`,
        ),
      ).status,
      "deleted",
    );
    assert.equal(
      await sql(
        `SELECT count(*) FROM app_tracking.profile_links_v1 WHERE profile_id=${q(capacityProfile)}`,
      ),
      "0",
    );
    for (const statement of [
      "SELECT * FROM app_tracking.shared_profiles_v1",
      "SELECT * FROM app_tracking.profile_links_v1",
      "SELECT app_tracking.maintain_profiles_v1()",
    ])
      await assert.rejects(psql(reporter, statement));
    await assert.rejects(
      psql(runtime, `SELECT app_tracking.admin_profiles_v1(${q(from)},${q(until)})`),
    );
    return {
      separate_consent: true,
      future_only: true,
      tool_credentials: true,
      period_overlap: true,
      scoped_unlink: true,
      shared_reset: true,
      source_reports_preserved: true,
      reset_expiry: true,
      bounded_reset: true,
      identity_deletion: true,
      read_time_expiry: true,
    };
  } finally {
    await sql("SELECT app_tracking.configure_profiles_v1(false,'')");
    await sql(
      `DELETE FROM app_tracking.event_batches_v1 WHERE batch_id IN (${identities.map((i) => q(i.id)).join(",")}); DELETE FROM app_tracking.event_installations_v1 WHERE installation_id IN (${identities.map((i) => q(i.id)).join(",")}); DELETE FROM app_tracking.event_installations_v1 WHERE installation_id IN (${capacityIds.map(q).join(",")}); DELETE FROM app_tracking.shared_profiles_v1 WHERE profile_id IN (${[profileId, secondaryProfile, capacityProfile].map(q).join(",")});`,
    );
  }
}
