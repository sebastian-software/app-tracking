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
    if (!response.ok) throw new Error(`Bunny operation failed (${response.status})`);
    return (response.status === 204 ? undefined : await response.json()) as T;
  };
}
