export const downloadHosts = {
  ferriki: {
    issuer: "downloads.ferriki.dev",
    cdn: "protected-assets.ferriki.dev",
  },
  ferrigura: {
    issuer: "downloads.ferrigura.dev",
    cdn: "protected-assets.ferrigura.dev",
  },
} as const;

export type DownloadTool = keyof typeof downloadHosts;
export type DownloadAsset = Readonly<{ path: string; bytes: number; sha256: string }>;

const sha256 = /^[a-f0-9]{64}$/;
const ferrikiPath = /^\/(?:themes\/)?[a-z0-9-]+\/(?:[a-zA-Z0-9]{8}|[a-f0-9]{64})$/;
const ferriguraPath =
  /^\/ferrigura\/(?:fonts\/[a-z0-9-]+\/[0-9.]+\/[a-f0-9]{64}\.ttf|catalogs\/[a-z0-9-]+\/[0-9.]+\/[a-f0-9]{64}\.json)$/;
const maxBodyBytes = 512;
const maxAssetBytes = 256 * 1024 * 1024;
const encoder = new TextEncoder();
const headers = { "Cache-Control": "private, no-store" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isDownloadPath(tool: DownloadTool, path: string) {
  return (
    path.length <= 240 &&
    !path.split("/").some((segment) => segment === "." || segment === "..") &&
    (tool === "ferriki" ? ferrikiPath : ferriguraPath).test(path)
  );
}

function hasValidIdentity(tool: DownloadTool, path: string, digest: string) {
  return (
    isDownloadPath(tool, path) &&
    sha256.test(digest) &&
    (tool === "ferriki" || path.split("/").at(-1)?.split(".")[0] === digest)
  );
}

export function validateAssets(tool: DownloadTool, raw: unknown): DownloadAsset[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 20_000)
    throw new Error("Invalid download asset list");

  const paths = new Set<string>();
  return raw.map((value: unknown) => {
    if (!isRecord(value)) throw new Error("Invalid download asset");
    const { path, bytes, sha256: digest } = value;
    if (
      typeof path !== "string" ||
      typeof digest !== "string" ||
      !hasValidIdentity(tool, path, digest) ||
      typeof bytes !== "number" ||
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      bytes > maxAssetBytes ||
      paths.has(path)
    )
      throw new Error("Invalid or duplicate download asset");
    paths.add(path);
    return { path, bytes, sha256: digest };
  });
}

async function requestAsset(request: Request, tool: DownloadTool) {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return;
  const reader = request.body?.getReader();
  if (!reader) return;
  const buffer = new Uint8Array(maxBodyBytes);
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > maxBodyBytes) return;
      buffer.set(value, length);
      length += value.byteLength;
    }
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)),
    );
    if (!isRecord(parsed) || Object.keys(parsed).length !== 2) return;
    const { path, sha256: digest } = parsed;
    if (
      typeof path === "string" &&
      typeof digest === "string" &&
      hasValidIdentity(tool, path, digest)
    )
      return { path, sha256: digest };
  } catch {
    return;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

const encodeDigest = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

export async function createDownloadService(options: {
  tool: DownloadTool;
  assets: unknown;
  tokenSha256: unknown;
  signingKey: string | undefined;
  now?: () => number;
}) {
  const { tool, signingKey, tokenSha256 } = options;
  const now = options.now ?? Date.now;
  const { issuer, cdn } = downloadHosts[tool];
  const assets = new Map(validateAssets(tool, options.assets).map((asset) => [asset.path, asset]));
  if (
    typeof signingKey !== "string" ||
    signingKey.length < 16 ||
    !Array.isArray(tokenSha256) ||
    tokenSha256.length < 1 ||
    tokenSha256.length > 1_000 ||
    !tokenSha256.every((value: unknown) => typeof value === "string" && sha256.test(value))
  )
    throw new Error("Invalid download credentials");

  const accepted = new Set<string>(tokenSha256);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (
      url.protocol !== "https:" ||
      url.host !== issuer ||
      url.pathname !== "/v1/downloads" ||
      url.search
    )
      return new Response(null, { status: 404, headers });
    if (request.method !== "POST")
      return new Response(null, { status: 405, headers: { ...headers, Allow: "POST" } });

    // The allowlist stores only digests of independently generated 256-bit build tokens.
    const token = request.headers.get("authorization")?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    if (token) {
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(token)));
      if (accepted.has(encodeDigest(digest))) {
        const requested = await requestAsset(request, tool);
        if (!requested) return new Response(null, { status: 400, headers });
        const asset = assets.get(requested.path);
        if (!asset || asset.sha256 !== requested.sha256)
          return new Response(null, { status: 404, headers });

        const expires = Math.floor(now() / 1_000) + 120;
        const download = new URL(asset.path, `https://${cdn}`);
        const signature = await crypto.subtle.sign(
          "HMAC",
          key,
          encoder.encode(download.pathname + expires),
        );
        download.searchParams.set("token", `HS256-${base64url(new Uint8Array(signature))}`);
        download.searchParams.set("expires", String(expires));
        return Response.json(
          { url: download.href, bytes: asset.bytes, sha256: asset.sha256 },
          { headers },
        );
      }
    }
    return new Response(null, { status: 401, headers });
  };
}
