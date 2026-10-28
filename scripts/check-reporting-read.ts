import { createReportingStorage, reportingFailureLabel } from "../src/reporting/storage.ts";
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
