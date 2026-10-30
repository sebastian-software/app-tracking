export type BunnyApi = <T>(method: string, path: string, body?: unknown) => Promise<T>;
export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function operationFailure(status: number, problem: unknown): Error {
  const details: string[] = [];
  if (problem && typeof problem === "object") {
    const fields = problem as Record<string, unknown>;
    if (
      typeof fields.errorKey === "string" &&
      /^[a-zA-Z][a-zA-Z0-9_.-]{0,99}$/.test(fields.errorKey)
    )
      details.push(fields.errorKey);
    if (fields.errors && typeof fields.errors === "object")
      details.push(
        ...Object.keys(fields.errors).filter((field) =>
          /^(?:RuleConfiguration|ruleConfiguration|PullZoneId|pullZoneId|RuleName|ruleName)(?:\.[a-zA-Z]+)*$/.test(
            field,
          ),
        ),
      );
  }
  return new Error(
    `Bunny operation failed (${status})${details.length ? `: ${details.join(", ")}` : ""}`,
  );
}
export function bunnyApi(key: string): BunnyApi {
  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`https://api.bunny.net${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: { AccessKey: key, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // API error bodies and resource paths can contain private account details.
    if (!response.ok) {
      // Preserve fixed validation codes/field names, never provider messages or values.
      let problem: unknown;
      try {
        problem = await response.json();
      } catch {
        /* A non-JSON provider response is still a bounded HTTP failure. */
      }
      throw operationFailure(response.status, problem);
    }
    const result = response.status === 204 ? undefined : await response.json();
    if (path.startsWith("/shield/")) {
      const failure = [result?.error, result?.errorResponse].find(
        (error) => error?.success === false,
      );
      if (failure) throw operationFailure(response.status, failure);
    }
    return result as T;
  };
}
