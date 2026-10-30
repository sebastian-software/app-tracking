import assert from "node:assert/strict";
import test from "node:test";
import { configureShield, SHIELD_SETTINGS, API_WRITE_RULE } from "../scripts/shield.ts";
import { bunnyApi, type BunnyApi } from "../scripts/bunny.ts";

function fixture() {
  const state = {
    zone: undefined as Record<string, unknown> | undefined,
    rules: [] as Record<string, unknown>[],
    writes: [] as { method: string; path: string; body: unknown }[],
    botMode: null as number | null,
    ignoreWrites: false,
  };
  const api: BunnyApi = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    let result: unknown;
    if (method !== "GET") state.writes.push({ method, path, body: structuredClone(body) });
    if (method === "GET" && path.startsWith("/shield/shield-zones?")) {
      result = {
        data: [
          { shieldZoneId: 999, pullZoneId: 999, planType: 2 },
          ...(state.zone ? [state.zone] : []),
        ],
        page: { nextPage: null },
      };
    } else if (method === "POST" && path === "/shield/shield-zone") {
      const request = body as { shieldZone: object; pullZoneId: number };
      state.zone = {
        shieldZoneId: 7,
        pullZoneId: request.pullZoneId,
        rateLimitRulesLimit: 2,
        dDoSExecutionMode: 1,
        ...request.shieldZone,
      };
    } else if (method === "PATCH" && path === "/shield/shield-zone") {
      assert.equal((body as { shieldZoneId: number }).shieldZoneId, 7);
      if (!state.ignoreWrites)
        Object.assign(state.zone!, (body as { shieldZone: object }).shieldZone);
    } else if (method === "GET" && path.startsWith("/shield/rate-limits/7?")) {
      result = state.rules.length
        ? { data: state.rules, page: { nextPage: null } }
        : { data: null, page: null };
    } else if (method === "GET" && path === "/shield/shield-zone/7/bot-detection") {
      result = { data: state.botMode === null ? null : { executionMode: state.botMode } };
    } else if (method === "POST" && path === "/shield/rate-limit") {
      assert.equal((body as { shieldZoneId: number }).shieldZoneId, 7);
      state.rules.push({ id: 8, ...(body as object) });
    } else if (method === "PATCH" && path === "/shield/rate-limit/8") {
      if (!state.ignoreWrites)
        Object.assign(
          state.rules.find((rule) => rule.id === 8)!,
          body,
        );
    } else assert.fail(`Unexpected fixture operation: ${method} ${path}`);
    return structuredClone(result) as T;
  };
  return { state, api };
}

test("Shield inspection never writes; creation selects Basic and converges on the owned zone", async () => {
  const { state, api } = fixture();
  assert.deepEqual(await configureShield(api, 2), {
    configured: false,
    verified: false,
    changes: 0,
  });
  assert.equal(state.writes.length, 0);
  const created = await configureShield(api, 2, true);
  assert.equal(created.verified, true);
  assert.equal(created.changes, 2);
  assert.deepEqual(state.writes[0].body, {
    pullZoneId: 2,
    shieldZone: SHIELD_SETTINGS,
    botDetectionExecutionMode: 0,
    csamScanningMode: 0,
    antivirusScanningMode: 0,
    accessLists: {},
  });
  assert.equal((await configureShield(api, 2, true)).changes, 0);
  assert.equal(state.writes.length, 2);
  const observed = await configureShield(api, 2);
  assert.equal(observed.verified, true);
  assert.equal(observed.apiWritesPerMinutePerIp, 120);
  assert.ok(!JSON.stringify(observed).includes("shieldZoneId"));
  const methods = API_WRITE_RULE.chainedRuleConditions[0].value.split(" ");
  assert.deepEqual(methods, ["POST", "PUT"]);
});

test("Shield repairs drift without modifying foreign rate limits or retaining payload logging", async () => {
  const { state, api } = fixture();
  await configureShield(api, 2, true);
  state.zone!.requestBodyLoggingEnabled = true;
  state.zone!.wafRequestHeaderLoggingEnabled = true;
  state.rules[0].ruleConfiguration = { ...API_WRITE_RULE, requestCount: 999 };
  const foreign = { id: 9, shieldZoneId: 7, ruleName: "operator-owned", ruleConfiguration: {} };
  state.rules.push(structuredClone(foreign));
  assert.equal((await configureShield(api, 2, true)).changes, 2);
  assert.deepEqual(state.rules[1], foreign);
  assert.equal(state.zone!.requestBodyLoggingEnabled, false);
  assert.equal(state.zone!.wafRequestHeaderLoggingEnabled, false);
  assert.equal((await configureShield(api, 2, true)).changes, 0);
});

test("Shield refuses paid-plan changes, duplicate ownership, exhausted slots, and browser challenges", async () => {
  for (const scenario of ["paid", "duplicate", "full", "challenge"] as const) {
    const { state, api } = fixture();
    await configureShield(api, 2, true);
    state.writes.length = 0;
    if (scenario === "paid") state.zone!.planType = 1;
    if (scenario === "duplicate") state.rules.push({ ...state.rules[0], id: 10 });
    if (scenario === "full")
      state.rules = [1, 2].map((id) => ({
        id,
        shieldZoneId: 7,
        ruleName: `foreign-${id}`,
        ruleConfiguration: {},
      }));
    if (scenario === "challenge") state.botMode = 1;
    await assert.rejects(configureShield(api, 2, true));
    assert.equal(state.writes.length, 0, scenario);
  }
});

test("Shield requires effective read-back instead of trusting successful writes", async () => {
  const { state, api } = fixture();
  await configureShield(api, 2, true);
  state.zone!.wafEnabled = false;
  state.ignoreWrites = true;
  await assert.rejects(configureShield(api, 2, true), /did not converge/);
  state.zone!.wafEnabled = true;
  state.zone!.dDoSExecutionMode = 0;
  await assert.rejects(configureShield(api, 2, true), /did not converge/);
});

test("Bunny errors expose validation fields without provider messages, values, or credentials", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      {
        errorKey: "Validation.Error",
        message: "private account and credential details",
        errors: {
          "RuleConfiguration.TransformationTypes": ["private submitted values"],
          "account.private": ["private account details"],
        },
      },
      { status: 400 },
    ),
  );
  await assert.rejects(bunnyApi("synthetic-key")("POST", "/shield/rate-limit", {}), {
    message:
      "Bunny operation failed (400): Validation.Error, RuleConfiguration.TransformationTypes",
  });
});
