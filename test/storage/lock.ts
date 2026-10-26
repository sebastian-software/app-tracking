import { execFile } from "node:child_process";
import { psqlEnvironment, quote } from "../../scripts/storage/psql.ts";

// The lock holder acknowledges acquisition over stdout and stays alive until
// the competing operation finishes. No sleeps, cross-session visibility, or RTT assumptions.
export async function withInstallationLock(url: string, id: string, work: () => Promise<void>) {
  let readyResolve!: () => void, readyReject!: (e: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const child = execFile("psql", ["-X", "-qAt", "-v", "ON_ERROR_STOP=1"], {
    env: psqlEnvironment(url),
    timeout: 20_000,
    maxBuffer: 64 * 1024,
  });
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += String(chunk);
    if (output.includes("APP_TRACKING_LOCK_READY")) readyResolve();
  });
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", () => {
      const e = new Error("Lock session failed");
      readyReject(e);
      reject(e);
    });
    child.once("close", (code) => {
      if (code === 0) resolve();
      else {
        const e = new Error("Lock session failed");
        readyReject(e);
        reject(e);
      }
    });
  });
  // Attach a rejection handler immediately while acquisition is pending.
  void closed.catch(() => {});
  child.stdin?.on("error", () => {});
  child.stdin?.write(
    `BEGIN;\nSELECT installation_id FROM app_tracking.reporting_installations WHERE installation_id=${quote(id)} FOR UPDATE;\n\\echo APP_TRACKING_LOCK_READY\n`,
  );
  try {
    await ready;
    await work();
  } finally {
    child.stdin?.end("COMMIT;\n");
    await closed;
  }
}
