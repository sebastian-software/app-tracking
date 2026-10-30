import { constants } from "node:fs";
import { strictJSON } from "../../../src/telemetry/json.ts";
import { lstat, mkdir, open, rename, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { hash } from "./context.ts";
import { directory, hex, random } from "./state.ts";
import { fail, TrackingError } from "./types.ts";

export interface SharedProfile {
  schema_version: 2;
  origin: string;
  profile_id: string;
  token: string;
  reset_pending: boolean;
}
export interface ProfileChoice {
  revision: string;
  enabled: boolean;
  changedAt: number;
  confirmed: boolean;
  profileId: string | null;
}

/** One non-stealable lock protocol shared with Rust. */
export async function withProfile<T>(
  root: string,
  origin: string,
  create: boolean,
  action: (profile: SharedProfile | undefined, save: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const dir = join(root, "profiles-v2", hash(origin));
  if (!(await directory(dir, create))) return action(undefined, async () => fail("State"));
  const lock = join(dir, "profile.lock");
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("Busy");
    fail("State");
  }
  try {
    const path = join(dir, "profile.json");
    let profile: SharedProfile | undefined;
    let file;
    try {
      const meta = await lstat(path);
      if (
        !meta.isFile() ||
        meta.isSymbolicLink() ||
        meta.size > 4096 ||
        (process.platform !== "win32" && meta.mode & 0o077)
      )
        fail("State");
      file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const actual = await file.stat();
      if (meta.ino !== actual.ino || meta.dev !== actual.dev || actual.size > 4096) fail("State");
      const parsed: unknown = strictJSON(await file.readFile("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("State");
      const value = parsed as Record<string, unknown>;
      if (
        Object.keys(value).sort().join() !==
          "origin,profile_id,reset_pending,schema_version,token" ||
        value.schema_version !== 2 ||
        value.origin !== origin ||
        typeof value.profile_id !== "string" ||
        !hex.test(value.profile_id) ||
        typeof value.token !== "string" ||
        !hex.test(value.token) ||
        typeof value.reset_pending !== "boolean"
      )
        fail("State");
      profile = value as unknown as SharedProfile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (error instanceof TrackingError) throw error;
        fail("State");
      }
      if (create)
        profile = {
          schema_version: 2,
          origin,
          profile_id: random(),
          token: random(),
          reset_pending: false,
        };
    } finally {
      await file?.close();
    }
    const save = async () => {
      if (!profile) fail("State");
      const temp = join(dir, `${random()}.tmp`);
      let out;
      try {
        out = await open(temp, "wx", 0o600);
        await out.writeFile(JSON.stringify(profile));
        await out.sync();
        await out.close();
        out = undefined;
        await rename(temp, path);
        if (process.platform !== "win32") {
          const parent = await open(dir, "r");
          try {
            await parent.sync();
          } finally {
            await parent.close();
          }
        }
      } catch {
        fail("State");
      } finally {
        await out?.close();
        await rm(temp, { force: true }).catch(() => {});
      }
    };
    if (create) await save();
    return await action(profile, save);
  } finally {
    await rmdir(lock).catch(() => fail("State"));
  }
}
