import { checkedHistory, historyQuery, type HistoryQuery } from "../src/reporting/history.ts";
import { createReportingStorage } from "../src/reporting/storage.ts";

export function monthQuery(args: string[]): HistoryQuery {
  if (args.length !== 5 || !/^\d{4}-\d{2}-01$/.test(args[0]!)) throw new Error("Invalid arguments");
  const [from, tool, stream, metric, mode] = args as [string, string, string, string, string];
  const date = new Date(from + "T00:00:00Z");
  if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== from)
    throw new Error("Invalid month");
  date.setUTCMonth(date.getUTCMonth() + 1);
  const params = new URLSearchParams({
    from,
    until: date.toISOString().slice(0, 10),
    tool,
    stream,
    metric,
    mode,
  });
  const query = historyQuery(new URL("https://example.invalid/?" + params));
  if (query.tool === "all") throw new Error("Select one tool");
  return query;
}

export function monthStatus(
  input: unknown,
  query: HistoryQuery,
): { state: string; reason: string; complete: boolean } {
  const result = checkedHistory(input, query);
  if (result.months.length !== 1) throw new Error("Expected one history period");
  const row = result.months[0]!;
  const complete =
    result.enabled &&
    result.period.coverage_from !== null &&
    result.period.coverage_from <= query.from &&
    ((row.state === "finalized" && row.reason === "ready") ||
      (row.state === "suppressed" && row.reason === "cohort"));
  return { state: row.state, reason: row.reason, complete };
}

if (import.meta.main) {
  try {
    const query = monthQuery(process.argv.slice(2));
    const url = process.env.REPORTING_DATABASE_URL;
    if (!url) throw new Error("Reporting URL is required");
    const result = await createReportingStorage(url).history!(query, AbortSignal.timeout(2800));
    const status = monthStatus(result, query);
    console.log(
      JSON.stringify({
        month: query.from,
        tool: query.tool,
        stream: query.stream,
        metric: query.metric,
        mode: query.mode,
        ...status,
      }),
    );
    if (!status.complete) process.exitCode = 1;
  } catch {
    console.error(
      "History month check failed: invalid arguments, unavailable reporting storage, or invalid response. No report values were logged.",
    );
    process.exitCode = 1;
  }
}
