import assert from "node:assert/strict";
import test from "node:test";
import { WorkOS } from "@workos-inc/node/worker";
import { SignJWT, exportJWK, generateKeyPair, decodeJwt, type JWTPayload } from "jose";
import {
  createWorkOSAuth,
  validateWorkOSConfig,
  type WorkOSConfig,
} from "../src/reporting/auth.ts";
import { createReportingHandler } from "../src/reporting/handler.ts";

const config: WorkOSConfig = {
  clientId: "client_fixture",
  apiKey: "sk_fixture_key_123",
  cookiePassword: "1".repeat(64),
  organizationId: "org_fixture",
  issuer: "https://api.workos.com",
  origin: "https://stats.example.test",
};
const keys = await generateKeyPair("RS256"),
  other = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256", use: "sig" };
const user = {
  object: "user",
  id: "user_fixture",
  email: "maintainer@example.test",
  email_verified: true,
  profile_picture_url: null,
  first_name: null,
  last_name: null,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  metadata: {},
};
async function token(overrides: JWTPayload = {}, key = keys.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: "user_fixture",
    sid: "session_fixture",
    client_id: config.clientId,
    org_id: config.organizationId,
    permissions: ["reporting:read"],
    auth_time: now - 30,
    iat: now,
    exp: now + 300,
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(typeof overrides.iss === "string" ? overrides.iss : config.issuer)
    .sign(key);
}
const request = (path: string, session?: string, options: RequestInit = {}) => {
  const headers = new Headers(options.headers);
  if (session) headers.set("cookie", session);
  return new Request(config.origin + path, { ...options, headers });
};
const pair = (setCookie: string) => setCookie.split(";")[0]!;

async function fixture(
  run: (value: {
    auth: ReturnType<typeof createWorkOSAuth>;
    seal: (jwt: string, overrides?: Record<string, unknown>) => Promise<string>;
    calls: { path: string; body: Record<string, unknown> }[];
    setFailure: (kind: "jwks" | "refresh" | "stall" | undefined) => void;
    setRefreshClaims: (claims: JWTPayload) => void;
  }) => Promise<void>,
) {
  const original = globalThis.fetch,
    calls: { path: string; body: Record<string, unknown> }[] = [];
  let responseToken = await token(),
    failure: string | undefined,
    responseOverrides: Record<string, unknown> = {},
    refreshClaims: JWTPayload = {};
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.workos.com");
    if (url.pathname === "/sso/jwks/" + config.clientId) {
      if (failure === "jwks") return new Response("unavailable", { status: 503 });
      return Response.json({ keys: [jwk] });
    }
    assert.equal(url.pathname, "/user_management/authenticate");
    const body = JSON.parse(String(init?.body));
    calls.push({ path: url.pathname, body });
    assert.equal(body.client_id, config.clientId);
    assert.equal(body.client_secret, config.apiKey);
    if (body.grant_type === "refresh_token") {
      if (failure === "stall")
        return new Promise<Response>((_resolve, reject) =>
          init!.signal!.addEventListener(
            "abort",
            () => reject(new DOMException("fixture abort", "AbortError")),
            { once: true },
          ),
        );
      if (failure === "refresh")
        return Response.json(
          { error: "temporarily_unavailable", message: "private fixture" },
          { status: 503 },
        );
      const previous = decodeJwt(responseToken);
      responseToken = await token({
        auth_time: previous.auth_time,
        sid: previous.sid,
        ...refreshClaims,
      });
    }
    return Response.json({
      user,
      access_token: responseToken,
      refresh_token: "fixture-refresh",
      authentication_method: "GoogleOAuth",
      ...responseOverrides,
    });
  };
  try {
    const auth = createWorkOSAuth(config),
      sdk = new WorkOS(config.apiKey, { clientId: config.clientId, maxRetries: 0 });
    await run({
      auth,
      calls,
      setFailure: (kind) => (failure = kind),
      setRefreshClaims: (claims) => {
        refreshClaims = claims;
      },
      async seal(jwt, overrides = {}) {
        responseToken = jwt;
        responseOverrides = overrides;
        const result = await sdk.userManagement.authenticateWithCode({
          clientId: config.clientId,
          code: "fixture-code",
          session: { sealSession: true, cookiePassword: config.cookiePassword },
        });
        assert.ok(result.sealedSession);
        return "__Host-app-tracking-session=" + encodeURIComponent(result.sealedSession);
      },
    });
  } finally {
    globalThis.fetch = original;
  }
}

test("WorkOS callback binds encrypted state, cookie and PKCE before exchanging the code", async () =>
  fixture(async ({ auth, calls }) => {
    const start = await auth.route(request("/admin/login"));
    assert.equal(start?.status, 303);
    const url = new URL(start!.headers.get("location")!);
    assert.equal(url.origin, "https://api.workos.com");
    assert.equal(url.searchParams.get("organization_id"), config.organizationId);
    assert.equal(url.searchParams.get("redirect_uri"), config.origin + "/admin/callback");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    const pending = start!.headers.getSetCookie()[0]!;
    for (const flag of ["Secure", "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=600"])
      assert.ok(pending.includes(flag));
    const callback = "/admin/callback?code=fixture-code&state=" + url.searchParams.get("state");
    await auth.route(request(callback));
    assert.equal(calls.length, 0);
    await auth.route(request(callback.replace(/state=.*/, "state=wrong"), pair(pending)));
    assert.equal(calls.length, 0);
    const completed = await auth.route(request(callback, pair(pending)));
    assert.equal(completed?.headers.get("location"), "/admin");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.body.grant_type, "authorization_code");
    const verifier = String(calls[0]!.body.code_verifier),
      digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    assert.equal(Buffer.from(digest).toString("base64url"), url.searchParams.get("code_challenge"));
    const cookies = completed!.headers.getSetCookie();
    assert.equal(cookies.length, 2);
    const session = cookies.find((value) => value.startsWith("__Host-app-tracking-session="))!;
    assert.ok(session.includes("Secure") && session.includes("HttpOnly"));
    assert.ok(!session.includes("fixture-refresh") && !session.includes(user.email));
    assert.ok("headers" in (await auth.check(request("/v1/admin/usage", pair(session)))));
    assert.match(completed!.headers.get("cache-control")!, /no-store/);
  }));

test("WorkOS authorization rejects old keys, absent/corrupt cookies, wrong org, permission, client, issuer, token type, and signature", async () =>
  fixture(async ({ auth, seal }) => {
    for (const headers of [
      {},
      { authorization: "Bearer " + "a".repeat(64) },
      { authorization: "Bearer at_admin_v1_" + "a".repeat(64) },
      { cookie: "__Host-app-tracking-session=corrupt" },
    ]) {
      const result = await auth.check(
        request("/v1/admin/usage", undefined, { headers: headers as Record<string, string> }),
      );
      assert.ok("response" in result);
      assert.equal(result.response.status, 401);
    }
    for (const [claims, status] of [
      [{ org_id: "org_other" }, 403],
      [{ permissions: [] }, 403],
      [{ client_id: "client_other" }, 401],
      [{ iss: "https://other.example.test" }, 401],
      [{ aud: "other" }, 401],
      [{ sub_type: "widget" }, 401],
      [{ sub_profile: "agent" }, 401],
      [{ act: { sub: "someone" } }, 401],
      [{ auth_time: Math.floor(Date.now() / 1000) - 604801 }, 401],
    ] as const) {
      const result = await auth.check(request("/v1/admin/usage", await seal(await token(claims))));
      assert.ok("response" in result);
      assert.equal(result.response.status, status);
    }
    const invalid = await auth.check(
      request("/v1/admin/usage", await seal(await token({}, other.privateKey))),
    );
    assert.ok("response" in invalid);
    assert.equal(invalid.response.status, 401);
  }));

test("callback diagnostics expose only a fixed phase and failure label", async () => {
  for (const [claims, expected] of [
    [{ iss: "https://api.workos.com/" }, "verify:issuer_api_trailing_slash"],
    [{ auth_time: undefined }, "verify:missing_auth_time"],
  ] as const)
    await fixture(async ({ auth, seal }) => {
      await seal(await token(claims));
      const start = await auth.route(request("/admin/login")),
        state = new URL(start!.headers.get("location")!).searchParams.get("state"),
        completed = await auth.route(
          request(
            "/admin/callback?code=fixture-code&state=" + state,
            pair(start!.headers.getSetCookie()[0]!),
          ),
        );
      assert.equal(completed!.headers.get("location"), "/admin?auth=failed");
      assert.equal(completed!.headers.get("x-app-tracking-login-failure"), expected);
    });
});

test("expired signed sessions refresh once, persist the rotated encrypted cookie, and recheck permissions", async () =>
  fixture(async ({ auth, seal, calls }) => {
    const now = Math.floor(Date.now() / 1000),
      session = await seal(await token({ iat: now - 600, exp: now - 300 }));
    calls.length = 0;
    const result = await auth.check(request("/v1/admin/usage", session));
    assert.ok("headers" in result);
    assert.equal(result.headers.getSetCookie().length, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.body.grant_type, "refresh_token");
    assert.ok(
      "headers" in
        (await auth.check(request("/v1/admin/usage", pair(result.headers.getSetCookie()[0]!)))),
    );
  }));

test("temporary WorkOS/JWKS failures return 503 without clearing the existing session", async () => {
  for (const failure of ["jwks", "refresh"] as const)
    await fixture(async ({ auth, seal, setFailure }) => {
      const now = Math.floor(Date.now() / 1000),
        session = await seal(
          await token(failure === "refresh" ? { iat: now - 600, exp: now - 300 } : {}),
        );
      setFailure(failure);
      const result = await auth.check(request("/v1/admin/usage", session));
      assert.ok("response" in result);
      assert.equal(result.response.status, 503);
      assert.deepEqual(await result.response.json(), { error: "service_unavailable" });
      assert.equal(result.response.headers.getSetCookie().length, 0);
    });
});

test("a refreshed cookie is preserved when the authorized statistics query fails", async () =>
  fixture(async ({ auth, seal }) => {
    const now = Math.floor(Date.now() / 1000),
      session = await seal(await token({ iat: now - 600, exp: now - 300 }));
    const handler = createReportingHandler(
      () => ({
        async usage() {
          throw new Error("private database fixture");
        },
      }),
      auth,
    );
    const response = await handler(
      request("/v1/admin/usage?from=2026-10-01&until=2026-10-28", session),
    );
    assert.equal(response.status, 503);
    assert.equal(response.headers.getSetCookie().length, 1);
    assert.deepEqual(await response.json(), { error: "service_unavailable" });
  }));

test("an authorized session remains usable after six days without extending its seven-day limit", async () =>
  fixture(async ({ auth, seal }) => {
    const now = Math.floor(Date.now() / 1000),
      session = await seal(await token({ auth_time: now - 6 * 24 * 60 * 60 }));
    const result = await auth.check(request("/v1/admin/usage", session));
    assert.ok("headers" in result);
    assert.equal(result.headers.getSetCookie().length, 0);
  }));

test("refresh cannot revive a seven-day session, retain revoked access, or change its authentication time", async () => {
  await fixture(async ({ auth, seal, calls }) => {
    const now = Math.floor(Date.now() / 1000),
      session = await seal(
        await token({ iat: now - 600, exp: now - 300, auth_time: now - 604801 }),
      );
    calls.length = 0;
    const result = await auth.check(request("/v1/admin/usage", session));
    assert.ok("response" in result);
    assert.equal(result.response.status, 401);
    assert.equal(calls.length, 0);
  });
  for (const [claims, status] of [
    [{ permissions: [] }, 403],
    [{ auth_time: Math.floor(Date.now() / 1000) }, 401],
  ] as const)
    await fixture(async ({ auth, seal, setRefreshClaims }) => {
      const now = Math.floor(Date.now() / 1000),
        session = await seal(await token({ iat: now - 600, exp: now - 300, auth_time: now - 60 }));
      setRefreshClaims(claims);
      const result = await auth.check(request("/v1/admin/usage", session));
      assert.ok("response" in result);
      assert.equal(result.response.status, status);
      assert.equal(result.response.headers.getSetCookie().length, 0);
    });
});

test(
  "the worker SDK's effective five-second deadline bounds stalled refresh without retry",
  { timeout: 12000 },
  async () =>
    fixture(async ({ auth, seal, calls, setFailure }) => {
      const now = Math.floor(Date.now() / 1000),
        session = await seal(await token({ iat: now - 600, exp: now - 300 }));
      calls.length = 0;
      setFailure("stall");
      const start = performance.now(),
        result = await auth.check(request("/v1/admin/usage", session));
      assert.ok("response" in result);
      assert.equal(result.response.status, 503);
      assert.equal(calls.length, 1);
      assert.ok(performance.now() - start < 10000);
      assert.equal(result.response.headers.getSetCookie().length, 0);
    }),
);

test("unverified or impersonated accounts and cross-origin cookie requests are denied", async () =>
  fixture(async ({ auth, seal }) => {
    for (const override of [
      { user: { ...user, email_verified: false } },
      { impersonator: { email: "support@example.test", reason: "fixture" } },
    ]) {
      const result = await auth.check(
        request("/v1/admin/usage", await seal(await token(), override)),
      );
      assert.ok("response" in result);
      assert.equal(result.response.status, 403);
    }
    const result = await auth.check(
      request("/v1/admin/usage", await seal(await token()), {
        headers: { origin: "https://other.example.test" },
      }),
    );
    assert.ok("response" in result);
    assert.equal(result.response.status, 403);
  }));

test("logout requires same-origin POST and clears cookies before redirecting to the fixed WorkOS logout", async () =>
  fixture(async ({ auth, seal }) => {
    const session = await seal(await token());
    assert.equal((await auth.route(request("/admin/logout", session)))?.status, 405);
    assert.equal(
      (
        await auth.route(
          request("/admin/logout", session, {
            method: "POST",
            headers: { origin: "https://other.example.test", "x-app-tracking-action": "logout" },
          }),
        )
      )?.status,
      403,
    );
    const response = await auth.route(
      request("/admin/logout", session, {
        method: "POST",
        headers: { origin: config.origin, "x-app-tracking-action": "logout" },
      }),
    );
    assert.equal(response?.status, 200);
    assert.equal(response!.headers.getSetCookie().length, 2);
    assert.ok(response!.headers.getSetCookie().every((value) => value.includes("Max-Age=0")));
    const location = new URL((await response!.json()).location);
    assert.equal(location.origin, "https://api.workos.com");
    assert.equal(location.searchParams.get("return_to"), config.origin + "/admin");
  }));

test("reporting auth configuration fails closed", () => {
  for (const patch of [
    { origin: "https://other.example.test/path" },
    { origin: "http://other.example.test" },
    { cookiePassword: "short" },
    { issuer: "http://api.workos.com" },
    { organizationId: "" },
    { clientId: "../other" },
  ])
    assert.throws(() => validateWorkOSConfig({ ...config, ...patch }));
});
