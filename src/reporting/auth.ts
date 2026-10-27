import { WorkOS } from "@workos-inc/node/worker";
import {
  createRemoteJWKSet,
  customFetch,
  decodeJwt,
  EncryptJWT,
  jwtDecrypt,
  jwtVerify,
  errors,
  type JWTPayload,
} from "jose";
import { adminReply, privateHeaders } from "./contract.ts";

export interface WorkOSConfig {
  clientId: string;
  apiKey: string;
  cookiePassword: string;
  organizationId: string;
  issuer: string;
  origin: string;
}
export interface ReportingAuth {
  route(request: Request): Promise<Response | undefined>;
  check(request: Request): Promise<{ response: Response } | { headers: Headers }>;
}
const sessionName = "__Host-app-tracking-session",
  flowName = "__Host-app-tracking-login";
const sessionSeconds = 8 * 60 * 60;

export function validateWorkOSConfig(config: WorkOSConfig): void {
  const origin = new URL(config.origin),
    issuer = new URL(config.issuer);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  if (
    origin.origin !== config.origin ||
    (origin.protocol !== "https:" && !(local && origin.protocol === "http:")) ||
    issuer.protocol !== "https:" ||
    issuer.username ||
    issuer.password ||
    issuer.search ||
    issuer.hash ||
    issuer.pathname !== "/" ||
    !/^client_[A-Za-z0-9]{3,128}$/.test(config.clientId) ||
    !/^org_[A-Za-z0-9]{3,128}$/.test(config.organizationId) ||
    !/^sk_[A-Za-z0-9_-]{8,256}$/.test(config.apiKey) ||
    !/^[a-f0-9]{64}$/.test(config.cookiePassword)
  )
    throw new Error("WorkOS reporting configuration is invalid");
}
function cookie(request: Request, name: string): string | undefined {
  const matches = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(name + "="));
  if (matches.length !== 1) return undefined;
  try {
    const value = decodeURIComponent(matches[0]!.slice(name.length + 1));
    return value.length <= 3800 ? value : undefined;
  } catch {
    return undefined;
  }
}
function setCookie(headers: Headers, name: string, value: string, seconds: number) {
  if (value.length > 3800) throw new Error("Session exceeds the supported cookie size");
  headers.append(
    "Set-Cookie",
    `${name}=${encodeURIComponent(value)}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(seconds))}`,
  );
}
function redirect(path: string, headers = new Headers()): Response {
  for (const [key, value] of Object.entries(privateHeaders)) headers.set(key, value);
  headers.set("Location", path);
  return new Response(null, { status: 303, headers });
}

export function createWorkOSAuth(config: WorkOSConfig): ReportingAuth {
  validateWorkOSConfig(config);
  const client = new WorkOS(config.apiKey, {
    clientId: config.clientId,
    issuer: config.issuer,
    maxRetries: 0,
  });
  // The 12.0.0 worker constructor does not forward options.timeout; the public
  // HTTP client's timeout still bounds both response headers and body reads.
  if (client.client.options) client.client.options.timeout = 5000;
  const jwks = createRemoteJWKSet(new URL(client.userManagement.getJwksUrl(config.clientId)), {
    timeoutDuration: 5000,
    cooldownDuration: 30000,
    cacheMaxAge: 600000,
    [customFetch]: (input, init) => fetch(input, { ...init, redirect: "error", cache: "no-store" }),
  });
  const flowKey = crypto.subtle
    .digest(
      "SHA-256",
      new TextEncoder().encode("app-tracking-oauth-state-v1\n" + config.cookiePassword),
    )
    .then((value) => new Uint8Array(value));
  const sameSite = (request: Request) =>
    new URL(request.url).origin === config.origin &&
    (!request.headers.has("origin") || request.headers.get("origin") === config.origin) &&
    request.headers.get("sec-fetch-site") !== "cross-site";
  async function unseal(value: string | undefined) {
    if (!value) return undefined;
    try {
      return await client.userManagement.getSessionFromCookie({
        sessionData: value,
        cookiePassword: config.cookiePassword,
      });
    } catch {
      return undefined;
    }
  }
  async function claims(token: string): Promise<JWTPayload> {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: config.issuer,
      algorithms: ["RS256"],
      requiredClaims: ["sub", "sid", "exp", "iat", "auth_time", "client_id"],
      maxTokenAge: 300,
      clockTolerance: 5,
    });
    if (
      payload.client_id !== config.clientId ||
      !String(payload.sub).startsWith("user_") ||
      typeof payload.sid !== "string" ||
      !payload.sid.startsWith("session_") ||
      typeof payload.auth_time !== "number" ||
      payload.auth_time > Date.now() / 1000 + 5 ||
      payload.auth_time + sessionSeconds <= Date.now() / 1000 ||
      (payload.sub_profile !== undefined && payload.sub_profile !== "user") ||
      payload.sub_type !== undefined ||
      payload.act !== undefined ||
      (payload.aud !== undefined &&
        !(Array.isArray(payload.aud) ? payload.aud : [payload.aud]).includes(config.clientId))
    )
      throw new errors.JWTInvalid("Invalid maintainer session");
    return payload;
  }
  function permitted(
    payload: JWTPayload,
    userId: string,
    verified: boolean,
    impersonated: boolean,
  ) {
    return (
      payload.sub === userId &&
      verified &&
      !impersonated &&
      payload.org_id === config.organizationId &&
      Array.isArray(payload.permissions) &&
      payload.permissions.includes("reporting:read")
    );
  }
  const unavailable = () => adminReply({ error: "service_unavailable" }, 503);
  function authFailure(error: unknown): Response {
    if (
      error instanceof errors.JOSEError &&
      (error.code.startsWith("ERR_JWT_") ||
        error.code.startsWith("ERR_JWS_") ||
        [
          "ERR_JWKS_NO_MATCHING_KEY",
          "ERR_JWKS_MULTIPLE_MATCHING_KEYS",
          "ERR_JOSE_ALG_NOT_ALLOWED",
          "ERR_JOSE_NOT_SUPPORTED",
        ].includes(error.code))
    )
      return adminReply({ error: "unauthorized" }, 401);
    return unavailable();
  }
  return {
    async route(request) {
      const url = new URL(request.url);
      if (!["/admin/login", "/admin/callback", "/admin/logout"].includes(url.pathname))
        return undefined;
      if (url.origin !== config.origin) return adminReply({ error: "forbidden" }, 403);
      if (url.pathname === "/admin/login") {
        if (request.method !== "GET") return adminReply({ error: "method_not_allowed" }, 405);
        if (url.search) return adminReply({ error: "invalid_request" }, 400);
        try {
          const authorization = await client.userManagement.getAuthorizationUrlWithPKCE({
            provider: "authkit",
            clientId: config.clientId,
            organizationId: config.organizationId,
            redirectUri: config.origin + "/admin/callback",
            screenHint: "sign-in",
          });
          const sealed = await new EncryptJWT({
            state: authorization.state,
            verifier: authorization.codeVerifier,
          })
            .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
            .setIssuer(config.origin)
            .setAudience("app-tracking-login")
            .setIssuedAt()
            .setExpirationTime("10m")
            .encrypt(await flowKey);
          const headers = new Headers();
          setCookie(headers, flowName, sealed, 600);
          return redirect(authorization.url, headers);
        } catch {
          return unavailable();
        }
      }
      if (url.pathname === "/admin/callback") {
        if (request.method !== "GET") return adminReply({ error: "method_not_allowed" }, 405);
        const headers = new Headers();
        setCookie(headers, flowName, "", 0);
        try {
          const state = url.searchParams.get("state"),
            code = url.searchParams.get("code"),
            pending = cookie(request, flowName);
          if (
            !state ||
            !code ||
            code.length > 2048 ||
            url.search.length > 4096 ||
            !pending ||
            url.searchParams.getAll("state").length !== 1 ||
            url.searchParams.getAll("code").length !== 1
          )
            throw new Error("Invalid callback");
          const { payload } = await jwtDecrypt(pending, await flowKey, {
            issuer: config.origin,
            audience: "app-tracking-login",
            keyManagementAlgorithms: ["dir"],
            contentEncryptionAlgorithms: ["A256GCM"],
            requiredClaims: ["exp", "iat"],
          });
          if (payload.state !== state || typeof payload.verifier !== "string")
            throw new Error("Invalid callback binding");
          const result = await client.userManagement.authenticateWithCode({
            clientId: config.clientId,
            code,
            codeVerifier: payload.verifier,
            session: { sealSession: true, cookiePassword: config.cookiePassword },
          });
          const payloadClaims = await claims(result.accessToken);
          if (
            !permitted(
              payloadClaims,
              result.user.id,
              result.user.emailVerified,
              Boolean(result.impersonator),
            ) ||
            !result.sealedSession
          )
            return redirect("/admin?auth=denied", headers);
          setCookie(
            headers,
            sessionName,
            result.sealedSession,
            Number(payloadClaims.auth_time) + sessionSeconds - Date.now() / 1000,
          );
          return redirect("/admin", headers);
        } catch {
          return redirect("/admin?auth=failed", headers);
        }
      }
      if (request.method !== "POST") return adminReply({ error: "method_not_allowed" }, 405);
      if (
        !sameSite(request) ||
        request.headers.get("origin") !== config.origin ||
        request.headers.get("x-app-tracking-action") !== "logout" ||
        url.search
      )
        return adminReply({ error: "forbidden" }, 403);
      const headers = new Headers(privateHeaders);
      setCookie(headers, sessionName, "", 0);
      setCookie(headers, flowName, "", 0);
      let location = config.origin + "/admin";
      const session = await unseal(cookie(request, sessionName));
      if (session?.accessToken) {
        try {
          const decoded = decodeJwt(session.accessToken);
          if (typeof decoded.sid === "string" && /^session_[A-Za-z0-9]+$/.test(decoded.sid))
            location = client.userManagement.getLogoutUrl({
              sessionId: decoded.sid,
              returnTo: location,
            });
        } catch {
          /* Local logout still completes. */
        }
      }
      return Response.json({ location }, { headers });
    },
    async check(request) {
      if (!sameSite(request)) return { response: adminReply({ error: "forbidden" }, 403) };
      if (request.headers.has("authorization"))
        return { response: adminReply({ error: "unauthorized" }, 401) };
      const sealed = cookie(request, sessionName),
        session = await unseal(sealed);
      if (!sealed || !session?.accessToken || !session.user)
        return { response: adminReply({ error: "unauthorized" }, 401) };
      const headers = new Headers();
      try {
        let payload;
        try {
          payload = await claims(session.accessToken);
        } catch (error) {
          if (!(error instanceof errors.JWTExpired)) throw error;
          const previous = error.payload;
          if (
            typeof previous.auth_time !== "number" ||
            previous.auth_time + sessionSeconds <= Date.now() / 1000 ||
            previous.client_id !== config.clientId ||
            !permitted(
              previous,
              session.user.id,
              session.user.emailVerified,
              Boolean(session.impersonator),
            )
          )
            return { response: adminReply({ error: "unauthorized" }, 401) };
          const refreshed = await client.userManagement
            .loadSealedSession({ sessionData: sealed, cookiePassword: config.cookiePassword })
            .refresh({ organizationId: config.organizationId });
          if (!refreshed.authenticated)
            return {
              response: refreshed.retryable
                ? unavailable()
                : adminReply({ error: "unauthorized" }, 401),
            };
          if (!refreshed.session?.accessToken || !refreshed.sealedSession)
            throw new Error("Invalid refresh result");
          payload = await claims(refreshed.session.accessToken);
          if (
            payload.auth_time !== previous.auth_time ||
            payload.sub !== previous.sub ||
            payload.sid !== previous.sid
          )
            throw new errors.JWTInvalid("Refresh cannot extend or replace the original session");
          if (
            !permitted(
              payload,
              refreshed.user.id,
              refreshed.user.emailVerified,
              Boolean(refreshed.impersonator),
            )
          )
            return { response: adminReply({ error: "forbidden" }, 403) };
          setCookie(
            headers,
            sessionName,
            refreshed.sealedSession,
            Number(payload.auth_time) + sessionSeconds - Date.now() / 1000,
          );
        }
        if (
          !permitted(
            payload,
            session.user.id,
            session.user.emailVerified,
            Boolean(session.impersonator),
          )
        )
          return { response: adminReply({ error: "forbidden" }, 403) };
        return { headers };
      } catch (error) {
        return { response: authFailure(error) };
      }
    },
  };
}
