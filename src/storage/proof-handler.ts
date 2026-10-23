import { createStorage, StorageError, type UsageRow } from "./database.ts";

// Synthetic integration probe only. Never attached to the production version handler.
// Provision with a temporary database role and remove the deployment after the run.
interface Input {
  id: string;
  token_hash: string;
  consented_at?: string;
  batch_id?: string;
  content_hash?: string;
  rows?: UsageRow[];
  discard_ack?: boolean;
}
const instance = crypto.randomUUID();
let invocations = 0;
export function createProofHandler(databaseUrl: string, secret: string) {
  if (!/^[0-9a-f]{64}$/.test(secret)) throw new Error("A dedicated proof secret is required");
  const storage = createStorage(databaseUrl);
  return async (request: Request): Promise<Response> => {
    const started = performance.now();
    const ordinal = ++invocations;
    const reply = (body: unknown, status = 200) =>
      Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
    const url = new URL(request.url);
    if (url.search || request.headers.get("authorization") !== `Bearer ${secret}`)
      return reply({ error: "unauthorized" }, 401);
    if (request.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
    if (!["/proof/register", "/proof/submit", "/proof/revoke"].includes(url.pathname))
      return reply({ error: "not_found" }, 404);
    if (
      request.headers.get("content-type") !== "application/json" ||
      request.headers.has("content-encoding")
    )
      return reply({ error: "media_type" }, 415);
    try {
      const reader = request.body?.getReader();
      if (!reader) return reply({ error: "body_required" }, 400);
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.length;
        if (length > 65536) {
          await reader.cancel();
          return reply({ error: "payload_too_large" }, 413);
        }
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const input: Input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!input || typeof input.id !== "string" || typeof input.token_hash !== "string")
        return reply({ error: "invalid_input" }, 400);
      let output;
      if (url.pathname === "/proof/register") {
        if (typeof input.consented_at !== "string") return reply({ error: "invalid_input" }, 400);
        output = await storage.register(
          "dalo",
          input.id,
          input.token_hash,
          input.consented_at,
          "local",
        );
      } else if (url.pathname === "/proof/revoke") {
        output = await storage.revoke("dalo", input.id, input.token_hash);
      } else {
        if (
          typeof input.batch_id !== "string" ||
          typeof input.content_hash !== "string" ||
          !Array.isArray(input.rows)
        )
          return reply({ error: "invalid_input" }, 400);
        output = await storage.submit(
          "dalo",
          input.id,
          input.token_hash,
          input.batch_id,
          input.content_hash,
          input.rows,
        );
      }
      // This deliberately models a lost application acknowledgement AFTER commit.
      if (input.discard_ack) return reply({ error: "acknowledgement_discarded" }, 503);
      const deno = (
        globalThis as unknown as {
          Deno?: { memoryUsage?: () => { heapUsed: number; rss: number } };
        }
      ).Deno;
      const memory = deno?.memoryUsage?.();
      return reply({
        ...output,
        elapsed_ms: performance.now() - started,
        request_bytes: length,
        instance,
        ordinal,
        heap_used_bytes: memory?.heapUsed ?? null,
        rss_bytes: memory?.rss ?? null,
      });
    } catch (error) {
      return reply(
        { error: error instanceof StorageError ? error.code : "invalid_input" },
        error instanceof StorageError ? 503 : 400,
      );
    }
  };
}
