import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import { createDownloadService, validateAssets } from "../src/downloads/service.ts";

const token = "a".repeat(64);
const signingKey = "issuer-fixture-signing-key";
const digest = "b".repeat(64);
const asset = { path: "/themes/nord/DVzhgQds", bytes: 26_684, sha256: digest };
const endpoint = "https://downloads.ferriki.dev/v1/downloads";

async function fixture() {
  return createDownloadService({
    tool: "ferriki",
    assets: [asset],
    tokenSha256: [createHash("sha256").update(token).digest("hex")],
    signingKey,
    now: () => 1_760_000_000_000,
  });
}

function request(body: unknown, authorization = `Bearer ${token}`, url = endpoint) {
  return new Request(url, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const valid = { path: asset.path, sha256: digest };

test("an authorized build receives a non-cacheable URL scoped to the catalog asset", async () => {
  const handler = await fixture();
  const response = await handler(request(valid));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const { url, ...details } = await response.json();
  assert.deepEqual(details, { bytes: asset.bytes, sha256: digest });
  const signed = new URL(url);
  assert.equal(signed.origin, "https://protected-assets.ferriki.dev");
  assert.equal(signed.pathname, asset.path);
  assert.deepEqual([...signed.searchParams.keys()].sort(), ["expires", "token"]);
  const expires = 1_760_000_120;
  assert.equal(signed.searchParams.get("expires"), String(expires));
  const signature = createHmac("sha256", signingKey)
    .update(asset.path + expires)
    .digest("base64url");
  assert.equal(signed.searchParams.get("token"), `HS256-${signature}`);
});

test("rejects anonymous, cross-domain, off-catalog and malformed requests", async () => {
  const handler = await fixture();
  assert.equal((await handler(request(valid, ""))).status, 401);
  assert.equal((await handler(request(valid, `Bearer ${"c".repeat(64)}`))).status, 401);
  assert.equal(
    (await handler(request(valid, undefined, "https://downloads.ferrigura.dev/v1/downloads")))
      .status,
    404,
  );
  assert.equal((await handler(new Request(endpoint))).status, 405);
  assert.equal((await handler(request({ ...valid, path: "/themes/rust/DVzhgQds" }))).status, 404);
  assert.equal((await handler(request({ ...valid, sha256: "9".repeat(64) }))).status, 404);
  assert.equal((await handler(request({ ...valid, path: "/themes/rust/%2e%2e" }))).status, 400);
  assert.equal((await handler(request({ ...valid, runtime: "22" }))).status, 400);
  assert.equal((await handler(request({ ...valid, path: "/".repeat(600) }))).status, 400);
});

test("Ferrigura registry accepts pinned renderer fonts and catalogs per tool", () => {
  const font = { ...asset, path: `/ferrigura/fonts/inter/4.1/${digest}.ttf` };
  const catalog = { ...asset, path: `/ferrigura/catalogs/fonts/1.0.0/${digest}.json` };
  assert.deepEqual(validateAssets("ferrigura", [font, catalog]), [font, catalog]);
  assert.throws(() => validateAssets("ferrigura", [{ ...font, sha256: "9".repeat(64) }]));
  assert.throws(() =>
    validateAssets("ferrigura", [{ ...font, path: font.path.replace(".ttf", ".woff2") }]),
  );
  assert.throws(() => validateAssets("ferriki", [font]));
  assert.throws(() => validateAssets("ferriki", [asset, asset]));
});

test("published catalogs produce only immutable protected object identities", async () => {
  const { assetDigest, ferriguraAssetsFromManifest, ferrikiAssetsFromCatalog } =
    await import("../scripts/downloads/catalog.ts");
  const nord = "e68ff2dae71a50102ba8c9d37f1938c88a877b71b42e7aefd20b3f2cf801d784";
  assert.deepEqual(
    ferrikiAssetsFromCatalog({
      release: {
        storageLayout: "language-hash-v2",
        assets: { "themes/nord.fktheme": { size: 26_684, sha256: nord } },
      },
    }),
    [{ path: "/themes/nord/DVzhgQds", bytes: 26_684, sha256: nord }],
  );
  const json = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      families: [
        {
          faces: [
            {
              renderer: {
                path: `fonts/inter/4.1/${digest}.ttf`,
                sha256: digest,
                size: 100,
              },
            },
          ],
        },
      ],
    }),
  );
  const manifestDigest = assetDigest(json);
  const path = `/ferrigura/catalogs/fonts/1.0.0/${manifestDigest}.json`;
  assert.deepEqual(ferriguraAssetsFromManifest(path, json), [
    { path, bytes: json.length, sha256: manifestDigest },
    { path: `/ferrigura/fonts/inter/4.1/${digest}.ttf`, bytes: 100, sha256: digest },
  ]);
  assert.throws(() => ferriguraAssetsFromManifest(path, Buffer.from("{}")));
});
