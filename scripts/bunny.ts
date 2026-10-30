export type BunnyApi = <T>(method: string, path: string, body?: unknown) => Promise<T>;
export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
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
      const details: string[] = [];
      try {
        const problem = await response.json();
        if (
          typeof problem?.errorKey === "string" &&
          /^[a-zA-Z][a-zA-Z_.-]{0,99}$/.test(problem.errorKey)
        )
          details.push(problem.errorKey);
        if (problem?.errors && typeof problem.errors === "object")
          details.push(
            ...Object.keys(problem.errors).filter((field) =>
              /^(?:RuleConfiguration|ruleConfiguration|PullZoneId|pullZoneId|RuleName|ruleName)(?:\.[a-zA-Z]+)*$/.test(
                field,
              ),
            ),
          );
      } catch {
        /* A non-JSON provider response is still a bounded HTTP failure. */
      }
      throw new Error(
        `Bunny operation failed (${response.status})${details.length ? `: ${details.join(", ")}` : ""}`,
      );
    }
    return (response.status === 204 ? undefined : await response.json()) as T;
  };
}
