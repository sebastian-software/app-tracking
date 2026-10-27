import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { createWorkOSAuth } from "../../src/reporting/auth.ts";

// Isolated provider fixture: the real SDK, JWT verifier, encrypted cookies and
// callback execute; only WorkOS's network responses are synthetic.
export async function workosBrowserFixture(origin: string) {
  const key = await generateKeyPair("RS256"),
    jwk = { ...(await exportJWK(key.publicKey)), kid: "browser-fixture", alg: "RS256", use: "sig" };
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== "https://api.workos.com")
      throw new Error("Unexpected fixture network destination");
    if (url.pathname === "/sso/jwks/client_fixture") return Response.json({ keys: [jwk] });
    if (url.pathname !== "/user_management/authenticate" || init?.method !== "POST")
      throw new Error("Unexpected provider fixture request");
    const now = Math.floor(Date.now() / 1000),
      accessToken = await new SignJWT({
        sub: "user_fixture",
        sid: "session_fixture",
        client_id: "client_fixture",
        org_id: "org_fixture",
        permissions: ["reporting:read"],
        auth_time: now,
        iat: now,
        exp: now + 300,
      })
        .setProtectedHeader({ alg: "RS256", kid: "browser-fixture" })
        .setIssuer("https://api.workos.com")
        .sign(key.privateKey);
    return Response.json({
      user: {
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
      },
      access_token: accessToken,
      refresh_token: "fixture-refresh",
      authentication_method: "GoogleOAuth",
    });
  };
  return {
    auth: createWorkOSAuth({
      clientId: "client_fixture",
      apiKey: "sk_fixture_key_123",
      cookiePassword: "1".repeat(64),
      organizationId: "org_fixture",
      issuer: "https://api.workos.com",
      origin,
    }),
    restore() {
      globalThis.fetch = original;
    },
  };
}
