import assert from "node:assert/strict";
import test from "node:test";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adminTokenHash } from "../src/reporting/handler.ts";

test("key generation is private, refuses overwrite, and cannot write into the checkout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reporting-key-test-"));
  const run = promisify(execFile),
    file = join(directory, "key.json");
  try {
    const { stdout, stderr } = await run(process.execPath, [
      "scripts/create-reporting-key.ts",
      file,
    ]);
    const text = await readFile(file, "utf8"),
      key = JSON.parse(text);
    assert.match(key.token, /^at_admin_v1_[a-f0-9]{64}$/);
    assert.equal(key.token_sha256, await adminTokenHash(key.token));
    assert.ok(!stdout.includes(key.token) && !stderr.includes(key.token));
    if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
    await assert.rejects(run(process.execPath, ["scripts/create-reporting-key.ts", file]));
    assert.equal(await readFile(file, "utf8"), text);
    await assert.rejects(
      run(process.execPath, ["scripts/create-reporting-key.ts", ".reporting-test-key.json"]),
    );
    await assert.rejects(stat(".reporting-test-key.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
