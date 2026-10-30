import assert from "node:assert/strict";
import test from "node:test";
import { configureShield, SHIELD_SETTINGS } from "../scripts/shield.ts";
import { bunnyApi, type BunnyApi } from "../scripts/bunny.ts";

function fixture() {
  const state = {
    zone: undefined as Record<string, unknown> | undefined,
    gateway: { RequestLimit: 20, BurstSize: 40, EnableLogging: false },
    writes: [] as { method: string; path: string; body: unknown }[],
    ignoreWrites: false,
    duplicate: false,
  };
  const api: BunnyApi = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    let result: unknown;
    if (method !== "GET") state.writes.push({ method, path, body: structuredClone(body) });
    if (method === "GET" && path.startsWith("/shield/shield-zones?")) {
      result = {
        data: [
          { shieldZoneId: 999, pullZoneId: 999, planType: 2 },
          ...(state.zone ? [state.zone] : []),
          ...(state.duplicate ? [state.zone] : []),
        ],
        page: { nextPage: null },
      };
    } else if (method === "POST" && path === "/shield/shield-zone") {
      const request = body as { shieldZone: object; pullZoneId: number };
      state.zone = {
        shieldZoneId: 7,
        pullZoneId: request.pullZoneId,
        dDoSExecutionMode: 1,
        ...request.shieldZone,
      };
    } else if (method === "PATCH" && path === "/shield/shield-zone") {
      assert.equal((body as { shieldZoneId: number }).shieldZoneId, 7);
      if (!state.ignoreWrites)
        Object.assign(state.zone!, (body as { shieldZone: object }).shieldZone);
    } else if (method === "GET" && path === "/pullzone/2") result = state.gateway;
    else if (method === "POST" && path === "/pullzone/2") {
      if (!state.ignoreWrites) Object.assign(state.gateway, body);
    } else assert.fail(`Unexpected fixture operation: ${method} ${path}`);
    return structuredClone(result) as T;
  };
  return { state, api };
}

test("Shield inspection never writes; Basic-only creation converges without touching another zone", async () => {
  const { state, api } = fixture();
  assert.equal((await configureShield(api, 2)).configured, false);
  assert.equal(state.writes.length, 0);
  assert.equal((await configureShield(api, 2, true)).verified, true);
  assert.deepEqual(state.writes[0].body, { pullZoneId: 2, shieldZone: SHIELD_SETTINGS });
  assert.equal((await configureShield(api, 2, true)).changes, 0);
  assert.equal(state.writes.length, 1);
  const observed = await configureShield(api, 2);
  assert.equal(observed.verified, true);
  assert.equal(observed.gatewayRequestsPerSecondPerIp, 20);
  assert.ok(!JSON.stringify(observed).includes("shieldZoneId"));
});

test("Shield repairs owned settings without requesting add-ons or changing other gateway settings", async () => {
  const { state, api } = fixture();
  await configureShield(api, 2, true);
  state.zone!.requestBodyLoggingEnabled = true;
  state.zone!.wafRequestHeaderLoggingEnabled = true;
  state.zone!.dDoSShieldSensitivity = 4;
  state.gateway.RequestLimit = 10;
  assert.equal((await configureShield(api, 2, true)).changes, 2);
  assert.equal(state.zone!.requestBodyLoggingEnabled, false);
  assert.equal(state.zone!.wafRequestHeaderLoggingEnabled, false);
  assert.equal(state.zone!.dDoSShieldSensitivity, 1);
  assert.deepEqual(state.gateway, { RequestLimit: 20, BurstSize: 40, EnableLogging: false });
  assert.equal((await configureShield(api, 2, true)).changes, 0);
});

test("Shield refuses paid-plan changes and ambiguous zone ownership", async () => {
  for (const scenario of ["paid", "duplicate"] as const) {
    const { state, api } = fixture();
    await configureShield(api, 2, true);
    state.writes.length = 0;
    if (scenario === "paid") state.zone!.planType = 1;
    else state.duplicate = true;
    await assert.rejects(configureShield(api, 2, true));
    assert.equal(state.writes.length, 0);
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
  state.zone!.dDoSExecutionMode = 1;
  state.gateway.BurstSize = 0;
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

test("Shield business errors inside HTTP 200 cannot be mistaken for applied protection", async (t) => {
  for (const field of ["error", "errorResponse"]) {
    t.mock.method(globalThis, "fetch", async () =>
      Response.json({
        [field]: { success: false, errorKey: "InvalidRule", message: "private account details" },
      }),
    );
    await assert.rejects(bunnyApi("synthetic-key")("POST", "/shield/rate-limit", {}), {
      message: "Bunny operation failed (200): InvalidRule",
    });
    t.mock.restoreAll();
  }
});
