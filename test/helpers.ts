import { readFileSync } from "node:fs";
import type { VersionResponse } from "../src/contract.ts";

export const NOW = Date.parse("2026-10-22T09:00:00.000Z");
export const published = "2026-10-21T08:00:00.000Z";
export const path = "/v1/versions/dalo/npm/stable";
export const request = (pathname = path, init?: RequestInit) =>
  new Request(`https://example.com${pathname}`, init);

export function metricsDocument(version = "1.2.3", generatedAt = new Date(NOW).toISOString()) {
  return {
    schema: 1,
    generatedAt,
    sources: { github: "ok", releases: "ok", npm: "error", crates: "error" },
    github: {
      dalo: { release: { tag: `dalo-v${version}`, version, publishedAt: published } },
      palamedes: { release: { tag: "palamedes-v2.3.4", version: "2.3.4", publishedAt: published } },
    },
  };
}

export function versionFixture(): VersionResponse {
  return JSON.parse(readFileSync(new URL("./fixtures/version.json", import.meta.url), "utf8"));
}
