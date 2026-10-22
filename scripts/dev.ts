import { createServer } from "node:http";
import { createHandler } from "../src/handler.ts";

const handle = createHandler();
const server = createServer((incoming, outgoing) => {
  void (async () => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (typeof value === "string") headers.set(name, value);
      else if (value) for (const item of value) headers.append(name, item);
    }
    // A fixed local origin prevents Host from becoming a routing or fetch input.
    const request = new Request(`http://127.0.0.1:8787${incoming.url ?? "/"}`, {
      method: incoming.method,
      headers,
    });
    incoming.resume();
    const response = await handle(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(new Uint8Array(await response.arrayBuffer()));
  })().catch(() => {
    outgoing.writeHead(500, { "Cache-Control": "no-store" });
    outgoing.end();
  });
});
server.listen(8787, "127.0.0.1", () => {
  console.log("Version service listening on http://127.0.0.1:8787");
});
