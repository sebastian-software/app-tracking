import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("published normalization-v1 hashes match canonical UTF-8 bytes independently", async () => {
  const fixtures = JSON.parse(
    await readFile(
      new URL("../crates/app-tracking/fixtures/project-identity-v1.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(fixtures.normalization_version, 1);
  for (const entry of fixtures.cases) {
    assert.equal(
      entry.project_id,
      entry.canonical === null
        ? null
        : createHash("sha256").update(entry.canonical, "utf8").digest("hex"),
      entry.name,
    );
  }
});
