import { randomBytes, createHash } from "node:crypto";
import type { UsageRow } from "../../src/storage/database.ts";

export function uuid7(now = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = (bytes[6]! & 15) | 0x70;
  bytes[8] = (bytes[8]! & 63) | 0x80;
  const s = bytes.toString("hex");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
export const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
export function maxRows(): UsageRow[] {
  return Array.from({ length: 256 }, (_, i) => ({
    day: new Date().toISOString().slice(0, 10),
    tool_version: "1.0.0",
    command: "status",
    count: 1,
    project_id: hash(`synthetic-project-${i}`),
    project_id_version: 1,
  }));
}
export function identity() {
  return {
    id: uuid7(),
    tokenHash: hash(randomBytes(32).toString("hex")),
    consentedAt: new Date().toISOString(),
  };
}
