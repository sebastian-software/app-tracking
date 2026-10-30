import { checkedPublicUsage, type PublicUsageResult } from "../src/reporting/history.ts";

const endpoints = [
  "https://sebastian-app-tracking.b-cdn.net/v1/public/usage",
  "https://sebastian-oss-metrics.b-cdn.net/v1/app-usage.json",
  "https://metrics.sebastian-software.com/v1/app-usage.json",
];
const topFields = ["schema_version", "unit", "window", "count_rounding", "snapshot_at", "series"];
const rowFields = ["month", "tool_id", "stream", "metric", "mode", "state", "count"];

function exactFields(value: unknown, fields: string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid object");
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key)))
    throw new Error("Unexpected or missing fields");
}

export function validateSnapshot(input: unknown, now: number): PublicUsageResult {
  exactFields(input, topFields);
  const value = input as Record<string, unknown>;
  if (!Array.isArray(value.series)) throw new Error("Invalid series");
  for (const row of value.series) exactFields(row, rowFields);
  const result = checkedPublicUsage(input);
  const age = now - Date.parse(result.snapshot_at);
  if (!Number.isFinite(age) || age < -60_000 || age > 5 * 60_000)
    throw new Error("Snapshot is stale or in the future");
  return result;
}

export function checkMonth(month: string, now: number): void {
  if (!/^\d{4}-(0[1-9]|1[0-2])-01$/.test(month)) throw new Error("Use YYYY-MM-01");
  const date = new Date(`${month}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== month)
    throw new Error("Invalid month");
  const eligible = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 8);
  if (now < eligible) throw new Error("Month is not eligible for finalization yet");
}

async function read(url: string): Promise<PublicUsageResult> {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (
    !response.ok ||
    !/(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get("cache-control") ?? "")
  )
    throw new Error("Response is unavailable or lacks no-store");
  if (
    Number(response.headers.get("age") ?? "0") > 0 ||
    /hit/i.test(response.headers.get("cdn-cache") ?? "")
  )
    throw new Error("Cached response");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing response body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 256_000) throw new Error("Response too large");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
  let input: unknown;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Invalid JSON response");
  }
  return validateSnapshot(input, Date.now());
}

export function compareMonth(
  snapshots: PublicUsageResult[],
  month: string,
): "available" | "unavailable" {
  const rows = snapshots.map((snapshot) =>
    snapshot.series
      .filter((row) => row.month === month)
      .map((row) => JSON.stringify(row))
      .sort(),
  );
  if (rows.some((row) => JSON.stringify(row) !== JSON.stringify(rows[0])))
    throw new Error("Selected month differs between source and adapters");
  return snapshots[0].series.some((row) => row.month === month && row.state === "available")
    ? "available"
    : "unavailable";
}

if (import.meta.main) {
  try {
    const month = process.argv[2] ?? "";
    checkMonth(month, Date.now());
    const snapshots = await Promise.all(endpoints.map(read));
    const result = compareMonth(snapshots, month);
    if (result === "unavailable")
      throw new Error("No available cells for selected month; coverage is missing or withheld");
    console.log(
      `${month}: available cells match across source and adapters; inspect coverage and screening before recording evidence.`,
    );
  } catch (error) {
    console.error(
      `Public month check failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exitCode = 1;
  }
}
