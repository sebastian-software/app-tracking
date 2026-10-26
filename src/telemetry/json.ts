import { TelemetryError } from "./contract.ts";

// JSON.parse alone loses duplicate keys and may round a fractional count to an integer.
// The wire domain contains only exact safe integers; 1.0 and 1e0 still denote one.
export function strictJSON(text: string): unknown {
  let at = 0;
  const invalid = (): never => {
    throw new TelemetryError("invalid_request");
  };
  const whitespace = () => {
    while (/[\x20\t\r\n]/.test(text[at] ?? "x")) at++;
  };
  function string(): string {
    const start = at++;
    while (at < text.length) {
      const c = text[at++];
      if (c === '"') {
        try {
          return JSON.parse(text.slice(start, at)) as string;
        } catch {
          return invalid();
        }
      }
      if (c === "\\") at++;
    }
    return invalid();
  }
  function value(depth: number): unknown {
    if (depth > 32) return invalid();
    whitespace();
    if (text[at] === '"') return string();
    if (text[at] === "{") {
      at++;
      whitespace();
      const result: Record<string, unknown> = Object.create(null);
      if (text[at] === "}") {
        at++;
        return result;
      }
      while (true) {
        whitespace();
        if (text[at] !== '"') return invalid();
        const key = string();
        whitespace();
        if (Object.hasOwn(result, key) || text[at++] !== ":") return invalid();
        result[key] = value(depth + 1);
        whitespace();
        const separator = text[at++];
        if (separator === "}") return result;
        if (separator !== ",") return invalid();
      }
    }
    if (text[at] === "[") {
      at++;
      whitespace();
      const result: unknown[] = [];
      if (text[at] === "]") {
        at++;
        return result;
      }
      while (true) {
        result.push(value(depth + 1));
        whitespace();
        const separator = text[at++];
        if (separator === "]") return result;
        if (separator !== ",") return invalid();
      }
    }
    for (const [token, parsed] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (text.startsWith(token, at)) {
        at += token.length;
        return parsed;
      }
    }
    const match = /^-?(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?/.exec(text.slice(at));
    if (!match) return invalid();
    at += match[0].length;
    const number = Number(match[0]);
    if (!Number.isSafeInteger(number)) return invalid();
    const digits = (match[1] + (match[2] ?? "")).replace(/^0+/, "");
    if (digits) {
      const trailing = digits.length - digits.replace(/0+$/, "").length;
      const scale = Number(match[3] ?? 0) - (match[2]?.length ?? 0) + trailing;
      if (scale < 0 || !Number.isFinite(scale)) return invalid();
    }
    return number;
  }
  const result = value(0);
  whitespace();
  if (at !== text.length) return invalid();
  return result;
}
export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new TelemetryError("service_unavailable"));
    if (signal.aborted) {
      void work.catch(() => {});
      aborted();
      return;
    }
    signal.addEventListener("abort", aborted, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}
export async function readJSON(
  request: Request,
  limit: number,
  signal: AbortSignal,
): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit))
    throw new TelemetryError(/^\d+$/.test(declared) ? "payload_too_large" : "invalid_request");
  const reader = request.body?.getReader();
  if (!reader) throw new TelemetryError("invalid_request");
  const chunks: Uint8Array[] = [];
  let length = 0,
    done = false;
  try {
    while (true) {
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) {
        done = true;
        break;
      }
      length += chunk.value.byteLength;
      if (length > limit) throw new TelemetryError("payload_too_large");
      chunks.push(chunk.value);
    }
    if (declared !== null && Number(declared) !== length)
      throw new TelemetryError("invalid_request");
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    // Preserve a UTF-8 BOM for rejection by the strict JSON grammar.
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new TelemetryError("invalid_request");
    }
    return strictJSON(text);
  } finally {
    if (!done) void reader.cancel().catch(() => {});
    else reader.releaseLock();
  }
}
