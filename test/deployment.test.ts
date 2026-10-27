import assert from "node:assert/strict";
import test from "node:test";
import { provision, SETTINGS } from "../scripts/provision.ts";
import { publish } from "../scripts/release.ts";
import type { BunnyApi } from "../scripts/bunny.ts";

test("provisioning converges twice without duplicating or rewriting resources", async () => {
  let created = false;
  let writes = 0;
  const zone: Record<string, unknown> = { EdgeRules: [], DisableCookies: true };
  const script = {
    Id: 1,
    Name: "app-tracking",
    LinkedPullZones: [{ Id: 2, PullZoneName: "isolated-zone" }],
  };
  const api: BunnyApi = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    let result: unknown;
    if (method === "GET" && path.startsWith("/compute/script?"))
      result = { Items: created ? [script] : [] };
    else if (method === "POST" && path === "/compute/script") {
      created = true;
      writes++;
      result = script;
    } else if (method === "GET" && path === "/compute/script/1") result = script;
    else if (method === "GET" && path === "/pullzone/2") result = zone;
    else if (method === "POST" && path === "/pullzone/2") {
      writes++;
      Object.assign(zone, body);
    } else assert.fail("Unexpected operation");
    return result as T;
  };
  assert.equal((await provision(api, "app-tracking", "isolated-zone")).changes, 2);
  assert.equal((await provision(api, "app-tracking", "isolated-zone")).changes, 0);
  assert.equal(writes, 2);
  assert.equal(zone.DisableCookies, false);
  assert.deepEqual(Object.fromEntries(Object.keys(SETTINGS).map((k) => [k, zone[k]])), SETTINGS);
  zone.EdgeRules = [{ Description: "foreign TTL override" }];
  await assert.rejects(provision(api, "app-tracking", "isolated-zone"), /Unexpected edge rules/);
});

test("publication orders upload, publish and purge; a failed publish does not purge", async () => {
  const calls: string[] = [];
  let failing = false;
  const api: BunnyApi = async <T>(_method: string, path: string): Promise<T> => {
    calls.push(path);
    if (failing && path.endsWith("/publish")) throw new Error("unavailable");
    return undefined as T;
  };
  const target = { scriptId: 1, zoneId: 2, base: "https://example.com" };
  await publish(api, target, "synthetic bundle", "a".repeat(40));
  assert.deepEqual(calls, [
    "/compute/script/1/code",
    "/compute/script/1/publish",
    "/pullzone/2/purgeCache",
  ]);
  calls.length = 0;
  failing = true;
  await assert.rejects(publish(api, target, "synthetic bundle", "b".repeat(40)));
  assert.equal(calls.length, 2);
  await assert.rejects(publish(api, target, "synthetic bundle", "invalid"));
});

test("deployment probe rejects a stale revision and uncached private-route violations", async () => {
  const { verifyDeployment } = await import("../scripts/verify-deployment.ts");
  const revision = "a".repeat(40);
  const fake: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers({ "X-App-Revision": revision, "Cache-Control": "no-store" });
    if (url.pathname === "/health") return Response.json({ status: "ok" }, { headers });
    if (url.pathname.startsWith("/v1/versions/")) {
      if (url.search || String(input).endsWith("?"))
        return Response.json({ error: { code: "invalid_request" } }, { status: 400, headers });
      headers.set("ETag", '"synthetic"');
      headers.set("CDN-Cache", "HIT");
      if (new Headers(init?.headers).has("if-none-match"))
        return new Response(null, { status: 304, headers });
      const parts = url.pathname.split("/");
      return Response.json(
        {
          tool_id: parts[3],
          distribution: parts[4],
          stale: false,
          checked_at: new Date().toISOString(),
        },
        { headers },
      );
    }
    return new Response(null, { status: 404, headers });
  };
  await verifyDeployment("https://example.com", revision, fake);
  const reporting: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/admin/login" || path === "/admin/logout") {
      const headers = new Headers({
        "X-App-Revision": revision,
        "Cache-Control": "private, no-store",
      });
      if (path === "/admin/login") {
        assert.equal(init?.redirect, "manual");
        headers.set("Location", "https://api.workos.com/user_management/authorize");
        headers.append(
          "Set-Cookie",
          "__Host-app-tracking-login=fixture; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600",
        );
        return new Response(null, { status: 303, headers });
      }
      assert.equal(init?.method, "POST");
      for (const name of ["login", "session"])
        headers.append(
          "Set-Cookie",
          `__Host-app-tracking-${name}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
        );
      return Response.json({ location: "https://example.com/admin" }, { headers });
    }
    if (path === "/admin" || path === "/v1/admin/usage")
      return new Response(null, {
        status: path === "/admin" ? 200 : 401,
        headers: { "X-App-Revision": revision, "Cache-Control": "private, no-store" },
      });
    return fake(input, init);
  };
  await verifyDeployment("https://example.com", revision, reporting, false, true);
  const strippedCookies: typeof fetch = async (input, init) => {
    const response = await reporting(input, init);
    response.headers.delete("set-cookie");
    return response;
  };
  await assert.rejects(
    verifyDeployment("https://example.com", revision, strippedCookies, false, true),
    /secure login cookie/,
  );
  const combinedLogoutCookies: typeof fetch = async (input, init) => {
    const response = await reporting(input, init);
    if (new URL(String(input)).pathname === "/admin/logout")
      response.headers.set("set-cookie", response.headers.getSetCookie().join(", "));
    return response;
  };
  await assert.rejects(
    verifyDeployment("https://example.com", revision, combinedLogoutCookies, false, true),
    /session-cookie deletion headers/,
  );
  const cachedReporting: typeof fetch = async (input, init) => {
    const response = await reporting(input, init);
    if (new URL(String(input)).pathname === "/v1/admin/usage")
      response.headers.set("CDN-Cache", "HIT");
    return response;
  };
  await assert.rejects(
    verifyDeployment("https://example.com", revision, cachedReporting, false, true),
  );
  await assert.rejects(
    verifyDeployment("https://example.com", "b".repeat(40), fake),
    /Unexpected deployed revision/,
  );
  const privateCache: typeof fetch = async (input, init) => {
    const response = await fake(input, init);
    if (String(input).endsWith("/health")) response.headers.set("CDN-Cache", "HIT");
    return response;
  };
  await assert.rejects(verifyDeployment("https://example.com", revision, privateCache));
  const staleSnapshot: typeof fetch = async (input, init) => {
    const response = await fake(input, init);
    if (new URL(String(input)).pathname.startsWith("/v1/versions/") && response.status === 200) {
      const data = await response.json();
      data.stale = true;
      data.checked_at = new Date(Date.now() - 7_200_000).toISOString();
      response.headers.set("cache-control", "no-store");
      response.headers.delete("cdn-cache");
      return Response.json(data, { headers: response.headers });
    }
    return response;
  };
  await verifyDeployment("https://example.com", revision, staleSnapshot);
  // Restoring an artifact predating generic events must still verify legacy
  // telemetry, rather than require endpoints that its bundle never contained.
  const legacyTelemetry: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const headers = { "X-App-Revision": revision, "Cache-Control": "no-store" };
    if (path === "/v1/usage-batches" || path.startsWith("/v1/installations/")) {
      const status = (init?.method ?? "GET") === "GET" ? 405 : 401;
      return Response.json(
        { schema_version: 1, error: { code: "unauthorized" } },
        { status, headers },
      );
    }
    return fake(input, init);
  };
  await verifyDeployment("https://example.com", revision, legacyTelemetry, true, false, false);
  await assert.rejects(
    verifyDeployment("https://example.com", revision, legacyTelemetry, true, false, true),
  );
  const cachedStale: typeof fetch = async (input, init) => {
    const response = await staleSnapshot(input, init);
    response.headers.set("cdn-cache", "HIT");
    return response;
  };
  await assert.rejects(verifyDeployment("https://example.com", revision, cachedStale));
});
