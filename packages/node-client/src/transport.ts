import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { fail, TrackingError } from "./types.ts";

export function endpoint(input: string, originOnly: boolean): URL {
  try {
    const url = new URL(input);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const loopback = host === "::1" || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host);
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username ||
      url.password ||
      /[?#]/.test(input) ||
      (originOnly && url.pathname !== "/")
    )
      fail("Configuration");
    return url;
  } catch {
    fail("Configuration");
  }
}

export async function request(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ response: IncomingMessage; close: () => void }> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  const close = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  };
  try {
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        url,
        {
          method,
          headers,
          maxHeaderSize: 16_384,
          signal: controller.signal,
          // No agent pooling: short-lived workers own at most one connection.
          agent: false,
        },
        resolve,
      );
      req.once("error", reject);
      req.end(body);
    });
    return {
      response,
      close: () => {
        response.destroy();
        close();
      },
    };
  } catch {
    close();
    fail(signal?.aborted ? "Cancelled" : "Network");
  }
}

export async function readBody(response: IncomingMessage, limit: number): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of response) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > limit) fail("Network");
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    if (error instanceof TrackingError) throw error;
    fail("Network");
  }
}
