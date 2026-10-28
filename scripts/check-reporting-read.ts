import { createReportingStorage, reportingFailureLabel } from "../src/reporting/storage.ts";
import { checkedHistory, checkedPublicUsage } from "../src/reporting/history.ts";
import { checkedEvents } from "../src/reporting/events.ts";
import { checkedUsage, type UsageQuery } from "../src/reporting/contract.ts";

export async function checkReportingRead(url: string): Promise<void> {
  const until = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.parse(until) - 86400000).toISOString().slice(0, 10);
  const query: UsageQuery = { from, until, tool: "all", mode: "local" };
  let stage = "storage";
  try {
    const result = await createReportingStorage(url).usage(query, AbortSignal.timeout(2800));
    stage = "contract";
    checkedUsage(result, query);
    stage = "events_storage";
    const eventsQuery = { ...query, metric: "cli.invocation" as const };
    const events = await createReportingStorage(url).events!(
      eventsQuery,
      AbortSignal.timeout(2800),
    );
    stage = "events_contract";
    checkedEvents(events, eventsQuery);
    const endMonth = until.slice(0, 7) + "-01";
    const startMonth = new Date(
      Date.UTC(Number(endMonth.slice(0, 4)), Number(endMonth.slice(5, 7)) - 2, 1),
    )
      .toISOString()
      .slice(0, 10);
    const historyQuery = {
      from: startMonth,
      until: endMonth,
      tool: "all" as const,
      mode: "local" as const,
      stream: "legacy" as const,
      metric: "cli.invocation" as const,
    };
    stage = "history_storage";
    const history = await createReportingStorage(url).history!(
      historyQuery,
      AbortSignal.timeout(2800),
    );
    stage = "history_contract";
    checkedHistory(history, historyQuery);
    stage = "public_storage";
    const projected = await createReportingStorage(url).publicUsage!(AbortSignal.timeout(2800));
    stage = "public_contract";
    if (
      !(
        typeof projected === "object" &&
        projected !== null &&
        "error" in projected &&
        projected.error === "not_found"
      )
    )
      checkedPublicUsage(projected);
  } catch (error) {
    console.error("Reporting read check failed: " + stage + ":" + reportingFailureLabel(error));
    throw new Error("Reporting read check failed");
  }
}
if (import.meta.main) {
  try {
    const url = process.env.REPORTING_DATABASE_URL;
    if (!url) throw new Error("Reporting URL is required");
    await checkReportingRead(url);
    console.log("Reporting read check passed; statistics were not logged.");
  } catch {
    process.exitCode = 1;
  }
}
