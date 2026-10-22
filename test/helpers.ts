import { readFileSync } from "node:fs";
import type { VersionResponse } from "../src/contract.ts";

export const NOW = Date.parse("2026-10-22T09:00:00.000Z");
export const published = "2026-10-21T08:00:00.000Z";
export const path = "/v1/versions/dalo/npm/stable";
export const request = (pathname = path, init?: RequestInit) =>
  new Request(`https://example.com${pathname}`, init);

export function npmDocument(name = "getdalo", version = "1.2.3") {
  return {
    name,
    "dist-tags": { latest: version },
    versions: { [version]: { name, version } },
    time: { [version]: published },
  };
}

export function versionFixture(): VersionResponse {
  return JSON.parse(readFileSync(new URL("./fixtures/version.json", import.meta.url), "utf8"));
}

export function githubDocument() {
  const document: {
    tag_name: string;
    draft: boolean;
    prerelease: boolean;
    published_at: string;
    html_url: string;
    assets: { name: string; state: string; size: number }[];
  } = JSON.parse(readFileSync(new URL("./fixtures/github-release.json", import.meta.url), "utf8"));
  return document;
}
