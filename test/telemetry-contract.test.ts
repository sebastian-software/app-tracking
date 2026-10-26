// Conformance oracle only: no HTTP endpoints, database, or production telemetry.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { fullFormats } from "ajv-formats/dist/formats.js";

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const policy = read("../contracts/telemetry-v1-policy.json");
const schema = read("../contracts/telemetry-v1.schema.json");
const fixture = read("./fixtures/telemetry/valid.json");
const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addFormat("date", fullFormats.date);
ajv.addFormat("date-time", fullFormats["date-time"]);
ajv.addSchema(schema);
const validate = (name: string) => ajv.getSchema(`${schema.$id}#/$defs/${name}`)!;
const DAY = 86_400_000;
const GRACE = policy.clock_skew_seconds * 1000;
const NOW = Date.parse(fixture.now);

type Row = {
  day: string;
  tool_version: string;
  command: string;
  count: number;
  project_id?: string;
  project_id_version?: number;
};
type Batch = {
  schema_version: number;
  tool_id: string;
  installation_id: string;
  batch_id: string;
  consent_revision: string;
  rows: Row[];
};
// The schema restricts this domain to ASCII strings and small positive integers.
// This is not a general-purpose JCS library or permissive production JSON parser.
function jcs(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(jcs).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${jcs(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
function dimensions(row: Row) {
  const { count: _, ...key } = row;
  return jcs(key);
}
function canonical(batch: Batch) {
  const rows = [...batch.rows].sort((a, b) => {
    const left = dimensions(a),
      right = dimensions(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return jcs({ ...batch, rows });
}
const hash = (batch: Batch) => createHash("sha256").update(canonical(batch)).digest("hex");
const born = (id: string) => Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);
function uuid(instant: string, tail = 2) {
  const time = Date.parse(instant).toString(16).padStart(12, "0");
  return `${time.slice(0, 8)}-${time.slice(8)}-7000-8000-${tail.toString(16).padStart(12, "0")}`;
}
const dateIndex = (ms: number) => Math.floor(ms / DAY);

interface SubmissionCase {
  name: string;
  expected: string;
  now?: string;
  receipt?: string;
  state?: string;
  last_activity?: string;
  total_count?: number;
  existing_daily_count?: number;
  credential_matches?: boolean;
  revision?: string;
  row_day?: string;
  batch_birth?: string;
  reverse_rows?: boolean;
  repeat_row?: boolean;
}
// Order is observable protocol behavior. Real locks/uniqueness/GC remain #6–#8.
function submission(c: SubmissionCase) {
  const now = c.now ? Date.parse(c.now) : NOW;
  const batch: Batch = structuredClone(fixture.batch);
  if (c.row_day) batch.rows = [{ ...batch.rows[0], day: c.row_day }];
  if (c.batch_birth) batch.batch_id = uuid(c.batch_birth);
  if (c.revision) batch.consent_revision = c.revision;
  if (c.reverse_rows) batch.rows.reverse();
  if (c.repeat_row) batch.rows.push({ ...batch.rows[0], count: 1 });
  if (c.total_count) {
    batch.rows = [];
    let remaining = c.total_count;
    while (remaining > 0) {
      const count = Math.min(remaining, policy.max_row_count);
      batch.rows.push({
        ...fixture.batch.rows[0],
        count,
        project_id: batch.rows.length.toString(16).padStart(64, "0"),
      });
      remaining -= count;
    }
  }
  if (c.credential_matches === false) return "unauthorized";
  if (c.state === "missing") return "installation_not_found";
  if (c.state === "revoked") return "installation_revoked";
  if (now - Date.parse(c.last_activity ?? fixture.now) >= policy.inactivity_days * DAY)
    return "installation_expired";
  if (batch.consent_revision !== policy.consent_revision) return "consent_required";
  const keys = batch.rows.map(dimensions);
  if (new Set(keys).size !== keys.length) return "duplicate_dimensions";
  if (c.receipt === "same") {
    assert.equal(hash(batch), fixture.payload_sha256);
    return "duplicate";
  }
  if (c.receipt === "different") return "batch_conflict";
  // Missing/expired receipts take the first-submission path. The old UUID must
  // fail even when edited occurrence days would otherwise be current.
  const created = born(batch.batch_id);
  if (created > now + GRACE) return "clock_skew";
  if (created < now - policy.batch_max_age_seconds * 1000 - GRACE) return "batch_expired";
  const lower = dateIndex(now - GRACE) - policy.submission_utc_dates + 1;
  const upper = dateIndex(now + GRACE);
  const consent = dateIndex(Date.parse(fixture.registration.consented_at));
  for (const row of batch.rows) {
    const day = dateIndex(Date.parse(`${row.day}T00:00:00.000Z`));
    if (day < lower || day > upper || day > dateIndex(created) || day < consent)
      return "invalid_usage_day";
  }
  const total = batch.rows.reduce((sum, row) => sum + row.count, 0);
  if (total > policy.max_batch_count) return "count_limit";
  const daily = new Map<string, number>();
  for (const row of batch.rows) daily.set(row.day, (daily.get(row.day) ?? 0) + row.count);
  if (
    [...daily.values()].some(
      (count) => count + (c.existing_daily_count ?? 0) > policy.max_daily_installation_count,
    )
  )
    return "count_limit";
  return "accepted";
}

interface RegistrationCase {
  name: string;
  expected: string;
  birth?: string;
  consented_at?: string;
  exists?: boolean;
  revoked?: boolean;
  credential_matches?: boolean;
  declaration_matches?: boolean;
}
function registration(c: RegistrationCase) {
  if (c.exists) {
    if (c.credential_matches === false) return "unauthorized";
    if (c.revoked) return "installation_revoked";
    return c.declaration_matches === false ? "registration_conflict" : "duplicate";
  }
  const birth = born(uuid(c.birth ?? fixture.now, 1));
  if (birth > NOW + GRACE) return "clock_skew";
  if (birth < NOW - policy.registration_window_seconds * 1000) return "installation_expired";
  const consented = Date.parse(c.consented_at ?? fixture.registration.consented_at);
  if (consented > NOW + GRACE || consented > birth + GRACE) return "clock_skew";
  if (consented < NOW - policy.inactivity_days * DAY) return "consent_required";
  return "registered";
}

interface ConsentCase {
  name: string;
  state?: string;
  action?: string;
  revision?: string;
  environment_consent?: string;
  grant_source?: string;
  legacy_reporting?: boolean;
  do_not_track?: boolean;
  offline?: boolean;
  ci?: boolean;
  ci_revision?: string;
  isolated_ci_state?: boolean;
  expected: object;
}
function consent(c: ConsentCase) {
  const base = { collect: false, upload: false, delete: false };
  if (c.action === "withdraw") return { ...base, discard_usage: true };
  if (c.action === "delete" || c.action === "reset") {
    return {
      ...base,
      delete: !c.offline,
      pending_deletion: true,
      retain: ["installation_id", "token", "deletion_status"],
      ...(c.action === "reset" ? { new_identity: false } : {}),
    };
  }
  const refused = c.state === "declined" || c.state === "withdrawn" || c.do_not_track;
  const grant =
    !refused &&
    ((c.state === "enabled" &&
      (c.revision ?? policy.consent_revision) === policy.consent_revision &&
      (c.grant_source !== "environment" || c.environment_consent === policy.consent_revision)) ||
      ((!c.state || c.state === "undecided") && c.environment_consent === policy.consent_revision));
  const allowed =
    !!grant &&
    (!c.ci || (c.ci_revision === policy.consent_revision && c.isolated_ci_state === true));
  return { collect: allowed, upload: allowed && !c.offline, delete: false };
}

test("v1 success/error/deletion fixtures conform to strict schemas", () => {
  for (const name of ["registration", "batch", "registration_ack", "batch_ack", "error"]) {
    const check = validate(name);
    assert.ok(check(fixture[name]), `${name}: ${ajv.errorsText(check.errors)}`);
  }
  assert.equal(validate("deletion")(null), true);
  assert.equal(validate("batch_ack")({ ...fixture.batch_ack, token: "redacted" }), false);
});

test("policy command catalog agrees with the wire schema", () => {
  assert.deepEqual(schema.$defs.row.properties.command.enum, [
    ...new Set(Object.values(policy.tools).flatMap((tool: any) => tool.commands)),
  ]);
  assert.equal(schema.$defs.batch.properties.rows.maxItems, policy.max_rows);
  assert.equal(schema.$defs.row.properties.count.maximum, policy.max_row_count);
  assert.ok(policy.receipt_retention_days * DAY > policy.batch_max_age_seconds * 1000 + 2 * GRACE);
  assert.ok(
    policy.revocation_retention_days * DAY > policy.registration_window_seconds * 1000 + GRACE,
  );
});

interface ShapeCase {
  name: string;
  definition: string;
  valid: boolean;
  changes: { path: (string | number)[]; remove?: boolean; value?: unknown }[];
}
for (const c of read("./fixtures/telemetry/shape-cases.json") as ShapeCase[]) {
  test(`schema: ${c.name}`, () => {
    const value = structuredClone(fixture[c.definition]);
    for (const change of c.changes) {
      let parent = value;
      for (const key of change.path.slice(0, -1)) parent = parent[key];
      const key = change.path.at(-1)!;
      if (change.remove) delete parent[key];
      else parent[key] = change.value;
    }
    const check = validate(c.definition);
    assert.equal(check(value), c.valid, ajv.errorsText(check.errors));
  });
}

test("independently generated canonical UTF-8 and SHA-256 are stable across JSON and row order", () => {
  assert.equal(canonical(fixture.batch), fixture.canonical_utf8);
  assert.equal(hash(fixture.batch), fixture.payload_sha256);
  // Reverse keys recursively, without omitting any nested fields.
  function reverse(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(reverse).reverse();
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .reverse()
          .map(([k, v]) => [k, reverse(v)]),
      );
    return value;
  }
  assert.equal(hash(reverse(fixture.batch) as Batch), fixture.payload_sha256);
  const changed: Batch = structuredClone(fixture.batch);
  changed.rows[0].count++;
  assert.notEqual(hash(changed), fixture.payload_sha256);
});

for (const c of read("./fixtures/telemetry/submission-cases.json") as SubmissionCase[])
  test(`submission: ${c.name}`, () => assert.equal(submission(c), c.expected));
for (const c of read("./fixtures/telemetry/registration-cases.json") as RegistrationCase[])
  test(`registration: ${c.name}`, () => assert.equal(registration(c), c.expected));
for (const c of read("./fixtures/telemetry/consent-cases.json") as ConsentCase[])
  test(`consent: ${c.name}`, () => assert.deepEqual(consent(c), c.expected));

test("byte, row, and count bounds include their exact boundary", () => {
  const raw = JSON.stringify(fixture.batch);
  const boundary = raw + " ".repeat(policy.max_batch_bytes - Buffer.byteLength(raw));
  assert.equal(Buffer.byteLength(boundary), 65536);
  assert.deepEqual(JSON.parse(boundary), fixture.batch);
  assert.ok(Buffer.byteLength(boundary + " ") > policy.max_batch_bytes);
  const batch: Batch = structuredClone(fixture.batch);
  batch.rows = Array.from({ length: policy.max_rows }, (_, i) => ({
    ...batch.rows[1],
    project_id: i.toString(16).padStart(64, "0"),
    project_id_version: 1,
  }));
  assert.ok(validate("batch")(batch));
  batch.rows.push(batch.rows[0]);
  assert.equal(validate("batch")(batch), false);
  batch.rows = [{ ...batch.rows[0], count: policy.max_row_count }];
  assert.ok(validate("batch")(batch));
});

test("retry deadlines are capped and never earlier than server suppression", () => {
  const delay = (failures: number, retryAfter?: number) =>
    Math.max(
      policy.retry_seconds[Math.min(Math.max(failures - 1, 0), policy.retry_seconds.length - 1)],
      retryAfter === undefined ? 0 : Math.min(86400, Math.max(60, retryAfter)),
    );
  assert.equal(delay(1), 60);
  assert.equal(delay(6), 86400);
  assert.equal(delay(100), 86400);
  assert.equal(delay(1, 90000), 86400);
  assert.equal(delay(3, 1), 1800);
  assert.equal(delay(1, 120), 120);
});

test("tool-specific schemas do not accept another tool's command catalog", () => {
  const palamedes = {
    ...fixture.batch,
    tool_id: "palamedes",
    rows: [{ ...fixture.batch.rows[0], command: "extract" }],
  };
  assert.equal(validate("batch")(palamedes), true);
  assert.equal(validate("registration")({ ...fixture.registration, tool_id: "palamedes" }), true);
  assert.equal(validate("batch")({ ...palamedes, tool_id: "dalo" }), false);
  assert.equal(
    validate("batch")({ ...palamedes, rows: [{ ...palamedes.rows[0], command: "sync" }] }),
    false,
  );
});
