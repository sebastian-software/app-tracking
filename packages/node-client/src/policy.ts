import { fail, type ClientOptions } from "./types.ts";

const truthy = (value: string | undefined) =>
  value !== undefined && value !== "" && value !== "0" && value !== "false";

/** One environment snapshot; environment settings can veto, never grant consent. */
export function resolvePolicy(input: ClientOptions["policy"] = {}) {
  const policy = { ...input };
  for (const key of ["offline", "ci", "isolatedCiState", "doNotTrack", "hostDisabled"] as const)
    if (policy[key] !== undefined && typeof policy[key] !== "boolean") fail("Configuration");
  const envTelemetry = process.env.APP_TRACKING_TELEMETRY;
  policy.telemetry =
    envTelemetry !== undefined && envTelemetry !== "on"
      ? envTelemetry
      : (policy.telemetry ?? envTelemetry);
  policy.doNotTrack = truthy(process.env.DO_NOT_TRACK) || policy.doNotTrack === true;
  policy.ci =
    truthy(process.env.CI) || truthy(process.env.CONTINUOUS_INTEGRATION) || policy.ci === true;
  policy.ciRevision = process.env.APP_TRACKING_CI ?? policy.ciRevision;
  return policy;
}
