import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

for (const name of ["update-client", "cli-settings"]) {
  test(`${name} fixtures are included unchanged in the Rust crate`, async () => {
    assert.equal(
      await readFile(`contracts/${name}.json`, "utf8"),
      await readFile(`crates/app-tracking/fixtures/${name}.json`, "utf8"),
    );
  });
}
